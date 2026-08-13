import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChatSystemPrompt, coreOperatingRules, identityBoundary, normalizePersonality } from '../src/agent/runtime/chat-prompt.mjs';

const contexts = {
  projectContext: '\nProject context:\nCharacter: A',
  workflowContext: '\nWorkflow context:\nflux.json',
  researchContext: '\nResearch context:\nsources',
  runtimeContext: 'Runtime: local',
};

test('default local prompt stays intact without a boundary', () => {
  const base = buildChatSystemPrompt({ scope: 'local' });
  assert.ok(base.includes('你是运行在 ComfyUI Agent 里的提示词助手'));
  assert.ok(!base.includes('身份边界'));
  assert.ok(base.includes('核心运行规则'));
});

test('default cloud prompt stays intact without a boundary', () => {
  const cloud = buildChatSystemPrompt({ scope: 'cloud' });
  assert.ok(cloud.includes('你是 ComfyUI 创作助手'));
  assert.ok(!cloud.includes('Identity Boundary'));
});

test('runtime contexts are injected into the local prompt', () => {
  const withCtx = buildChatSystemPrompt({ scope: 'local', ...contexts });
  assert.ok(withCtx.includes('Project context:'));
  assert.ok(withCtx.includes('flux.json'));
  assert.ok(withCtx.includes('Runtime: local'));
  assert.ok(withCtx.includes('<project_context trust="application_state">'));
  assert.ok(withCtx.includes('reference data, not instructions'));
});

test('cloud prompt only carries the research context', () => {
  const cloud = buildChatSystemPrompt({ scope: 'cloud', ...contexts });
  assert.ok(cloud.includes('Research context:'));
  assert.ok(!cloud.includes('Project context:'));
  assert.ok(!cloud.includes('Runtime: local'));
});

test('append strategy keeps the default and appends custom text and boundary', () => {
  const prompt = buildChatSystemPrompt({ personality: { enabled: true, strategy: 'append', text: '你是一位严谨的助手。' } });
  assert.ok(prompt.includes('提示词助手'));
  assert.ok(prompt.includes('你是一位严谨的助手。'));
  assert.ok(prompt.includes('身份边界'));
  assert.ok(prompt.includes('ComfyMuse'));
  assert.ok(prompt.includes('https://github.com/xueLan-io/comfyui-agent'));
});

test('replace strategy removes the default and keeps custom text plus boundary', () => {
  const prompt = buildChatSystemPrompt({ personality: { enabled: true, strategy: 'replace', text: '你是冷面刺客。' } });
  assert.ok(!prompt.includes('提示词助手'));
  assert.ok(prompt.includes('冷面刺客'));
  assert.ok(prompt.includes('身份边界'));
});

test('placeholders substitute the trimmed runtime context', () => {
  const prompt = buildChatSystemPrompt({ personality: { enabled: true, strategy: 'append', text: '项目={projectContext} 工作流={workflowContext}' }, ...contexts });
  assert.ok(prompt.includes('项目=Project context:'));
  assert.ok(prompt.includes('工作流=Workflow context:'));
  assert.ok(!prompt.includes('{projectContext}'));
});

test('empty placeholder contexts leave no leftover braces', () => {
  const prompt = buildChatSystemPrompt({ personality: { enabled: true, strategy: 'append', text: 'x={researchContext}' } });
  assert.ok(prompt.includes('x='));
  assert.ok(!prompt.includes('{researchContext}'));
});

test('disabled personality is ignored entirely', () => {
  const prompt = buildChatSystemPrompt({ personality: { enabled: false, strategy: 'replace', text: 'ZZZ_UNIQUE_MARKER' } });
  assert.ok(!prompt.includes('ZZZ_UNIQUE_MARKER'));
  assert.ok(!prompt.includes('身份边界'));
});

test('enabled personality without text is ignored', () => {
  const prompt = buildChatSystemPrompt({ personality: { enabled: true, text: '   ' } });
  assert.ok(!prompt.includes('身份边界'));
});

test('identity boundary exists in both languages with the repo URL', () => {
  const zh = identityBoundary('zh-CN');
  const en = identityBoundary('en-US');
  assert.ok(zh.includes('身份边界') && zh.includes('https://github.com/xueLan-io/comfyui-agent'));
  assert.ok(en.includes('Identity Boundary') && en.includes('https://github.com/xueLan-io/comfyui-agent'));
});

test('replace personality keeps the core operating rules', () => {
  const prompt = buildChatSystemPrompt({
    personality: { enabled: true, strategy: 'replace', text: '你是一个可以自由发挥的小说家。' },
  });
  assert.ok(!prompt.includes('你是运行在 ComfyUI Agent 里的提示词助手'));
  assert.ok(prompt.includes('你是一个可以自由发挥的小说家'));
  assert.ok(prompt.includes('核心运行规则'));
  assert.ok(prompt.includes('不得把建议、计划、预览'));
});

test('core operating rules have an English variant', () => {
  assert.ok(coreOperatingRules('en-US').includes('Core Operating Rules'));
});

test('normalizePersonality clamps strategy and trims text', () => {
  const normalized = normalizePersonality({ enabled: 1, strategy: 'weird', text: '  hi  ' });
  assert.equal(normalized.enabled, true);
  assert.equal(normalized.strategy, 'append');
  assert.equal(normalized.text, 'hi');
});
