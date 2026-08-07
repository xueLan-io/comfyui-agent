import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginRegistry } from '../src/runtime/plugins/plugin-registry.mjs';
import { assertPluginManifest, validatePluginManifest } from '../src/runtime/plugins/plugin-contract.mjs';

const manifest = { contractVersion: '1.0', pluginId: 'example', name: 'Example', version: '1.0.0', capabilities: ['tools'] };

test('plugin manifest validates identity and capabilities', () => {
  assert.equal(validatePluginManifest(manifest).valid, true);
  assert.throws(() => assertPluginManifest({ ...manifest, capabilities: ['network'] }), /capabilities/);
});

test('registry enforces declared capabilities and duplicate ids', () => {
  assert.throws(() => createPluginRegistry({ plugins: [{ manifest, services() {} }] }), /undeclared capability/);
  const plugin = { manifest, start: async ({ host }) => host.registerTool?.({ name: 'example' }) };
  const registry = createPluginRegistry({ plugins: [plugin] });
  assert.throws(() => createPluginRegistry({ plugins: [plugin, plugin] }), /Duplicate pluginId/);
  assert.equal(registry.manifest('example').state, 'registered');
});

test('plugin lifecycle is idempotent and removes stopped plugins', async () => {
  const calls = [];
  const registry = createPluginRegistry({ plugins: [{ manifest: { ...manifest, pluginId: 'life' }, start: () => calls.push('start'), stop: () => calls.push('stop') }] });
  await registry.start('life'); await registry.start('life');
  assert.deepEqual(calls, ['start']);
  assert.equal(registry.manifest('life').state, 'started');
  await registry.remove('life');
  assert.deepEqual(calls, ['start', 'stop']);
  assert.equal(registry.get('life'), null);
});
