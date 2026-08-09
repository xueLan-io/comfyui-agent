import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertServiceManifest, validateServiceManifest } from '../src/runtime/service-contract.mjs';
import { createServiceRegistry } from '../src/runtime/service-registry.mjs';
import { ServiceInvoker } from '../src/runtime/service-invoke.mjs';

const manifest = {
  contractVersion: '1.0', serviceId: 'test-service', name: 'Test', version: '1.0.0', kind: 'local',
  inputs: {}, outputs: {}, execution: { prepareRequired: true, requiresConfirmation: true, timeoutMs: 1000 },
  permissions: { prepare: 'read', invoke: 'execute', status: 'read', cancel: 'execute', result: 'read', archive: 'mutate', download: 'read' },
};

test('service manifest validates required contract and permissions', () => {
  assert.equal(validateServiceManifest(manifest).valid, true);
  assert.throws(() => assertServiceManifest({ ...manifest, serviceId: '' }), /serviceId/);
});

test('service registry rejects duplicate ids and resolves actions', () => {
  const service = { manifest, status: () => ({ state: 'queued' }) };
  const registry = createServiceRegistry([service]);
  assert.equal(registry.manifest('test-service').serviceId, 'test-service');
  assert.equal(registry.resolve('test-service', 'status')().state, 'queued');
  assert.throws(() => createServiceRegistry([service, service]), /Duplicate/);
});

test('service invoker requires confirmation and preserves preview identity', async () => {
  const service = { manifest, invoke: async input => ({ state: 'queued', digest: input.idempotencyKey }) };
  const registry = createServiceRegistry([service]);
  const ledger = { entries: new Map(), begin(id, value) { this.entries.set(id, { requestId: id, ...value }); }, update() {}, snapshot(id) { return this.entries.get(id); } };
  const invoker = new ServiceInvoker({ registry, ledger, clock: () => 1000 });
  const owner = { principalId: 'p', projectId: 'x', sessionId: 's', permissions: ['read', 'execute'] };
  const preview = await invoker.prepare({ serviceId: 'test-service', input: { prompt: 'cat' }, owner });
  await assert.rejects(() => invoker.invoke({ serviceId: 'test-service', previewId: preview.previewId, requestId: preview.requestId, confirmation: false, owner }), error => error.code === 'CONFIRMATION_REQUIRED');
  const result = await invoker.invoke({ serviceId: 'test-service', previewId: preview.previewId, requestId: preview.requestId, confirmation: true, owner: preview.owner });
  assert.equal(result.state, 'queued');
  assert.equal(invoker.previews.has(preview.previewId), false);
});

test('service invocation shares one in-flight side effect for concurrent callers', async () => {
  let calls = 0;
  let release;
  const service = { manifest, invoke: async input => { calls++; await new Promise(resolve => { release = resolve; }); return { state: 'queued', digest: input.idempotencyKey }; } };
  const registry = createServiceRegistry([service]);
  const ledger = { begin() {}, update() {}, snapshot() { return null; } };
  const invoker = new ServiceInvoker({ registry, ledger, clock: () => 1000 });
  const owner = { principalId: 'p', projectId: 'x', sessionId: 's', permissions: ['read', 'execute'] };
  const preview = await invoker.prepare({ serviceId: 'test-service', input: { prompt: 'cat' }, owner });
  const input = { serviceId: 'test-service', previewId: preview.previewId, requestId: preview.requestId, confirmation: true, owner };
  const first = invoker.invoke(input);
  const second = invoker.invoke(input);
  await new Promise(resolve => setImmediate(resolve));
  release();
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(results[0], results[1]);
});

test('service status and result do not expose unknown or foreign service requests', () => {
  const registry = createServiceRegistry([{ manifest, status: () => ({ state: 'queued' }), result: () => ({}) }]);
  const ledger = { snapshot() { return null; } };
  const invoker = new ServiceInvoker({ registry, ledger });
  const owner = { principalId: 'p', projectId: 'x', sessionId: 's', permissions: ['read'] };
  assert.deepEqual(invoker.status({ serviceId: 'test-service', requestId: 'missing', owner }), { code: 'REQUEST_NOT_FOUND' });
  assert.deepEqual(invoker.result({ serviceId: 'test-service', requestId: 'missing', owner }), { code: 'REQUEST_NOT_FOUND' });
});
