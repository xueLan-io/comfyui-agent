import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateGenerationTime, progressTimeEstimate } from '../src/runtime/generation-time-estimate.mjs';

test('AMD MiniMax H3 route forecasts a visible long-running task window', () => {
  const estimate = estimateGenerationTime({
    modelType: 'minimax_h3',
    settings: { width: 640, height: 352, frames: 124, steps: 20 },
    runtime: { backend: 'hip', gpu: { name: 'AMD GPU' } },
  });
  assert.equal(estimate.video, true);
  assert.ok(estimate.estimatedMs >= 450000 && estimate.estimatedMs <= 490000);
  assert.ok(estimate.minMs < estimate.estimatedMs);
  assert.ok(estimate.maxMs > estimate.estimatedMs);
});

test('progress time estimate calibrates remaining time from actual sampling progress', () => {
  const estimate = { estimatedMs: 480000 };
  const forecast = progressTimeEstimate(estimate, { startedAt: 0, now: 60000 });
  const calibrated = progressTimeEstimate(estimate, { startedAt: 0, now: 120000, percent: 20 });
  assert.equal(forecast.remainingMs, 420000);
  assert.equal(calibrated.remainingMs, 480000);
  assert.equal(calibrated.confidence, 'calibrated');
});

test('time estimate accepts null resolution and runtime', () => {
  const estimate = estimateGenerationTime({ modelType: 'minimax_h3', resolution: null, runtime: null });
  assert.equal(estimate.basis.width, 1024);
  assert.equal(estimate.basis.height, 1024);
  assert.equal(estimate.basis.amd, false);
});
