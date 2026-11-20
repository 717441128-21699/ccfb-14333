/**
 * 领域类型定义:拓片元数据、单元特征、评分结果。
 * 所有路径(CPU 参考实现 / WebGL2 引擎 / UI)共用这些类型。
 */

export type RubricKey = 'ink' | 'sharpness' | 'flatness' | 'flower';

export const RUBRIC_KEYS: RubricKey[] = ['ink', 'sharpness', 'flatness', 'flower'];

export const RUBRIC_LABELS: Record<RubricKey, string> = {
  ink: '墨色均匀',
  sharpness: '字口清晰',
  flatness: '纸面平整',
  flower: '石花干扰',
};

/** 缺陷区域标签(与评分项对应,热力图标注用) */
export const DEFECT_LABELS: Record<RubricKey, string> = {
  ink: '墨不匀',
  sharpness: '字口虚',
  flatness: '纸褶',
  flower: '石花',
};

/** 各评分项的主题色(热力图/标注框/图表共用) */
export const RUBRIC_COLORS: Record<RubricKey, string> = {
  ink: '#e67e22',
  sharpness: '#3498db',
  flatness: '#9b59b6',
  flower: '#e74c3c',
};

/** 默认综合权重,和为 1;可在界面调整 */
export const DEFAULT_WEIGHTS: Record<RubricKey, number> = {
  ink: 0.3,
  sharpness: 0.35,
  flatness: 0.15,
  flower: 0.2,
};

/** 拓片业务元数据(导入时由清单文件提供,合成数据自动生成) */
export interface RubbingMeta {
  /** 拓片编号 */
  id: string;
  /** 碑名/碑号,同一块碑的多张拓本共享 */
  steleId: string;
  steleName?: string;
  /** 拓工 */
  craftsman: string;
  /** 拓制年份 */
  year: number;
  /** 文件名或合成批次名 */
  source: string;
  width: number;
  height: number;
  createdAt: string;
}

/** 合成拓片的退化控制参数,0..1,0 = 无退化 */
export interface DegradationParams {
  /** 墨色浓淡(风格项,不应影响质量分):0 淡墨,1 浓墨 */
  inkLevel: number;
  /** 墨色不均程度 */
  inkUneven: number;
  /** 字口磨损/虚化程度 */
  wear: number;
  /** 纸褶程度 */
  wrinkle: number;
  /** 石花干扰程度 */
  stoneFlower: number;
}

/**
 * 每个 64×64 像素单元的归约统计量。
 * GLSL 与 CPU 两条管线必须产出数值一致的本结构(见 tests/gl-parity)。
 * 通道布局与 WebGL2 单元纹理一一对应。
 */
export interface CellStats {
  /** 单元内有效像素数 */
  n: number;
  /** 亮度均值 */
  mean: number;
  /** 亮度方差 */
  variance: number;
  /** 墨区像素(亮度 <= 全局阈值)均值 */
  inkMean: number;
  /** 墨区亮度方差 —— 墨色均匀的核心信号 */
  inkVar: number;
  /** 墨区像素数 */
  inkCount: number;
  /** 纯墨区(模糊亮度低于阈值)的模糊亮度均值与标准差:墨色均匀的主信号,排除笔画 */
  pureInkCount: number;
  pureInkMean: number;
  pureInkStd: number;
  /** Sobel 梯度幅值之和(仅边缘像素) */
  edgeMagSum: number;
  /** 边缘像素数 */
  edgeCount: number;
  /** 单元内全部像素的 Sobel 幅值之和(字口锐度主信号,不依赖边缘阈值) */
  gradSum: number;
  /** 强边缘像素(幅值 >= 2×边缘阈值)数量与幅值和:刻画字口本身的锐利强边 */
  strongEdgeCount: number;
  strongEdgeMagSum: number;
  /** 亮像素(字形)占比,用于判断单元是否含字 */
  brightRatio: number;
  /** top-hat 亮细线响应之和与超阈值像素数(纸褶信号) */
  tophatSum: number;
  tophatCount: number;
  /** tophat 超阈值像素的连通域数量、低填充(线状)域像素数与近圆小颗粒(石花)像素数 */
  tophatComponents: number;
  tophatLinePixels: number;
  tophatBlobPixels: number;
  /** 局部亮异点数(石花候选) */
  brightCount: number;
  /** 亮异点边界像素数(紧邻暗背景) */
  brightBoundary: number;
  /** 亮异点超过阈值的亮度累积(异常强度) */
  brightAnomalySum: number;
  /** 边缘方向直方图,4 个方向 bin */
  orient: [number, number, number, number];
  /** 边缘像素坐标的二阶矩(用于主方向延展度/线状判别),Σxx, Σyy, Σxy */
  edgeMomentXx: number;
  edgeMomentYy: number;
  edgeMomentXy: number;
}

/** 整张图的单元网格 */
export interface CellGrid {
  width: number;
  height: number;
  cellSize: number;
  imageWidth: number;
  imageHeight: number;
  cells: CellStats[];
}

/** 一个评分项的结果 */
export interface RubricScore {
  key: RubricKey;
  label: string;
  /** 0..100,越高越好 */
  score: number;
  /** 0..1,缺陷严重度,与 score 反向 */
  severity: number;
}

/** 图上标注出的缺陷区域(相邻缺陷单元连通后得到) */
export interface DefectRegion {
  rubric: RubricKey;
  label: string;
  /** 像素坐标包围盒 */
  bbox: { x: number; y: number; w: number; h: number };
  /** 包含的单元数 */
  cellCount: number;
  /** 区域内平均严重度 0..1 */
  severity: number;
}

export interface ScoreResult {
  meta: RubbingMeta;
  /** 综合分 0..100 */
  overall: number;
  rubrics: Record<RubricKey, RubricScore>;
  /** 每个单元、每个评分项的严重度 0..1,用于热力图,长度 = cells */
  cellSeverity: Record<RubricKey, Float32Array>;
  /** 排序后的缺陷区域 */
  defects: DefectRegion[];
  /** 评分管线元信息 */
  engine: {
    backend: 'cpu' | 'webgl2';
    /** 含读回的总耗时 ms */
    durationMs: number;
    /** 全局 Otsu 阈值 */
    threshold: number;
    /** 边缘阈值 */
    edgeThreshold: number;
    /** 极性是否被翻转(扫描件反相时) */
    polarityFlipped: boolean;
  };
  /** 合成拓片携带的参考退化参数与参考分,真实拓片为 undefined */
  reference?: {
    params: DegradationParams;
    overall: number;
    rubrics: Record<RubricKey, number>;
  };
}

/** 灰度浮点图(亮度约定:0 墨底,1 纸/字口) */
export interface GrayImage {
  width: number;
  height: number;
  /** row-major,长度 width*height */
  data: Float32Array;
}

/** 8 位 RGBA 图 */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
