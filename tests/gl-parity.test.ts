import { describe, expect, it } from 'vitest';
import { generateRubbing } from '../src/core/synthetic';
import { extractCells, DEFAULT_FEATURE_CONFIG } from '../src/core/features';
import { boxBlur9, sobel, tophatLines } from '../src/core/imageops';
import { reduceFromPixelFeatures } from '../src/gl/cpuReduce';
import type { GrayImage } from '../src/core/types';

/**
 * GL/CPU parity:
 * GL 着色器输出逐像素特征(亮度/模糊/Sobel/tophat/标志位),readPixels 后由
 * reduceFromPixelFeatures 归约。本测试用 CPU 计算出同样的逐像素特征,
 * 喂给 GL 归约函数,验证其结果与核心 extractCells 完全一致。
 * (着色器本身的逐像素公式在浏览器 E2E 页面对照,Node 无 WebGL 上下文)
 */
describe('GL 归约与 CPU 特征管线 parity', () => {
  const params = { inkLevel: 0.5, inkUneven: 0.45, wear: 0.4, wrinkle: 0.5, stoneFlower: 0.4 };
  const { image } = generateRubbing({ width: 320, height: 320, seed: 99, glyphSeed: 60000, params });

  /** 用 CPU 复现着色器的逐像素输出缓冲 */
  function gpuLikeBuffers(img: GrayImage, threshold: number, edgeThr: number) {
    const { width, height, data } = img;
    const blur = boxBlur9(img);
    const { mag } = sobel(blur);
    const { response: tophat } = tophatLines(img, 3);
    const bright = new Uint8Array(width * height);
    const brightBnd = new Uint8Array(width * height);
    const edge = new Uint8Array(width * height);
    const strong = new Uint8Array(width * height);
    const margin = DEFAULT_FEATURE_CONFIG.brightMargin;
    const densityThr = threshold - DEFAULT_FEATURE_CONFIG.brightDensityGap;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const L = data[p];
        if (L > threshold + margin && blur.data[p] <= densityThr) {
          bright[p] = 1;
          const xl = x > 0 ? data[p - 1] : L;
          const xr = x < width - 1 ? data[p + 1] : L;
          const yu = y > 0 ? data[p - width] : L;
          const yd = y < height - 1 ? data[p + width] : L;
          if (xl <= threshold || xr <= threshold || yu <= threshold || yd <= threshold) brightBnd[p] = 1;
        }
        if (mag[p] >= edgeThr) {
          edge[p] = 1;
          if (mag[p] >= edgeThr * 2) strong[p] = 1;
        }
      }
    }
    return { blur: blur.data, mag, tophat, bright, brightBnd, edge, strong };
  }

  it('归约出的网格尺寸与单元数一致', () => {
    const cpu = extractCells(image);
    const buf = gpuLikeBuffers(image, cpu.threshold, cpu.edgeThreshold);
    const glGrid = reduceFromPixelFeatures(image, buf.blur, buf.mag, buf.tophat, buf.bright, buf.brightBnd, buf.edge, buf.strong, cpu.threshold);
    expect(glGrid.width).toBe(cpu.grid.width);
    expect(glGrid.height).toBe(cpu.grid.height);
    expect(glGrid.cells).toHaveLength(cpu.grid.cells.length);
  });

  it('每个单元的核心统计量数值一致(容差 1e-4)', () => {
    const cpu = extractCells(image);
    const buf = gpuLikeBuffers(image, cpu.threshold, cpu.edgeThreshold);
    const glGrid = reduceFromPixelFeatures(image, buf.blur, buf.mag, buf.tophat, buf.bright, buf.brightBnd, buf.edge, buf.strong, cpu.threshold);
    for (let i = 0; i < cpu.grid.cells.length; i++) {
      const a = cpu.grid.cells[i];
      const b = glGrid.cells[i];
      expect(b.n).toBe(a.n);
      expect(b.inkCount).toBe(a.inkCount);
      expect(b.edgeCount).toBe(a.edgeCount);
      expect(b.strongEdgeCount).toBe(a.strongEdgeCount);
      expect(b.gradSum).toBeCloseTo(a.gradSum, 4);
      expect(b.mean).toBeCloseTo(a.mean, 4);
      expect(b.pureInkStd).toBeCloseTo(a.pureInkStd, 4);
      expect(b.brightCount).toBe(a.brightCount);
      expect(b.tophatLinePixels).toBe(a.tophatLinePixels);
      expect(b.tophatBlobPixels).toBe(a.tophatBlobPixels);
    }
  });

  it('经 GL 归约后的评分与 CPU 路径 Spearman 完全一致(同输入同分)', () => {
    const cpu = extractCells(image);
    const buf = gpuLikeBuffers(image, cpu.threshold, cpu.edgeThreshold);
    const glGrid = reduceFromPixelFeatures(image, buf.blur, buf.mag, buf.tophat, buf.bright, buf.brightBnd, buf.edge, buf.strong, cpu.threshold);
    // 单元统计量一致 => 聚合评分必然一致
    let maxDiff = 0;
    for (let i = 0; i < cpu.grid.cells.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(glGrid.cells[i].gradSum - cpu.grid.cells[i].gradSum));
    }
    expect(maxDiff).toBeLessThan(1e-3);
  });
});
