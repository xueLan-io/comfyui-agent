import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateTechnical, buildEvaluation } from '../src/agent/schemas/evaluation-schema.mjs';
import { Evaluator } from '../src/agent/runtime/evaluator.mjs';

test('evaluateTechnical passes with images', () => {
  const result = evaluateTechnical({ images: [{ filename: 'a.png' }] });
  assert.equal(result.passed, true);
  assert.equal(result.score, 1);
});

test('evaluateTechnical fails with error', () => {
  const result = evaluateTechnical({ error: 'timeout' });
  assert.equal(result.passed, false);
  assert.equal(result.score, 0);
  assert.ok(result.detail.includes('timeout'));
});

test('evaluateTechnical fails with no images', () => {
  const result = evaluateTechnical({ images: [] });
  assert.equal(result.passed, false);
  assert.equal(result.score, 0);
});

test('buildEvaluation computes overall score', () => {
  const evaluation = buildEvaluation({
    technical: { passed: true, score: 1, detail: 'ok' },
    alignment: { passed: true, score: 1, detail: 'ok' },
    creative: { passed: true, score: 1, detail: 'ok' },
    issues: [],
    recommendation: { action: 'accept', modification: '', confidence: 1 },
  });
  assert.equal(evaluation.passed, true);
  assert.equal(evaluation.scores.overall, 1);
  assert.equal(evaluation.needsRetry, false);
});

test('Evaluator.evaluate returns full evaluation', async () => {
  const evaluator = new Evaluator();
  const result = await evaluator.evaluate(
    { images: [{ filename: 'a.png' }] },
    'test goal',
    { stepId: 's1' },
  );
  assert.equal(result.passed, true);
  assert.ok(result.scores);
  assert.ok(result.recommendation);
  assert.equal(result.needsRetry, false);
});

test('Evaluator evaluate fails on error result', async () => {
  const evaluator = new Evaluator();
  const result = await evaluator.evaluate(
    { error: 'generation failed' },
    'test goal',
    { stepId: 's2' },
  );
  assert.equal(result.passed, false);
  assert.equal(result.recommendation.action, 'retry');
});

test('Evaluator does not fabricate visual scores without a vision model', async () => {
  const result = await new Evaluator().evaluate({ images: [{ filename: 'a.png' }] }, 'goal');
  assert.equal(result.technical, 'passed');
  assert.equal(result.constraint, 'unknown');
  assert.equal(result.creative, 'not_evaluated');
  assert.equal(result.scores.alignment, null);
  assert.equal(result.scores.creative, null);
});

test('Evaluator with a null provider keeps local constraint and creative scores', async () => {
  const result = await new Evaluator(null, {}).evaluate({ images: [{ filename: 'a.png' }] }, 'goal');
  assert.equal(result.constraint, 'unknown');
  assert.equal(result.creative, 'not_evaluated');
  assert.equal(result.passed, true);
});

test('technical evaluation checks output files, batch, and node errors', () => {
  const result = evaluateTechnical({
    images: [{ filename: 'a.png' }],
    executionStatus: 'success',
    expectedBatch: 2,
    imageChecks: [{ filename: 'a.png', exists: true, readable: true, validFormat: false }],
    nodeErrors: ['execution_error'],
  });
  assert.equal(result.passed, false);
  assert.match(result.detail, /Expected 2 image/);
  assert.match(result.detail, /Invalid image format/);
  assert.match(result.detail, /Node execution error/);
});
