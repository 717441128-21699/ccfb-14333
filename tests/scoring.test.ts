import { describe, expect, it } from 'vitest';
import { buildDataset, scoreDataset } from '../src/core/dataset';
import { spearman } from '../src/core/stats';
import { scoreImageCpu } from '../src/core/scorer';
import { generateRubbing } from '../src/core/synthetic';
import type { RubricKey, ScoreResult } from '../src/core/types';

/**
 * 核心验收指标:评分与专家(参考)分的 Spearman >= 0.85。
 * 数据集含多碑、多拓工、多年份与混合退化,模拟真实挑选场景。
 */
describe('评分与专家参考分的一致性', () => {
  const dataset = buildDataset({
    steleCount: 12,
    rubbingsPerStele: 6,
    width: 384,
    height: 512,
    seedBase: 2024,
    craftsmen: ['张拓', '李拓', '王拓', '赵拓'],
    yearRange: [2015, 2024],
  });
  const results = scoreDataset(dataset);

  it('数据集规模符合预期', () => {
    expect(results).toHaveLength(72);
  });

  it('综合分 Spearman 相关不低于 0.85', () => {
    const ref = results.map((r) => r.reference!.overall);
    const pred = results.map((r) => r.overall);
    const rho = spearman(ref, pred);
    // 打印实际数值便于校准调参
    console.log(`综合分 Spearman = ${rho.toFixed(4)}`);
    expect(rho).toBeGreaterThanOrEqual(0.85);
  });

  it.each(['ink', 'sharpness', 'flatness', 'flower'] as RubricKey[])(
    '分项 %s 的 Spearman 不低于 0.85',
    (key) => {
      const ref = results.map((r) => r.reference!.rubrics[key]);
      const pred = results.map((r) => r.rubrics[key].score);
      const rho = spearman(ref, pred);
      console.log(`分项 ${key} Spearman = ${rho.toFixed(4)}`);
      expect(rho).toBeGreaterThanOrEqual(0.85);
    },
  );

  it('无退化样本得分 >= 90,满退化样本得分 <= 25(四类退化全满,属重拓档)', () => {
    const zero = { inkLevel: 0.5, inkUneven: 0, wear: 0, wrinkle: 0, stoneFlower: 0 };
    const good = generateRubbing({ width: 384, height: 384, seed: 1, params: zero });
    const goodScore = scoreImageCpu(
      { id: 'g', steleId: 'S', craftsman: 'x', year: 2020, source: 'g', width: 384, height: 384, createdAt: '' },
      good.image,
    );
    console.log('无退化综合分:', goodScore.overall, JSON.stringify(Object.fromEntries(Object.entries(goodScore.rubrics).map(([k, v]) => [k, v.score]))));
    expect(goodScore.overall).toBeGreaterThanOrEqual(90);

    const full = { inkLevel: 0.5, inkUneven: 1, wear: 1, wrinkle: 1, stoneFlower: 1 };
    const bad = generateRubbing({ width: 384, height: 384, seed: 2, params: full });
    const badScore = scoreImageCpu(
      { id: 'b', steleId: 'S', craftsman: 'x', year: 2020, source: 'b', width: 384, height: 384, createdAt: '' },
      bad.image,
    );
    console.log('满退化综合分:', badScore.overall, JSON.stringify(Object.fromEntries(Object.entries(badScore.rubrics).map(([k, v]) => [k, v.score]))));
    expect(badScore.overall).toBeLessThanOrEqual(25);
  });

  it('墨色浓淡(风格项)不显著影响质量分:同退化不同 inkLevel 分数差 <= 8', () => {
    const make = (inkLevel: number, seed: number): ScoreResult => {
      const params = { inkLevel, inkUneven: 0.4, wear: 0.3, wrinkle: 0.2, stoneFlower: 0.25 };
      const { image } = generateRubbing({ width: 320, height: 320, seed, glyphSeed: 60000, params });
      return scoreImageCpu(
        { id: `i${inkLevel}`, steleId: 'S', craftsman: 'x', year: 2020, source: 'i', width: 320, height: 320, createdAt: '' },
        image,
      );
    };
    const light = make(0, 55);
    const dark = make(1, 55);
    console.log('淡墨分:', light.overall, '浓墨分:', dark.overall);
    expect(Math.abs(light.overall - dark.overall)).toBeLessThanOrEqual(8);
  });

  it('同一退化等级在不同种子下排名稳定(分差标准差可接受)', () => {
    const scores: number[] = [];
    for (let seed = 1; seed <= 8; seed++) {
      const params = { inkLevel: seed / 8, inkUneven: 0.5, wear: 0.5, wrinkle: 0.4, stoneFlower: 0.4 };
      const { image } = generateRubbing({ width: 320, height: 320, seed, params });
      const r = scoreImageCpu(
        { id: `s${seed}`, steleId: 'S', craftsman: 'x', year: 2020, source: 's', width: 320, height: 320, createdAt: '' },
        image,
      );
      scores.push(r.overall);
    }
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const sd = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length);
    console.log('同等级跨种子均值/标准差:', mean.toFixed(2), sd.toFixed(2));
    expect(sd).toBeLessThan(7);
  });
});
