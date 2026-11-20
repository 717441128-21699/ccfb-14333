/**
 * 评分模型:CellStats → 单元严重度 → 分项分 → 综合分 → 缺陷区域。
 *
 * 严重度全部落在 [0,1],越高越差;分项分 = 100·(1−severity)。
 * 严重度到分数的映射常数由合成数据校准(见 calibration.ts),
 * 保证无退化图接近满分、满退化图接近 0 分,且与参考分线性对齐。
 */
import type {
  CellGrid,
  CellStats,
  DefectRegion,
  GrayImage,
  RubricKey,
  RubricScore,
  RubbingMeta,
  ScoreResult,
} from './types';
import { DEFAULT_WEIGHTS, RUBRIC_KEYS, RUBRIC_LABELS, DEFECT_LABELS } from './types';
import { extractCells } from './features';
import { CALIBRATION } from './calibration.generated';

/** 单个评分项的校准常数 */
export interface Calib {
  /** 无退化基准严重度(中位数) */
  s0: number;
  /** 满退化严重度(中位数) */
  s1: number;
}

export type CalibrationTable = Record<RubricKey, Calib>;

/** 单元严重度阈值:超过该值的单元进入缺陷连通标注 */
export const DEFECT_CELL_SEVERITY = 0.45;

/** 用校准常数把原始严重度压到 [0,1] */
export function normalize(raw: number, calib: Calib): number {
  if (calib.s1 <= calib.s0 + 1e-6) return raw > calib.s0 ? 1 : 0;
  return Math.min(1, Math.max(0, (raw - calib.s0) / (calib.s1 - calib.s0)));
}

/* ------------------------------------------------------------------ */
/* 原始严重度(未校准),GL 与 CPU 共用同一套公式                        */
/* ------------------------------------------------------------------ */

/**
 * 墨色不匀:纯墨区内部模糊亮度的标准差。
 * 合成器采用乘性墨层模型,墨层起伏的绝对幅度与墨色浓淡解耦,
 * 因此这里直接用 std(不用会随暗底均值发散的 CV)。
 * 只统计模糊后仍低于阈值的像素,排除笔画;漏拓单元另给高严重度。
 */
export function rawInkSeverity(c: CellStats): number {
  if (c.pureInkCount < 32) {
    return c.inkCount < 16 ? 0.5 : 0.2;
  }
  return Math.min(1, c.pureInkStd * 7);
}

/**
 * 字口虚化:强边缘占比 + 强边平均幅值。
 * 锐利字口在墨-字过渡处产生高幅值强边;磨损柔化使强边幅值下降、数量减少。
 * 石花/纸褶虽增加边缘数量,但多为低幅值弱边,不进入强边统计,因此不干扰本项。
 * 无字单元(brightRatio 低)返回 0,聚合按字形占比加权。
 */
export function rawSharpnessSeverity(c: CellStats): number {
  if (c.brightRatio < 0.06) return 0;
  if (c.edgeCount < 4) return 0.6; // 有字却几乎无边缘:严重虚化
  // 强边在全部边缘中的占比
  const strongRatio = c.strongEdgeCount / c.edgeCount;
  // 强边平均幅值(归一化到 ~[0,1])
  const strongMag = c.strongEdgeCount > 0 ? c.strongEdgeMagSum / c.strongEdgeCount : 0;
  // 清晰:strongRatio ~0.4+、strongMag ~0.5+;磨损:两者同步下降
  const ratioPart = Math.min(1, Math.max(0, (0.45 - strongRatio) / 0.4));
  const magPart = Math.min(1, Math.max(0, (0.5 - strongMag) / 0.42));
  return Math.min(1, 0.55 * ratioPart + 0.45 * magPart);
}

/**
 * 纸褶:top-hat 细长低填充连通域的像素密度(lineDensity)。
 * 该特征经验证只对纸褶响应,对墨不匀/磨损/石花恒为 0(它们的亮结构不满足
 * "细长 + 低填充 + 主尺寸≥20px"的线状判据),因此不再混入其他响应项。
 */
export function rawFlatnessSeverity(c: CellStats): number {
  if (c.n === 0) return 0;
  const lineDensity = c.tophatLinePixels / c.n;
  return Math.min(1, lineDensity * 16);
}

/**
 * 石花:亮异点密度为主信号(对石花等级单调)。
 * 关键门控 = 连通域数/亮异点数:石花是分散小颗粒,比值 > 1;
 * 纸褶是少数长线,比值 ~0.33。用该比值做乘性门控,纸褶区域石花分被压到接近 0。
 */
export function rawFlowerSeverity(c: CellStats): number {
  if (c.n === 0 || c.brightCount < 3) return 0;
  const brightDensity = c.brightCount / c.n;
  const boundaryRatio = c.brightBoundary / c.brightCount;
  const compPerBright = c.tophatComponents / Math.max(1, c.brightCount);
  // 比值 0.33(纸褶)→ 门控 ~0;比值 >=1(石花)→ 门控 1
  const scatterGate = Math.min(1, Math.max(0, (compPerBright - 0.5) / 0.5));
  return Math.min(1, brightDensity * 22 * (0.35 + 0.65 * boundaryRatio) * (0.15 + 0.85 * scatterGate));
}

const RAW_FNS: Record<RubricKey, (c: CellStats) => number> = {
  ink: rawInkSeverity,
  sharpness: rawSharpnessSeverity,
  flatness: rawFlatnessSeverity,
  flower: rawFlowerSeverity,
};

/** 计算全部单元的四类严重度网格 */
export function cellSeverityGrids(
  grid: CellGrid,
  calib: CalibrationTable = CALIBRATION,
): Record<RubricKey, Float32Array> {
  const out = {
    ink: new Float32Array(grid.cells.length),
    sharpness: new Float32Array(grid.cells.length),
    flatness: new Float32Array(grid.cells.length),
    flower: new Float32Array(grid.cells.length),
  };
  for (let i = 0; i < grid.cells.length; i++) {
    const c = grid.cells[i];
    for (const key of RUBRIC_KEYS) {
      out[key][i] = normalize(RAW_FNS[key](c), calib[key]);
    }
  }
  return out;
}

/**
 * 全图聚合:四项评分均使用全图级信号(单元间变异 / 强边密度 / 线状域 / 亮异点),
 * 与 aggregateRawSeverity 同口径;sev 仅保留给单元热力图,不参与全图聚合。
 */
function aggregateSeverity(
  grid: CellGrid,
  _sev: Record<RubricKey, Float32Array>,
  calib: CalibrationTable,
): Record<RubricKey, number> {
  return {
    ink: normalize(globalInkSeverity(grid), calib.ink),
    sharpness: normalize(globalSharpnessSeverity(grid), calib.sharpness),
    flatness: normalize(globalFlatnessSeverity(grid), calib.flatness),
    flower: normalize(globalFlowerSeverity(grid), calib.flower),
  };
}

/**
 * 全图墨色不匀:单元间纯墨区均值的变异系数(低频信号)。
 * 墨不匀是大尺度缓变,单元内部的高频颗粒噪声应被排除;
 * 单元间均值的离散度恰好捕捉低频起伏,且乘性墨层模型下与浓淡基本解耦。
 */
function globalInkSeverity(grid: CellGrid): number {
  const means: number[] = [];
  const weights: number[] = [];
  for (const c of grid.cells) {
    if (c.pureInkCount >= 32) {
      means.push(c.pureInkMean);
      weights.push(c.pureInkCount);
    }
  }
  if (means.length < 4) return 0.3;
  let wsum = 0;
  let m = 0;
  for (let i = 0; i < means.length; i++) {
    m += means[i] * weights[i];
    wsum += weights[i];
  }
  m /= wsum;
  if (m <= 1e-3) return 0.3;
  let varAcc = 0;
  for (let i = 0; i < means.length; i++) {
    varAcc += weights[i] * (means[i] - m) ** 2;
  }
  const sd = Math.sqrt(varAcc / wsum);
  // 单元间 CV:无退化 ~0.04,满退化 ~0.45
  return Math.min(1, (sd / m) * 2.2);
}

/** 全图墨底反差(亮 1 与墨底均值之差),用于把绝对亮度差信号归一化,消除墨色浓淡影响 */
function globalContrast(grid: CellGrid): number {
  let inkSum = 0;
  let inkN = 0;
  for (const c of grid.cells) {
    if (c.inkCount > 0) {
      inkSum += c.inkMean * c.inkCount;
      inkN += c.inkCount;
    }
  }
  const inkMean = inkN > 0 ? inkSum / inkN : 0.2;
  return Math.max(0.25, 1 - inkMean);
}

/**
 * 全图纸褶严重度:全图大尺寸稀疏连通域(纸褶)像素密度,按墨底反差归一化。
 * 特征层已用尺寸+填充率把纸褶(大而稀疏)与石花(小而饱满)分到不同计数器。
 */
function globalFlatnessSeverity(grid: CellGrid): number {
  let line = 0;
  let n = 0;
  for (const c of grid.cells) {
    line += c.tophatLinePixels;
    n += c.n;
  }
  const lineDensity = line / Math.max(1, n) / globalContrast(grid);
  return Math.min(1, lineDensity * 16);
}

/**
 * 全图石花严重度:近圆小颗粒(石花)连通域的像素密度,按墨底反差归一化。
 * tophat 响应是绝对亮度差,浓墨底反差大、淡墨底反差小;除以亮-墨底反差后,
 * 石花分不再随墨色浓淡(风格)漂移。亮异点边界占比辅助排除笔画平坦亮区。
 */
function globalFlowerSeverity(grid: CellGrid): number {
  let n = 0;
  let blob = 0;
  let boundary = 0;
  let bright = 0;
  for (const c of grid.cells) {
    n += c.n;
    blob += c.tophatBlobPixels;
    boundary += c.brightBoundary;
    bright += c.brightCount;
  }
  const contrast = globalContrast(grid);
  const blobDensity = blob / Math.max(1, n) / contrast;
  const boundaryRatio = bright > 0 ? boundary / bright : 0;
  // 纯用反差归一化的近圆颗粒密度,边界占比加权;不再叠加未归一化的亮异点项
  return Math.min(1, blobDensity * 12 * (0.5 + 0.5 * boundaryRatio));
}

/**
 * 全图字口锐度:强边缘在全部边缘中的占比。
 * 锐利字口的边缘几乎都是高幅值强边(占比 ~0.9);磨损柔化使强边转弱、占比下降到接近 0。
 * 用边缘总数(而非亮区面积)归一化,避免石花/纸褶增加亮区时稀释指标。
 * 石花/纸褶虽增加弱边,但占比仍显著高于严重磨损,干扰有限。
 */
function globalSharpnessSeverity(grid: CellGrid): number {
  let strong = 0;
  let edge = 0;
  for (const c of grid.cells) {
    strong += c.strongEdgeCount;
    edge += c.edgeCount;
  }
  if (edge < grid.cellSize * grid.cellSize) return 0; // 几乎无内容,不评价
  const ratio = strong / edge;
  // 清晰 ~0.9,严重磨损 ~0.0
  return Math.min(1, Math.max(0, (0.85 - ratio) / 0.8));
}

/** 单个评分项的全图加权原始严重度(校准用,与评分聚合权重完全一致) */
export function aggregateRawSeverity(grid: CellGrid, key: RubricKey): number {
  if (key === 'ink') return globalInkSeverity(grid);
  if (key === 'sharpness') return globalSharpnessSeverity(grid);
  if (key === 'flatness') return globalFlatnessSeverity(grid);
  return globalFlowerSeverity(grid);
}

/** 相邻缺陷单元做连通域,输出缺陷区域(按严重度降序) */
export function findDefectRegions(
  grid: CellGrid,
  sev: Record<RubricKey, Float32Array>,
): DefectRegion[] {
  const visited = new Uint8Array(grid.cells.length);
  const regions: DefectRegion[] = [];
  for (let i = 0; i < grid.cells.length; i++) {
    if (visited[i]) continue;
    // 找该单元最突出的评分项
    let best: RubricKey | null = null;
    let bestSev = DEFECT_CELL_SEVERITY;
    for (const key of RUBRIC_KEYS) {
      if (sev[key][i] > bestSev) {
        best = key;
        bestSev = sev[key][i];
      }
    }
    if (!best) continue;
    const rubric = best;
    // BFS 连通:4 邻域,同评分项且超阈值
    const queue = [i];
    visited[i] = 1;
    const members: number[] = [];
    let sevSum = 0;
    let minCx = Infinity;
    let minCy = Infinity;
    let maxCx = -Infinity;
    let maxCy = -Infinity;
    while (queue.length > 0) {
      const idx = queue.pop()!;
      members.push(idx);
      sevSum += sev[rubric][idx];
      const cx = idx % grid.width;
      const cy = Math.floor(idx / grid.width);
      minCx = Math.min(minCx, cx);
      maxCx = Math.max(maxCx, cx);
      minCy = Math.min(minCy, cy);
      maxCy = Math.max(maxCy, cy);
      const neighbors = [
        cx > 0 ? idx - 1 : -1,
        cx < grid.width - 1 ? idx + 1 : -1,
        cy > 0 ? idx - grid.width : -1,
        cy < grid.height - 1 ? idx + grid.width : -1,
      ];
      for (const nb of neighbors) {
        if (nb < 0 || visited[nb]) continue;
        if (sev[rubric][nb] >= DEFECT_CELL_SEVERITY) {
          visited[nb] = 1;
          queue.push(nb);
        }
      }
    }
    const cs = grid.cellSize;
    regions.push({
      rubric,
      label: DEFECT_LABELS[rubric],
      bbox: {
        x: minCx * cs,
        y: minCy * cs,
        w: (maxCx - minCx + 1) * cs,
        h: (maxCy - minCy + 1) * cs,
      },
      cellCount: members.length,
      severity: sevSum / members.length,
    });
  }
  regions.sort((a, b) => b.severity * b.cellCount - a.severity * a.cellCount);
  return regions;
}

export interface ScoreOptions {
  weights?: Record<RubricKey, number>;
  calibration?: CalibrationTable;
  backend: 'cpu' | 'webgl2';
  durationMs: number;
  threshold: number;
  edgeThreshold: number;
  polarityFlipped: boolean;
  reference?: ScoreResult['reference'];
}

/** 由单元网格组装完整评分结果 */
export function scoreFromGrid(
  meta: RubbingMeta,
  grid: CellGrid,
  opts: ScoreOptions,
): ScoreResult {
  const calib = opts.calibration ?? CALIBRATION;
  const cellSeverity = cellSeverityGrids(grid, calib);
  const sev = aggregateSeverity(grid, cellSeverity, calib);
  const weights = opts.weights ?? DEFAULT_WEIGHTS;

  const rubrics = {} as Record<RubricKey, RubricScore>;
  let overall = 0;
  for (const key of RUBRIC_KEYS) {
    const score = Math.round((1 - sev[key]) * 1000) / 10;
    rubrics[key] = { key, label: RUBRIC_LABELS[key], score, severity: sev[key] };
    overall += score * weights[key];
  }
  overall = Math.round(overall * 10) / 10;

  return {
    meta,
    overall,
    rubrics,
    cellSeverity,
    defects: findDefectRegions(grid, cellSeverity),
    engine: {
      backend: opts.backend,
      durationMs: opts.durationMs,
      threshold: opts.threshold,
      edgeThreshold: opts.edgeThreshold,
      polarityFlipped: opts.polarityFlipped,
    },
    reference: opts.reference,
  };
}

/** CPU 一站式评分(测试与降级路径使用) */
export function scoreImageCpu(
  meta: RubbingMeta,
  image: GrayImage,
  opts: Partial<Omit<ScoreOptions, 'backend' | 'durationMs' | 'threshold' | 'edgeThreshold' | 'polarityFlipped'>> = {},
): ScoreResult {
  const t0 = performance.now();
  const { grid, threshold, edgeThreshold, polarityFlipped } = extractCells(image);
  const result = scoreFromGrid(meta, grid, {
    ...opts,
    backend: 'cpu',
    durationMs: performance.now() - t0,
    threshold,
    edgeThreshold,
    polarityFlipped,
  });
  return result;
}
