import assert from 'node:assert/strict';
import test from 'node:test';
import { TRACE_SCHEMA_VERSION, validateTaskTrace } from '../src/runtime/trace-contract.mjs';
import { TaskManager } from '../src/agent/runtime/task-manager.mjs';

test('task traces include a schema version and owner identities', () => {
  const manager = new TaskManager(null);
  manager.create({ id: 'task-1', kind: 'run', traceId: 'trace-1', projectId: 'project-1', sessionId: 'session-1' });

  const trace = manager.getTrace('task-1');

  assert.equal(trace.schemaVersion, TRACE_SCHEMA_VERSION);
  assert.equal(trace.taskId, 'task-1');
  assert.equal(trace.projectId, 'project-1');
});

test('trace validation accepts a complete legacy trace as version zero', () => {
  const trace = { taskId: 'task-1', projectId: 'project-1' };
  assert.equal(validateTaskTrace(trace, 'task-1', 'project-1'), trace);
});

test('trace validation rejects mismatched owners and unsupported schemas', () => {
  assert.throws(
    () => validateTaskTrace({ schemaVersion: 1, taskId: 'task-1', projectId: 'project-2' }, 'task-1', 'project-1'),
    error => error.code === 'trace_invalid',
  );
  assert.throws(
    () => validateTaskTrace({ schemaVersion: TRACE_SCHEMA_VERSION + 1, taskId: 'task-1', projectId: 'project-1' }, 'task-1', 'project-1'),
    error => error.code === 'trace_schema_unsupported',
  );
});
