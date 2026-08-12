import assert from 'node:assert/strict';
import test from 'node:test';
import { IntentRouter, isExplicitNewGeneration, ruleIntent } from '../src/agent/runtime/intent-router.mjs';
import { LLMProvider } from '../src/agent/llm/provider.mjs';

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

function routerContext(overrides = {}) {
  return {
    conversation: [],
    sessionMemory: {},
    sessionState: {},
    lastPrompt: '',
    lastImages: [],
    attachedMedia: null,
    ...overrides,
  };
}

test('route aborts and drains the classifier after a complete JSON decision', async () => {
  const json = JSON.stringify({ intent: 'chat', action: 'reply', confidence: 0.9, target: 'none', reason: 'question' });
  let signal;
  let abortObserved = false;
  let settled = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const llm = {
    isConfigured: true,
    async chat(options) {
      assert.equal(options.maxTokens, 800);
      signal = options.signal;
      const split = Math.ceil(json.length / 2);
      options.onChunk(json.slice(0, split));
      options.onChunk(json.slice(split));
      await new Promise(resolve => {
        if (signal.aborted) {
          abortObserved = true;
          resolve();
        } else {
          signal.addEventListener('abort', () => {
            abortObserved = true;
            resolve();
          }, { once: true });
        }
      });
      await gate;
      settled = true;
      const error = new Error('分类请求已完成');
      error.code = 'LLM_CANCELLED';
      throw error;
    },
  };
  const router = new IntentRouter(llm);
  let resolved = false;
  const request = router.route('这个工作流怎么用？', routerContext()).then(result => {
    resolved = true;
    return result;
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(abortObserved, true);
  assert.equal(resolved, false);
  release();
  const decision = await request;
  assert.equal(settled, true);
  assert.equal(signal.reason, 'intent-classification-complete');
  assert.equal(decision.intent, 'chat');
  assert.equal(decision.action, 'reply');
  assert.equal(decision.source, 'llm');
});

test('complete classifier cancellation releases the local provider lock before the next call', async () => {
  const json = JSON.stringify({ intent: 'chat', action: 'reply', confidence: 0.9, target: 'none', reason: 'question' });
  const provider = new LLMProvider({
    providers: [{ id: 'local', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', models: [{ id: 'local-model' }] }],
    active: { providerId: 'local', modelId: 'local-model', strategy: 'local' },
  });
  const instance = provider._pool.local[0].instance;
  const events = [];
  let classifierStarted;
  let startClassifier;
  classifierStarted = new Promise(resolve => { startClassifier = resolve; });
  let plannerStarted;
  let startPlanner;
  plannerStarted = new Promise(resolve => { startPlanner = resolve; });
  let callCount = 0;
  instance.chat = async options => {
    callCount += 1;
    if (callCount === 1) {
      events.push('classifier-started');
      startClassifier();
      await new Promise(resolve => {
        const finish = () => {
          events.push('classifier-aborted');
          resolve();
        };
        if (options.signal.aborted) finish();
        else options.signal.addEventListener('abort', finish, { once: true });
        options.onChunk(json);
      });
      const error = new Error('分类请求已完成');
      error.code = 'LLM_CANCELLED';
      events.push('classifier-settled');
      throw error;
    }
    events.push('planner-started');
    startPlanner();
    return { content: 'planner result' };
  };

  const router = new IntentRouter(provider);
  const routePromise = router.route('这个工作流怎么用？', routerContext());
  await classifierStarted;
  const plannerPromise = provider.chat({ messages: [{ role: 'user', content: 'planner' }] });
  await plannerStarted;
  const [decision, planner] = await Promise.all([routePromise, plannerPromise]);

  assert.equal(decision.intent, 'chat');
  assert.equal(planner.content, 'planner result');
  assert.equal(callCount, 2);
  assert.deepEqual(events, ['classifier-started', 'classifier-aborted', 'classifier-settled', 'planner-started']);
});

test('route falls back to the full-stream parse when the JSON never becomes complete', async () => {
  const full = JSON.stringify({ intent: 'chat', action: 'reply', confidence: 0.9, target: 'none', reason: 'question' });
  const llm = {
    isConfigured: true,
    async chat(options) {
      // 流中永远不出现完整 JSON（截断的片段），完整内容只在返回时给出
      options.onChunk(full.slice(0, Math.ceil(full.length / 2)));
      await new Promise(resolve => setTimeout(resolve, 20));
      return { content: full };
    },
  };
  const router = new IntentRouter(llm);
  const decision = await router.route('这是怎么做的？', routerContext());
  assert.equal(decision.intent, 'chat');
  assert.equal(decision.action, 'reply');
  assert.equal(decision.source, 'llm');
});

test('route keeps the previous fallback behaviour when the classifier fails', async () => {
  const llm = {
    isConfigured: true,
    async chat() {
      throw new Error('LLM_API_ERROR');
    },
  };
  const router = new IntentRouter(llm);
  const decision = await router.route('帮我生成一只猫', routerContext());
  assert.equal(decision.intent, 'generate');
  assert.equal(decision.action, 'prepare');
});

test('route propagates a user cancellation instead of falling back', async () => {
  const cancellation = new Error('模型请求已取消');
  cancellation.code = 'LLM_CANCELLED';
  const llm = {
    isConfigured: true,
    async chat() {
      throw cancellation;
    },
  };
  const router = new IntentRouter(llm);
  await assert.rejects(
    router.route('帮我构思一个角色', routerContext()),
    error => error === cancellation,
  );
});

test('route does not hide a real error after an early classifier decision', async () => {
  const json = JSON.stringify({ intent: 'chat', action: 'reply', confidence: 0.9, target: 'none', reason: 'question' });
  const llm = {
    isConfigured: true,
    async chat(options) {
      options.onChunk(json);
      throw new Error('LLM_API_ERROR');
    },
  };
  const router = new IntentRouter(llm);
  const decision = await router.route('帮我构思一个角色', routerContext());
  assert.equal(decision.intent, 'chat');
  assert.equal(decision.action, 'reply');
  assert.equal(decision.source, 'fallback');
});
