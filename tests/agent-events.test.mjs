import assert from 'node:assert/strict';
import test from 'node:test';
import { emit, on, off, initSession, AgentEventTypes } from '../src/agent/events/agent-events.mjs';

test('emit calls registered handlers', () => {
  let received = null;
  const unsub = on(AgentEventTypes.STATUS, (event) => { received = event; });
  emit(AgentEventTypes.STATUS, { status: 'running', message: 'test' });
  assert.ok(received);
  assert.equal(received.type, AgentEventTypes.STATUS);
  assert.equal(received.status, 'running');
  unsub();
});

test('on returns unsubscribe function', () => {
  let count = 0;
  const unsub = on(AgentEventTypes.STEP, () => { count++; });
  emit(AgentEventTypes.STEP, {});
  assert.equal(count, 1);
  unsub();
  emit(AgentEventTypes.STEP, {});
  assert.equal(count, 1);
});

test('off removes handler', () => {
  let count = 0;
  const handler = () => { count++; };
  on(AgentEventTypes.ERROR, handler);
  emit(AgentEventTypes.ERROR, {});
  assert.equal(count, 1);
  off(AgentEventTypes.ERROR, handler);
  emit(AgentEventTypes.ERROR, {});
  assert.equal(count, 1);
});

test('emit wraps data with createEvent', () => {
  let received = null;
  const unsub = on(AgentEventTypes.MESSAGE, (event) => { received = event; });
  emit(AgentEventTypes.MESSAGE, { role: 'agent', content: 'hi' });
  assert.ok(received.timestamp > 0);
  assert.equal(received.type, AgentEventTypes.MESSAGE);
  assert.equal(received.role, 'agent');
  unsub();
});

test('handler error does not break emit', () => {
  let secondCalled = false;
  const unsub1 = on(AgentEventTypes.STEP, () => { throw new Error('boom'); });
  const unsub2 = on(AgentEventTypes.STEP, () => { secondCalled = true; });
  emit(AgentEventTypes.STEP, {});
  assert.equal(secondCalled, true);
  unsub1();
  unsub2();
});

test('initSession sets sessionId', () => {
  initSession('test-project-123', 'test-session-123');
  let received = null;
  const unsub = on(AgentEventTypes.STATUS, (event) => { received = event; });
  emit(AgentEventTypes.STATUS, { status: 'idle' });
  assert.equal(received.projectId, 'test-project-123');
  assert.equal(received.sessionId, 'test-session-123');
  unsub();
});
