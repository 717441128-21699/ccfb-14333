import { describe, expect, it } from 'vitest';
import { generateRubbing } from '../src/core/synthetic';
import { extractCells, CELL_SIZE } from '../src/core/features';
import { otsuThreshold, sobel, boxBlur9, detectPolarity, invertGray, toGray } from '../src/core/imageops';
import type { GrayImage, RgbaImage } from '../src/core/types';

const ZERO = { inkLevel: 0.5, inkUneven: 0, wear: 0, wrinkle: 0, stoneFlower: 0 };

describe('预处理与基础算子', () => {
  it('Otsu 在双峰图上给出两类之间的阈值', () => {
    const w = 256;
    const data = new Float32Array(w * w);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) data[y * w + x] = x < w / 2 ? 0.1 : 0.9;
    }
    const t = otsuThreshold({ width: w, height: w, data });
    expect(t).toBeGreaterThan(0.3);
    expect(t).toBeLessThan(0.7);
  });

  it('盒式模糊保持亮度均值近似不变且降低方差', () => {
    const { image } = generateRubbing({ width: 128, height: 128, seed: 3, params: { ...ZERO, stoneFlower: 0.6 } });
    const blurred = boxBlur9(image);
    const mean = (a: Float32Array): number => a.reduce((s, v) => s + v, 0) / a.length;
    const variance = (a: Float32Array): number => {
      const m = mean(a);
      return a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length;
    };
    expect(Math.abs(mean(blurred.data) - mean(image.data))).toBeLessThan(0.02);
    expect(variance(blurred.data)).toBeLessThan(variance(image.data));
  });

  it('Sobel 在垂直亮边上产生强水平梯度', () => {
    const w = 64;
    const data = new Float32Array(w * w);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) data[y * w + x] = x < 32 ? 0.1 : 0.9;
    const { mag, gx } = sobel({ width: w, height: w, data });
    const edgeIdx = 32 * w + 32;
    expect(Math.abs(gx[edgeIdx])).toBeGreaterThan(1);
    expect(mag[edgeIdx]).toBeGreaterThan(1);
  });

  it('极性检测与反相互逆', () => {
    const { image } = generateRubbing({ width: 96, height: 96, seed: 4, params: ZERO });
    expect(detectPolarity(image)).toBe(false);
    const flipped = invertGray(image);
    expect(detectPolarity(flipped)).toBe(true);
  });

  it('反相图评分预处理后阈值与原图互补', () => {
    const { image } = generateRubbing({ width: 160, height: 160, seed: 5, params: ZERO });
    const a = extractCells(image);
    const b = extractCells(invertGray(image));
    expect(b.polarityFlipped).toBe(true);
    // 反相后 Otsu 中点估计存在直方图离散化误差,容差 0.12
    expect(Math.abs(a.threshold - (1 - b.threshold))).toBeLessThan(0.12);
  });
});

describe('单元特征提取', () => {
  it('网格尺寸与单元统计结构正确', () => {
    const { image } = generateRubbing({ width: 300, height: 200, seed: 6, params: { ...ZERO, wear: 0.5 } });
    const { grid } = extractCells(image);
    expect(grid.width).toBe(Math.ceil(300 / CELL_SIZE));
    expect(grid.height).toBe(Math.ceil(200 / CELL_SIZE));
    expect(grid.cells).toHaveLength(grid.width * grid.height);
    for (const c of grid.cells) {
      expect(c.n).toBeGreaterThan(0);
      expect(c.variance).toBeGreaterThanOrEqual(0);
      expect(c.inkVar).toBeGreaterThanOrEqual(0);
      expect(c.orient).toHaveLength(4);
    }
  });

  it('同图结果确定可复现', () => {
    const { image } = generateRubbing({ width: 256, height: 256, seed: 8, params: { ...ZERO, wrinkle: 0.7 } });
    const a = extractCells(image);
    const b = extractCells(image);
    expect(a.grid.cells.map((c) => c.inkVar)).toEqual(b.grid.cells.map((c) => c.inkVar));
    expect(a.threshold).toBe(b.threshold);
  });

  it('石花增多时亮异点统计上升', () => {
    const clean = generateRubbing({ width: 320, height: 320, seed: 10, params: ZERO });
    const dirty = generateRubbing({ width: 320, height: 320, seed: 10, params: { ...ZERO, stoneFlower: 0.9 } });
    const sumBright = (img: GrayImage): number =>
      extractCells(img).grid.cells.reduce((s, c) => s + c.brightCount, 0);
    expect(sumBright(dirty.image)).toBeGreaterThan(sumBright(clean.image) * 1.5);
  });

  it('toGray 与 Rec.601 系数一致', () => {
    const rgba: RgbaImage = {
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([255, 0, 0, 255]),
    };
    const g = toGray(rgba);
    expect(g.data[0]).toBeCloseTo(0.299, 3);
  });
});
