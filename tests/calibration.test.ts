import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildCalibration, validateCalibration } from '../src/core/calibration';
import { CALIBRATION } from '../src/core/calibration.generated';
import type { RubricKey } from '../src/core/types';

/**
 * 校准流程:
 *   UPDATE_CALIBRATION=1 npx vitest run tests/calibration.test.ts
 * 会重写 src/core/calibration.generated.ts;普通测试运行只验证现有表。
 */
describe('校准表', () => {
  it('当前校准表在退化扫描上单调且 Spearman >= 0.85', () => {
    const { perRubric } = validateCalibration(CALIBRATION);
    for (const key of Object.keys(perRubric) as RubricKey[]) {
      console.log(`${key}: rho=${perRubric[key].spearman.toFixed(4)} monotonic=${perRubric[key].monotonic}`);
      expect(perRubric[key].monotonic).toBe(true);
      expect(perRubric[key].spearman).toBeGreaterThanOrEqual(0.85);
    }
  });

  it.runIf(process.env.UPDATE_CALIBRATION === '1')('生成新校准表并写盘', () => {
    const result = buildCalibration(24, 512);
    for (const key of Object.keys(result.calibration) as RubricKey[]) {
      const d = result.diagnostics[key];
      console.log(`${key} s0=${d.s0.toFixed(4)} s1=${d.s1.toFixed(4)}`);
    }
    const lines = [
      '/** 自动生成:scripts/calibrate(见 tests/calibration.test.ts),请勿手改 */',
      "import type { CalibrationTable } from './scorer';",
      '',
      'export const CALIBRATION: CalibrationTable = {',
    ];
    for (const key of Object.keys(result.calibration) as RubricKey[]) {
      const { s0, s1 } = result.calibration[key];
      lines.push(`  ${key}: { s0: ${s0.toFixed(6)}, s1: ${s1.toFixed(6)} },`);
    }
    lines.push('};', '');
    writeFileSync(resolve(__dirname, '../src/core/calibration.generated.ts'), lines.join('\n'), 'utf8');
    expect(true).toBe(true);
  });
});
