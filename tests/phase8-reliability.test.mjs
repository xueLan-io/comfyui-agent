import assert from 'node:assert/strict';
import test from 'node:test';
import { createManifestCache } from '../src/agent/tools/comfyui/manifest-cache.mjs';
import { JSONFileStore } from '../src/agent/memory/store.mjs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('manifest cache expires by TTL and can serve stale while refreshing', async () => {
  let now = 0; let calls = 0; let resolveRefresh;
  const cache = createManifestCache({ ttlMs: 10, staleWhileRevalidate: true, clock: () => now, resolveFile: async () => 'workflow.json', statFile: async () => ({ mtimeMs: 1, size: 1 }), resolveManifest: async () => { calls += 1; if (calls === 2) await new Promise(resolve => { resolveRefresh = resolve; }); return { calls }; } });
  assert.deepEqual(await cache.get('workflow.json', 'workflows'), { calls: 1 });
  now = 20;
  assert.deepEqual(await cache.get('workflow.json', 'workflows'), { calls: 1 });
  resolveRefresh?.();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
});

test('JSON store keeps corrupt source and exposes awaitable flush/commit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phase8-store-'));
  try {
    const store = new JSONFileStore(dir, 'state.json', { version: 1 });
    await writeFile(store.filePath, '{broken');
    await store.load();
    assert.equal((await readdir(dir)).some(name => name.startsWith('state.json.corrupt-')), true);
    store.set('value', 2);
    await store.flush();
    await store.commit();
    assert.deepEqual(JSON.parse(await readFile(store.filePath, 'utf8')).value, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
