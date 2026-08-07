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
