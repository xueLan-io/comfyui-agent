import assert from 'node:assert/strict';
import test from 'node:test';
import { createGovernanceContext } from '../src/runtime/governance/context.mjs';
import { OperationGateway, confirmationDigest } from '../src/runtime/governance/operation-gateway.mjs';
import { createPolicyEngine } from '../src/runtime/governance/policy-engine.mjs';
import { AdmissionController } from '../src/runtime/governance/admission-controller.mjs';
import { QuotaManager } from '../src/runtime/governance/quota-manager.mjs';
import { RateLimiter } from '../src/runtime/governance/rate-limiter.mjs';

function setup(events) {
  const context = createGovernanceContext({ principalId: 'p', tenantId: 't', projectId: 'pr', sessionId: 's', requestId: 'r', taskId: 'task', traceId: 'trace' });
  const policyEngine = createPolicyEngine({ principals: new Map([['p', { id: 'p', tenantId: 't', roles: ['operator'] }]]) });
  const admission = new AdmissionController({ policyEngine, rateLimiter: new RateLimiter({ limit: 10, burst: 10 }), quotaManager: new QuotaManager({ limits: { generation_count: 1 } }) });
  return { context, gateway: new OperationGateway({ policyEngine, admission, audit: { emit: async event => { events.push(event); } } }) };
}

test('gateway binds confirmation to request and preview digest', async () => {
  const events = []; const { context, gateway } = setup(events); const input = { prompt: 'x' }; const resource = { previewId: 'preview' };
  const confirmation = { accepted: true, digest: confirmationDigest({ action: 'service.invoke', resource, input }), requestId: context.requestId, previewId: resource.previewId };
  assert.deepEqual(await gateway.run({ context, action: 'service.invoke', resource, input, confirmation, execute: async () => ({ state: 'completed' }) }), { state: 'completed' });
  assert.equal(events.some(event => event.decision === 'started'), true);
  assert.equal(events.some(event => event.decision === 'allow'), true);
});

test('gateway releases admission on execution failure and audits denial', async () => {
  const events = []; const { context, gateway } = setup(events);
  await assert.rejects(() => gateway.run({ context, action: 'service.invoke', input: { confirmation: true }, execute: async () => { throw Object.assign(new Error('boom'), { code: 'FAIL' }); } }), error => error.code === 'FAIL');
  assert.equal(events.some(event => event.decision === 'error'), true);
  assert.equal(events.filter(event => ['allow', 'error', 'cancel', 'deny'].includes(event.decision)).length, 1);
});

test('gateway emits deny only when execution was never entered', async () => {
  const events = []; const { context, gateway } = setup(events);
  await assert.rejects(() => gateway.run({ context, action: 'service.invoke', input: {}, execute: async () => ({}) }), error => error.code === 'CONFIRMATION_REQUIRED');
  assert.deepEqual(events.map(event => event.decision), ['deny']);
});

test('coordinator-style comfyui.submit passes quota and confirmation binding (Electron wiring pattern)', async () => {
  const events = [];
  const context = createGovernanceContext({ principalId: 'p', tenantId: 't', projectId: 'pr', sessionId: 's', requestId: 'r1', taskId: 'task1', traceId: 'trace1' });
  const policyEngine = createPolicyEngine({ principals: new Map([['p', { id: 'p', tenantId: 't', roles: ['operator'] }]]) });
  const admission = new AdmissionController({ policyEngine, rateLimiter: new RateLimiter({ limit: 10, burst: 10 }), quotaManager: new QuotaManager({ limits: { generation_count: 1 } }) });
  const gateway = new OperationGateway({ policyEngine, admission, audit: { emit: async event => { events.push(event); } } });
  const resource = { projectId: 'pr', sessionId: 's', previewId: 'preview1' };
  const action = 'comfyui.submit';
  const input = { confirmation: true };
  const confirmation = { accepted: true, digest: confirmationDigest({ action, resource, input }), requestId: context.requestId, previewId: resource.previewId };
  assert.deepEqual(await gateway.run({ context, action, resource, input, quota: { generation_count: 1 }, confirmation, execute: async () => ({ state: 'submitted' }) }), { state: 'submitted' });
  assert.equal(events.some(event => event.decision === 'started'), true);
  assert.equal(events.some(event => event.decision === 'allow'), true);
});

test('coordinator-style generation is denied when generation quota is exhausted', async () => {
  const events = [];
  const context = createGovernanceContext({ principalId: 'p', tenantId: 't', projectId: 'pr', sessionId: 's', requestId: 'r2', taskId: 'task2', traceId: 'trace2' });
  const policyEngine = createPolicyEngine({ principals: new Map([['p', { id: 'p', tenantId: 't', roles: ['operator'] }]]) });
  const admission = new AdmissionController({ policyEngine, rateLimiter: new RateLimiter({ limit: 10, burst: 10 }), quotaManager: new QuotaManager({ limits: { generation_count: 1 } }) });
  const gateway = new OperationGateway({ policyEngine, admission, audit: { emit: async event => { events.push(event); } } });
  const action = 'comfyui.submit';
  const resource = { projectId: 'pr', sessionId: 's', previewId: 'preview2' };
  const input = { confirmation: true };
  const makeConfirmation = requestId => ({ accepted: true, digest: confirmationDigest({ action, resource, input }), requestId, previewId: resource.previewId });
  await gateway.run({ context, action, resource, input, quota: { generation_count: 1 }, confirmation: makeConfirmation(context.requestId), execute: async () => ({ state: 'submitted' }) });
  await assert.rejects(
    () => gateway.run({ context, action, resource, input, quota: { generation_count: 1 }, confirmation: makeConfirmation(context.requestId), execute: async () => ({ state: 'submitted' }) }),
    error => error.code === 'QUOTA_EXCEEDED',
  );
  assert.equal(events.some(event => event.decision === 'deny'), true);
});
