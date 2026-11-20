/**
 * 统计工具:Spearman 秩相关、碑分组排序、质量分布。
 */
import type { RubricKey, ScoreResult } from './types';

/**
 * Spearman 等级相关系数。
 * 并列值取平均秩;常数列返回 0。
 */
export function spearman(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 2) {
    throw new Error('spearman: 输入长度不一致或样本不足');
  }
  const rx = averageRanks(x);
  const ry = averageRanks(y);
  const n = x.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += rx[i];
    my += ry[i];
  }
  mx /= n;
  my /= n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i] - mx;
    const b = ry[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return 0;
  return num / Math.sqrt(dx * dy);
}

/** 平均秩(处理并列),秩从 1 开始 */
function averageRanks(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i + 1;
    while (j < indexed.length && indexed[j].v === indexed[i].v) j++;
    const avgRank = (i + 1 + j) / 2; // 并列段的平均秩
    for (let k = i; k < j; k++) ranks[indexed[k].i] = avgRank;
    i = j;
  }
  return ranks;
}

export interface SteleGroup {
  steleId: string;
  steleName?: string;
  items: ScoreResult[];
  best?: ScoreResult;
}

/** 按碑分组,组内按综合分降序,第一名即主图候选 */
export function groupByStele(results: ScoreResult[]): SteleGroup[] {
  const map = new Map<string, SteleGroup>();
  for (const r of results) {
    const id = r.meta.steleId;
    if (!map.has(id)) {
      map.set(id, { steleId: id, steleName: r.meta.steleName, items: [] });
    }
    map.get(id)!.items.push(r);
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.items.sort((a, b) => b.overall - a.overall);
    g.best = g.items[0];
  }
  groups.sort((a, b) => (b.best?.overall ?? 0) - (a.best?.overall ?? 0));
  return groups;
}

export interface DistributionBin {
  /** 区间下界(含) */
  from: number;
  /** 区间上界(不含,最后一个含 100) */
  to: number;
  label: string;
  count: number;
}

/** 分数段分布,默认 10 分一档 */
export function scoreDistribution(results: ScoreResult[], binSize = 10): DistributionBin[] {
  const bins: DistributionBin[] = [];
  for (let from = 0; from < 100; from += binSize) {
    const to = Math.min(100, from + binSize);
    bins.push({ from, to, label: `${from}-${to}`, count: 0 });
  }
  for (const r of results) {
    const idx = Math.min(bins.length - 1, Math.floor(r.overall / binSize));
    bins[idx].count++;
  }
  return bins;
}

export interface CraftsmanYearStat {
  craftsman: string;
  year: number;
  count: number;
  mean: number;
  median: number;
  min: number;
  max: number;
  rubricMeans: Record<RubricKey, number>;
}

/** 拓工 × 年份的质量分布统计(主任统计页数据源) */
export function craftsmanYearStats(results: ScoreResult[]): CraftsmanYearStat[] {
  const map = new Map<string, ScoreResult[]>();
  for (const r of results) {
    const key = `${r.meta.craftsman}||${r.meta.year}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }
  const out: CraftsmanYearStat[] = [];
  for (const [, items] of map) {
    const scores = items.map((r) => r.overall).sort((a, b) => a - b);
    const rubricMeans = {} as Record<RubricKey, number>;
    for (const k of ['ink', 'sharpness', 'flatness', 'flower'] as RubricKey[]) {
      rubricMeans[k] = mean(items.map((r) => r.rubrics[k].score));
    }
    out.push({
      craftsman: items[0].meta.craftsman,
      year: items[0].meta.year,
      count: items.length,
      mean: round2(mean(scores)),
      median: round2(median(scores)),
      min: scores[0],
      max: scores[scores.length - 1],
      rubricMeans,
    });
  }
  out.sort((a, b) => a.craftsman.localeCompare(b.craftsman) || a.year - b.year);
  return out;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
