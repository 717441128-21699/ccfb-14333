/**
 * 主应用:四个角色视图 + 性能基准。
 *  - library  老先生:全部拓片评分总览,按分排序,颜色一眼看出好坏
 *  - detail   拓工:单张热力图 + 缺陷框,标明哪类缺陷在哪个位置
 *  - stele    库管:按碑分组,组内排序,第一名标注为主图
 *  - stats    主任:拓工×年份质量分布
 *  - benchmark:6000×9000 大图 3 秒性能预算验证
 */
import type { RubricKey, ScoreResult } from '../core/types';
import { RUBRIC_KEYS, RUBRIC_LABELS, RUBRIC_COLORS } from '../core/types';
import { buildScoredState, groupByStele, craftsmanYearStats, scoreDistribution, type AppState } from './state';
import { drawThumbnail, drawHeatmap, drawDefectBoxes, scoreBarsHtml } from './render';
import { generateRubbing } from '../core/synthetic';
import { grayToRgba } from '../core/imageops';
import { extractCells } from '../core/features';
import { scoreImageCpu } from '../core/scorer';
import { ScoringService } from '../gl/service';

const state: AppState = {
  items: [],
  results: [],
  selectedId: null,
  view: 'library',
  backend: 'cpu',
  weights: { ink: 0.3, sharpness: 0.35, flatness: 0.15, flower: 0.2 },
};

const app = document.getElementById('app')!;

function scoreColor(score: number): string {
  if (score >= 85) return '#2ecc71';
  if (score >= 70) return '#f1c40f';
  if (score >= 55) return '#e67e22';
  return '#e74c3c';
}

function navHtml(): string {
  const items: [AppState['view'], string][] = [
    ['library', '评分总览(老先生)'],
    ['stele', '按碑分组(库管)'],
    ['stats', '质量统计(主任)'],
    ['benchmark', '性能基准(6000×9000)'],
  ];
  return `<nav class="topnav">
    <span class="brand">拓片质量评分系统</span>
    ${items.map(([v, label]) => `<button class="nav-btn ${state.view === v ? 'active' : ''}" data-view="${v}">${label}</button>`).join('')}
    <span class="backend-tag">后端:${state.backend}</span>
  </nav>`;
}

function render(): void {
  let body = '';
  switch (state.view) {
    case 'library': body = libraryView(); break;
    case 'detail': body = detailView(); break;
    case 'stele': body = steleView(); break;
    case 'stats': body = statsView(); break;
    case 'benchmark': body = benchmarkView(); break;
  }
  app.innerHTML = navHtml() + `<main class="view">${body}</main>`;
  bindEvents();
  afterRender();
}

/* ---------------- 老先生:评分总览 ---------------- */
function libraryView(): string {
  const sorted = [...state.results].sort((a, b) => b.overall - a.overall);
  return `
    <h2>拓片评分总览(共 ${sorted.length} 张,按综合分降序)</h2>
    <p class="hint">颜色:绿≥85 优 · 黄≥70 良 · 橙≥55 中 · 红&lt;55 需重拓。点击卡片查看拓工标注。</p>
    <div class="card-grid">
      ${sorted.map((r) => {
        return `
        <div class="rub-card" data-id="${r.meta.id}" data-action="open">
          <canvas data-thumb="${r.meta.id}"></canvas>
          <div class="rub-card-body">
            <div class="rub-id">${r.meta.id}</div>
            <div class="rub-stele">${r.meta.steleName ?? r.meta.steleId}</div>
            <div class="rub-overall" style="color:${scoreColor(r.overall)}">${r.overall.toFixed(1)}</div>
            <div class="rub-meta">${r.meta.craftsman} · ${r.meta.year}</div>
            <div class="rub-dots">
              ${RUBRIC_KEYS.map((k) => `<span class="dot" style="background:${scoreColor(r.rubrics[k].score)}" title="${RUBRIC_LABELS[k]} ${r.rubrics[k].score.toFixed(1)}"></span>`).join('')}
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

/* ---------------- 拓工:单张缺陷标注 ---------------- */
function detailView(): string {
  const r = state.results.find((x) => x.meta.id === state.selectedId);
  if (!r) return '<p>未选择拓片</p>';
  const item = state.items.find((i) => i.meta.id === r.meta.id)!;
  return `
    <button class="back-btn" data-action="back">← 返回</button>
    <h2>${r.meta.id} <small>${item.meta.steleName}</small></h2>
    <div class="detail-layout">
      <div class="detail-canvas-wrap">
        <h3>缺陷位置标注(拓工视图)</h3>
        <canvas data-defect></canvas>
        <h3>分项热力图</h3>
        <div class="heatmap-tabs">
          ${RUBRIC_KEYS.map((k, i) => `<button class="heat-tab ${i === 0 ? 'active' : ''}" data-heat="${k}">${RUBRIC_LABELS[k]}</button>`).join('')}
        </div>
        <canvas data-heatmap></canvas>
      </div>
      <div class="detail-side">
        <div class="overall-big" style="color:${scoreColor(r.overall)}">${r.overall.toFixed(1)}</div>
        <div class="overall-label">综合分</div>
        ${scoreBarsHtml(r)}
        <h3>检测到的缺陷区域(${r.defects.length})</h3>
        <ul class="defect-list">
          ${r.defects.slice(0, 12).map((d) => `
            <li style="border-left-color:${RUBRIC_COLORS[d.rubric]}">
              <b>${d.label}</b> · 严重度 ${(d.severity * 100).toFixed(0)}% ·
              位置(${d.bbox.x},${d.bbox.y}) ${d.bbox.w}×${d.bbox.h}px
            </li>`).join('') || '<li>无显著缺陷</li>'}
        </ul>
        <div class="ref-box">
          <h4>专家参考分(合成数据)</h4>
          <div>综合:${r.reference?.overall.toFixed(1) ?? '-'}</div>
          ${RUBRIC_KEYS.map((k) => `<div>${RUBRIC_LABELS[k]}:${r.reference?.rubrics[k].toFixed(1) ?? '-'}</div>`).join('')}
        </div>
        <div class="engine-box">引擎:${r.engine.backend} · 耗时 ${r.engine.durationMs.toFixed(1)}ms</div>
      </div>
    </div>`;
}

/* ---------------- 库管:按碑分组 + 主图 ---------------- */
function steleView(): string {
  const groups = groupByStele(state.results);
  return `
    <h2>按碑分组(每组第一张为主图候选)</h2>
    <p class="hint">同碑多张拓本按综合分降序,首位带「主图」徽标。</p>
    ${groups.map((g) => `
      <section class="stele-group">
        <h3>${g.steleName ?? g.steleId} <small>${g.steleId} · ${g.items.length} 张</small></h3>
        <div class="stele-row">
          ${g.items.map((r, idx) => {
            const isBest = idx === 0;
            return `
            <div class="stele-item ${isBest ? 'best' : ''}" data-id="${r.meta.id}" data-action="open">
              ${isBest ? '<span class="main-badge">主图</span>' : ''}
              <canvas data-thumb="${r.meta.id}"></canvas>
              <div class="stele-score" style="color:${scoreColor(r.overall)}">${r.overall.toFixed(1)}</div>
              <div class="stele-craft">${r.meta.craftsman}·${r.meta.year}</div>
            </div>`;
          }).join('')}
        </div>
      </section>`).join('')}`;
}

/* ---------------- 主任:拓工×年份统计 ---------------- */
function statsView(): string {
  const stats = craftsmanYearStats(state.results);
  const dist = scoreDistribution(state.results, 10);
  const maxCount = Math.max(...dist.map((b) => b.count), 1);
  return `
    <h2>质量分布统计(主任视图)</h2>
    <h3>全库分数段分布</h3>
    <div class="dist-chart">
      ${dist.map((b) => `
        <div class="dist-col" title="${b.label}: ${b.count}张">
          <div class="dist-bar" style="height:${(b.count / maxCount) * 160}px"></div>
          <div class="dist-count">${b.count}</div>
          <div class="dist-label">${b.label}</div>
        </div>`).join('')}
    </div>
    <h3>拓工 × 年份质量</h3>
    <table class="stats-table">
      <thead><tr><th>拓工</th><th>年份</th><th>数量</th><th>均分</th><th>中位</th><th>最低</th><th>最高</th>${RUBRIC_KEYS.map((k) => `<th>${RUBRIC_LABELS[k]}</th>`).join('')}</tr></thead>
      <tbody>
        ${stats.map((s) => `
          <tr>
            <td>${s.craftsman}</td><td>${s.year}</td><td>${s.count}</td>
            <td style="color:${scoreColor(s.mean)}"><b>${s.mean.toFixed(1)}</b></td>
            <td>${s.median.toFixed(1)}</td><td>${s.min.toFixed(1)}</td><td>${s.max.toFixed(1)}</td>
            ${RUBRIC_KEYS.map((k: RubricKey) => `<td>${s.rubricMeans[k].toFixed(1)}</td>`).join('')}
          </tr>`).join('')}
      </tbody>
    </table>`;
}

/* ---------------- 性能基准 ---------------- */
function benchmarkView(): string {
  return `
    <h2>大图性能基准(目标:6000×9000 在 3 秒内)</h2>
    <div class="bench-controls">
      <label>宽度 <input id="bench-w" type="number" value="1200" step="400"></label>
      <label>高度 <input id="bench-h" type="number" value="1800" step="400"></label>
      <button id="bench-run">运行基准(当前后端:${state.backend})</button>
      <button id="bench-gl">切换到 WebGL2(若可用)</button>
    </div>
    <div id="bench-result" class="bench-result">点击运行,将生成指定尺寸合成拓片并计时评分。</div>`;
}

function runBenchmark(): void {
  const w = Number((document.getElementById('bench-w') as HTMLInputElement).value);
  const h = Number((document.getElementById('bench-h') as HTMLInputElement).value);
  const out = document.getElementById('bench-result')!;
  out.textContent = `生成 ${w}×${h} 合成拓片中...`;
  const t0 = performance.now();
  const { image } = generateRubbing({ width: w, height: h, seed: 31337, glyphSeed: 60000, params: { inkLevel: 0.5, inkUneven: 0.4, wear: 0.3, wrinkle: 0.3, stoneFlower: 0.3 } });
  const genMs = performance.now() - t0;
  out.textContent = `生成耗时 ${genMs.toFixed(0)}ms,评分中...`;
  const meta = { id: 'BENCH', steleId: 'B', craftsman: '基准', year: 2024, source: 'bench', width: w, height: h, createdAt: new Date().toISOString() };
  const t1 = performance.now();
  let result: ScoreResult;
  if (state.backend === 'webgl2') {
    const service = new ScoringService();
    state.backend = service.backend;
    result = service.score(meta, grayToRgba(image));
    service.dispose();
  } else {
    result = scoreImageCpu(meta, image);
  }
  const scoreMs = performance.now() - t1;
  const total = performance.now() - t0;
  const budget = 3000;
  out.innerHTML = `
    <div class="bench-stats">
      <div>尺寸:<b>${w}×${h}</b>(${(w * h / 1e6).toFixed(1)} 百万像素)</div>
      <div>合成生成:${genMs.toFixed(0)}ms</div>
      <div>评分管线:<b>${scoreMs.toFixed(0)}ms</b>(后端 ${result.engine.backend})</div>
      <div>总耗时:${total.toFixed(0)}ms</div>
      <div class="${scoreMs <= budget ? 'pass' : 'fail'}">3 秒预算:${scoreMs <= budget ? '✓ 达标' : `✗ 超预算 ${(scoreMs / budget).toFixed(1)}×`}</div>
      <div>综合分:${result.overall.toFixed(1)} ${JSON.stringify(Object.fromEntries(Object.entries(result.rubrics).map(([k, v]) => [k, v.score.toFixed(1)])))}</div>
    </div>`;
}

/* ---------------- 事件与渲染后回调 ---------------- */
function bindEvents(): void {
  app.querySelectorAll<HTMLElement>('[data-view]').forEach((el) => {
    el.onclick = () => {
      state.view = el.dataset.view as AppState['view'];
      render();
    };
  });
  app.querySelectorAll<HTMLElement>('[data-action="open"]').forEach((el) => {
    el.onclick = () => {
      state.selectedId = el.dataset.id!;
      state.view = 'detail';
      render();
    };
  });
  const back = app.querySelector<HTMLElement>('[data-action="back"]');
  if (back) back.onclick = () => { state.view = 'library'; render(); };
  const run = document.getElementById('bench-run') as HTMLButtonElement | null;
  if (run) run.onclick = () => runBenchmark();
  const glBtn = document.getElementById('bench-gl') as HTMLButtonElement | null;
  if (glBtn) glBtn.onclick = () => {
    const service = new ScoringService();
    state.backend = service.backend;
    service.dispose();
    render();
  };
}

function afterRender(): void {
  // 缩略图
  app.querySelectorAll<HTMLCanvasElement>('[data-thumb]').forEach((canvas) => {
    const item = state.items.find((i) => i.meta.id === canvas.dataset.thumb);
    if (item) drawThumbnail(canvas, item.image, 160);
  });
  // 详情图
  const r = state.results.find((x) => x.meta.id === state.selectedId);
  const item = state.items.find((i) => i.meta.id === r?.meta.id);
  const defectCanvas = app.querySelector<HTMLCanvasElement>('[data-defect]');
  const heatCanvas = app.querySelector<HTMLCanvasElement>('[data-heatmap]');
  if (r && item && defectCanvas) drawDefectBoxes(defectCanvas, item.image, r.defects);
  if (r && item && heatCanvas) {
    const { grid } = extractCells(item.image);
    let activeHeat: RubricKey = 'ink';
    drawHeatmap(heatCanvas, item.image, grid, r.cellSeverity[activeHeat]);
    app.querySelectorAll<HTMLElement>('[data-heat]').forEach((tab) => {
      tab.onclick = () => {
        app.querySelectorAll('[data-heat]').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        activeHeat = tab.dataset.heat as RubricKey;
        drawHeatmap(heatCanvas, item.image, grid, r.cellSeverity[activeHeat]);
      };
    });
  }
}

export function startApp(): void {
  const loading = document.getElementById('loading')!;
  loading.textContent = '正在生成合成拓片数据集并评分...';
  setTimeout(() => {
    const { items, results } = buildScoredState((done, total) => {
      loading.textContent = `评分中 ${done}/${total}...`;
    });
    state.items = items;
    state.results = results;
    // 列表统一走 CPU(确定性、可复现);WebGL2 在性能基准页显式启用对照
    state.backend = 'cpu';
    render();
  }, 30);
}
