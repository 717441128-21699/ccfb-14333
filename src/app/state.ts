/**
 * 应用全局状态:合成数据集 + 评分结果 + 当前视图。
 * 数据集在前端按需生成(Web Worker 可选),评分通过 ScoringService(WebGL2/CPU)。
 */
import type { RubricKey, ScoreResult } from '../core/types';
import { buildDataset, type DatasetItem } from '../core/dataset';
import { scoreImageCpu } from '../core/scorer';
import { groupByStele, craftsmanYearStats, scoreDistribution } from '../core/stats';

export type ViewKey = 'library' | 'detail' | 'stele' | 'stats' | 'benchmark';

export interface AppState {
  items: DatasetItem[];
  results: ScoreResult[];
  selectedId: string | null;
  view: ViewKey;
  backend: 'cpu' | 'webgl2';
  weights: Record<RubricKey, number>;
}

export const DEFAULT_DATASET_CONFIG = {
  steleCount: 12,
  rubbingsPerStele: 6,
  width: 384,
  height: 512,
  seedBase: 2024,
  craftsmen: ['张拓', '李拓', '王拓', '赵拓'],
  yearRange: [2015, 2024] as [number, number],
};

/** 生成数据集并用 CPU 评分(前端首屏;GL 评分在详情/基准页按需切换) */
export function buildScoredState(
  onProgress?: (done: number, total: number) => void,
): Pick<AppState, 'items' | 'results'> {
  const items = buildDataset(DEFAULT_DATASET_CONFIG);
  const results: ScoreResult[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    results.push(scoreImageCpu(it.meta, it.image, { reference: it.reference }));
    onProgress?.(i + 1, items.length);
  }
  return { items, results };
}

export { groupByStele, craftsmanYearStats, scoreDistribution };
