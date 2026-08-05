import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'node:path';
import { JSONFileStore } from '../src/agent/memory/store.mjs';
import { TaskManager } from '../src/agent/runtime/task-manager.mjs';

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'comfy-agent-taskmgr-'));
}

test('create task with defaults', () => {
  const mgr = new TaskManager(null);
  const task = mgr.create({ id: 't1', kind: 'run' });
  assert.equal(task.id, 't1');
  assert.equal(task.kind, 'run');
  assert.equal(task.status, 'queued');
  assert.equal(task.message, '');
  assert.equal(task.workflowName, '');
  assert.ok(task.createdAt > 0);
  assert.ok(task.updatedAt > 0);
});

test('create task with custom fields', () => {
  const mgr = new TaskManager(null);
  const task = mgr.create({ id: 't2', kind: 'chat', message: 'hello', workflowName: 'test.json' });
  assert.equal(task.message, 'hello');
  assert.equal(task.workflowName, 'test.json');
});

test('update task patch and updatedAt', () => {
  const mgr = new TaskManager(null);
  const task = mgr.create({ id: 't3', kind: 'run' });
  const before = task.updatedAt;
  const updated = mgr.update('t3', { status: 'executing', error: '' });
  assert.equal(updated.status, 'executing');
  assert.ok(updated.updatedAt >= before);
});

test('update non-existent task returns null', () => {
  const mgr = new TaskManager(null);
  assert.equal(mgr.update('nonexistent', { status: 'error' }), null);
});

test('get returns task by id', () => {
  const mgr = new TaskManager(null);
  mgr.create({ id: 't4', kind: 'run' });
  assert.equal(mgr.get('t4').id, 't4');
  assert.equal(mgr.get('missing'), undefined);
});

test('list returns latest N tasks reversed', () => {
  const mgr = new TaskManager(null);
  mgr.create({ id: 't1', kind: 'run' });
  mgr.create({ id: 't2', kind: 'run' });
  mgr.create({ id: 't3', kind: 'run' });
  const list = mgr.list(2);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 't3');
  assert.equal(list[1].id, 't2');
});

test('persist saves to store and load restores', async () => {
  const dir = makeTempDir();
  try {
    const store = new JSONFileStore(dir, 'tasks.json');
    const mgr = new TaskManager(store);
    mgr.create({ id: 'p1', kind: 'run', message: 'persist me' });
    await mgr.persist();

    const mgr2 = new TaskManager(new JSONFileStore(dir, 'tasks.json'));
    await mgr2.load();
    assert.equal(mgr2.get('p1').message, 'persist me');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('load from empty store', async () => {
  const dir = makeTempDir();
  try {
    const mgr = new TaskManager(new JSONFileStore(dir, 'tasks.json'));
    await mgr.load();
    assert.equal(mgr.tasks.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trace records plan, attempts, retries, result, and timings', () => {
  const mgr = new TaskManager(null);
  mgr.create({ id: 'trace-task', kind: 'run', message: 'make an image', traceId: 'trace-1', intent: 'generate' });
  mgr.recordPlan('trace-task', { goal: 'image', steps: [{ id: 'step1', tool: 'comfyui' }] });
  mgr.recordStep('trace-task', { stepId: 'step1', tool: 'comfyui', attempt: 1, status: 'failed', duration_ms: 25, error: 'temporary' });
  mgr.recordRetry('trace-task', { stepId: 'step1', attempt: 1, reason: 'temporary' });
  mgr.complete('trace-task', { result: { imageCount: 1 } });

  const trace = mgr.getTrace('trace-task');
  assert.equal(trace.taskId, 'trace-task');
  assert.equal(trace.traceId, 'trace-1');
  assert.equal(trace.intent, 'generate');
  assert.equal(trace.steps[0].status, 'failed');
  assert.equal(trace.retries.length, 1);
  assert.equal(trace.timings.step1.total_ms, 25);
  assert.equal(trace.result.imageCount, 1);
  assert.ok(trace.completedAt > 0);
});

test('trace records request and ComfyUI attempt identities', () => {
  const mgr = new TaskManager(null);
  mgr.create({ id: 'identity-task', kind: 'run', requestId: 'request-1', projectId: 'project-1' });
  const attempt = mgr.beginAttempt('identity-task', { stepId: 'step1', attempt: 1 });
  mgr.updateAttempt('identity-task', attempt.attemptId, { promptId: 'prompt-1', phase: 'submitted' });

  const trace = mgr.getTrace('identity-task');
  assert.equal(trace.requestId, 'request-1');
  assert.equal(trace.attempts[0].attemptId, attempt.attemptId);
  assert.equal(trace.attempts[0].promptId, 'prompt-1');
});

test('recoverInterrupted keeps submitted tasks observable and abandons pre-submit tasks', () => {
  const mgr = new TaskManager(null);
  mgr.create({ id: 'submitted', kind: 'run' });
  mgr.transition('submitted', 'classifying');
  mgr.update('submitted', { promptId: 'prompt-1' });
  mgr.create({ id: 'unsubmitted', kind: 'run' });
  mgr.transition('unsubmitted', 'classifying');

  const recoverable = mgr.recoverInterrupted();

  assert.deepEqual(recoverable.map(task => task.id), ['submitted']);
  assert.equal(mgr.get('submitted').state, 'observing');
  assert.equal(mgr.get('unsubmitted').state, 'abandoned');
});

test('task manager exposes recovery-specific terminal states', () => {
  const mgr = new TaskManager(null);
  mgr.create({ id: 'recover-state', kind: 'run' });
  mgr.transition('recover-state', 'classifying');
  mgr.transition('recover-state', 'planning');
  mgr.transition('recover-state', 'executing');
  mgr.transition('recover-state', 'observing');
  mgr.transition('recover-state', 'observe_timeout');
  mgr.transition('recover-state', 'observing');
  mgr.transition('recover-state', 'archive_failed');
  assert.equal(mgr.get('recover-state').state, 'archive_failed');
});

test('attempt ids remain distinct across retries', () => {
  const mgr = new TaskManager(null);
  mgr.create({ id: 'retry-task', kind: 'run' });
  const first = mgr.beginAttempt('retry-task', { stepId: 'step1', attempt: 1 });
  const second = mgr.beginAttempt('retry-task', { stepId: 'step1', attempt: 2 });

  assert.notEqual(first.attemptId, second.attemptId);
  assert.equal(mgr.getTrace('retry-task').attempts.length, 2);
});

test('settleComplete settles observing and archive_failed tasks into completed', () => {
  const mgr = new TaskManager(null);
  mgr.create({ id: 'obs', kind: 'run' });
  mgr.transition('obs', 'classifying');
  mgr.transition('obs', 'planning');
  mgr.transition('obs', 'executing');
  mgr.transition('obs', 'observing');
  mgr.create({ id: 'arch', kind: 'run' });
  mgr.transition('arch', 'classifying');
  mgr.transition('arch', 'planning');
  mgr.transition('arch', 'executing');
  mgr.transition('arch', 'observing');
  mgr.transition('arch', 'archive_failed');

  mgr.settleComplete('obs', { result: { recovered: true } });
  mgr.settleComplete('arch', { result: { recovered: true } });

  assert.equal(mgr.get('obs').state, 'completed');
  assert.equal(mgr.get('obs').status, 'completed');
  assert.deepEqual(mgr.get('obs').result, { recovered: true });
  assert.ok(mgr.get('obs').completedAt > 0);
  assert.equal(mgr.get('arch').state, 'completed');
});

test('settleComplete settles recovery-specific states via direct update', () => {
  const mgr = new TaskManager(null);
  mgr.create({ id: 'unknown', kind: 'run' });
  mgr.transition('unknown', 'classifying');
  mgr.transition('unknown', 'planning');
  mgr.transition('unknown', 'executing');
  mgr.transition('unknown', 'observing');
  mgr.transition('unknown', 'submit_unknown');

  mgr.settleComplete('unknown', { result: { recovered: true } });

  assert.equal(mgr.get('unknown').state, 'completed');
  assert.equal(mgr.get('unknown').result.recovered, true);
});

test('settleComplete returns null for unknown tasks', () => {
  const mgr = new TaskManager(null);
  assert.equal(mgr.settleComplete('missing', { result: {} }), null);
});

test('archive marks recoverable task abandoned', () => {
  const mgr = new TaskManager(null);
  mgr.create({ id: 'archive-task', kind: 'run' });
  mgr.transition('archive-task', 'classifying');
  mgr.transition('archive-task', 'planning');
  mgr.transition('archive-task', 'executing');
  mgr.transition('archive-task', 'observing');

  const archived = mgr.archive('archive-task');

  assert.equal(archived.state, 'abandoned');
  assert.equal(archived.status, 'abandoned');
  assert.equal(archived.lastError, 'Archived by user');
  assert.equal(mgr.archive('archive-task'), null);
});
