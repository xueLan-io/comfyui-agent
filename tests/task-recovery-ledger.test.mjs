import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestLedger } from '../electron/request-ledger.mjs';
import { TaskManager } from '../src/agent/runtime/task-manager.mjs';

test('recovery links task and request ledger without resubmitting', () => {
  const ledger = new RequestLedger();
  ledger.begin('request-1', { source: 'direct', fingerprint: 'same', projectId: 'p', sessionId: 's', taskId: 'task-1' });
  const store = { get: () => [], set() {}, async save() {} };
  const manager = new TaskManager(store);
  manager.create({ id: 'task-1', requestId: 'request-1', projectId: 'p', sessionId: 's', traceId: 'trace-1' });
  manager.transition('task-1', 'classifying');
  manager.transition('task-1', 'planning');
  manager.transition('task-1', 'executing');
  manager.transition('task-1', 'observing', { promptId: 'prompt-1' });
  const [recoverable] = manager.recoverInterrupted();
  ledger.recover('request-1', { taskId: recoverable.id, promptId: recoverable.promptId });
  assert.equal(recoverable.state, 'observing');
  assert.equal(ledger.snapshot('request-1').state, 'observing');
  assert.equal(ledger.snapshot('request-1').promptId, 'prompt-1');
});
