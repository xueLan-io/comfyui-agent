import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateGenerationResources } from '../src/runtime/resource-estimator.mjs';

test('resource estimator scales image VRAM with resolution and batch', () => {
  const result = estimateGenerationResources({
    modelType: 'sdxl',
    resolution: { width: 1024, height: 1024 },
    settings: { batch: 2 },
    runtime: { gpu: { vramFree: 24000, vramTotal: 24000 } },
  });

  assert.equal(result.video, false);
  assert.equal(result.width, 1024);
  assert.equal(result.batch, 2);
  assert.ok(result.estimatedVramMb > 5120);
  assert.equal(result.issues.length, 0);
});

test('resource estimator warns when video frames exceed available VRAM', () => {
  const result = estimateGenerationResources({
    modelType: 'wan',
    capabilities: { modes: ['txt2video'] },
    resolution: { width: 1280, height: 720 },
    settings: { batch: 1 },
    frames: 81,
    runtime: { gpu: { vramFree: 4096, vramTotal: 8192 } },
  });

  assert.equal(result.video, true);
  assert.equal(result.frames, 81);
  assert.ok(result.issues.some(issue => issue.code === 'vram_insufficient'));
  assert.equal(result.issues.find(issue => issue.code === 'vram_insufficient').severity, 'warning');
});

test('strict estimation records a severe shortage without forcing a block', () => {
  const result = estimateGenerationResources({
    modelType: 'flux',
    resolution: { width: 2048, height: 2048 },
    runtime: { gpu: { vramFree: 2048 } },
    strict: true,
  });

  assert.equal(result.issues[0].code, 'vram_insufficient');
  assert.equal(result.issues[0].severity, 'warning');
  assert.equal(result.issues[0].strictSeverity, 'error');
  assert.match(result.issues[0].message, /resolution|frames|batch/);
});
