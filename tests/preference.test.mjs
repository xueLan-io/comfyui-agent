import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PreferenceMemory } from '../src/agent/memory/preference.mjs';

test('migrates flat LLM preferences; without safeStorage the key is not persisted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-pref-'));
  const path = join(dir, 'config.json');
  try {
    await writeFile(path, JSON.stringify({ llm: { provider: 'openai-compatible', baseUrl: 'https://example.com/v1', model: 'model-x', apiKey: 'secret' } }));
    const preferences = new PreferenceMemory(path);
    assert.equal(preferences.get('llm.providers.0.models.0.id'), 'model-x');
    assert.equal(preferences.get('llm.providers.0.apiKey'), 'secret');
    preferences.set('ui.theme', 'light');
    const stored = JSON.parse(await readFile(path, 'utf8'));
    // No safeStorage in the test runtime: the key must be dropped, never
    // persisted in a recoverable (plain base64) form.
    assert.equal(stored.llm.providers[0].apiKey, '');
    assert.match(stored.llm.providers[0].apiKeyError, /安全存储/);
    assert.equal(stored.llm.active.modelId, 'model-x');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('without safeStorage the Baidu research API key is not persisted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-pref-'));
  const path = join(dir, 'config.json');
  try {
    const preferences = new PreferenceMemory(path);
    preferences.set('research.baiduApiKey', 'baidu-secret');
    const stored = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(stored.research.baiduApiKey, '');
    assert.match(stored.research.baiduApiKeyError, /安全存储/);
    const reloaded = new PreferenceMemory(path);
    assert.equal(reloaded.get('research.baiduApiKey'), '');
    assert.match(reloaded.get('research.baiduApiKeyError'), /安全存储/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reports Chromium ciphertext that cannot be decrypted and preserves it on unrelated saves', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-pref-'));
  const path = join(dir, 'config.json');
  const encryptedApiKey = `enc:${Buffer.from('v10corrupted-ciphertext').toString('base64')}`;
  try {
    await writeFile(path, JSON.stringify({
      llm: {
        providers: [{
          id: 'openai',
          type: 'openai-compatible',
          baseUrl: 'https://example.com/v1',
          apiKey: encryptedApiKey,
          headers: {},
          models: [{ id: 'model-x', name: 'Model X' }],
        }],
        active: { providerId: 'openai', modelId: 'model-x' },
      },
    }));
    const preferences = new PreferenceMemory(path);
    assert.equal(preferences.get('llm.providers.0.apiKey'), '');
    assert.match(preferences.get('llm.providers.0.apiKeyError'), /could not be decrypted/);

    preferences.set('ui.theme', 'light');
    const stored = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(stored.llm.providers[0].apiKey, encryptedApiKey);
    assert.equal(stored.llm.providers[0].apiKeyError, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('research key that cannot be decrypted is preserved on unrelated research saves', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-pref-'));
  const path = join(dir, 'config.json');
  const encryptedBaidu = `enc:${Buffer.from('v10corrupted-baidu').toString('base64')}`;
  const encryptedSearch = `enc:${Buffer.from('v10corrupted-search').toString('base64')}`;
  try {
    await writeFile(path, JSON.stringify({ research: { baiduApiKey: encryptedBaidu, searchApiKey: encryptedSearch } }));
    const preferences = new PreferenceMemory(path);
    // 解密失败：明文被清空，错误被标记，加密串保留
    assert.equal(preferences.get('research.baiduApiKey'), '');
    assert.match(preferences.get('research.baiduApiKeyError'), /could not be decrypted/);
    assert.equal(preferences.get('research.searchApiKey'), '');
    assert.match(preferences.get('research.searchApiKeyError'), /could not be decrypted/);
    // 模拟 main.mjs 的保存：展开运算符会丢掉不可枚举的 _encrypted* 属性
    const research = { ...preferences.get('research') };
    preferences.set('research', research);
    const stored = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(stored.research.baiduApiKey, encryptedBaidu);
    assert.equal(stored.research.searchApiKey, encryptedSearch);
    assert.equal(stored.research.baiduApiKeyError, undefined);
    assert.equal(stored.research.searchApiKeyError, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('without safeStorage the search API key is not persisted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-pref-'));
  const path = join(dir, 'config.json');
  try {
    const preferences = new PreferenceMemory(path);
    preferences.set('research.searchApiKey', 'tvly-secret');
    const stored = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(stored.research.searchApiKey, '');
    assert.match(stored.research.searchApiKeyError, /安全存储/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
