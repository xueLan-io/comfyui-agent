import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTraceOwner } from '../src/runtime/trace-contract.mjs';

test('trace owner enforcement checks project, session, and tenant', () => {
  const trace = { projectId: 'project-a', sessionId: 'session-a', tenantId: 'tenant-a' };
  assert.equal(assertTraceOwner(trace, trace), trace);
  assert.throws(() => assertTraceOwner(trace, { projectId: 'project-b', sessionId: 'session-a', tenantId: 'tenant-a' }), error => error.code === 'TRACE_OWNER_MISMATCH');
  assert.throws(() => assertTraceOwner(trace, { projectId: 'project-a', sessionId: 'session-b', tenantId: 'tenant-a' }), error => error.code === 'TRACE_OWNER_MISMATCH');
});
