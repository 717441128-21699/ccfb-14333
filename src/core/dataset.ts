/**
 * 合成数据集构建:批量生成带退化参数与参考分的拓片,
 * 用于校准、Spearman 验证、界面演示与性能基准。
 */
import type { DegradationParams, GrayImage, RubbingMeta, ScoreResult } from './types';
import { generateRubbing, referenceScore } from './synthetic';
import { grayToRgba } from './imageops';
import { scoreImageCpu } from './scorer';

export interface DatasetItem {
  meta: RubbingMeta;
  image: GrayImage;
  params: DegradationParams;
  reference: NonNullable<ScoreResult['reference']>;
}

export interface DatasetConfig {
  /** 每块碑的拓本数 */
  rubbingsPerStele: number;
  steleCount: number;
  width: number;
  height: number;
  seedBase?: number;
  craftsmen: string[];
  yearRange: [number, number];
}

const STELE_NAMES = [
  '礼器碑', '乙瑛碑', '史晨碑', '曹全碑', '张迁碑', '石门颂', '西狭颂', '孔宙碑',
  '衡方碑', '鲜于璜碑', '尹宙碑', '郙阁颂',
];

/**
 * 拉丁超立方抽样:四个退化通道相互独立。
 * 每个通道把 [0,1] 切成 total 个等概率层,每层取一个带内抖动样本,
 * 再独立洗牌,保证:(1) 各通道均匀覆盖全等级;(2) 通道间近似零相关。
 * 这样合成数据集不会因抽样耦合而虚高/虚低各评分项的相关性。
 */
function lhsColumns(rand: () => number, total: number, count: number): Float32Array[] {
  const cols: Float32Array[] = [];
  for (let k = 0; k < count; k++) {
    const col = new Float32Array(total);
    for (let i = 0; i < total; i++) col[i] = (i + rand()) / total;
    // Fisher–Yates 独立洗牌
    for (let i = total - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = col[i];
      col[i] = col[j];
      col[j] = tmp;
    }
    cols.push(col);
  }
  return cols;
}

/**
 * 独立分层抽样四个退化量。
 * 约 1/5 样本强制为优质(各通道都低),模拟馆藏精品;其余用拉丁超立方独立抽样。
 */
function sampleParams(
  rand: () => number,
  index: number,
  columns: Float32Array[],
): DegradationParams {
  // 每 5 个样本出 1 个优质样本
  if (index % 5 === 0) {
    return {
      inkLevel: rand(),
      inkUneven: rand() * 0.12,
      wear: rand() * 0.12,
      wrinkle: rand() * 0.12,
      stoneFlower: rand() * 0.12,
    };
  }
  const j = index - Math.floor(index / 5) - 1; // 非优质样本在 LHS 列中的下标
  return {
    inkLevel: rand(),
    inkUneven: columns[0][j % columns[0].length],
    wear: columns[1][j % columns[1].length],
    wrinkle: columns[2][j % columns[2].length] * 0.95,
    stoneFlower: columns[3][j % columns[3].length] * 0.95,
  };
}

/** 小型可复现 PRNG(数据集层独立种子流) */
function makeRand(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildDataset(cfg: DatasetConfig): DatasetItem[] {
  const rand = makeRand(cfg.seedBase ?? 42);
  const items: DatasetItem[] = [];
  const total = cfg.steleCount * cfg.rubbingsPerStele;
  // 四个退化通道的独立拉丁超立方列(去掉优质样本占用的位置)
  const columns = lhsColumns(rand, total - Math.ceil(total / 5), 4);
  let idx = 0;
  for (let s = 0; s < cfg.steleCount; s++) {
    const steleId = `STELE-${String(s + 1).padStart(3, '0')}`;
    const steleName = STELE_NAMES[s % STELE_NAMES.length];
    // 同一块碑的所有拓本共享字形种子:字形固定,只有拓制质量在变
    const glyphSeed = (cfg.seedBase ?? 42) * 1009 + s * 77 + 1;
    for (let r = 0; r < cfg.rubbingsPerStele; r++) {
      const params = sampleParams(rand, idx, columns);
      const seed = (cfg.seedBase ?? 42) + idx * 101;
      const { image } = generateRubbing({ width: cfg.width, height: cfg.height, seed, glyphSeed, params });
      const year = Math.round(cfg.yearRange[0] + rand() * (cfg.yearRange[1] - cfg.yearRange[0]));
      const craftsman = cfg.craftsmen[Math.floor(rand() * cfg.craftsmen.length)];
      const ref = referenceScore(params);
      const meta: RubbingMeta = {
        id: `${steleId}-R${String(r + 1).padStart(2, '0')}`,
        steleId,
        steleName,
        craftsman,
        year,
        source: `synthetic#${seed}`,
        width: cfg.width,
        height: cfg.height,
        createdAt: new Date(Date.UTC(year, 0, 1)).toISOString(),
      };
      items.push({
        meta,
        image,
        params,
        reference: { params, overall: ref.overall, rubrics: ref.rubrics },
      });
      idx++;
    }
  }
  return items;
}

/** 对数据集执行 CPU 评分(校准与测试用) */
export function scoreDataset(items: DatasetItem[]): ScoreResult[] {
  return items.map((it) =>
    scoreImageCpu(it.meta, it.image, { reference: it.reference }),
  );
}

export { grayToRgba };
