/**
 * 校准:用合成拓片测量每个评分项在无退化/满退化两端的原始严重度,
 * 得到 normalize() 的线性映射常数。
 *
 * 方法:
 *  - 基线集:四项退化全为 0,仅随机化墨色浓淡与种子 → 各评分项原始严重度中位数 = s0
 *  - 单项满退化集:一次只把一个退化项设为 1,其余为 0 → 对应项中位数 = s1
 *  - 多组种子取中位数,抑制随机波动
 */
import type { GrayImage, RubricKey } from './types';
import { RUBRIC_KEYS } from './types';
import { generateRubbing } from './synthetic';
import { extractCells } from './features';
import {
  aggregateRawSeverity,
  type CalibrationTable,
} from './scorer';
import { spearman } from './stats';

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 计算一张图指定评分项的全图加权原始严重度(与线上评分同一聚合权重) */
function rawSeverityAggregate(image: GrayImage, key: RubricKey): number {
  const { grid } = extractCells(image);
  return aggregateRawSeverity(grid, key);
}

export interface CalibrationResult {
  calibration: CalibrationTable;
  /** 校准用样本量与诊断信息 */
  diagnostics: Record<RubricKey, { s0: number; s1: number; baselineValues: number[]; fullValues: number[] }>;
}

export function buildCalibration(sampleCount = 24, size = 512): CalibrationResult {
  const calibration = {} as CalibrationTable;
  const diagnostics = {} as CalibrationResult['diagnostics'];

  for (const key of RUBRIC_KEYS) {
    const baselineValues: number[] = [];
    const fullValues: number[] = [];

    for (let i = 0; i < sampleCount; i++) {
      const seed = 1000 + i * 37;
      // 基线与满退化用同一字形种子,差异只来自退化参数
      const glyphSeed = 50000 + i * 131;
      const baseline = generateRubbing({
        width: size,
        height: size,
        seed,
        glyphSeed,
        params: { inkLevel: (i % 5) / 4, inkUneven: 0, wear: 0, wrinkle: 0, stoneFlower: 0 },
      });
      baselineValues.push(rawSeverityAggregate(baseline.image, key));

      const fullParams = { inkLevel: 0.5, inkUneven: 0, wear: 0, wrinkle: 0, stoneFlower: 0 };
      fullParams[key === 'ink' ? 'inkUneven' : key === 'sharpness' ? 'wear' : key === 'flatness' ? 'wrinkle' : 'stoneFlower'] = 1;
      const full = generateRubbing({ width: size, height: size, seed: seed + 1, glyphSeed, params: fullParams });
      fullValues.push(rawSeverityAggregate(full.image, key));
    }

    const s0 = median(baselineValues);
    // s1 取满退化端,并保证与 s0 有最小间隔,避免归一化除数过小
    const s1 = Math.max(s0 + 0.08, median(fullValues));
    calibration[key] = { s0, s1 };
    diagnostics[key] = { s0, s1, baselineValues, fullValues };
  }

  return { calibration, diagnostics };
}

/** 验证校准表在合成数据集上的单调性与 Spearman */
export function validateCalibration(calibration: CalibrationTable): {
  perRubric: Record<RubricKey, { spearman: number; monotonic: boolean }>;
} {
  const perRubric = {} as Record<RubricKey, { spearman: number; monotonic: boolean }>;

  for (const key of RUBRIC_KEYS) {
    const refLevels: number[] = [];
    const predSev: number[] = [];
    // 多个字形 × 多个退化级别:覆盖字形布局差异,样本量足够时 Spearman 才稳定
    const GLYPHS = 12;
    for (let level = 0; level <= 5; level++) {
      const d = level / 5;
      for (let rep = 0; rep < GLYPHS; rep++) {
        const params = { inkLevel: 0.5, inkUneven: 0, wear: 0, wrinkle: 0, stoneFlower: 0 };
        params[key === 'ink' ? 'inkUneven' : key === 'sharpness' ? 'wear' : key === 'flatness' ? 'wrinkle' : 'stoneFlower'] = d;
        // 同一 rep 内退化扫描共享字形,跨 rep 换字形以覆盖不同布局
        const glyphSeed = 60000 + rep * 977;
        const { image } = generateRubbing({
          width: 384,
          height: 384,
          seed: 7000 + level * 13 + rep,
          glyphSeed,
          params,
        });
        const { grid } = extractCells(image);
        // 与线上评分相同的加权聚合,再做归一化
        const raw = aggregateRawSeverity(grid, key);
        const { s0, s1 } = calibration[key];
        const norm = Math.min(1, Math.max(0, (raw - s0) / Math.max(1e-6, s1 - s0)));
        refLevels.push(d);
        predSev.push(norm);
      }
    }
    perRubric[key] = {
      spearman: spearman(refLevels, predSev),
      monotonic: isMonotonic(refLevels, predSev),
    };
  }
  return { perRubric };
}

function isMonotonic(x: number[], y: number[]): boolean {
  // 按 x 排序后 y 应整体不降(允许小波动:相邻级别平均不回头)
  const pairs = x.map((v, i) => [v, y[i]]).sort((a, b) => a[0] - b[0]);
  const levelMeans = new Map<number, number[]>();
  for (const [xv, yv] of pairs) {
    if (!levelMeans.has(xv)) levelMeans.set(xv, []);
    levelMeans.get(xv)!.push(yv);
  }
  const means = [...levelMeans.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.reduce((a, b) => a + b, 0) / v.length);
  for (let i = 1; i < means.length; i++) {
    if (means[i] < means[i - 1] - 0.03) return false;
  }
  return true;
}
