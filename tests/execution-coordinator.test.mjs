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
  assert.deepEqual(await cancelling, { cancelled: true, taskId: 'task-1' });
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
