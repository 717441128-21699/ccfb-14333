/**
 * 单元特征提取(CPU 参考实现)。
 *
 * 处理流程与 WebGL2 着色器逐公式对应(parity 测试保证数值一致):
 *   灰度 → 极性校正 → Otsu 阈值
 *   → 9 抽头盒式模糊 → Sobel(固定边缘阈值,不随图自适应,避免吃掉磨损信号)
 *   → 形态学 top-hat(亮细线 = 纸褶)
 *   → 逐像素:墨区统计 / 全像素梯度 / 亮异点(石花)
 *   → 按 64×64 单元归约为 CellStats
 */
import type { CellGrid, CellStats, GrayImage } from './types';
import {
  areaDownsample,
  boxBlur9,
  detectPolarity,
  invertGray,
  otsuThreshold,
  sobel,
  tophatLines,
  TOPHAT_THRESHOLD,
} from './imageops';

export const CELL_SIZE = 64;

/** 全局调参常量(同时作为 GLSL uniform) */
export interface FeatureConfig {
  cellSize: number;
  /** 亮异点判定:亮度超过 thr + brightMargin */
  brightMargin: number;
  /** 亮异点邻域密度上限(模糊亮度 <= 该值才算墨区里的异点,排除笔画内部) */
  brightDensityGap: number;
  /** 固定边缘阈值(Sobel 幅值) */
  edgeThreshold: number;
  /** top-hat 纸褶响应阈值 */
  tophatThreshold: number;
}

export const DEFAULT_FEATURE_CONFIG: FeatureConfig = {
  cellSize: CELL_SIZE,
  brightMargin: 0.08,
  brightDensityGap: 0.03,
  edgeThreshold: 0.12,
  tophatThreshold: TOPHAT_THRESHOLD,
};

export interface PreprocessResult {
  image: GrayImage;
  threshold: number;
  edgeThreshold: number;
  polarityFlipped: boolean;
}

/** 预处理:极性校正 + Otsu(边缘阈值固定,见 DEFAULT_FEATURE_CONFIG) */
export function preprocess(img: GrayImage): PreprocessResult {
  const polarityFlipped = detectPolarity(img);
  const image = polarityFlipped ? invertGray(img) : img;
  const threshold = otsuThreshold(image);
  return { image, threshold, edgeThreshold: DEFAULT_FEATURE_CONFIG.edgeThreshold, polarityFlipped };
}

/**
 * 提取单元网格。CPU 全分辨率实现,供测试/无 WebGL2 环境使用。
 */
export function extractCells(img: GrayImage, cfg: FeatureConfig = DEFAULT_FEATURE_CONFIG): {
  grid: CellGrid;
  threshold: number;
  edgeThreshold: number;
  polarityFlipped: boolean;
} {
  const pre = preprocess(img);
  const { threshold, edgeThreshold } = pre;
  const gray = pre.image;
  const { width, height, data } = gray;

  const blur = boxBlur9(gray);
  const { mag, gx, gy } = sobel(blur);
  const { response: tophat } = tophatLines(gray, 3);

  const cs = cfg.cellSize;
  const gw = Math.ceil(width / cs);
  const gh = Math.ceil(height / cs);
  const cells: CellStats[] = [];

  const margin = cfg.brightMargin;
  const densityThr = threshold - cfg.brightDensityGap;
  const tophatThr = cfg.tophatThreshold;

  for (let cy = 0; cy < gh; cy++) {
    for (let cx = 0; cx < gw; cx++) {
      const x0 = cx * cs;
      const y0 = cy * cs;
      const x1 = Math.min(width, x0 + cs);
      const y1 = Math.min(height, y0 + cs);

      let n = 0;
      let sumL = 0;
      let sumL2 = 0;
      let pureInkCount = 0;
      let sumB = 0;
      let sumB2 = 0;
      let inkCount = 0;
      let inkSum = 0;
      let inkSq = 0;
      let edgeMagSum = 0;
      let edgeCount = 0;
      let strongEdgeCount = 0;
      let strongEdgeMagSum = 0;
      let gradSum = 0;
      let brightPixelCount = 0;
      let tophatSum = 0;
      let tophatCount = 0;
      let tophatComponents = 0;
      let tophatLinePixels = 0;
      let tophatBlobPixels = 0;
      let brightCount = 0;
      let brightBoundary = 0;
      let brightAnomalySum = 0;
      const orient = [0, 0, 0, 0];
      let edgeMomentXx = 0;
      let edgeMomentYy = 0;
      let edgeMomentXy = 0;

      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = y * width + x;
          const L = data[p];
          n++;
          sumL += L;
          sumL2 += L * L;
          // 纯墨区:模糊后仍低于阈值,远离笔画边缘,只反映墨层本身的起伏
          const bL = blur.data[p];
          if (bL <= threshold) {
            pureInkCount++;
            sumB += bL;
            sumB2 += bL * bL;
          }

          if (L <= threshold) {
            inkCount++;
            inkSum += L;
            inkSq += L * L;
          } else {
            brightPixelCount++;
          }

          const m = mag[p];
          gradSum += m;
          if (m >= edgeThreshold) {
            edgeCount++;
            edgeMagSum += m;
            // 强边缘:锐利字口的标志性高幅值边,石花/纸褶多为弱边
            if (m >= edgeThreshold * 2) {
              strongEdgeCount++;
              strongEdgeMagSum += m;
            }
            // 单元内局部坐标的二阶矩,用于线状延展度
            const lx = x - x0;
            const ly = y - y0;
            edgeMomentXx += lx * lx;
            edgeMomentYy += ly * ly;
            edgeMomentXy += lx * ly;
            const ang = Math.atan2(gy[p], gx[p]); // [-pi, pi]
            const a = ang < 0 ? ang + Math.PI : ang; // [0, pi)
            const b = Math.min(3, Math.floor((a / Math.PI) * 4));
            orient[b]++;
          }

          tophatSum += tophat[p];
          if (tophat[p] >= tophatThr) tophatCount++;
          // 亮异点:亮于阈值 + 局部仍偏暗(排除笔画内部)+ 邻接暗背景(石花)
          if (L > threshold + margin && blur.data[p] <= densityThr) {
            brightCount++;
            brightAnomalySum += L - threshold;
            const xl = x > 0 ? data[p - 1] : L;
            const xr = x < width - 1 ? data[p + 1] : L;
            const yu = y > 0 ? data[p - width] : L;
            const yd = y < height - 1 ? data[p + width] : L;
            if (xl <= threshold || xr <= threshold || yu <= threshold || yd <= threshold) {
              brightBoundary++;
            }
          }
        }
      }

      const mean = n > 0 ? sumL / n : 0;
      const variance = n > 0 ? Math.max(0, sumL2 / n - mean * mean) : 0;
      const pureInkMean = pureInkCount > 0 ? sumB / pureInkCount : 0;
      const pureInkStd = pureInkCount > 0 ? Math.sqrt(Math.max(0, sumB2 / pureInkCount - pureInkMean * pureInkMean)) : 0;
      const inkMean = inkCount > 0 ? inkSum / inkCount : 0;
      const inkVar = inkCount > 0 ? Math.max(0, inkSq / inkCount - inkMean * inkMean) : 0;

      // tophat 连通域:低填充率(细长线)的域计为纸褶,高填充近圆域归石花
      const cc = analyzeTophatComponents(tophat, width, x0, y0, x1, y1, tophatThr);
      tophatComponents = cc.components;
      tophatLinePixels = cc.linePixels;
      tophatBlobPixels = cc.blobPixels;

      cells.push({
        n,
        mean,
        variance,
        inkMean,
        inkVar,
        inkCount,
        pureInkCount,
        pureInkMean,
        pureInkStd,
        edgeMagSum,
        edgeCount,
        strongEdgeCount,
        strongEdgeMagSum,
        gradSum,
        brightRatio: n > 0 ? brightPixelCount / n : 0,
        tophatSum,
        tophatCount,
        tophatComponents,
        tophatLinePixels,
        tophatBlobPixels,
        brightCount,
        brightBoundary,
        brightAnomalySum,
        orient: [orient[0], orient[1], orient[2], orient[3]],
        edgeMomentXx,
        edgeMomentYy,
        edgeMomentXy,
      });
    }
  }

  return {
    grid: { width: gw, height: gh, cellSize: cs, imageWidth: width, imageHeight: height, cells },
    threshold,
    edgeThreshold,
    polarityFlipped: pre.polarityFlipped,
  };
}

/** 仅供 GL 引擎复用的小图边缘阈值占位(固定值已移入配置,保留导出兼容) */
export function edgeThresholdFromConfig(cfg: FeatureConfig): number {
  return cfg.edgeThreshold;
}

/**
 * 单元内 tophat 超阈值像素的连通域分析。
 * 纸褶连通域细长、填充率低(fill < 0.25);石花颗粒近圆、填充率高。
 * 返回连通域数量与属于"线状域"的像素总数。
 */
function analyzeTophatComponents(
  response: Float32Array,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thr: number,
): { components: number; linePixels: number; blobPixels: number } {
  const cw = x1 - x0;
  const ch = y1 - y0;
  const local = new Uint8Array(cw * ch);
  let active = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (response[y * width + x] >= thr) {
        local[(y - y0) * cw + (x - x0)] = 1;
        active++;
      }
    }
  }
  // 快速路径:单元内无 tophat 响应,跳过连通域分配与遍历
  if (active === 0) return { components: 0, linePixels: 0, blobPixels: 0 };
  const seen = new Uint8Array(cw * ch);
  let components = 0;
  let linePixels = 0;
  let blobPixels = 0;
  // 纸褶与石花几何形状相近(都近圆),改用尺寸 + 填充率区分:
  // 纸褶 = 少数大尺寸稀疏域;石花 = 大量小尺寸饱满颗粒
  const LINE_MIN_DIM = 18;
  const LINE_FILL = 0.35;
  const BLOB_MAX_DIM = 14;
  const BLOB_FILL = 0.3;
  for (let i = 0; i < local.length; i++) {
    if (!local[i] || seen[i]) continue;
    const queue = [i];
    seen[i] = 1;
    let cnt = 0;
    let minX = cw;
    let maxX = 0;
    let minY = ch;
    let maxY = 0;
    while (queue.length > 0) {
      const p = queue.pop()!;
      cnt++;
      const px = p % cw;
      const py = (p / cw) | 0;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      const neighbors = [
        px > 0 ? p - 1 : -1,
        px < cw - 1 ? p + 1 : -1,
        py > 0 ? p - cw : -1,
        py < ch - 1 ? p + cw : -1,
      ];
      for (const nb of neighbors) {
        if (nb >= 0 && local[nb] && !seen[nb]) {
          seen[nb] = 1;
          queue.push(nb);
        }
      }
    }
    components++;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const fill = cnt / (bw * bh);
    const maxDim = Math.max(bw, bh);
    // 纸褶:大尺寸、低填充的稀疏连通域
    if (cnt >= 8 && maxDim >= LINE_MIN_DIM && fill < LINE_FILL) {
      linePixels += cnt;
    }
    // 石花:小尺寸、高填充的饱满颗粒
    if (cnt >= 3 && maxDim <= BLOB_MAX_DIM && fill >= BLOB_FILL) {
      blobPixels += cnt;
    }
  }
  return { components, linePixels, blobPixels };
}

export { areaDownsample };
