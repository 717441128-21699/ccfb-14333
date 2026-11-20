import { describe, expect, it } from 'vitest';
import { spearman, groupByStele, scoreDistribution, craftsmanYearStats, mean, median } from '../src/core/stats';
import type { ScoreResult } from '../src/core/types';

describe('spearman', () => {
  it('完全正相关返回 1', () => {
    expect(spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50])).toBeCloseTo(1, 10);
  });

  it('完全负相关返回 -1', () => {
    expect(spearman([1, 2, 3, 4, 5], [50, 40, 30, 20, 10])).toBeCloseTo(-1, 10);
  });

  it('并列值取平均秩后仍正确', () => {
    // [10,10,30,40] 的秩为 [1.5,1.5,3,4]
    const rho = spearman([1, 2, 3, 4], [10, 10, 30, 40]);
    expect(rho).toBeGreaterThan(0.9);
  });

  it('常数列返回 0 而不是 NaN', () => {
    expect(spearman([1, 1, 1, 1], [1, 2, 3, 4])).toBe(0);
  });

  it('长度不一致抛错', () => {
    expect(() => spearman([1, 2], [1])).toThrow();
  });
});

function fakeResult(id: string, steleId: string, overall: number, craftsman = '张拓', year = 2020): ScoreResult {
  const rubrics = {
    ink: { key: 'ink' as const, label: '墨色均匀', score: overall, severity: 0 },
    sharpness: { key: 'sharpness' as const, label: '字口清晰', score: overall, severity: 0 },
    flatness: { key: 'flatness' as const, label: '纸面平整', score: overall, severity: 0 },
    flower: { key: 'flower' as const, label: '石花干扰', score: overall, severity: 0 },
  };
  return {
    meta: { id, steleId, craftsman, year, source: id, width: 64, height: 64, createdAt: '' },
    overall,
    rubrics,
    cellSeverity: {
      ink: new Float32Array(), sharpness: new Float32Array(),
      flatness: new Float32Array(), flower: new Float32Array(),
    },
    defects: [],
    engine: { backend: 'cpu', durationMs: 1, threshold: 0.5, edgeThreshold: 0.1, polarityFlipped: false },
  };
}

describe('groupByStele', () => {
  it('按碑分组且组内降序,首位为主图', () => {
    const results = [
      fakeResult('a2', 'S1', 80),
      fakeResult('a1', 'S1', 92),
      fakeResult('b1', 'S2', 70),
    ];
    const groups = groupByStele(results);
    expect(groups).toHaveLength(2);
    expect(groups[0].steleId).toBe('S1');
    expect(groups[0].items.map((r) => r.meta.id)).toEqual(['a1', 'a2']);
    expect(groups[0].best?.meta.id).toBe('a1');
  });
});

describe('分布与统计', () => {
  it('分数段计数正确', () => {
    const results = [fakeResult('1', 'S1', 55), fakeResult('2', 'S1', 82), fakeResult('3', 'S1', 88)];
    const bins = scoreDistribution(results, 10);
    expect(bins.find((b) => b.label === '50-60')?.count).toBe(1);
    expect(bins.find((b) => b.label === '80-90')?.count).toBe(2);
  });

  it('拓工年份聚合包含均值中位数', () => {
    const results = [
      fakeResult('1', 'S1', 80, '张拓', 2021),
      fakeResult('2', 'S2', 90, '张拓', 2021),
      fakeResult('3', 'S3', 70, '李拓', 2022),
    ];
    const stats = craftsmanYearStats(results);
    expect(stats).toHaveLength(2);
    const zhang = stats.find((s) => s.craftsman === '张拓')!;
    expect(zhang.count).toBe(2);
    expect(zhang.mean).toBe(85);
    expect(zhang.median).toBe(85);
  });

  it('mean/median 边界', () => {
    expect(mean([])).toBe(0);
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
  });
});
