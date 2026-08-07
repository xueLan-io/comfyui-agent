import assert from 'node:assert/strict';
import test from 'node:test';
import { createManifestCache } from '../src/agent/tools/comfyui/manifest-cache.mjs';

test('manifest cache hits, refreshes, invalidates, and deduplicates concurrent loads', async () => {
  let calls = 0;
  let fileStat = { mtimeMs: 1, size: 2 };
  const cache = createManifestCache({
    resolveManifest: async () => { calls += 1; await new Promise(resolve => setTimeout(resolve, 2)); return { calls }; },
    resolveFile: async () => 'a.json',
    statFile: async () => fileStat,
  });
  const [a, b] = await Promise.all([cache.get('a.json', 'workflows'), cache.get('a.json', 'workflows')]);
  assert.equal(a.calls, 1); assert.equal(b.calls, 1); assert.equal(cache.size(), 1);
  fileStat = { mtimeMs: 2, size: 2 };
  assert.equal((await cache.get('a.json', 'workflows')).calls, 2);
  assert.equal((await cache.get('a.json', 'workflows', { refresh: true })).calls, 3);
  cache.invalidate('a.json', 'workflows'); assert.equal(cache.size(), 0);
  await cache.get('a.json', 'workflows'); cache.clear(); assert.equal(cache.size(), 0);
});

test('manifest cache does not cache parse failures', async () => {
  let calls = 0;
  const cache = createManifestCache({ resolveManifest: async () => { calls += 1; throw new Error('bad json'); }, resolveFile: async () => 'bad.json', statFile: async () => ({ mtimeMs: 1, size: 1 }) });
  await assert.rejects(cache.get('bad.json', 'workflows'));
  await assert.rejects(cache.get('bad.json', 'workflows'));
  assert.equal(calls, 2); assert.equal(cache.size(), 0);
});
