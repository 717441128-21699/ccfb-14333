/**
 * 合成拓片生成器。
 *
 * 模拟白底墨拓(暗底亮字)的成像过程,四类退化各有独立、可控的参数通道:
 *   inkUneven   墨色不匀 —— 缓变墨层 + 局部墨团
 *   wear        字口磨损 —— 笔画局部柔化 + 边缘缺口 + 淡笔
 *   wrinkle     纸褶     —— 细长弯曲的亮/暗带
 *   stoneFlower 石花     —— 墨区内随机亮斑(不规则颗粒/片状)
 * inkLevel 是风格项(蝉翼拓↔乌金拓),只改整体墨色浓淡,不应影响质量分。
 *
 * 输出为浮点灰度图(0 墨底,1 字/纸),确定性可复现(种子驱动)。
 */
import type { DegradationParams, GrayImage, RubricKey } from './types';
import { mulberry32, randInt, uniform, valueNoise1D, valueNoise2D } from './rng';
import { boxBlur } from './imageops';

export interface SyntheticOptions {
  width: number;
  height: number;
  /** 退化随机种子(墨团/石花/褶子位置等) */
  seed: number;
  /**
   * 字形种子。同一块碑的多张拓本应传同一个 glyphSeed,
   * 这样拓本之间只有拓制质量差异,字形布局完全一致 —— 与真实拓制场景对应。
   * 默认与 seed 相同。
   */
  glyphSeed?: number;
  params: DegradationParams;
  /** 文字栅格列数/行数,默认按尺寸推算 */
  cols?: number;
  rows?: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 伪笔画:在网格单元内生成 1~3 个矩形笔画(横竖为主,少量点) */
function rasterizeGlyphs(
  width: number,
  height: number,
  cols: number,
  rows: number,
  rand: () => number,
): Float32Array {
  const glyph = new Float32Array(width * height);
  const cw = width / cols;
  const ch = height / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // 留少量空格,模拟碑面残字
      if (rand() < 0.08) continue;
      const x0 = c * cw;
      const y0 = r * ch;
      const strokes = randInt(rand, 1, 3);
      for (let s = 0; s < strokes; s++) {
        const vertical = rand() < 0.55;
        const sw = cw * uniform(rand, 0.08, 0.14); // 笔画宽度
        if (vertical) {
          const sx = x0 + cw * uniform(rand, 0.2, 0.7);
          const sy = y0 + ch * uniform(rand, 0.12, 0.25);
          const sh = ch * uniform(rand, 0.5, 0.78);
          fillRect(glyph, width, height, sx, sy, sw, sh);
        } else {
          const sx = x0 + cw * uniform(rand, 0.12, 0.25);
          const sy = y0 + ch * uniform(rand, 0.2, 0.75);
          const swW = cw * uniform(rand, 0.5, 0.78);
          fillRect(glyph, width, height, sx, sy, swW, sw);
        }
      }
    }
  }
  return glyph;
}

function fillRect(
  buf: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(width, Math.round(x + w));
  const y1 = Math.min(height, Math.round(y + h));
  for (let yy = y0; yy < y1; yy++) {
    const row = yy * width;
    for (let xx = x0; xx < x1; xx++) buf[row + xx] = 1;
  }
}

/** 字口磨损:随机选一些笔画区域做柔化与断口,wear 控制作用比例与强度 */
function applyWear(
  glyph: Float32Array,
  width: number,
  height: number,
  wear: number,
  rand: () => number,
): Float32Array {
  if (wear <= 0.001) return glyph;
  // 全局柔化:半径随 wear 从 1 增到 6,使 Sobel 幅值连续、单调下降,
  // 且柔化主导梯度,弱化字形布局本身带来的锐度差异
  const radius = Math.round(1 + wear * 5);
  let out = boxBlur({ width, height, data: glyph }, radius).data;

  // 边缘对比度衰减:磨损让字口变浅,进一步压低梯度,强化单调
  if (wear > 0.05) {
    const k = Math.min(0.82, wear * 0.82);
    for (let i = 0; i < out.length; i++) {
      out[i] = out[i] * (1 - k * (1 - out[i]));
    }
  }

  // 边缘缺口:随机小方块把笔画抹掉一部分
  const nibbles = Math.round(wear * 120);
  for (let i = 0; i < nibbles; i++) {
    const nx = randInt(rand, 0, width - 1);
    const ny = randInt(rand, 0, height - 1);
    const nw = randInt(rand, 2, 4 + Math.round(wear * 6));
    const nh = randInt(rand, 2, 4 + Math.round(wear * 6));
    for (let y = ny; y < Math.min(height, ny + nh); y++) {
      for (let x = nx; x < Math.min(width, nx + nw); x++) {
        const p = y * width + x;
        if (glyph[p] > 0) out[p] *= uniform(rand, 0.15, 0.6);
      }
    }
  }

  // 淡笔:随机区域整体压低笔画亮度
  const faded = Math.round(wear * 12);
  for (let i = 0; i < faded; i++) {
    const fx = randInt(rand, 0, width - 1);
    const fy = randInt(rand, 0, height - 1);
    const fw = randInt(rand, 20, 80);
    const fh = randInt(rand, 20, 80);
    const k = uniform(rand, 0.35, 0.75);
    for (let y = fy; y < Math.min(height, fy + fh); y++) {
      for (let x = fx; x < Math.min(width, fx + fw); x++) {
        const p = y * width + x;
        if (out[p] > 0.2) out[p] *= k;
      }
    }
  }
  return out;
}

/** 墨色不匀:低频缓变场 + 少量局部墨团 */
function inkUnevenField(
  width: number,
  height: number,
  amount: number,
  rand: () => number,
): Float32Array {
  const field = valueNoise2D(rand, width, height, Math.max(3, Math.round(width / 260)), Math.max(3, Math.round(height / 260)));
  // 中心到 0,范围约 [-1,1]
  for (let i = 0; i < field.length; i++) field[i] = (field[i] - 0.5) * 2;
  // 墨团:若干高斯状暗块
  const blobs = Math.round(amount * 10);
  for (let b = 0; b < blobs; b++) {
    const cx = rand() * width;
    const cy = rand() * height;
    const sigma = uniform(rand, Math.min(width, height) * 0.05, Math.min(width, height) * 0.18);
    const strength = uniform(rand, -0.8, -0.3) * amount;
    const r2 = (3 * sigma) ** 2;
    const x0 = Math.max(0, Math.floor(cx - 3 * sigma));
    const x1 = Math.min(width, Math.ceil(cx + 3 * sigma));
    const y0 = Math.max(0, Math.floor(cy - 3 * sigma));
    const y1 = Math.min(height, Math.ceil(cy + 3 * sigma));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        field[y * width + x] += strength * Math.exp(-d2 / (2 * sigma * sigma));
      }
    }
  }
  for (let i = 0; i < field.length; i++) field[i] *= amount;
  // 转为以 1 为中心的乘性系数(范围约 [1-amount, 1+amount]),
  // 墨色不均匀作为"墨层厚度的相对起伏",与绝对浓淡解耦
  for (let i = 0; i < field.length; i++) field[i] = 1 + field[i];
  return field;
}

/** 纸褶:细长弯曲的明暗双线带 */
function applyWrinkles(
  img: Float32Array,
  width: number,
  height: number,
  amount: number,
  rand: () => number,
): void {
  if (amount <= 0.001) return;
  const count = Math.round(1 + amount * 7);
  for (let w = 0; w < count; w++) {
    // 随机起点与走向,以斜向/纵向为主
    const horizontal = rand() < 0.35;
    const pathLen = horizontal ? width : height;
    const cross = horizontal ? height : width;
    const base = rand() * cross;
    const amp = uniform(rand, 6, 26) * (0.5 + amount);
    const phase = rand() * Math.PI * 2;
    const freq = uniform(rand, 1, 3);
    const widthPx = uniform(rand, 2, 4 + amount * 5);
    const strength = uniform(rand, 0.12, 0.3) * (0.4 + amount);
    const line = valueNoise1D(rand, pathLen, 2);
    for (let t = 0; t < pathLen; t++) {
      const center = base + Math.sin((t / pathLen) * Math.PI * 2 * freq + phase) * amp + (line[t] - 0.5) * amp;
      // 褶子截面:一侧亮线一侧暗线
      for (let off = -Math.ceil(widthPx * 2); off <= Math.ceil(widthPx * 2); off++) {
        const crossPos = Math.round(center + off);
        if (crossPos < 0 || crossPos >= cross) continue;
        const x = horizontal ? t : crossPos;
        const y = horizontal ? crossPos : t;
        const p = y * width + x;
        const profile =
          (off <= 0 ? 1 : -1) * Math.exp(-(off * off) / (2 * widthPx * widthPx)) * strength;
        img[p] = clamp01(img[p] + profile);
      }
    }
  }
}

/** 石花:墨区内的亮颗粒与不规则亮片 */
function applyStoneFlowers(
  img: Float32Array,
  width: number,
  height: number,
  glyph: Float32Array,
  amount: number,
  rand: () => number,
): void {
  if (amount <= 0.001) return;
  const specks = Math.round(amount * 900);
  for (let i = 0; i < specks; i++) {
    const x = randInt(rand, 0, width - 1);
    const y = randInt(rand, 0, height - 1);
    const p = y * width + x;
    if (glyph[p] > 0.3) continue; // 不落在笔画上
    const r = rand() < 0.85 ? uniform(rand, 0.8, 1.8) : uniform(rand, 2.5, 5 + amount * 6);
    const val = uniform(rand, 0.35, 0.9);
    stamp(img, width, height, x, y, r, val);
  }
  // 少量片状剥落
  const flakes = Math.round(amount * 14);
  for (let i = 0; i < flakes; i++) {
    const cx = randInt(rand, 0, width - 1);
    const cy = randInt(rand, 0, height - 1);
    const rx = uniform(rand, 6, 16 + amount * 22);
    const ry = uniform(rand, 5, 12 + amount * 16);
    for (let y = Math.max(0, cy - Math.ceil(ry)); y <= Math.min(height - 1, cy + Math.ceil(ry)); y++) {
      for (let x = Math.max(0, cx - Math.ceil(rx)); x <= Math.min(width - 1, cx + Math.ceil(rx)); x++) {
        const p = y * width + x;
        if (glyph[p] > 0.3) continue;
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        const d = nx * nx + ny * ny + uniform(rand, -0.15, 0.15);
        if (d < 1) img[p] = clamp01(Math.max(img[p], uniform(rand, 0.3, 0.75) * (1.1 - d)));
      }
    }
  }
}

function stamp(
  buf: Float32Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  r: number,
  val: number,
): void {
  for (let y = Math.max(0, cy - Math.ceil(r)); y <= Math.min(height - 1, cy + Math.ceil(r)); y++) {
    for (let x = Math.max(0, cx - Math.ceil(r)); x <= Math.min(width - 1, cx + Math.ceil(r)); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r) {
        const p = y * width + x;
        const k = 1 - d / (r + 0.5);
        buf[p] = clamp01(Math.max(buf[p], val * k));
      }
    }
  }
}

/**
 * 生成一张合成拓片。
 * @returns 灰度图 + 实际使用的参数(含被钳制/默认补齐的值)
 */
export function generateRubbing(opts: SyntheticOptions): { image: GrayImage; params: DegradationParams } {
  const { width, height, seed } = opts;
  const params: DegradationParams = {
    inkLevel: clamp01(opts.params.inkLevel),
    inkUneven: clamp01(opts.params.inkUneven),
    wear: clamp01(opts.params.wear),
    wrinkle: clamp01(opts.params.wrinkle),
    stoneFlower: clamp01(opts.params.stoneFlower),
  };
  const rand = mulberry32(seed);
  // 字形随机流独立:同 glyphSeed 的拓本字形完全一致,只有退化不同
  const glyphRand = mulberry32(opts.glyphSeed ?? seed);
  const cols = opts.cols ?? Math.max(4, Math.round(width / 90));
  const rows = opts.rows ?? Math.max(5, Math.round(height / 110));

  // 1. 文字骨架(字形流)+ 磨损(退化流,作用在固定字形上)
  let glyph = rasterizeGlyphs(width, height, cols, rows, glyphRand);
  glyph = applyWear(glyph, width, height, params.wear, rand);

  // 2. 墨底:inkLevel 决定浓淡。淡墨底亮(~0.42),浓墨底暗(~0.06)
  const baseInk = 0.42 - params.inkLevel * 0.36;
  const img = new Float32Array(width * height);
  for (let i = 0; i < img.length; i++) img[i] = baseInk;

  // 3. 墨色不匀场(只作用于墨底,笔画保持亮)
  const uneven = inkUnevenField(width, height, params.inkUneven, rand);

  // 4. 合成。两层解耦:
  //    墨底 = baseInk × uneven(乘性不均匀,相对起伏与浓淡无关);
  //    笔画在墨底上加恒定反差 glyphContrast(与 inkLevel 无关,保证字口梯度不受浓淡影响)。
  //    磨损通过降低笔画增益减小反差,直接削弱梯度。
  const glyphContrast = 0.62 - params.wear * 0.3;
  for (let i = 0; i < img.length; i++) {
    const g = glyph[i];
    const inkLocal = baseInk * uneven[i] * (1 - g * 0.85) + baseInk * g * 0.85;
    img[i] = inkLocal + g * glyphContrast;
  }

  // 5. 纸褶(对全图作用)
  applyWrinkles(img, width, height, params.wrinkle, rand);

  // 6. 石花(落在墨区)
  applyStoneFlowers(img, width, height, glyph, params.stoneFlower, rand);

  // 7. 纸张/拓制颗粒噪声(小幅,所有图都有,模拟真实采集噪声)
  const grainRand = mulberry32(seed ^ 0x9e3779b9);
  const grainAmp = 0.018;
  for (let i = 0; i < img.length; i++) {
    img[i] = clamp01(img[i] + (grainRand() - 0.5) * 2 * grainAmp);
  }

  return { image: { width, height, data: img }, params };
}

/** 参考评分:由退化参数直接给出 0..100 的分项与综合分(无噪声、单调) */
export function referenceScore(params: DegradationParams): {
  overall: number;
  rubrics: Record<RubricKey, number>;
} {
  const rubric = (d: number): number => Math.round(100 * (1 - d) * 10) / 10;
  const rubrics = {
    ink: rubric(params.inkUneven),
    sharpness: rubric(params.wear),
    flatness: rubric(params.wrinkle),
    flower: rubric(params.stoneFlower),
  };
  const weights = { ink: 0.3, sharpness: 0.35, flatness: 0.15, flower: 0.2 };
  const overall =
    rubrics.ink * weights.ink +
    rubrics.sharpness * weights.sharpness +
    rubrics.flatness * weights.flatness +
    rubrics.flower * weights.flower;
  return { overall: Math.round(overall * 10) / 10, rubrics };
}
