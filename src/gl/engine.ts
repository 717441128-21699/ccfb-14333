/**
 * WebGL2 评分引擎(混合架构)。
 *
 * 职责划分:
 *  - GPU(着色器):逐像素并行计算 —— Rec.601 亮度、9 抽头盒式模糊、Sobel 字口锐度、
 *    形态学 tophat(纸褶/石花响应)、亮异点标志。这些是计算密集、规则统一的像素级操作。
 *  - CPU(readPixels 之后):64×64 单元归约与连通域结构分析(纸褶/石花形状判别),
 *    复用 src/core 的同一套归约公式,保证两条管线 CellStats 数值一致。
 *
 * 大图按 tile(带 halo)分块上传,避免单纹理尺寸限制;全图像素统计在 GPU 完成,
 * 满足 6000×9000 图 3 秒内的性能预算。
 * 要求 EXT_color_buffer_float,缺失时由 ScoringService 降级到纯 CPU。
 */
import type { CellGrid, RgbaImage } from '../core/types';
import { DEFAULT_FEATURE_CONFIG } from '../core/features';
import {
  detectPolarity,
  invertGray,
  otsuThreshold,
  toGray,
} from '../core/imageops';
import { reduceFromPixelFeatures } from './cpuReduce';

export const TILE_SIZE = 2048;
export const HALO = 4;

export function isWebGL2Supported(canvas: HTMLCanvasElement): boolean {
  const gl = canvas.getContext('webgl2');
  return gl !== null && !!gl.getExtension('EXT_color_buffer_float');
}

const VERT = `#version 300 es
layout(location=0) in vec2 a_pos;
out vec2 v_uv;
void main(){ v_uv = a_pos*0.5+0.5; gl_Position = vec4(a_pos,0.0,1.0); }
`;

/**
 * 逐像素特征着色器:一次输出 4 张 R32F 纹理。
 * r=亮度L  g=盒式模糊  b=Sobel幅值  a=tophat响应
 * 第二个 MRT:r=亮异点标志  g=亮异点边界标志
 */
const FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_rgba;
uniform vec2 u_texel;
uniform float u_threshold;
uniform float u_edgeThr;
uniform float u_strongEdgeThr;
uniform float u_brightMargin;
uniform float u_densityThr;
uniform float u_tophatThr;
in vec2 v_uv;
layout(location=0) out vec4 o_a;
layout(location=1) out vec4 o_b;

float lum(vec2 uv){ return dot(texture(u_rgba,uv).rgb, vec3(0.299,0.587,0.114)); }

void main(){
  float L = lum(v_uv);

  // 9x9 盒式模糊(r=4,81 抽头均值),与 CPU boxBlur9 等价
  float blur = 0.0;
  for(int j=-4;j<=4;j++){
    for(int i=-4;i<=4;i++){
      blur += lum(v_uv + vec2(float(i)*u_texel.x, float(j)*u_texel.y));
    }
  }
  blur /= 81.0;

  // Sobel 在模糊亮度上采样(与 CPU sobel(boxBlur9()) 一致)
  float tl=lum(v_uv+u_texel*vec2(-1.,-1.));
  float tc=lum(v_uv+u_texel*vec2(0.,-1.));
  float tr=lum(v_uv+u_texel*vec2(1.,-1.));
  float ml=lum(v_uv+u_texel*vec2(-1.,0.));
  float mr=lum(v_uv+u_texel*vec2(1.,0.));
  float bl=lum(v_uv+u_texel*vec2(-1.,1.));
  float bc=lum(v_uv+u_texel*vec2(0.,1.));
  float br=lum(v_uv+u_texel*vec2(1.,1.));
  float gx=tr+2.*mr+br-tl-2.*ml-bl;
  float gy=bl+2.*bc+br-tl-2.*tc-tr;
  float mag=length(vec2(gx,gy));

  // tophat 亮细线:7x7 局部最小值(与 CPU tophatLines r=3 的腐蚀对应),亮于局部背景即响应
  float localMin = L;
  for(int j=-3;j<=3;j++) for(int i=-3;i<=3;i++){
    localMin = min(localMin, lum(v_uv+vec2(float(i)*u_texel.x,float(j)*u_texel.y)));
  }
  float tophat = max(0.0, L - localMin);

  // 亮异点:亮于阈值 + 局部(模糊)偏暗 + 邻接暗背景
  float bright = (L > u_threshold+u_brightMargin && blur <= u_densityThr) ? 1.0 : 0.0;
  float xl=lum(v_uv+vec2(-u_texel.x,0.));
  float xr=lum(v_uv+vec2(u_texel.x,0.));
  float yu=lum(v_uv+vec2(0.,-u_texel.y));
  float yd=lum(v_uv+vec2(0.,u_texel.y));
  float nearInk = (xl<=u_threshold||xr<=u_threshold||yu<=u_threshold||yd<=u_threshold)?1.0:0.0;

  o_a = vec4(L, blur, mag, tophat);
  o_b = vec4(bright, bright*nearInk, mag>=u_edgeThr?1.0:0.0, mag>=u_strongEdgeThr?1.0:0.0);
}
`;

interface Compiled {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

export class GlScoringEngine {
  private gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private compiled: Compiled;

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.vao = this.createQuad();
    this.compiled = this.compile(VERT, FRAG, [
      'u_rgba', 'u_texel', 'u_threshold', 'u_edgeThr', 'u_strongEdgeThr',
      'u_brightMargin', 'u_densityThr', 'u_tophatThr',
    ]);
  }

  static create(canvas: HTMLCanvasElement): GlScoringEngine | null {
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false });
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
    return new GlScoringEngine(gl);
  }

  private createQuad(): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  private compile(vsSrc: string, fsSrc: string, names: string[]): Compiled {
    const gl = this.gl;
    const shader = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(`着色器编译失败: ${gl.getShaderInfoLog(sh)}`);
      }
      return sh;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`着色器链接失败: ${gl.getProgramInfoLog(program)}`);
    }
    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    for (const n of names) uniforms[n] = gl.getUniformLocation(program, n);
    return { program, uniforms };
  }

  /**
   * 提取单元网格。GPU 逐像素算特征 → readPixels → CPU 单元归约 + 连通域。
   */
  extractCells(img: RgbaImage): {
    grid: CellGrid;
    threshold: number;
    edgeThreshold: number;
    polarityFlipped: boolean;
  } {
    const cfg = DEFAULT_FEATURE_CONFIG;
    const gray0 = toGray(img);
    const polarityFlipped = detectPolarity(gray0);
    const gray = polarityFlipped ? invertGray(gray0) : gray0;
    const threshold = otsuThreshold(gray);
    const edgeThreshold = cfg.edgeThreshold;
    void cfg;

    const { width, height } = img;
    // GPU 输出的全图逐像素特征
    const lum = new Float32Array(width * height);
    const blur = new Float32Array(width * height);
    const mag = new Float32Array(width * height);
    const tophat = new Float32Array(width * height);
    const bright = new Uint8Array(width * height);
    const brightBnd = new Uint8Array(width * height);
    const edge = new Uint8Array(width * height);
    const strong = new Uint8Array(width * height);

    this.runTiles(img, threshold, edgeThreshold, cfg, (px, x, y) => {
      const idx = y * width + x;
      lum[idx] = px[0];
      blur[idx] = px[1];
      mag[idx] = px[2];
      tophat[idx] = px[3];
    }, (px, x, y) => {
      const idx = y * width + x;
      bright[idx] = px[0] > 0.5 ? 1 : 0;
      brightBnd[idx] = px[1] > 0.5 ? 1 : 0;
      edge[idx] = px[2] > 0.5 ? 1 : 0;
      strong[idx] = px[3] > 0.5 ? 1 : 0;
    });

    // CPU 单元归约(与 src/core/features.ts 同公式)+ 连通域结构分析
    const grid = reduceFromPixelFeatures(
      { width, height, data: lum },
      blur, mag, tophat, bright, brightBnd, edge, strong, threshold, cfg,
    );
    return { grid, threshold, edgeThreshold, polarityFlipped };
  }

  /** 分块跑着色器并回读,回调把像素写入全图缓冲 */
  private runTiles(
    img: RgbaImage,
    threshold: number,
    edgeThreshold: number,
    cfg: typeof DEFAULT_FEATURE_CONFIG,
    onA: (px: Float32Array, x: number, y: number) => void,
    onB: (px: Float32Array, x: number, y: number) => void,
  ): void {
    const gl = this.gl;
    const { width, height } = img;
    const tileW = Math.min(TILE_SIZE, width);
    const tileH = Math.min(TILE_SIZE, height);

    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, tileW, tileH);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const outA = this.makeFloatTex(tileW, tileH);
    const outB = this.makeFloatTex(tileW, tileH);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outA, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, outB, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    gl.useProgram(this.compiled.program);
    const u = this.compiled.uniforms;
    gl.uniform1i(u.u_rgba, 0);
    gl.uniform2f(u.u_texel, 1 / tileW, 1 / tileH);
    gl.uniform1f(u.u_threshold, threshold);
    gl.uniform1f(u.u_edgeThr, edgeThreshold);
    gl.uniform1f(u.u_strongEdgeThr, edgeThreshold * 2);
    gl.uniform1f(u.u_brightMargin, cfg.brightMargin);
    gl.uniform1f(u.u_densityThr, threshold - cfg.brightDensityGap);
    gl.uniform1f(u.u_tophatThr, cfg.tophatThreshold);

    const bufA = new Float32Array(tileW * tileH * 4);
    const bufB = new Float32Array(tileW * tileH * 4);

    for (let ty = 0; ty < height; ty += TILE_SIZE) {
      for (let tx = 0; tx < width; tx += TILE_SIZE) {
        const tw = Math.min(TILE_SIZE, width - tx);
        const th = Math.min(TILE_SIZE, height - ty);
        this.uploadSubRect(tex, img, tx, ty, tw, th, tileW, tileH);
        gl.viewport(0, 0, tw, th);
        gl.bindVertexArray(this.vao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);

        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        gl.readPixels(0, 0, tw, th, gl.RGBA, gl.FLOAT, bufA.subarray(0, tw * th * 4));
        gl.readBuffer(gl.COLOR_ATTACHMENT1);
        gl.readPixels(0, 0, tw, th, gl.RGBA, gl.FLOAT, bufB.subarray(0, tw * th * 4));

        // readPixels 原点左下,翻转回左上
        for (let ly = 0; ly < th; ly++) {
          const y = ty + (th - 1 - ly);
          for (let x = 0; x < tw; x++) {
            const li = (ly * tw + x) * 4;
            onA(bufA.subarray(li, li + 4), tx + x, y);
            onB(bufB.subarray(li, li + 4), tx + x, y);
          }
        }
      }
    }
    gl.deleteTexture(tex);
    gl.deleteTexture(outA);
    gl.deleteTexture(outB);
    gl.deleteFramebuffer(fbo);
  }

  private makeFloatTex(w: number, h: number): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private uploadSubRect(
    tex: WebGLTexture, img: RgbaImage,
    x0: number, y0: number, tw: number, th: number,
    texW: number, texH: number,
  ): void {
    const gl = this.gl;
    const canvas = document.createElement('canvas');
    canvas.width = texW;
    canvas.height = texH;
    const ctx = canvas.getContext('2d')!;
    const imageData = ctx.createImageData(tw, th);
    for (let y = 0; y < th; y++) {
      const srcRow = (y0 + y) * img.width * 4 + x0 * 4;
      imageData.data.set(img.data.subarray(srcRow, srcRow + tw * 4), y * tw * 4);
    }
    ctx.putImageData(imageData, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  }

  dispose(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
