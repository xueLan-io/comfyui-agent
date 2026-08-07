import assert from 'node:assert/strict';
import test from 'node:test';
import { createGovernanceContext } from '../src/runtime/governance/context.mjs';
import { createPolicyEngine } from '../src/runtime/governance/policy-engine.mjs';
import { AdmissionController } from '../src/runtime/governance/admission-controller.mjs';
import { QuotaManager } from '../src/runtime/governance/quota-manager.mjs';
import { RateLimiter } from '../src/runtime/governance/rate-limiter.mjs';

test('admission releases quota and execution slots', () => {
  const context = createGovernanceContext({ principalId: 'p', tenantId: 't', projectId: 'pr', sessionId: 's' });
  const admission = new AdmissionController({ policyEngine: createPolicyEngine({ principals: new Map([['p', { id: 'p', tenantId: 't', roles: ['operator'] }]]) }), rateLimiter: new RateLimiter({ limit: 10, burst: 10 }), quotaManager: new QuotaManager({ limits: { generation_count: 1 } }), limits: { 'session:s': 1 } });
  const lease = admission.admit(context, { action: 'service.invoke', input: { confirmation: true }, quota: { generation_count: 1 } });
  assert.throws(() => admission.admit(context, { action: 'service.invoke', input: { confirmation: true } }), error => error.code === 'RATE_LIMITED' || error.code === 'QUOTA_EXCEEDED');
  lease.release();
});

test('admission accepts the session wildcard limit', () => {
  const context = createGovernanceContext({ principalId: 'p', tenantId: 't', projectId: 'pr', sessionId: 's-wildcard' });
  const policyEngine = createPolicyEngine({ principals: new Map([['p', { id: 'p', tenantId: 't', roles: ['operator'] }]]) });
  const admission = new AdmissionController({ policyEngine, limits: { 'session:*': 1 } });
  const first = admission.admit(context, { action: 'service.invoke', input: { confirmation: true } });
  assert.throws(() => admission.admit(context, { action: 'service.invoke', input: { confirmation: true } }), error => error.code === 'RATE_LIMITED');
  first.release();
});
