/**
 * 图像基础算子。CPU 参考实现与 GLSL 着色器使用完全相同的数学定义,
 * tests/gl-paracy 用本文件的结果作为对照基准。
 */
import type { GrayImage, RgbaImage } from './types';

/** Rec.601 亮度,与 GLSL 中的 dot(rgb, vec3(0.299,0.587,0.114)) 一致 */
export function toGray(img: RgbaImage): GrayImage {
  const { width, height, data } = img;
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    out[p] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
  }
  return { width, height, data: out };
}

export function grayToRgba(img: GrayImage): RgbaImage {
  const data = new Uint8ClampedArray(img.width * img.height * 4);
  for (let p = 0, i = 0; p < img.data.length; p++, i += 4) {
    const v = Math.round(Math.min(1, Math.max(0, img.data[p])) * 255);
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data };
}

/**
 * 可分离盒式模糊(半径 r,窗口 2r+1),边界 clamp 采样。
 * 与 GLSL 的 9-tap 固定半径模糊不同:本函数用于合成器磨损,
 * 特征管线里的模糊见 boxBlur9(r=4,9 抽头),两者刻意区分。
 */
export function boxBlur(img: GrayImage, radius: number): GrayImage {
  if (radius <= 0) return { width: img.width, height: img.height, data: img.data.slice() };
  const { width, height, data } = img;
  const tmp = new Float32Array(width * height);
  const out = new Float32Array(width * height);
  const win = 2 * radius + 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let acc = 0;
    for (let x = -radius; x <= radius; x++) {
      acc += data[row + Math.min(width - 1, Math.max(0, x))];
    }
    for (let x = 0; x < width; x++) {
      tmp[row + x] = acc / win;
      const xAdd = Math.min(width - 1, x + radius + 1);
      const xSub = Math.max(0, x - radius);
      acc += data[row + xAdd] - data[row + xSub];
    }
  }
  for (let x = 0; x < width; x++) {
    let acc = 0;
    for (let y = -radius; y <= radius; y++) {
      acc += tmp[Math.min(height - 1, Math.max(0, y)) * width + x];
    }
    for (let y = 0; y < height; y++) {
      out[y * width + x] = acc / win;
      const yAdd = Math.min(height - 1, y + radius + 1);
      const ySub = Math.max(0, y - radius);
      acc += tmp[yAdd * width + x] - tmp[ySub * width + x];
    }
  }
  return { width, height, data: out };
}

/** 9 抽头盒式模糊(r=4),与 GLSL blur9 完全对应 */
export function boxBlur9(img: GrayImage): GrayImage {
  return boxBlur(img, 4);
}

export interface SobelResult {
  mag: Float32Array;
  gx: Float32Array;
  gy: Float32Array;
}

/** Sobel 梯度,边界 clamp,与 GLSL sobel 一一对应 */
export function sobel(img: GrayImage): SobelResult {
  const { width, height, data } = img;
  const mag = new Float32Array(width * height);
  const gx = new Float32Array(width * height);
  const gy = new Float32Array(width * height);
  const at = (x: number, y: number): number =>
    data[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tl = at(x - 1, y - 1);
      const tc = at(x, y - 1);
      const tr = at(x + 1, y - 1);
      const ml = at(x - 1, y);
      const mr = at(x + 1, y);
      const bl = at(x - 1, y + 1);
      const bc = at(x, y + 1);
      const br = at(x + 1, y + 1);
      const sx = tr + 2 * mr + br - tl - 2 * ml - bl;
      const sy = bl + 2 * bc + br - tl - 2 * tc - tr;
      const p = y * width + x;
      gx[p] = sx;
      gy[p] = sy;
      mag[p] = Math.hypot(sx, sy);
    }
  }
  return { mag, gx, gy };
}

/**
 * Otsu 阈值(输入亮度图,输出 [0,1] 阈值)。
 * 为控制大图开销,先面积平均降采样到 maxDim=512 再统计直方图(256 bin)。
 * GL 管线与 CPU 管线共享本函数的结果,因此两条路径阈值必然一致。
 */
export function otsuThreshold(img: GrayImage, maxDim = 512): number {
  const small = areaDownsample(img, maxDim);
  const bins = 256;
  const hist = new Float64Array(bins);
  for (let i = 0; i < small.data.length; i++) {
    const b = Math.min(bins - 1, Math.max(0, Math.round(small.data[i] * (bins - 1))));
    hist[b]++;
  }
  const total = small.data.length;
  let sum = 0;
  for (let b = 0; b < bins; b++) sum += b * hist[b];
  let wB = 0;
  let sumB = 0;
  let bestVar = -1;
  let bestT = 128;
  for (let t = 0; t < bins; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      // 阈值取两类中心的中点,落在类间空隙里,而不是暗类上沿
      bestT = Math.round((mB + mF) / 2);
    }
  }
  return bestT / (bins - 1);
}

/** 面积平均降采样:目标最长边 <= maxDim,等比缩放 */
export function areaDownsample(img: GrayImage, maxDim: number): GrayImage {
  const { width, height, data } = img;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  if (scale >= 1) return { width, height, data: data.slice() };
  const nw = Math.max(1, Math.round(width * scale));
  const nh = Math.max(1, Math.round(height * scale));
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy0 = Math.floor((y / nh) * height);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) / nh) * height));
    for (let x = 0; x < nw; x++) {
      const sx0 = Math.floor((x / nw) * width);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) / nw) * width));
      let acc = 0;
      let cnt = 0;
      for (let yy = sy0; yy < sy1; yy++) {
        const row = yy * width;
        for (let xx = sx0; xx < sx1; xx++) {
          acc += data[row + xx];
          cnt++;
        }
      }
      out[y * nw + x] = acc / cnt;
    }
  }
  return { width: nw, height: nh, data: out };
}

/**
 * 极性检测:拓片标准约定是暗底亮字(墨区占多数,均值偏暗)。
 * 若亮像素(>0.5)占比超过一半,判定为白底扫描件/反相图,需要反相。
 * 用占比而非均值,可避免亮笔画拉偏均值导致误判。
 */
export function detectPolarity(img: GrayImage): boolean {
  let bright = 0;
  for (let i = 0; i < img.data.length; i++) {
    if (img.data[i] > 0.5) bright++;
  }
  return bright / img.data.length > 0.5;
}

export function invertGray(img: GrayImage): GrayImage {
  const out = new Float32Array(img.data.length);
  for (let i = 0; i < out.length; i++) out[i] = 1 - img.data[i];
  return { width: img.width, height: img.height, data: out };
}

/* ------------------------------------------------------------------ */
/* 形态学 top-hat:提取比结构元窄的亮细线(纸褶)                         */
/* tophat = 原图 - 灰度开运算(先腐蚀后膨胀),黑帽结构元为两条正交线段    */
/* GLSL 中用同半径的两趟 min/max 窗口实现,公式与本函数一致              */
/* ------------------------------------------------------------------ */

/** 水平方向窗口最小值(腐蚀),边界 clamp */
function erodeLineH(data: Float32Array, width: number, height: number, radius: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let m = Infinity;
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.min(width - 1, Math.max(0, x + k));
        const v = data[row + xx];
        if (v < m) m = v;
      }
      out[row + x] = m;
    }
  }
  return out;
}

/** 水平方向窗口最大值(膨胀),边界 clamp */
function dilateLineH(data: Float32Array, width: number, height: number, radius: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let m = -Infinity;
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.min(width - 1, Math.max(0, x + k));
        const v = data[row + xx];
        if (v > m) m = v;
      }
      out[row + x] = m;
    }
  }
  return out;
}

/** 垂直方向窗口最小值(腐蚀),边界 clamp */
function erodeLineV(data: Float32Array, width: number, height: number, radius: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let m = Infinity;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(height - 1, Math.max(0, y + k));
        const v = data[yy * width + x];
        if (v < m) m = v;
      }
      out[y * width + x] = m;
    }
  }
  return out;
}

/** 垂直方向窗口最大值(膨胀),边界 clamp */
function dilateLineV(data: Float32Array, width: number, height: number, radius: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let m = -Infinity;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(height - 1, Math.max(0, y + k));
        const v = data[yy * width + x];
        if (v > m) m = v;
      }
      out[y * width + x] = m;
    }
  }
  return out;
}

export interface TophatResult {
  /** top-hat 响应图,>= 0 */
  response: Float32Array;
  width: number;
  height: number;
}

/**
 * 亮细线 top-hat:分别用水平、垂直线结构元做开运算,取两路响应的最大值。
 * 褶子是细长亮带(宽度 2~5px),radius=3 可覆盖;石花为近圆颗粒/宽片,
 * 在线结构元开运算后响应弱,从而与纸褶区分。
 */
export function tophatLines(img: GrayImage, radius = 3): TophatResult {
  const { width, height, data } = img;
  // 水平结构元开运算:水平腐蚀 → 水平膨胀
  const eh = erodeLineH(data, width, height, radius);
  const oh = dilateLineH(eh, width, height, radius);
  // 垂直结构元开运算
  const ev = erodeLineV(data, width, height, radius);
  const ov = dilateLineV(ev, width, height, radius);

  const response = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) {
    // 两路开运算取较亮者(更保守的背景),tophat = 原图 - 背景
    const opening = Math.max(oh[i], ov[i]);
    response[i] = Math.max(0, data[i] - opening);
  }
  return { response, width, height };
}

/** top-hat 响应阈值:超过该值进入纸褶连通域分析(取低值以保留弱褶,形状再筛) */
export const TOPHAT_THRESHOLD = 0.03;
