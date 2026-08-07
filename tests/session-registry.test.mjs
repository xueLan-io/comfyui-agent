import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionRegistry } from '../src/runtime/governance/session-registry.mjs';

test('session registry isolates, expires, and revokes sessions', () => {
  let now = 1000;
  const registry = new SessionRegistry({ clock: () => now, ttlMs: 100 });
  const session = registry.createSession({ id: 'p', tenantId: 't' }, { projectId: 'pr' });
  assert.equal(registry.isValidSession(session.sessionId), true);
  assert.throws(() => registry.assertSession(session.sessionId, { projectId: 'other' }), error => error.code === 'PROJECT_ACCESS_DENIED');
  now = 1200;
  assert.equal(registry.isValidSession(session.sessionId), false);
  assert.equal(registry.revokeSession(session.sessionId), true);
});
