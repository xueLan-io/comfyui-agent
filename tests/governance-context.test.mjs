import assert from 'node:assert/strict';
import test from 'node:test';
import { assertGovernanceContext, bindOwner, createGovernanceContext, sameGovernanceOwner } from '../src/runtime/governance/context.mjs';

test('governance context is normalized and immutable', () => {
  const context = createGovernanceContext({ principalId: 'p', tenantId: 't', projectId: 'pr', sessionId: 's', source: 'mcp' });
  assert.equal(context.source, 'mcp');
  assert.equal(Object.isFrozen(context), true);
  assert.doesNotThrow(() => assertGovernanceContext(context));
  assert.equal(sameGovernanceOwner(context, { ...context }), true);
  assert.deepEqual(bindOwner({ assetId: 'a' }, context), { assetId: 'a', principalId: 'p', tenantId: 't', projectId: 'pr', sessionId: 's' });
});

test('side effect context requires an owner', () => {
  assert.throws(() => assertGovernanceContext({ source: 'mcp' }), error => error.code === 'AUTHENTICATION_REQUIRED' || error.code === 'GOVERNANCE_CONTEXT_INVALID');
});
