import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionCoordinator } from '../electron/execution-coordinator.mjs';

test('coordinator keeps the execution lock until work settles after cancellation', async () => {
  const coordinator = new ExecutionCoordinator();
  let release;
  const settled = new Promise(resolve => { release = resolve; });
  const cancelCalls = [];
  const execution = coordinator.execute({
    source: 'direct',
    taskId: 'task-1',
    owner: { projectId: 'project-1', sessionId: 'session-1', projectDir: 'project', workflowDir: 'workflow' },
    work: async () => {
      await settled;
      return { cancelled: true };
    },
    cancel: async () => cancelCalls.push('cancel'),
  });

  await new Promise(resolve => setImmediate(resolve));
  const cancelling = coordinator.cancel({ source: 'direct', taskId: 'task-1' });
  assert.equal(coordinator.isBusy, true);
  await assert.rejects(
    () => coordinator.execute({ source: 'ai', owner: {}, work: async () => ({}) }),
    error => error.code === 'GENERATION_BUSY',
  );
  release();
  assert.deepEqual(await cancelling, { cancelled: true, settled: true, requestId: '', taskId: 'task-1', phase: 'cancelled' });
  assert.deepEqual(await execution, { cancelled: true });
  assert.deepEqual(cancelCalls, ['cancel']);
  assert.equal(coordinator.isBusy, false);
});

test('preview ownership must match when it is confirmed', async () => {
  const coordinator = new ExecutionCoordinator();
  const owner = { projectId: 'project-1', sessionId: 'session-1', projectDir: 'project', workflowDir: 'workflow' };
  coordinator.registerPreview({ source: 'direct', previewId: 'preview-1', owner });

  await assert.rejects(
    () => coordinator.execute({ source: 'direct', previewId: 'preview-1', owner: { ...owner, sessionId: 'session-2' }, work: async () => ({}) }),
    error => error.code === 'GENERATION_OWNER_MISMATCH',
  );
  assert.ok(coordinator.getPreview('preview-1'));
  await coordinator.execute({ source: 'direct', previewId: 'preview-1', owner, work: async () => ({ ok: true }) });
  assert.equal(coordinator.isBusy, false);
});

test('failed preview execution keeps the preview available for retry', async () => {
  const coordinator = new ExecutionCoordinator();
  const owner = { projectId: 'project-1', sessionId: 'session-1', projectDir: 'project', workflowDir: 'workflow' };
  coordinator.registerPreview({ source: 'ai', previewId: 'preview-1', taskId: 'task-1', owner });

  await assert.rejects(
    coordinator.execute({
      source: 'ai',
      previewId: 'preview-1',
      taskId: 'task-1',
      owner,
      work: async () => { throw new Error('prepare failed'); },
    }),
    /prepare failed/,
  );

  assert.equal(coordinator.getPreview('preview-1').status, 'prepared');
});

test('preview is consumed only after successful execution', async () => {
  const coordinator = new ExecutionCoordinator();
  const owner = { projectId: 'project-1', sessionId: 'session-1', projectDir: 'project', workflowDir: 'workflow' };
  coordinator.registerPreview({ source: 'ai', previewId: 'preview-2', owner });

  await coordinator.execute({ source: 'ai', previewId: 'preview-2', owner, work: async () => ({ ok: true }) });

  assert.equal(coordinator.getPreview('preview-2'), null);
});

test('coordinator keeps a stuck execution locked after cancellation timeout', async () => {
  const coordinator = new ExecutionCoordinator();
  const execution = coordinator.execute({
    source: 'direct',
    taskId: 'stuck-task',
    owner: {},
    work: async () => new Promise(() => {}),
    cancel: async () => {},
  });

  await new Promise(resolve => setImmediate(resolve));
  const started = Date.now();
  const result = await coordinator.cancel({ source: 'direct', taskId: 'stuck-task' });

  assert.equal(result.cancelled, true);
  assert.ok(Date.now() - started >= 4900);
  assert.equal(coordinator.isBusy, true);
  await assert.rejects(
    () => coordinator.execute({ source: 'direct', owner: {}, work: async () => ({ recovered: true }) }),
    error => error.code === 'GENERATION_BUSY',
  );
  // The unresolved promise is intentionally retained to prove the lock is
  // not released while remote observe/archive work is still alive.
  void execution;
});

test('busy errors expose the active request owner and cancellation reports stopping', async () => {
  const coordinator = new ExecutionCoordinator();
  const execution = coordinator.execute({
    source: 'direct',
    requestId: 'request-1',
    taskId: 'task-1',
    owner: { projectId: 'project-1', sessionId: 'session-1' },
    work: async () => new Promise(() => {}),
    cancel: async () => {},
  });

  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(
    () => coordinator.execute({ source: 'ai', owner: {}, work: async () => ({}) }),
    error => error.code === 'GENERATION_BUSY'
      && error.requestId === 'request-1'
      && error.projectId === 'project-1'
      && error.sessionId === 'session-1',
  );
  const result = await coordinator.cancel({ source: 'direct', taskId: 'task-1' });
  assert.deepEqual(result, {
    cancelled: true,
    settled: false,
    requestId: 'request-1',
    taskId: 'task-1',
    phase: 'stopping',
  });
  assert.deepEqual(coordinator.getState(), {
    busy: true,
    source: 'direct',
    requestId: 'request-1',
    taskId: 'task-1',
    phase: 'stopping',
    owner: { projectId: 'project-1', sessionId: 'session-1' },
  });
  void execution;
});
