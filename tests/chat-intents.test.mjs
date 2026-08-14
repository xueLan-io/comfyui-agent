import assert from 'node:assert/strict';
import test from 'node:test';
import { isConfirmTurn, messageAttachments, needsWorkflowChatContext, wantsWebResearch, IDENTITY_QUERY } from '../src/agent/runtime/chat-intents.mjs';
import { AGENT_TOOL_MODULES, createAgentToolRegistry } from '../src/agent/runtime/agent-tools.mjs';

test('confirm-turn heuristics match confirmations in both languages', () => {
  for (const text of ['confirm', 'Confirm', 'yes', 'run', 'go', '确认', '确定', '执行', '开始', '执行生成', '确认执行。']) {
    assert.equal(isConfirmTurn(text), true, `should confirm: ${text}`);
  }
  for (const text of ['请确认一下工作流', '确认后再说', '帮我生成一张图', 'yes but add more detail', '']) {
    assert.equal(isConfirmTurn(text), false, `should not confirm: ${text}`);
  }
});

test('web research is gated by intent and local-query hints', () => {
  assert.equal(wantsWebResearch('搜索一下这个角色的设定', 'creative'), true);
  assert.equal(wantsWebResearch('查查官方资料', 'creative'), true);
  assert.equal(wantsWebResearch('https://example.com', 'creative'), true);
  assert.equal(wantsWebResearch('当前工作流的 seed 是多少', 'query'), false);
  assert.equal(wantsWebResearch('查一下队列里的任务', 'creative'), false);
  assert.equal(wantsWebResearch('', 'creative'), false);
});

test('workflow context is requested for query/prompt_edit/refine or hint phrases', () => {
  assert.equal(needsWorkflowChatContext('当前工作流用的什么采样器', 'creative'), true);
  assert.equal(needsWorkflowChatContext('hello', 'query'), true);
  assert.equal(needsWorkflowChatContext('hello', 'creative'), false);
});

test('identity queries are recognized by the identity regex', () => {
  for (const text of ['你是谁', '你是什么模型', 'who are you', '你能做什么', '你是什么ai']) {
    assert.equal(IDENTITY_QUERY.test(text), true, `should be identity: ${text}`);
  }
  assert.equal(IDENTITY_QUERY.test('帮我把提示词优化一下'), false);
});

test('message attachments normalize media paths and kinds', () => {
  assert.deepEqual(messageAttachments(), []);
  assert.deepEqual(messageAttachments(null), []);
  assert.deepEqual(messageAttachments({
    images: [{ path: 'C:\\x\\a.png' }, { name: 'b.png' }, {}],
    videos: [{ path: '/tmp/c.mp4' }],
  }), [
    { name: 'a.png', kind: 'image' },
    { name: 'b.png', kind: 'image' },
    { name: 'c.mp4', kind: 'video' },
  ]);
});

test('agent tool registry exposes the canonical tool surface', () => {
  const registry = createAgentToolRegistry();
  assert.ok(registry.byName);
  assert.equal(registry.byName.comfyui, registry.byName.comfyui);
  for (const required of ['comfyui', 'prompt_enhance', 'prompt_library', 'filesystem', 'filesystem_mutate', 'system', 'web', 'workflow_inspect', 'inspect_image', 'workflow_patch']) {
    assert.ok(registry.byName[required], `missing tool: ${required}`);
  }
  assert.ok(AGENT_TOOL_MODULES.length >= 10);
});
