import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeExecutionContext, assertExecutionContext } from '../src/agent/schemas/execution-context.mjs';

test('new generation context never inherits a media target', () => {
  const context = normalizeExecutionContext({
    intent: 'generate',
    target: 'new',
    request: '生成一只猫',
    media: { images: [{ name: 'old.png' }] },
  });

  assert.equal(context.target, 'new');
  assert.equal(context.mediaSource, 'none');
  assert.doesNotThrow(() => assertExecutionContext(context));
});

test('refinement context preserves the selected historical source', () => {
  const context = normalizeExecutionContext({
    intent: 'refine',
    target: 'last_generation',
    request: '上一张换成夜景',
    sourceTurnId: 'turn_1',
  });

  assert.equal(context.mediaSource, 'last_generation');
  assert.equal(context.turnId, 'turn_1');
  assert.doesNotThrow(() => assertExecutionContext(context));
});

test('edit context with current media selects the attached source', () => {
  const context = normalizeExecutionContext({
    intent: 'edit',
    target: 'attached_media',
    request: '把这张图改成油画',
    media: { images: [{ name: 'reference.png' }] },
  });

  assert.equal(context.mediaSource, 'attached_media');
  assert.doesNotThrow(() => assertExecutionContext(context));
});

test('non-generation intents cannot enter the executor', () => {
  assert.throws(
    () => assertExecutionContext(normalizeExecutionContext({ intent: 'prompt_edit', action: 'reply' })),
    /cannot create a generation execution/,
  );
});

test('missing execution context is rejected before execution', () => {
  assert.throws(
    () => assertExecutionContext(normalizeExecutionContext({ intent: 'edit', target: 'none', missing: ['reference_media'] })),
    /Execution context is missing/,
  );
});

test('execution context derives media source from target', () => {
  const context = normalizeExecutionContext({ intent: 'generate', target: 'new', mediaSource: 'last_generation' });
  assert.equal(context.mediaSource, 'none');
  assert.doesNotThrow(() => assertExecutionContext(context));
});

test('execution context rejects a mismatched media source', () => {
  assert.throws(
    () => assertExecutionContext({ ...normalizeExecutionContext({ intent: 'edit', target: 'attached_media' }), mediaSource: 'last_generation' }),
    /does not match media source/,
  );
});
