/**
 * Canvas 渲染:合成拓片缩略图、单元热力图叠加、缺陷区域框标注。
 */
import type { CellGrid, DefectRegion, GrayImage, RubricKey, ScoreResult } from '../core/types';
import { DEFECT_LABELS, RUBRIC_COLORS, RUBRIC_KEYS } from '../core/types';

/** 灰度图绘制到 canvas(放大到目标尺寸) */
export function drawGrayImage(canvas: HTMLCanvasElement, img: GrayImage): void {
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  const out = ctx.createImageData(img.width, img.height);
  for (let i = 0; i < img.data.length; i++) {
    const v = Math.round(Math.min(1, Math.max(0, img.data[i])) * 255);
    out.data[i * 4] = v;
    out.data[i * 4 + 1] = v;
    out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
}

const SEVERITY_COLORS: [number, number, number][] = [
  [46, 204, 113], // 绿(好)
  [241, 196, 15], // 黄
  [230, 126, 34], // 橙
  [231, 76, 60], // 红(差)
];

function severityColor(sev: number): [number, number, number] {
  const idx = Math.min(3, Math.floor(sev * 4));
  return SEVERITY_COLORS[idx];
}

/** 在图上叠加指定评分项的单元热力图 */
export function drawHeatmap(
  canvas: HTMLCanvasElement,
  img: GrayImage,
  grid: CellGrid,
  severity: Float32Array,
  alpha = 0.45,
): void {
  drawGrayImage(canvas, img);
  const ctx = canvas.getContext('2d')!;
  const cs = grid.cellSize;
  const overlay = ctx.createImageData(grid.imageWidth, grid.imageHeight);
  for (let i = 0; i < grid.cells.length; i++) {
    const cx = i % grid.width;
    const cy = Math.floor(i / grid.width);
    const [r, g, b] = severityColor(severity[i]);
    const a = Math.round(severity[i] * 255 * alpha);
    const x0 = cx * cs;
    const y0 = cy * cs;
    for (let y = y0; y < Math.min(grid.imageHeight, y0 + cs); y++) {
      for (let x = x0; x < Math.min(grid.imageWidth, x0 + cs); x++) {
        const p = (y * grid.imageWidth + x) * 4;
        overlay.data[p] = r;
        overlay.data[p + 1] = g;
        overlay.data[p + 2] = b;
        overlay.data[p + 3] = a;
      }
    }
  }
  ctx.putImageData(overlay, 0, 0);
}

/** 在图上绘制缺陷区域标注框(拓工视图:标明是哪类缺陷、在哪) */
export function drawDefectBoxes(
  canvas: HTMLCanvasElement,
  img: GrayImage,
  defects: DefectRegion[],
  maxRegions = 12,
): void {
  drawGrayImage(canvas, img);
  const ctx = canvas.getContext('2d')!;
  const top = defects.slice(0, maxRegions);
  ctx.lineWidth = Math.max(2, img.width / 200);
  ctx.font = `${Math.max(12, img.width / 28)}px sans-serif`;
  for (const d of top) {
    const color = RUBRIC_COLORS[d.rubric];
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.strokeRect(d.bbox.x, d.bbox.y, d.bbox.w, d.bbox.h);
    const label = d.label;
    const metrics = ctx.measureText(label);
    const ty = Math.max(14, d.bbox.y - 4);
    ctx.fillRect(d.bbox.x, ty - 12, metrics.width + 8, 16);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, d.bbox.x + 4, ty);
  }
}

/** 小尺寸缩略图(列表用),内部用离屏 canvas 缩放 */
export function drawThumbnail(canvas: HTMLCanvasElement, img: GrayImage, maxW: number): void {
  const off = document.createElement('canvas');
  drawGrayImage(off, img);
  const scale = Math.min(1, maxW / img.width);
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
}

/** 评分条(四分项)渲染为 HTML 字符串 */
export function scoreBarsHtml(result: ScoreResult): string {
  return RUBRIC_KEYS.map((k: RubricKey) => {
    const r = result.rubrics[k];
    const [rr, gg, bb] = severityColor(r.severity);
    return `
      <div class="score-bar-row">
        <span class="score-bar-label">${r.label}</span>
        <div class="score-bar-track">
          <div class="score-bar-fill" style="width:${r.score}%;background:rgb(${rr},${gg},${bb})"></div>
        </div>
        <span class="score-bar-value">${r.score.toFixed(1)}</span>
      </div>`;
  }).join('');
}

export { DEFECT_LABELS };
