import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  BaseEventSchema,
  PlanEventSchema,
  ProgressEventSchema,
  StatusEventSchema,
  StepEventSchema,
  createEvent,
} from '../src/agent/schemas/event-schema.mjs';
import { TASK_STATUS } from '../src/agent/runtime/task-manager.mjs';

const main = await readFile(new URL('../electron/main.mjs', import.meta.url), 'utf8');

function handlerSource(channel, nextChannel) {
  const start = main.indexOf(`ipcMain.handle('${channel}'`);
  const end = main.indexOf(`ipcMain.handle('${nextChannel}'`, start);
  assert.ok(start >= 0 && end > start, `${channel} handler not found`);
  return main.slice(start, end);
}

test('agent event schemas cover emitted identifiers and statuses', () => {
  assert.ok(BaseEventSchema.properties.requestId);
  assert.ok(BaseEventSchema.properties.turnId);
  const event = createEvent('agent:status', { requestId: 'request-1', turnId: 'turn-1' });
  assert.equal(event.requestId, 'request-1');
  assert.equal(event.turnId, 'turn-1');

  for (const status of TASK_STATUS) assert.ok(StatusEventSchema.properties.status.enum.includes(status), status);
  for (const status of ['waiting', 'preview', 'stopping', 'preparing']) {
    assert.ok(StatusEventSchema.properties.uiStatus.enum.includes(status), status);
  }
  assert.ok(StepEventSchema.properties.status.enum.includes('warning'));
  assert.ok(PlanEventSchema.properties.stage.enum.includes('thinking'));
  assert.ok(PlanEventSchema.properties.stage.enum.includes('clarification'));
  assert.ok(ProgressEventSchema.properties.scope.enum.includes('llm-policy'));
  assert.ok(ProgressEventSchema.properties.scope.enum.includes('timing'));
  assert.ok(ProgressEventSchema.properties.duration_ms);
  assert.ok(ProgressEventSchema.properties.timingPhase.enum.includes('turn'));
  assert.ok(ProgressEventSchema.properties.attempt);
  assert.equal(ProgressEventSchema.properties.attempt.minimum, 1);
});

test('active request status includes uncertain ComfyUI submissions', () => {
  const handler = handlerSource('agent:list-request-status', 'agent:discard-preview');
  assert.match(handler, /RequestStates\.SUBMIT_UNKNOWN/);
});

test('discarding an AI preview cancels its request ledger entry', () => {
  const handler = handlerSource('agent:discard-preview', 'agent:clear-conversation');
  const resolveAt = handler.indexOf('const requestId =');
  const discardAt = handler.indexOf('executionCoordinator.discardPreview');
  assert.ok(resolveAt >= 0 && resolveAt < discardAt);
  assert.match(handler, /pending\?\.requestId[\s\S]{0,80}pending\?\.result\?\.requestId/);
  assert.match(handler, /result\.discarded && requestId/);
  assert.match(handler, /state: RequestStates\.CANCELLED/);
});

test('direct archive failures retain their archive result and skip generic ledger failure', () => {
  const handler = handlerSource('direct:run-prepared', 'direct:discard-preview');
  assert.match(handler, /const archiveResult = error\.archiveResult \|\| taskResult/);
  assert.match(handler, /state: 'archive_failed', result: archiveResult/);
  assert.match(handler, /if \(!archiveFailed\) requestLedger\.fail\(requestId, error\)/);
  assert.doesNotMatch(handler, /state: 'archive_failed'[\s\S]{0,300}state: 'archive_failed'/);
});

test('agent process and initialization errors carry available session ownership', () => {
  assert.match(main, /code: 'AGENT_PROCESS_EXITED',[\s\S]{0,250}projectId: nextAgent\.sessionManager\.activeProjectId \|\| previousProjectId,[\s\S]{0,150}sessionId: nextAgent\.sessionManager\.activeSessionId \|\| previousSessionId/);
  assert.match(main, /error\.projectId \|\|= nextAgent\.sessionManager\.activeProjectId \|\| previousProjectId/);
  assert.match(main, /error\.sessionId \|\|= nextAgent\.sessionManager\.activeSessionId \|\| previousSessionId/);
  assert.match(main, /code: error\.code \|\| 'AGENT_INIT_FAILED', projectId, sessionId/);
});
