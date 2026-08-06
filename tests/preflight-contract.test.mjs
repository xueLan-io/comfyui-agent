import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPreflightReport, preflightError } from '../src/runtime/preflight-contract.mjs';

test('preflight report deduplicates issues and exposes model readiness', () => {
  const report = buildPreflightReport({
    issues: [
      { code: 'model_missing', severity: 'error', message: 'missing model' },
      { code: 'model_missing', severity: 'error', message: 'missing model' },
    ],
    modelRequirements: [{ value: 'model.safetensors', available: false }],
    modelType: 'wan',
  });

  assert.equal(report.valid, false);
  assert.equal(report.modelReady, false);
  assert.equal(report.issueCount, 1);
  assert.equal(report.errorCount, 1);
  assert.deepEqual(report.missingModels.map(item => item.value), ['model.safetensors']);
});

test('preflight errors carry the complete report for callers', () => {
  const report = buildPreflightReport({ adaptationOnly: true, modelType: 'minimax_h3' });
  const error = preflightError(report);

  assert.equal(error.failureType, 'adaptation_only');
  assert.equal(error.retryable, false);
  assert.equal(error.preflight.modelType, 'minimax_h3');
});

test('preflight report includes runtime and adapter capabilities', () => {
  const report = buildPreflightReport({
    modelType: 'wan',
    adapterCapabilities: { supportsVideoOutput: true },
    runtime: { gpu: { vendor: 'amd' }, ffmpeg: { available: true } },
  });

  assert.equal(report.adapterCapabilities.supportsVideoOutput, true);
  assert.equal(report.runtime.gpu.vendor, 'amd');
});

test('preflight report exposes resource estimate diagnostics', () => {
  const report = buildPreflightReport({
    modelType: 'wan',
    resourceEstimate: { estimatedVramMb: 16000, availableVramMb: 8000 },
  });

  assert.equal(report.resourceEstimate.estimatedVramMb, 16000);
  assert.equal(report.resourceEstimate.availableVramMb, 8000);
});
