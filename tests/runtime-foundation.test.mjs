import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginHost } from '../src/runtime/plugins/plugin-host.mjs';
import { createWindowRegistry } from '../src/runtime/window-registry.mjs';
import { createMetrics } from '../src/runtime/metrics.mjs';
import { TaskStore } from '../src/runtime/task-store.mjs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('plugin host registers tools and services through declared capabilities', async () => {
  const calls = [];
  const host = createPluginHost({ plugins: [{ manifest: { contractVersion: '1.0', pluginId: 'p', name: 'P', version: '1', capabilities: ['tools'] }, start: ({ host: api }) => api.registerTool({ name: 'plugin_tool', description: 'x', input_schema: { type: 'object' }, output_schema: { type: 'object' }, side_effects: [], requires_confirmation: false, idempotent: true, retry: { mode: 'never' }, execute: async () => ({}) }) }] });
  await host.registry.start('p'); calls.push(host.toolRegistry.get('plugin_tool').name);
  assert.deepEqual(calls, ['plugin_tool']);
});

test('window registry removes destroyed contents and sends to matching windows', () => {
  const handlers = {}; const sent = [];
  const contents = { once(event, fn) { handlers[event] = fn; }, isDestroyed: () => false, send: (...args) => sent.push(args) };
  const other = { once() {}, isDestroyed: () => false, send: () => {} };
  const registry = createWindowRegistry(); registry.register('main', contents, { kind: 'main' }); registry.register('other', other, { kind: 'floating' });
  assert.equal(registry.send('x', 1, metadata => metadata.kind === 'main'), 1); handlers.destroyed(); assert.equal(registry.get('main'), null); assert.equal(sent.length, 1);
});

test('metrics and task store provide bounded observable persistence', async () => {
  const metrics = createMetrics({ clock: (() => { let now = 1; return () => now++; })() }); metrics.increment('cache.hit'); metrics.observe('request', 4); assert.equal(metrics.snapshot().counters['cache.hit'], 1);
  const dir = await mkdtemp(join(tmpdir(), 'comfy-task-')); const store = new TaskStore(join(dir, 'tasks.json')); store.put({ id: 'a', state: 'queued' }); await store.flush(); assert.equal(JSON.parse(await readFile(join(dir, 'tasks.json'), 'utf8')).length, 1); assert.equal((await new TaskStore(join(dir, 'tasks.json')).load()).get('a').state, 'queued');
});

test('task store reload removes tasks deleted from disk and normalizes ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-task-reload-')); const path = join(dir, 'tasks.json');
  const store = new TaskStore(path); store.put({ id: 1, state: 'queued' }); store.put({ id: 2, state: 'queued' }); await store.flush();
  const replacement = new TaskStore(path); replacement.put({ id: 1, state: 'completed' }); await replacement.flush();
  await store.load();
  assert.equal(store.get(2), null); assert.equal(store.get(1).state, 'completed');
});
