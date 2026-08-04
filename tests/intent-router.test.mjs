import assert from 'node:assert/strict';
import test from 'node:test';
import { isExplicitNewGeneration, ruleIntent } from '../src/agent/runtime/intent-router.mjs';

function decision(message, context = {}) {
  return ruleIntent(message, {
    conversation: [],
    sessionMemory: {},
    sessionState: {},
    lastPrompt: '',
    lastImages: [],
    attachedMedia: null,
    ...context,
  });
}

test('isExplicitNewGeneration ignores explicit image references', () => {
  assert.equal(isExplicitNewGeneration('生成一只猫'), true);
  assert.equal(isExplicitNewGeneration('帮我优化一下，生成一只猫'), true);
  assert.equal(isExplicitNewGeneration('调整一下画面，生成一张图'), true);
  assert.equal(isExplicitNewGeneration('生成一张更好看的图'), true);
  assert.equal(isExplicitNewGeneration('加强光影，画一个女孩'), true);
  assert.equal(isExplicitNewGeneration('把这张图改得更好看'), false);
  assert.equal(isExplicitNewGeneration('重绘这张图'), false);
  assert.equal(isExplicitNewGeneration('刚才生成的图改一下'), false);
  assert.equal(isExplicitNewGeneration('再来一张'), false);
});

test('ruleIntent classifies explicit new generation as generate despite refinement words', () => {
  for (const message of ['帮我优化一下，生成一只猫', '调整一下画面，生成一张图', '生成一张更好看的图', '加强光影，画一个女孩']) {
    const result = decision(message);
    assert.equal(result.intent, 'generate', message);
    assert.equal(result.action, 'prepare', message);
    assert.equal(result.target, 'new', message);
  }
});

test('ruleIntent keeps a new generation when a previous image exists', () => {
  const result = decision('生成一张更好看的图', { lastImages: [{ name: 'prev.png' }], lastPrompt: 'a cat' });
  assert.equal(result.intent, 'generate');
  assert.equal(result.target, 'new');
});

test('ruleIntent keeps explicit image edits as edit', () => {
  for (const message of ['把这张图改得更好看', '重绘这张图', '图生图', '把这张图，帮我调整一下', '用参考图换背景']) {
    const result = decision(message);
    assert.equal(result.intent, 'edit', message);
    assert.equal(result.action, 'prepare', message);
  }
});

test('ruleIntent keeps a refine request that does not ask for a new generation', () => {
  const result = decision('把颜色改成红色');
  assert.equal(result.intent, 'refine');
  assert.ok(result.missing.includes('previous_generation'));
});

test('ruleIntent keeps regenerate-same-phrasing as refine', () => {
  const result = decision('再来一张');
  assert.equal(result.intent, 'refine');
  assert.ok(result.missing.includes('previous_generation'));
});

test('ruleIntent pending follow-up inherits refine even for a new generation phrase', () => {
  const result = decision('就生成一只猫吧', {
    sessionState: { pending: { request: '帮我优化一下画面', intent: 'refine', missing: ['previous_generation'], question: '请先生成一张图片' } },
  });
  assert.equal(result.intent, 'refine');
  assert.equal(result.action, 'prepare');
});
