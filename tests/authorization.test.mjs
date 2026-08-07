import assert from 'node:assert/strict';
import test from 'node:test';
import { createGovernanceContext } from '../src/runtime/governance/context.mjs';
import { assertAuthorized } from '../src/runtime/governance/authorization.mjs';
import { createPolicyEngine } from '../src/runtime/governance/policy-engine.mjs';

const context = createGovernanceContext({ principalId: 'p', tenantId: 't', projectId: 'pr', sessionId: 's', source: 'internal' });
test('policy grants scoped role permission and requires confirmation', () => {
  const engine = createPolicyEngine({ principals: new Map([['p', { id: 'p', tenantId: 't', roles: ['editor'] }]]) });
  const decision = engine.authorize(context, 'workflow.write', { projectId: 'pr' }, {});
  assert.equal(decision.allowed, true);
  assert.equal(decision.requiredConfirmation, true);
  assert.throws(() => assertAuthorized(decision), error => error.code === 'CONFIRMATION_REQUIRED');
});

test('policy denies cross tenant and project access', () => {
  const engine = createPolicyEngine({ principals: new Map([['p', { id: 'p', tenantId: 't', roles: ['viewer'] }]]) });
  assert.equal(engine.authorize(context, 'project.read', { tenantId: 'other' }).code, 'TENANT_MISMATCH');
  assert.equal(engine.authorize(context, 'project.read', { projectId: 'other' }).code, 'PROJECT_ACCESS_DENIED');
});
