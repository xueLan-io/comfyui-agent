import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Agent } from '../src/agent/runtime/agent.mjs';
import { IntentRouter, ruleIntent } from '../src/agent/runtime/intent-router.mjs';
import { assessPromptReadiness } from '../src/agent/tools/prompt/readiness.mjs';

test('routes follow-up edits to the latest generation', () => {
  const decision = ruleIntent('换成红色', { lastPrompt: 'a cat in a garden', lastImages: [{}] });
  assert.equal(decision.intent, 'refine');
  assert.equal(decision.action, 'prepare');
  assert.equal(decision.target, 'last_generation');
});

test('asks for a refinement direction instead of guessing', () => {
  const decision = ruleIntent('这个感觉一般', { lastPrompt: 'a cat in a garden' });
  assert.equal(decision.intent, 'refine');
  assert.equal(decision.action, 'clarify');
  assert.deepEqual(decision.missing, ['refinement_direction']);
});

test('refinement direction uses the shared readiness vocabulary', () => {
  const decision = ruleIntent('换成夜景', { lastPrompt: 'a cat in a garden', lastImages: [{}] });
  assert.equal(decision.intent, 'refine');
  assert.equal(decision.action, 'prepare');
  assert.deepEqual(decision.missing, []);
});

test('generic correction of the previous generation asks for the actual change', () => {
  const decision = ruleIntent('\u628a\u4e0a\u4e00\u8f6e\u751f\u6210\u7684\u56fe\u7247\u4fee\u6b63\u4e00\u4e0b', {
    lastPrompt: 'a cat in a garden',
    lastImages: [{}],
  });
  assert.equal(decision.intent, 'refine');
  assert.equal(decision.action, 'clarify');
  assert.deepEqual(decision.missing, ['refinement_direction']);
});

test('short attribute statements stay in chat unless they explicitly request a change', () => {
  const decision = ruleIntent('\u7c89\u8272\u5934\u53d1', { lastPrompt: 'a cat in a garden', lastImages: [{}] });
  assert.equal(decision, null);
});

test('pronouns do not refine the latest generation by themselves', () => {
  const decision = ruleIntent('它', { lastPrompt: 'a cat in a garden', lastImages: [{}] });
  assert.equal(decision, null);
});

test('casual time references do not refine the latest generation', () => {
  const decision = ruleIntent('最近怎么样', { lastPrompt: 'a cat in a garden', lastImages: [{}] });
  assert.equal(decision, null);
});

test('natural questions are classified as chat', () => {
  const decision = ruleIntent('你能帮我看看吗？');
  assert.equal(decision.intent, 'chat');
  assert.equal(decision.action, 'reply');
});

test('asks for a source when a refinement arrives before the first generation', () => {
  const decision = ruleIntent('换成红色');
  assert.equal(decision.action, 'clarify');
  assert.deepEqual(decision.missing, ['previous_generation']);
});

test('attached media can be the source for a refinement before any generation', () => {
  const decision = ruleIntent('\u7ee7\u7eed\u4f18\u5316\u5979\u7684\u59ff\u52bf', {
    attachedMedia: { images: [{ name: 'reference.png' }] },
  });
  assert.equal(decision.intent, 'refine');
  assert.equal(decision.action, 'prepare');
  assert.equal(decision.target, 'attached_media');
});

test('ordinary generation language is classified as generate', () => {
  const decision = ruleIntent('想要个赛博朋克风的头像');
  assert.equal(decision.intent, 'generate');
  assert.equal(decision.action, 'prepare');
  assert.equal(decision.target, 'new');
});

test('prompt optimization is answered as a chat reply, not a generation', () => {
  const decision = ruleIntent('帮我优化这个提示词：一只猫在雨中');
  assert.equal(decision.intent, 'prompt_edit');
  assert.equal(decision.action, 'reply');
});

test('prompt refinement of the latest prompt stays a reply', () => {
  const decision = ruleIntent('优化一下提示词', { lastPrompt: 'a cat in a garden' });
  assert.equal(decision.intent, 'prompt_edit');
  assert.equal(decision.action, 'reply');
  assert.equal(decision.target, 'last_prompt');
});

test('explicit generation after prompt editing is not treated as a plain reply', () => {
  const decision = ruleIntent('优化提示词然后生成', { lastPrompt: 'a cat in a garden' });
  assert.notEqual(decision.intent, 'prompt_edit');
  assert.notEqual(decision.action, 'reply');
});

test('prompt readiness blocks image editing without a reference', () => {
  const result = assessPromptReadiness({ request: '把这张图改成油画', intent: 'edit' });
  assert.equal(result.readiness, 'clarify');
  assert.ok(result.missing.includes('reference_media'));
});

test('prompt readiness accepts attached media as refinement context', () => {
  const result = assessPromptReadiness({
    request: '\u7ee7\u7eed\u4f18\u5316\u5979\u7684\u59ff\u52bf',
    intent: 'refine',
    media: { images: [{ name: 'reference.png' }] },
  });
  assert.equal(result.readiness, 'ready');
  assert.deepEqual(result.missing, []);
});

test('prompt readiness accepts clarity and action as refinement directions', () => {
  const result = assessPromptReadiness({
    request: '\u589e\u52a0\u6e05\u6670\u5ea6 \u8bbe\u8ba1\u4e00\u4e2a\u7b26\u5408\u4eba\u8bbe\u7684\u53ef\u7231\u52a8\u4f5c',
    intent: 'refine',
    media: { images: [{ name: 'reference.png' }] },
  });
  assert.equal(result.readiness, 'ready');
  assert.deepEqual(result.missing, []);
});

test('prompt readiness allows a useful subject with optional warnings', () => {
  const result = assessPromptReadiness({ request: '生成一只猫，高级感', intent: 'generate' });
  assert.equal(result.readiness, 'warn');
  assert.deepEqual(result.missing, []);
});

test('low-confidence LLM generation decisions become clarification', async () => {
  const router = new IntentRouter({
    isConfigured: true,
    async chat() {
      return { content: JSON.stringify({ intent: 'generate', action: 'prepare', confidence: 0.4, missing: [] }) };
    },
  });
  const decision = await router.route('帮我处理一下这个', {});
  assert.equal(decision.action, 'clarify');
  assert.ok(decision.question);
});

test('pending clarification combines the follow-up with the original request', () => {
  const decision = ruleIntent('红色', {
    sessionState: {
      pending: { intent: 'refine', request: '换个颜色' },
    },
  });
  assert.equal(decision.action, 'prepare');
  assert.match(decision.request, /换个颜色/);
  assert.match(decision.request, /红色/);
});

test('pending clarification does not turn a greeting into a generation', () => {
  const decision = ruleIntent('你好', {
    sessionState: {
      pending: { intent: 'generate', request: '生成一张图' },
    },
  });
  assert.equal(decision, null);
});

test('pending clarification leaves casual conversation to chat', () => {
  const decision = ruleIntent('我只是想聊聊天', {
    sessionState: {
      pending: { intent: 'generate', request: '生成一张图' },
    },
  });
  assert.equal(decision, null);
});

test('Agent route treats generation language as a generation request even without AI', async () => {
  const agent = Object.create(Agent.prototype);
  agent.intentRouter = new IntentRouter(null);
  agent.sessionManager = {
    conversation: { getLLMMessages: () => [] },
    getSessionState: () => ({ phase: 'idle', pending: null }),
    project: {
      get(field) {
        return field === 'lastImages' || field === 'lastPrompt' ? (field === 'lastImages' ? [] : '') : undefined;
      },
    },
  };
  const decision = await agent.routeIntent('生成一张图', { media: null });
  assert.equal(decision.intent, 'generate');
  assert.equal(decision.action, 'clarify');
  assert.ok(decision.missing.includes('subject'));
});

test('generate mode lets generation language pass the question rule', () => {
  const decision = ruleIntent('怎么生成高清图？', { modeHint: 'generate' });
  assert.equal(decision.intent, 'generate');
  assert.equal(decision.action, 'prepare');
});

test('answer mode keeps tutorial questions as chat', () => {
  const decision = ruleIntent('怎么生成高清图？', { modeHint: 'answer' });
  assert.equal(decision.intent, 'chat');
  assert.equal(decision.action, 'reply');
});

test('generate mode does not turn a greeting into a generation', () => {
  const decision = ruleIntent('你好', { modeHint: 'generate' });
  assert.equal(decision, null);
});

test('runtime and workflow rules only match query phrasing', () => {
  assert.equal(ruleIntent('帮我生成一个科幻设备的插画').intent, 'generate');
  assert.equal(ruleIntent('节点连接成树状的海报'), null);
  assert.equal(ruleIntent('怎么查看当前显存状态').intent, 'query');
  assert.equal(ruleIntent('节点怎么连接').intent, 'query');
});

test('cancel remains first in generation mode', () => {
  const decision = ruleIntent('取消生成', { modeHint: 'generate' });
  assert.equal(decision.intent, 'cancel');
  assert.equal(decision.action, 'reply');
});

test('intent router includes attached image data when classifying a visual request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'comfy-router-image-'));
  const imagePath = join(directory, 'reference.png');
  await writeFile(imagePath, 'image');
  t.after(() => rm(directory, { recursive: true, force: true }));
  let request;
  const router = new IntentRouter({
    isConfigured: true,
    async chat(options) {
      request = options;
      return {
        content: JSON.stringify({
          intent: 'generate',
          action: 'prepare',
          target: 'new',
          missing: [],
          confidence: 0.95,
          reason: '根据附图生成',
        }),
      };
    },
  }, {
    imageDataUrl: async () => 'data:image/png;base64,abc',
  });

  const result = await router.route('参考素材内容', {
    attachedMedia: { images: [{ path: imagePath }] },
  });

  assert.equal(result.intent, 'generate');
  assert.equal(request.messages[1].content.at(-1).type, 'image_url');
  assert.equal(request.messages[1].content.at(-1).image_url.url, 'data:image/png;base64,abc');
});

test('intent router lets the language model interpret an attached image before applying edit rules', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'comfy-router-visual-intent-'));
  const imagePath = join(directory, 'reference.png');
  await writeFile(imagePath, 'image');
  t.after(() => rm(directory, { recursive: true, force: true }));
  let called = false;
  const router = new IntentRouter({
    isConfigured: true,
    async chat() {
      called = true;
      return { content: JSON.stringify({ intent: 'chat', action: 'reply', confidence: 0.9, target: 'none' }) };
    },
  }, { imageDataUrl: async () => 'data:image/png;base64,abc' });

  const result = await router.route('把这张图改得更好看', {
    attachedMedia: { images: [{ path: imagePath }] },
  });

  assert.equal(called, true);
  assert.equal(result.intent, 'chat');
  assert.equal(result.action, 'reply');
});

test('intent router forwards modeHint and the active strategy preference', async () => {
  let request;
  const router = new IntentRouter({
    isConfigured: true,
    strategy: 'cloud',
    async chat(options) {
      request = options;
      return {
        content: JSON.stringify({
          intent: 'generate',
          action: 'prepare',
          target: 'new',
          missing: [],
          confidence: 0.95,
          reason: '用户选择了生成模式',
        }),
      };
    },
  });

  await router.route('请处理这段描述', { modeHint: 'generate' });

  assert.equal(request.prefer, 'cloud');
  const payload = JSON.parse(request.messages[1].content);
  assert.equal(payload.modeHint, 'generate');
  assert.match(request.messages[0].content, /AI generation mode/);
});

test('generate mode prepares an attached image prompt extraction request', () => {
  const decision = ruleIntent('反推出这张图的提示词', {
    modeHint: 'generate',
    attachedMedia: { images: [{ path: 'reference.png' }] },
  });
  assert.equal(decision.intent, 'generate');
  assert.equal(decision.action, 'prepare');
});

test('prompt readiness reuses a recent chat answer for a bare generation command', () => {
  const result = assessPromptReadiness({
    request: 'generate an image',
    intent: 'generate',
    conversation: [
      { role: 'assistant', content: 'masterpiece, a silver-haired woman with large white wings, full body, centered composition' },
    ],
  });
  assert.equal(result.readiness, 'ready');
  assert.deepEqual(result.missing, []);
});

test('prompt readiness still asks for a subject without prompt or chat context', () => {
  const result = assessPromptReadiness({ request: 'generate an image', intent: 'generate' });
  assert.equal(result.readiness, 'clarify');
  assert.deepEqual(result.missing, ['subject']);
});
