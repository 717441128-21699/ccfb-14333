/**
 * GL 引擎 readPixels 之后的 CPU 归约逻辑(从 engine.ts 抽出的纯函数版)。
 * 与 src/core/features.ts 的 extractCells 共用同一套单元归约与连通域判据,
 * 本文件让该逻辑在无 WebGL 的 Node 测试环境中可直接做 parity 对照。
 */
import type { CellGrid, CellStats, GrayImage } from '../core/types';
import { DEFAULT_FEATURE_CONFIG, type FeatureConfig } from '../core/features';

/** 与 features.ts 相同的 tophat 连通域判据 */
export function analyzeTophatComponents(
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
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (response[y * width + x] >= thr) local[(y - y0) * cw + (x - x0)] = 1;
    }
  }
  const seen = new Uint8Array(cw * ch);
  let components = 0;
  let linePixels = 0;
  let blobPixels = 0;
  for (let i = 0; i < local.length; i++) {
    if (!local[i] || seen[i]) continue;
    const queue = [i];
    seen[i] = 1;
    let cnt = 0;
    let minX = cw, maxX = 0, minY = ch, maxY = 0;
    while (queue.length) {
      const p = queue.pop()!;
      cnt++;
      const px = p % cw, py = (p / cw) | 0;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      for (const nb of [
        px > 0 ? p - 1 : -1,
        px < cw - 1 ? p + 1 : -1,
        py > 0 ? p - cw : -1,
        py < ch - 1 ? p + cw : -1,
      ]) {
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
    if (cnt >= 8 && maxDim >= 18 && fill < 0.35) linePixels += cnt;
    if (cnt >= 3 && maxDim <= 14 && fill >= 0.3) blobPixels += cnt;
  }
  return { components, linePixels, blobPixels };
}

/**
 * 由 GPU 逐像素特征缓冲归约出 CellGrid。
 * 输入为着色器输出的全图逐像素数组(亮度/模糊/梯度/tophat/标志位),
 * 归约公式与 features.ts 完全一致。
 */
export function reduceFromPixelFeatures(
  gray: GrayImage,
  blur: Float32Array,
  mag: Float32Array,
  tophat: Float32Array,
  bright: Uint8Array,
  brightBnd: Uint8Array,
  edge: Uint8Array,
  strong: Uint8Array,
  threshold: number,
  cfg: FeatureConfig = DEFAULT_FEATURE_CONFIG,
): CellGrid {
  const { width, height, data } = gray;
  const cs = cfg.cellSize;
  const gw = Math.ceil(width / cs);
  const gh = Math.ceil(height / cs);
  const cells: CellStats[] = [];

  for (let cy = 0; cy < gh; cy++) {
    for (let cx = 0; cx < gw; cx++) {
      const x0 = cx * cs;
      const y0 = cy * cs;
      const x1 = Math.min(width, x0 + cs);
      const y1 = Math.min(height, y0 + cs);
      let n = 0, sumL = 0, sumL2 = 0;
      let inkCount = 0, inkSum = 0, inkSq = 0;
      let pureInkCount = 0, sumB = 0, sumB2 = 0;
      let edgeCount = 0, edgeMagSum = 0, strongEdgeCount = 0, strongEdgeMagSum = 0, gradSum = 0;
      let brightPixelCount = 0, brightCount = 0, brightBoundary = 0, brightAnomalySum = 0;
      let tophatSum = 0, tophatCount = 0;
      const orient = [0, 0, 0, 0];

      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = y * width + x;
          const L = data[p];
          const bL = blur[p];
          n++;
          sumL += L;
          sumL2 += L * L;
          if (L <= threshold) {
            inkCount++;
            inkSum += L;
            inkSq += L * L;
          } else {
            brightPixelCount++;
          }
          if (bL <= threshold) {
            pureInkCount++;
            sumB += bL;
            sumB2 += bL * bL;
          }
          const m = mag[p];
          gradSum += m;
          if (edge[p]) {
            edgeCount++;
            edgeMagSum += m;
            if (strong[p]) {
              strongEdgeCount++;
              strongEdgeMagSum += m;
            }
          }
          tophatSum += tophat[p];
          if (tophat[p] >= cfg.tophatThreshold) tophatCount++;
          if (bright[p]) {
            brightCount++;
            brightAnomalySum += L - threshold;
            if (brightBnd[p]) brightBoundary++;
          }
        }
      }

      const mean = sumL / n;
      const variance = Math.max(0, sumL2 / n - mean * mean);
      const inkMean = inkCount ? inkSum / inkCount : 0;
      const inkVar = inkCount ? Math.max(0, inkSq / inkCount - inkMean * inkMean) : 0;
      const pureInkMean = pureInkCount ? sumB / pureInkCount : 0;
      const pureInkStd = pureInkCount ? Math.sqrt(Math.max(0, sumB2 / pureInkCount - pureInkMean * pureInkMean)) : 0;
      const cc = analyzeTophatComponents(tophat, width, x0, y0, x1, y1, cfg.tophatThreshold);

      cells.push({
        n, mean, variance, inkMean, inkVar, inkCount,
        edgeMagSum, edgeCount, strongEdgeCount, strongEdgeMagSum, gradSum,
        brightRatio: brightPixelCount / n,
        pureInkCount, pureInkMean, pureInkStd,
        tophatSum, tophatCount, tophatComponents: cc.components,
        tophatLinePixels: cc.linePixels, tophatBlobPixels: cc.blobPixels,
        brightCount, brightBoundary, brightAnomalySum,
        orient: [orient[0], orient[1], orient[2], orient[3]],
        edgeMomentXx: 0, edgeMomentYy: 0, edgeMomentXy: 0,
      });
    }
  }
  return { width: gw, height: gh, cellSize: cs, imageWidth: width, imageHeight: height, cells };
}
