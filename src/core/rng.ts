/**
 * 确定性随机工具:合成拓片需要可复现,测试与校准依赖固定种子。
 */

/** mulberry32 —— 小而快的确定性 PRNG,返回 [0,1) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 任意区间均匀分布 */
export function uniform(rand: () => number, min: number, max: number): number {
  return min + rand() * (max - min);
}

/** 整型区间 [min, max] */
export function randInt(rand: () => number, min: number, max: number): number {
  return Math.floor(uniform(rand, min, max + 1));
}

/** 折线上的一维值噪声,两端钳制;用于墨色缓变场 */
export function valueNoise1D(rand: () => number, length: number, octaves: number): Float32Array {
  const out = new Float32Array(length);
  let ampSum = 0;
  let amp = 1;
  for (let o = 0; o < octaves; o++) {
    const gridSize = Math.max(2, Math.round(length / (90 * 2 ** o)));
    const grid = new Float32Array(gridSize + 1);
    for (let i = 0; i < grid.length; i++) grid[i] = rand();
    for (let x = 0; x < length; x++) {
      const gx = (x / length) * gridSize;
      const i0 = Math.min(gridSize, Math.floor(gx));
      const t = gx - i0;
      const s = t * t * (3 - 2 * t);
      out[x] += amp * (grid[i0] * (1 - s) + grid[i0 + 1] * s);
    }
    ampSum += amp;
    amp *= 0.5;
  }
  for (let x = 0; x < length; x++) out[x] /= ampSum;
  return out;
}

/** 二维值噪声(双线性),输出 [0,1] */
export function valueNoise2D(
  rand: () => number,
  width: number,
  height: number,
  gridW: number,
  gridH: number,
): Float32Array {
  const grid = new Float32Array((gridW + 1) * (gridH + 1));
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const gy = (y / Math.max(1, height - 1)) * gridH;
    const j0 = Math.min(gridH - 1, Math.floor(gy));
    const j1 = Math.min(gridH, j0 + 1);
    const ty = gy - j0;
    const sy = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < width; x++) {
      const gx = (x / Math.max(1, width - 1)) * gridW;
      const i0 = Math.min(gridW - 1, Math.floor(gx));
      const i1 = Math.min(gridW, i0 + 1);
      const tx = gx - i0;
      const sx = tx * tx * (3 - 2 * tx);
      const v00 = grid[j0 * (gridW + 1) + i0];
      const v10 = grid[j0 * (gridW + 1) + i1];
      const v01 = grid[j1 * (gridW + 1) + i0];
      const v11 = grid[j1 * (gridW + 1) + i1];
      const top = v00 * (1 - sx) + v10 * sx;
      const bot = v01 * (1 - sx) + v11 * sx;
      out[y * width + x] = top * (1 - sy) + bot * sy;
    }
  }
  return out;
}
