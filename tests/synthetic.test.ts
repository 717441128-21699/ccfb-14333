import { describe, expect, it } from 'vitest';
import { generateRubbing, referenceScore } from '../src/core/synthetic';
import { extractCells } from '../src/core/features';
import { aggregateRawSeverity } from '../src/core/scorer';
import type { DegradationParams, RubricKey } from '../src/core/types';

const SIZE = 384;

/** 全图级原始严重度(与线上评分、校准同口径) */
function medians(params: DegradationParams, seed = 7): Record<RubricKey, number> {
  const { image } = generateRubbing({ width: SIZE, height: SIZE, seed, glyphSeed: 60000, params });
  const { grid } = extractCells(image);
  return {
    ink: aggregateRawSeverity(grid, 'ink'),
    sharpness: aggregateRawSeverity(grid, 'sharpness'),
    flatness: aggregateRawSeverity(grid, 'flatness'),
    flower: aggregateRawSeverity(grid, 'flower'),
  };
}

const ZERO: DegradationParams = { inkLevel: 0.5, inkUneven: 0, wear: 0, wrinkle: 0, stoneFlower: 0 };

describe('合成拓片生成器', () => {
  it('同种子完全可复现', () => {
    const a = generateRubbing({ width: 128, height: 128, seed: 123, params: ZERO });
    const b = generateRubbing({ width: 128, height: 128, seed: 123, params: ZERO });
    expect(a.image.data).toEqual(b.image.data);
  });

  it('输出范围落在 [0,1]', () => {
    const { image } = generateRubbing({ width: 128, height: 128, seed: 1, params: { ...ZERO, stoneFlower: 1 } });
    for (const v of image.data) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('墨色浓淡改变整体亮度但不改变排序信号(风格项)', () => {
    const light = generateRubbing({ width: SIZE, height: SIZE, seed: 9, params: { ...ZERO, inkLevel: 0 } });
    const dark = generateRubbing({ width: SIZE, height: SIZE, seed: 9, params: { ...ZERO, inkLevel: 1 } });
    const meanLight = avg(light.image.data);
    const meanDark = avg(dark.image.data);
    expect(meanLight).toBeGreaterThan(meanDark);
  });

  it.each([
    ['inkUneven', 'ink'] as const,
    ['wear', 'sharpness'] as const,
    ['wrinkle', 'flatness'] as const,
    ['stoneFlower', 'flower'] as const,
  ])('退化 %s 增强时对应原始严重度整体上升', (param, rubric) => {
    const low = medians({ ...ZERO, [param]: 0.15 });
    const high = medians({ ...ZERO, [param]: 0.9 });
    expect(high[rubric]).toBeGreaterThan(low[rubric]);
  });

  it('单项退化主要拉动对应分项,不显著拉动无关分项(通道独立性)', () => {
    const base = medians(ZERO);
    const worn = medians({ ...ZERO, wear: 0.95 });
    // 字口磨损对 sharpness 的拉动应明显大于对 flower 的拉动
    expect(worn.sharpness - base.sharpness).toBeGreaterThan(worn.flower - base.flower);
    const flowery = medians({ ...ZERO, stoneFlower: 0.95 });
    expect(flowery.flower - base.flower).toBeGreaterThan(flowery.sharpness - base.sharpness);
  });
});

describe('参考分', () => {
  it('无退化满分、满退化接近 0 分', () => {
    const good = referenceScore(ZERO);
    expect(good.overall).toBe(100);
    const bad = referenceScore({ inkLevel: 0.5, inkUneven: 1, wear: 1, wrinkle: 1, stoneFlower: 1 });
    expect(bad.overall).toBe(0);
  });

  it('对退化参数单调', () => {
    const r1 = referenceScore({ ...ZERO, wear: 0.3 });
    const r2 = referenceScore({ ...ZERO, wear: 0.8 });
    expect(r2.rubrics.sharpness).toBeLessThan(r1.rubrics.sharpness);
  });
});

function avg(a: Float32Array): number {
  return a.reduce((s, v) => s + v, 0) / a.length;
}
