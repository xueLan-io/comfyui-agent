import assert from 'node:assert/strict';
import test from 'node:test';
import { assessPromptReadiness } from '../src/agent/tools/prompt/readiness.mjs';

test('edit without media requires reference_media', () => {
  const result = assessPromptReadiness({ request: '重绘这张图', intent: 'edit', media: {}, lastImages: [] });
  assert.equal(result.readiness, 'clarify');
  assert.ok(result.missing.includes('reference_media'));
  assert.match(result.question, /参考图/);
});

test('refine without previous generation requires previous_generation', () => {
  const result = assessPromptReadiness({ request: '把颜色改成红色', intent: 'refine', media: {}, lastImages: [], lastPrompt: '' });
  assert.equal(result.readiness, 'clarify');
  assert.ok(result.missing.includes('previous_generation'));
  assert.match(result.question, /请先生成一张图片/);
});

test('refine with a previous generation asks for the direction', () => {
  const result = assessPromptReadiness({ request: '改一下', intent: 'refine', media: {}, lastImages: [{ name: 'prev.png' }], lastPrompt: 'a cat' });
  assert.equal(result.readiness, 'clarify');
  assert.ok(result.missing.includes('refinement_direction'));
});

test('refine with direction and previous generation is ready', () => {
  const result = assessPromptReadiness({ request: '把颜色改成红色', intent: 'refine', media: {}, lastImages: [{ name: 'prev.png' }], lastPrompt: 'a cat' });
  assert.equal(result.readiness, 'ready');
});

test('generate with a subject is ready', () => {
  const result = assessPromptReadiness({ request: '生成一只猫', intent: 'generate', media: {}, lastImages: [], lastPrompt: '' });
  assert.equal(result.readiness, 'ready');
});

test('generate without subject requires subject', () => {
  const result = assessPromptReadiness({ request: '生成一张图', intent: 'generate', media: {}, lastImages: [], lastPrompt: '' });
  assert.equal(result.readiness, 'clarify');
  assert.ok(result.missing.includes('subject'));
});

test('generate re-assessment ignores refinement words after the command', () => {
  const result = assessPromptReadiness({ request: '帮我优化一下，生成一只猫', intent: 'generate', media: {}, lastImages: [], lastPrompt: '' });
  assert.equal(result.readiness, 'ready');
});
