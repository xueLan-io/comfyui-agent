import assert from 'node:assert/strict';
import test from 'node:test';
import { createIpcGateway } from '../src/runtime/governance/ipc-gateway.mjs';

test('IPC gateway checks sender and delegates context/resource to operation gateway', async () => {
  const calls = [];
  const ipc = createIpcGateway({
    gateway: { run: async input => { calls.push(input); return input.execute({ signal: null }); } },
    resolveContext: async () => ({ principalId: 'p', tenantId: 't', projectId: 'pr', sessionId: 's', requestId: 'r', taskId: 'task', traceId: 'trace', source: 'ipc' }),
    resolveResource: async (_, input) => ({ projectId: input.projectId }),
    // The default is fail-closed; production callers must opt in explicitly.
    senderCheck: () => true,
  });
  ipc.registerAuthorizedHandler('project:rename', { action: 'project.write' }, async (_, input) => input.name);
  assert.equal(await ipc.get('project:rename')({}, { projectId: 'pr', name: 'new' }), 'new');
  assert.equal(calls[0].action, 'project.write');
  assert.equal(calls[0].resource.projectId, 'pr');
});

test('IPC gateway rejects an unregistered sender', async () => {
  const ipc = createIpcGateway({ gateway: { run: async () => true }, senderCheck: () => false });
  ipc.registerAuthorizedHandler('project:delete', { action: 'project.write' }, async () => true);
  await assert.rejects(() => ipc.get('project:delete')({}, {}), error => error.code === 'AUTHORIZATION_DENIED');
});
