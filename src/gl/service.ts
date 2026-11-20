/**
 * 评分服务:对外的统一入口,自动在 WebGL2 与 CPU 参考实现间切换。
 * GL 不可用时透明降级为 CPU,评分公式完全相同。
 */
import type { GrayImage, RgbaImage, RubricKey, RubbingMeta, ScoreResult } from '../core/types';
import { DEFAULT_WEIGHTS } from '../core/types';
import { scoreFromGrid } from '../core/scorer';
import { scoreImageCpu } from '../core/scorer';
import { GlScoringEngine, isWebGL2Supported } from './engine';

export interface ScoringServiceOptions {
  weights?: Record<RubricKey, number>;
  /** 强制 CPU(测试与对照用) */
  forceCpu?: boolean;
}

export class ScoringService {
  private engine: GlScoringEngine | null = null;
  private glAvailable: boolean;
  private canvas: HTMLCanvasElement | null = null;
  readonly weights: Record<RubricKey, number>;

  constructor(opts: ScoringServiceOptions = {}) {
    this.weights = opts.weights ?? { ...DEFAULT_WEIGHTS };
    if (opts.forceCpu || typeof document === 'undefined') {
      this.glAvailable = false;
      return;
    }
    this.canvas = document.createElement('canvas');
    this.glAvailable = isWebGL2Supported(this.canvas);
  }

  get backend(): 'webgl2' | 'cpu' {
    return this.glAvailable ? 'webgl2' : 'cpu';
  }

  private ensureEngine(): GlScoringEngine | null {
    if (!this.glAvailable || !this.canvas) return null;
    if (!this.engine) {
      this.engine = GlScoringEngine.create(this.canvas);
      if (!this.engine) this.glAvailable = false;
    }
    return this.engine;
  }

  /** 评分:接受 RGBA(浏览器上传路径)或灰度图(合成/测试路径) */
  score(meta: RubbingMeta, image: RgbaImage | GrayImage, reference?: ScoreResult['reference']): ScoreResult {
    if (!this.glAvailable) {
      const gray = isRgba(image) ? toGrayLocal(image) : image;
      return scoreImageCpu(meta, gray, { weights: this.weights, reference });
    }
    const engine = this.ensureEngine();
    if (!engine) {
      const gray = isRgba(image) ? toGrayLocal(image) : image;
      return scoreImageCpu(meta, gray, { weights: this.weights, reference });
    }
    const rgba = isRgba(image) ? image : grayToRgbaLocal(image);
    const t0 = performance.now();
    const { grid, threshold, edgeThreshold, polarityFlipped } = engine.extractCells(rgba);
    const result = scoreFromGrid(meta, grid, {
      weights: this.weights,
      backend: 'webgl2',
      durationMs: performance.now() - t0,
      threshold,
      edgeThreshold,
      polarityFlipped,
      reference,
    });
    return result;
  }

  dispose(): void {
    this.engine?.dispose();
    this.engine = null;
  }
}

function isRgba(image: RgbaImage | GrayImage): image is RgbaImage {
  return (image as RgbaImage).data instanceof Uint8ClampedArray;
}

// 局部导入避免节点环境下的循环依赖问题
import { toGray as toGrayLocal, grayToRgba as grayToRgbaLocal } from '../core/imageops';
