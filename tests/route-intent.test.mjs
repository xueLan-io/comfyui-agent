import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/agent/runtime/agent.mjs';

function makeAgent() {
  return new Agent({ llmConfig: { provider: 'openai-compatible', model: 'gpt-4o' } });
}

test('routeIntent downgrades a pending refine to generate for an explicit new generation', async () => {
  const agent = makeAgent();
  agent.sessionManager.setSessionState({
    pending: { request: '帮我优化一下画面', intent: 'refine', missing: ['previous_generation'], question: '请先生成一张图片，或附加要修改的参考图。' },
  });

  const result = await agent.routeIntent('就生成一只猫吧', {});

  assert.equal(result.intent, 'generate');
  assert.equal(result.action, 'prepare');
  assert.equal(result.target, 'new');
});

test('routeIntent downgrades a pending edit to generate for an explicit new generation', async () => {
  const agent = makeAgent();
  agent.sessionManager.setSessionState({
    pending: { request: '图生图做一张', intent: 'edit', missing: ['reference_media'], question: '请先附加参考图片。' },
  });

  const result = await agent.routeIntent('算了，就生成一只猫吧', {});

  assert.equal(result.intent, 'generate');
  assert.equal(result.action, 'prepare');
});

test('routeIntent keeps clarifying when the follow-up is still an edit direction', async () => {
  const agent = makeAgent();
  agent.sessionManager.setSessionState({
    pending: { request: '把这张图改一下', intent: 'edit', missing: ['reference_media'], question: '请先附加参考图片。' },
  });

  const result = await agent.routeIntent('把颜色改成红色', {});

  assert.equal(result.intent, 'edit');
  assert.equal(result.action, 'clarify');
  assert.ok(result.missing.includes('reference_media'));
});

test('routeIntent keeps refine clarification for a refinement-only follow-up', async () => {
  const agent = makeAgent();
  agent.sessionManager.setSessionState({
    pending: { request: '帮我优化一下画面', intent: 'refine', missing: ['previous_generation'], question: '请先生成一张图片，或附加要修改的参考图。' },
  });

  const result = await agent.routeIntent('把颜色改成红色', {});

  assert.equal(result.intent, 'refine');
  assert.equal(result.action, 'clarify');
  assert.ok(result.missing.includes('previous_generation'));
});
