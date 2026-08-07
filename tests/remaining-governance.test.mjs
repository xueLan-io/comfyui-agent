import assert from 'node:assert/strict';
import test from 'node:test';
import { createGovernanceContext } from '../src/runtime/governance/context.mjs';
import { createPolicyEngine } from '../src/runtime/governance/policy-engine.mjs';
import { AdmissionController } from '../src/runtime/governance/admission-controller.mjs';
import { RateLimiter } from '../src/runtime/governance/rate-limiter.mjs';
import { OperationGateway } from '../src/runtime/governance/operation-gateway.mjs';

test('remaining side-effect entries can be governed with owner context', async () => {
  const events = [];
  const context = createGovernanceContext({ principalId: 'p', tenantId: 't', projectId: 'project-a', sessionId: 'session-a', source: 'ipc' });
  const policy = createPolicyEngine({ principals: new Map([['p', { id: 'p', tenantId: 't', roles: ['admin'] }]]) });
  const gateway = new OperationGateway({ policyEngine: policy, admission: new AdmissionController({ policyEngine: policy, rateLimiter: new RateLimiter({ limit: 10, burst: 10 }) }), audit: { emit: async event => events.push(event) } });
  const result = await gateway.run({ context, action: 'workflow.write', resource: { projectId: 'project-a' }, input: { confirmation: true }, execute: async () => ({ committed: true }) });
  assert.deepEqual(result, { committed: true });
  assert.equal(events.every(event => event.projectId === 'project-a' && event.sessionId === 'session-a'), true);
});

test('owner mismatch is rejected before remaining operation executes', async () => {
  const context = createGovernanceContext({ principalId: 'p', tenantId: 't', projectId: 'project-a', sessionId: 'session-a', source: 'ipc' });
  const policy = createPolicyEngine({ principals: new Map([['p', { id: 'p', tenantId: 't', roles: ['admin'] }]]) });
  const gateway = new OperationGateway({ policyEngine: policy, admission: new AdmissionController({ policyEngine: policy }) });
  let executed = false;
  await assert.rejects(() => gateway.run({ context, action: 'media.export', resource: { projectId: 'project-b' }, input: { confirmation: true }, execute: async () => { executed = true; } }), error => error.code === 'PROJECT_ACCESS_DENIED');
  assert.equal(executed, false);
});
