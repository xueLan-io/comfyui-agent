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
