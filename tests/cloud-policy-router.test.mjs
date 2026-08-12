import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudPolicyBlockedError, CloudPolicyRouter, reviewCloudMessages } from '../src/agent/llm/cloud-policy-router.mjs';
import { LLMProvider } from '../src/agent/llm/provider.mjs';

const LOCAL_AND_CLOUD = [
  { id: 'local', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', models: [{ id: 'local-model' }] },
  { id: 'cloud', type: 'openai-compatible', baseUrl: 'https://api.example.com/v1', apiKey: 'key', models: [{ id: 'cloud-model' }] },
];

function response(content) {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), { status: 200 });
}

test('policy state machine reviews locally and returns to idle', () => {
  const states = [];
  const router = new CloudPolicyRouter({ onStateChange: event => states.push(event.state) });
  const decision = router.review([{ role: 'user', content: 'a landscape with a red cabin' }]);
  assert.equal(decision.allowed, true);
  assert.deepEqual(states, ['reviewing', 'cloud_allowed']);
  router.complete();
  assert.equal(router.state, 'idle');
  assert.deepEqual(states, ['reviewing', 'cloud_allowed', 'idle']);
});

test('repeated reviews reuse only the text classification result', () => {
  const router = new CloudPolicyRouter();
  const messages = [{ role: 'user', content: 'nude character' }];
  const first = router.review(messages);
  router.complete();
  const overridden = router.review(messages, { forceAllow: true });
  router.complete();

  assert.deepEqual(first.categories, ['sexual_content']);
  assert.deepEqual(overridden.categories, ['sexual_content']);
  assert.equal(first.allowed, false);
  assert.equal(overridden.allowed, true);
  assert.equal(overridden.overridden, true);
  assert.equal(router._categoryCache.size, 1);
});

test('different policy cache scopes never share a classification entry', () => {
  const router = new CloudPolicyRouter();
  const messages = [{ role: 'user', content: 'nude character' }];
  const first = router.review(messages, { policyCacheKey: 'resolver:local:model-a' });
  router.complete();
  const second = router.review(messages, { policyCacheKey: 'compiler:local:model-a' });
  router.complete();

  assert.deepEqual(first.categories, ['sexual_content']);
  assert.deepEqual(second.categories, ['sexual_content']);
  assert.equal(router._categoryCache.size, 2);
});

test('policy classification cache is bounded', () => {
  const router = new CloudPolicyRouter();
  for (let index = 0; index < 65; index += 1) {
    router.review([{ role: 'user', content: `safe landscape ${index}` }]);
    router.complete();
  }
  assert.equal(router._categoryCache.size, 64);
});

test('policy review covers restricted prompt templates', () => {
  const decision = reviewCloudMessages([{ role: 'user', content: 'nude character, erotic pose' }]);
  assert.equal(decision.allowed, false);
  assert.equal(decision.requiresLocal, true);
  assert.deepEqual(decision.categories, ['sexual_content']);
});

test('soft suggestive wording alone does not flag sexual content', () => {
  const decision = reviewCloudMessages([{ role: 'user', content: 'a seductive girl in a summer dress' }]);
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.categories, []);
});

test('two soft sexual signals still route to local', () => {
  const decision = reviewCloudMessages([{ role: 'user', content: 'seductive pose, erotic bare body' }]);
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.categories, ['sexual_content']);
});

test('benign anime prompt passes the review', () => {
  const decision = reviewCloudMessages([{ role: 'user', content: '生成一个穿泳装的可爱女孩，夏日海边' }]);
  assert.equal(decision.allowed, true);
});

test('candidate filters do not change multi-category policy decisions', () => {
  const decision = reviewCloudMessages([{
    role: 'user',
    content: 'nude child, graphic violence, suicide, how to make a bomb',
  }]);
  assert.equal(decision.allowed, false);
  assert.equal(decision.requiresLocal, true);
  assert.deepEqual(decision.categories, [
    'sexual_content',
    'sexualized_minors',
    'graphic_violence',
    'self_harm',
    'illicit_instructions',
  ]);
});

test('candidate filters remain conservative for rule trigger phrases', () => {
  const prompts = [
    ['graphic violence and blood splatter', 'graphic_violence'],
    ['I want to end my life', 'self_harm'],
    ['how to deploy malware', 'illicit_instructions'],
    ['14 years old girl, erotic pose', 'sexualized_minors'],
  ];
  for (const [content, category] of prompts) {
    const decision = reviewCloudMessages([{ role: 'user', content }]);
    assert.ok(decision.categories.includes(category), `${category} should match: ${content}`);
  }
});

test('app-authored system instructions never influence the review', () => {
  const decision = reviewCloudMessages([
    { role: 'system', content: 'nude nudity xxx porn erotic content' },
    { role: 'user', content: 'a quiet landscape' },
  ]);
  assert.equal(decision.allowed, true);
});

test('sexualized minors content redirects to local', () => {
  const decision = reviewCloudMessages([{ role: 'user', content: 'child porn' }]);
  assert.equal(decision.allowed, false);
  assert.equal(decision.requiresLocal, true);
  assert.ok(decision.categories.includes('sexualized_minors'));
});

test('age-based minors content redirects to local', () => {
  const decision = reviewCloudMessages([{ role: 'user', content: '14 years old girl, nude' }]);
  assert.equal(decision.allowed, false);
  assert.equal(decision.requiresLocal, true);
  assert.ok(decision.categories.includes('sexualized_minors'));
});

test('cloud strategy sends restricted content to local and never cloud', async () => {
  const originalFetch = globalThis.fetch;
  const requestedModels = [];
  globalThis.fetch = async (_url, options) => {
    requestedModels.push(JSON.parse(options.body).model);
    return response('local response');
  };
  try {
    const provider = new LLMProvider({
      providers: LOCAL_AND_CLOUD,
      active: { providerId: 'cloud', modelId: 'cloud-model', strategy: 'cloud' },
    });
    const result = await provider.chat({ messages: [{ role: 'user', content: 'nude character' }] });
    assert.equal(result.content, 'local response');
    assert.deepEqual(requestedModels, ['local-model']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('restricted content stops before cloud when no local model is configured', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response('should not be returned');
  };
  try {
    const provider = new LLMProvider({
      providers: [LOCAL_AND_CLOUD[1]],
      active: { providerId: 'cloud', modelId: 'cloud-model', strategy: 'cloud' },
    });
    await assert.rejects(
      provider.chat({ messages: [{ role: 'user', content: 'graphic violence and gore' }] }),
      error => error instanceof CloudPolicyBlockedError && error.code === 'CLOUD_POLICY_BLOCKED',
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('auto local selection surfaces the local error and never falls back to cloud', async () => {
  const originalFetch = globalThis.fetch;
  const requestedModels = [];
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'GET') return new Response(JSON.stringify({ data: [] }), { status: 200 });
    const model = JSON.parse(options.body).model;
    requestedModels.push(model);
    if (model === 'local-model') throw new Error('local unavailable');
    return response('cloud response');
  };
  try {
    const provider = new LLMProvider({
      providers: LOCAL_AND_CLOUD,
      active: { providerId: 'local', modelId: 'local-model', strategy: 'auto' },
    });
    await assert.rejects(
      provider.chat({ messages: [{ role: 'user', content: 'self-harm discussion' }] }),
      /local unavailable/,
    );
    assert.deepEqual(requestedModels, ['local-model']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('forceAllow review decision is marked as overridden', () => {
  const states = [];
  const router = new CloudPolicyRouter({ onStateChange: event => states.push(event.state) });
  const decision = router.review([{ role: 'user', content: 'nude character' }], { forceAllow: true });
  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresLocal, false);
  assert.equal(decision.overridden, true);
  assert.deepEqual(decision.categories, ['sexual_content']);
  assert.deepEqual(states, ['reviewing', 'user_override']);
  router.complete();
  assert.equal(router.state, 'idle');
});

test('manual override sends restricted content to cloud after confirmation', async () => {
  const originalFetch = globalThis.fetch;
  const requestedModels = [];
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'GET') return new Response(JSON.stringify({ data: [] }), { status: 200 });
    const model = JSON.parse(options.body).model;
    requestedModels.push(model);
    return response('cloud response');
  };
  try {
    const provider = new LLMProvider({
      providers: [LOCAL_AND_CLOUD[1]],
      active: { providerId: 'cloud', modelId: 'cloud-model', strategy: 'cloud' },
    });
    const states = [];
    provider.setPolicyStateHandler(({ state }) => states.push(state));
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'graphic violence and gore' }],
      allowPolicyOverride: true,
    });
    assert.equal(result.content, 'cloud response');
    assert.deepEqual(requestedModels, ['cloud-model']);
    assert.ok(states.includes('user_override'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('without confirmation restricted content is still blocked for cloud', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response('should not be returned');
  };
  try {
    const provider = new LLMProvider({
      providers: [LOCAL_AND_CLOUD[1]],
      active: { providerId: 'cloud', modelId: 'cloud-model', strategy: 'cloud' },
    });
    await assert.rejects(
      provider.chat({ messages: [{ role: 'user', content: 'nude character' }] }),
      error => error instanceof CloudPolicyBlockedError && error.code === 'CLOUD_POLICY_BLOCKED',
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cloud request emits review before the cloud call', async () => {
  const originalFetch = globalThis.fetch;
  const states = [];
  globalThis.fetch = async () => response('cloud response');
  try {
    const provider = new LLMProvider({
      providers: [LOCAL_AND_CLOUD[1]],
      active: { providerId: 'cloud', modelId: 'cloud-model', strategy: 'cloud' },
    });
    provider.setPolicyStateHandler(({ state }) => states.push(state));
    await provider.chat({ messages: [{ role: 'user', content: 'a safe landscape' }] });
    assert.deepEqual(states, ['reviewing', 'cloud_allowed', 'idle']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('concurrent cloud requests keep independent policy state lifecycles', async () => {
  const originalFetch = globalThis.fetch;
  let releaseResponses;
  const responsesReady = new Promise(resolve => { releaseResponses = resolve; });
  let calls = 0;
  const states = [];
  globalThis.fetch = async () => {
    calls += 1;
    await responsesReady;
    return response(`cloud response ${calls}`);
  };
  try {
    const provider = new LLMProvider({
      providers: [LOCAL_AND_CLOUD[1]],
      active: { providerId: 'cloud', modelId: 'cloud-model', strategy: 'cloud' },
    });
    provider.setPolicyStateHandler(({ state }) => states.push(state));

    const first = provider.chat({ messages: [{ role: 'user', content: 'first safe landscape' }] });
    await new Promise(resolve => setImmediate(resolve));
    const second = provider.chat({ messages: [{ role: 'user', content: 'second safe landscape' }] });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(calls, 2);
    releaseResponses();
    const results = await Promise.all([first, second]);

    assert.equal(results.length, 2);
    assert.deepEqual(states, ['reviewing', 'cloud_allowed', 'reviewing', 'cloud_allowed', 'idle', 'idle']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const IMAGE_MESSAGE = [{ role: 'user', content: [{ type: 'text', text: 'a portrait' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] }];

test('images go to cloud by default when the media policy allows it', async () => {
  const originalFetch = globalThis.fetch;
  const requestedModels = [];
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'GET') return new Response(JSON.stringify({ data: [] }), { status: 200 });
    requestedModels.push(JSON.parse(options.body).model);
    return response('cloud response');
  };
  try {
    const provider = new LLMProvider({
      providers: LOCAL_AND_CLOUD,
      active: { providerId: 'cloud', modelId: 'cloud-model', strategy: 'cloud' },
    });
    const result = await provider.chat({ messages: IMAGE_MESSAGE });
    assert.equal(result.content, 'cloud response');
    assert.deepEqual(requestedModels, ['cloud-model']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('images are treated as unreviewed media and routed to local when the policy disallows cloud', async () => {
  const router = new CloudPolicyRouter();
  const decision = router.review(IMAGE_MESSAGE, { allowMediaToCloud: false });
  assert.equal(decision.allowed, false);
  assert.equal(decision.requiresLocal, true);
  assert.equal(decision.reason, 'unreviewed_media');
  assert.deepEqual(decision.categories, []);
  router.complete();
});

test('media policy switch forces image messages to local model', async () => {
  const originalFetch = globalThis.fetch;
  const requestedModels = [];
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'GET') return new Response(JSON.stringify({ data: [] }), { status: 200 });
    requestedModels.push(JSON.parse(options.body).model);
    return response('local response');
  };
  try {
    const provider = new LLMProvider({
      providers: LOCAL_AND_CLOUD,
      active: { providerId: 'cloud', modelId: 'cloud-model', strategy: 'cloud' },
      allowMediaToCloud: false,
    });
    const result = await provider.chat({ messages: IMAGE_MESSAGE });
    assert.equal(result.content, 'local response');
    assert.deepEqual(requestedModels, ['local-model']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('restricted text still blocks for cloud even when media is allowed', async () => {
  const router = new CloudPolicyRouter();
  const decision = router.review([{ role: 'user', content: 'nude character' }], { allowMediaToCloud: true });
  assert.equal(decision.allowed, false);
  assert.equal(decision.requiresLocal, true);
  assert.equal(decision.reason, 'restricted_content');
  router.complete();
});
