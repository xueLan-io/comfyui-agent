import assert from 'node:assert/strict';
import test from 'node:test';
import { LLMProvider, providerKind, resolveLLMRouting, resolveLLMStrategy } from '../src/agent/llm/provider.mjs';

const BOTH_PROVIDERS = [
  { id: 'lmstudio', name: 'LM Studio', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', models: [{ id: 'local-model' }] },
  { id: 'cloud', name: 'Cloud', type: 'openai-compatible', baseUrl: 'https://api.example.com/v1', apiKey: 'key', models: [{ id: 'cloud-model' }] },
];

test('resolveLLMStrategy only forces an explicit local or cloud strategy', () => {
  assert.equal(resolveLLMStrategy({ strategy: 'local' }), 'local');
  assert.equal(resolveLLMStrategy({ strategy: 'cloud' }), 'cloud');
  assert.equal(resolveLLMStrategy({ strategy: 'auto' }), undefined);
  assert.equal(resolveLLMStrategy({ strategy: 'manual' }), undefined);
  assert.equal(resolveLLMStrategy(null), undefined);
});

test('classifies providers into local and cloud', () => {
  assert.equal(providerKind({ type: 'ollama', baseUrl: 'http://127.0.0.1:11434' }), 'local');
  assert.equal(providerKind({ type: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' }), 'local');
  assert.equal(providerKind({ type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1' }), 'local');
  assert.equal(providerKind({ type: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' }), 'cloud');
  assert.equal(providerKind({ type: 'openai-compatible' }), 'cloud');
});

test('resolveLLMRouting honors the active provider in auto mode', () => {
  const resolved = resolveLLMRouting({
    providers: BOTH_PROVIDERS,
    active: { providerId: 'cloud', modelId: 'cloud-model', strategy: 'auto' },
  });
  assert.equal(resolved.strategy, 'auto');
  assert.equal(resolved.kind, 'cloud');
  assert.equal(resolved.providerId, 'cloud');
  assert.equal(resolved.modelId, 'cloud-model');
});

test('resolveLLMRouting keeps local when the active provider is local in auto mode', () => {
  const resolved = resolveLLMRouting({
    providers: BOTH_PROVIDERS,
    active: { providerId: 'lmstudio', modelId: 'local-model', strategy: 'auto' },
  });
  assert.equal(resolved.kind, 'local');
  assert.equal(resolved.providerId, 'lmstudio');
});

test('resolveLLMRouting falls back to cloud in auto when only cloud is configured', () => {
  const resolved = resolveLLMRouting({
    providers: [BOTH_PROVIDERS[1]],
    active: { providerId: 'cloud', modelId: 'cloud-model', strategy: 'auto' },
  });
  assert.equal(resolved.kind, 'cloud');
  assert.equal(resolved.providerId, 'cloud');
});

test('resolveLLMRouting honors an explicit local or cloud strategy', () => {
  const local = resolveLLMRouting({ providers: BOTH_PROVIDERS, active: { providerId: 'cloud', modelId: 'cloud-model', strategy: 'local' } });
  assert.equal(local.kind, 'local');
  assert.equal(local.providerId, 'lmstudio');
  const cloud = resolveLLMRouting({ providers: BOTH_PROVIDERS, active: { providerId: 'cloud', modelId: 'cloud-model', strategy: 'cloud' } });
  assert.equal(cloud.kind, 'cloud');
  assert.equal(cloud.providerId, 'cloud');
});

test('auto mode with an explicit cloud selection never falls back to a local provider after a cloud failure', async () => {
  const originalFetch = globalThis.fetch;
  const requestedModels = [];
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'GET') return new Response(JSON.stringify({ data: [] }), { status: 200 });
    const model = JSON.parse(options.body).model;
    requestedModels.push(model);
    if (model === 'cloud-model') throw new Error('cloud down');
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'local ok' } }] }), { status: 200 });
  };
  try {
    const provider = new LLMProvider({
      providers: BOTH_PROVIDERS,
      active: { providerId: 'cloud', modelId: 'cloud-model', strategy: 'auto' },
    });
    await assert.rejects(provider.chat({ messages: [{ role: 'user', content: 'hi' }] }), /cloud down/);
    assert.deepEqual(requestedModels, ['cloud-model']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('auto mode uses the active cloud provider alone when it works', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    if (options.method === 'GET') return new Response(JSON.stringify({ data: [] }), { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'cloud ok' } }] }), { status: 200 });
  };
  try {
    const provider = new LLMProvider({
      providers: BOTH_PROVIDERS,
      active: { providerId: 'cloud', modelId: 'cloud-model', strategy: 'auto' },
    });
    const result = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(result.content, 'cloud ok');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('auto mode uses the active local provider first', async () => {
  const originalFetch = globalThis.fetch;
  const requestedModels = [];
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'GET') return new Response(JSON.stringify({ data: [] }), { status: 200 });
    const model = JSON.parse(options.body).model;
    requestedModels.push(model);
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'local ok' } }] }), { status: 200 });
  };
  try {
    const provider = new LLMProvider({
      providers: BOTH_PROVIDERS,
      active: { providerId: 'lmstudio', modelId: 'local-model', strategy: 'auto' },
    });
    const result = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(result.content, 'local ok');
    assert.deepEqual(requestedModels, ['local-model']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('auto mode with a local selection never falls back to cloud after a mid-call error', async () => {
  const originalFetch = globalThis.fetch;
  const requestedModels = [];
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'GET') return new Response(JSON.stringify({ data: [] }), { status: 200 });
    const model = JSON.parse(options.body).model;
    requestedModels.push(model);
    if (model === 'local-model') throw new Error('local model crashed');
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'cloud response' } }] }), { status: 200 });
  };
  try {
    const provider = new LLMProvider({
      providers: BOTH_PROVIDERS,
      active: { providerId: 'lmstudio', modelId: 'local-model', strategy: 'auto' },
    });
    await assert.rejects(provider.chat({ messages: [{ role: 'user', content: 'hi' }] }), /local model crashed/);
    assert.deepEqual(requestedModels, ['local-model']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('manual strategy routes exactly to the active provider', async () => {
  const originalFetch = globalThis.fetch;
  const requestedModels = [];
  globalThis.fetch = async (_url, options) => {
    const model = JSON.parse(options.body).model;
    requestedModels.push(model);
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200 });
  };
  try {
    const provider = new LLMProvider({
      providers: BOTH_PROVIDERS,
      active: { providerId: 'cloud', modelId: 'cloud-model', strategy: 'manual' },
    });
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.deepEqual(requestedModels, ['cloud-model']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('explicit cloud strategy never falls back to a local provider after a cloud failure', async () => {
  const originalFetch = globalThis.fetch;
  const requestedModels = [];
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'GET') return new Response(JSON.stringify({ data: [] }), { status: 200 });
    const model = JSON.parse(options.body).model;
    requestedModels.push(model);
    if (model === 'cloud-model') throw new Error('cloud unreachable');
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'local' } }] }), { status: 200 });
  };
  try {
    const provider = new LLMProvider({
      providers: BOTH_PROVIDERS,
      active: { providerId: 'cloud', modelId: 'cloud-model', strategy: 'cloud' },
    });
    await assert.rejects(provider.chat({ messages: [{ role: 'user', content: 'hi' }] }), /cloud unreachable/);
    assert.deepEqual(requestedModels, ['cloud-model']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('manual strategy never falls back to a local provider after a cloud failure', async () => {
  const originalFetch = globalThis.fetch;
  const requestedModels = [];
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'GET') return new Response(JSON.stringify({ data: [] }), { status: 200 });
    const model = JSON.parse(options.body).model;
    requestedModels.push(model);
    if (model === 'cloud-model') throw new Error('cloud unreachable');
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'local' } }] }), { status: 200 });
  };
  try {
    const provider = new LLMProvider({
      providers: BOTH_PROVIDERS,
      active: { providerId: 'cloud', modelId: 'cloud-model', strategy: 'manual' },
    });
    await assert.rejects(provider.chat({ messages: [{ role: 'user', content: 'hi' }] }), /cloud unreachable/);
    assert.deepEqual(requestedModels, ['cloud-model']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('isConfigured reflects the active strategy', () => {
  const localOnly = new LLMProvider({ providers: [BOTH_PROVIDERS[0]], active: { providerId: 'lmstudio', modelId: 'local-model', strategy: 'cloud' } });
  assert.equal(localOnly.isConfigured, false);
  const autoBoth = new LLMProvider({ providers: BOTH_PROVIDERS, active: { providerId: 'cloud', modelId: 'cloud-model', strategy: 'auto' } });
  assert.equal(autoBoth.isConfigured, true);
  const manualCloud = new LLMProvider({ providers: BOTH_PROVIDERS, active: { providerId: 'cloud', modelId: 'cloud-model', strategy: 'manual' } });
  assert.equal(manualCloud.isConfigured, true);
});

test('chat throws a clear error when the selected strategy has no configured provider', async () => {
  const provider = new LLMProvider({ providers: [BOTH_PROVIDERS[0]], active: { providerId: 'lmstudio', modelId: 'local-model', strategy: 'cloud' } });
  await assert.rejects(provider.chat({ messages: [{ role: 'user', content: 'hi' }] }), /未配置云端模型/);
});

test('local requests get a min maxTokens floor; cloud reasoning requests reserve output headroom', async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'GET') return new Response(JSON.stringify({ data: [] }), { status: 200 });
    seen.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200 });
  };
  try {
    const provider = new LLMProvider({
      providers: BOTH_PROVIDERS,
      active: { providerId: 'cloud', modelId: 'cloud-model', strategy: 'manual' },
    });
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 300 });
    assert.ok(seen[0].max_tokens > 300, 'cloud reasoning model reserves headroom above the caller budget');
    const localProvider = new LLMProvider({
      providers: BOTH_PROVIDERS,
      active: { providerId: 'lmstudio', modelId: 'local-model', strategy: 'local' },
    });
    await localProvider.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 300 });
    assert.equal(seen[1].max_tokens, 1024, 'local is floored to the min budget');
    await localProvider.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 1500 });
    assert.equal(seen[2].max_tokens, 1500, 'local keeps an explicit larger budget');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cloud dispatch replaces the system prompt when cloudSystemPrompt is set; local keeps the caller prompt', async () => {
  const originalFetch = globalThis.fetch;
  const sentBodies = [];
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'GET') return new Response(JSON.stringify({ data: [] }), { status: 200 });
    sentBodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200 });
  };
  try {
    const provider = new LLMProvider({
      providers: BOTH_PROVIDERS,
      active: { providerId: 'cloud', modelId: 'cloud-model', strategy: 'cloud' },
    });
    const localSystem = 'local-tuned instructions';
    const cloudSystem = 'clean cloud instructions';
    await provider.chat({
      messages: [
        { role: 'system', content: localSystem },
        { role: 'user', content: 'hi' },
      ],
      cloudSystemPrompt: cloudSystem,
    });
    assert.equal(sentBodies[0].messages[0].content, cloudSystem, 'cloud request uses the cloud system prompt');

    const localProvider = new LLMProvider({
      providers: BOTH_PROVIDERS,
      active: { providerId: 'lmstudio', modelId: 'local-model', strategy: 'local' },
    });
    await localProvider.chat({
      messages: [
        { role: 'system', content: localSystem },
        { role: 'user', content: 'hi' },
      ],
      cloudSystemPrompt: cloudSystem,
    });
    assert.equal(sentBodies[1].messages[0].content, localSystem, 'local request keeps the caller system prompt');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('supportsVision reflects the vision declaration of the routed model', async () => {
  const providers = [
    { id: 'lmstudio', name: 'LM Studio', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', models: [{ id: 'local-model', vision: true }] },
    { id: 'cloud', name: 'Cloud', type: 'openai-compatible', baseUrl: 'https://api.example.com/v1', apiKey: 'key', models: [{ id: 'cloud-model' }] },
  ];
  const noVision = new LLMProvider({
    providers,
    active: { providerId: 'cloud', modelId: 'cloud-model', strategy: 'auto' },
  });
  assert.equal(await noVision.supportsVision(), false);
  assert.equal(await noVision.supportsVision({ prefer: 'local' }), false, 'explicit cloud selection stays authoritative');

  const withVision = new LLMProvider({
    providers,
    active: { providerId: 'lmstudio', modelId: 'local-model', strategy: 'manual' },
  });
  assert.equal(await withVision.supportsVision(), true);
});
