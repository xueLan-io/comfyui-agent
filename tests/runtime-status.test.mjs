import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRuntimeView, generationRecordView, runtimePhaseForStatus } from '../src/runtime/runtime-status.mjs';
import { CANCELLED, COMPLETED, ERROR, IDLE, PREPARING, RUNNING, STOPPING, canTransition } from '../src/runtime/generation-state-machine.mjs';

test('maps every backend lifecycle family to one frontend phase', () => {
  assert.equal(runtimePhaseForStatus('classifying'), 'preparing');
  assert.equal(runtimePhaseForStatus('clarifying'), 'awaiting_input');
  assert.equal(runtimePhaseForStatus('prepared'), 'preview');
  assert.equal(runtimePhaseForStatus('queued'), 'queued');
  assert.equal(runtimePhaseForStatus('observing'), 'running');
  assert.equal(runtimePhaseForStatus('stopping'), 'stopping');
  assert.equal(runtimePhaseForStatus('completed'), 'completed');
  assert.equal(runtimePhaseForStatus('failed'), 'failed');
  assert.equal(runtimePhaseForStatus('archive_failed'), 'recovery');
  assert.equal(runtimePhaseForStatus('submit_unknown'), 'recovery');
});

test('runtime view is the single source of busy and recovery semantics', () => {
  assert.equal(buildRuntimeView({ rawStatus: 'executing' }).busy, true);
  assert.equal(buildRuntimeView({ rawStatus: 'clarifying' }).busy, false);
  assert.equal(buildRuntimeView({ rawStatus: 'archive_failed' }).recoverable, true);
  assert.equal(buildRuntimeView({ rawStatus: 'cancelled' }).terminal, true);
  assert.equal(buildRuntimeView({ rawStatus: 'completed' }).tone, 'success');
});

test('generation records preserve archive failures as recoverable output', () => {
  const view = generationRecordView({ status: 'archive_failed', media: [{ filename: 'result.png' }] });
  assert.equal(view.phase, 'recovery');
  assert.equal(view.recoverable, true);
});

test('generation state machine accepts real restart, recovery and cancellation paths', () => {
  assert.equal(canTransition(IDLE, ERROR), true);
  assert.equal(canTransition(IDLE, STOPPING), true);
  assert.equal(canTransition(RUNNING, IDLE), true);
  assert.equal(canTransition(STOPPING, CANCELLED), true);
  assert.equal(canTransition(ERROR, PREPARING), true);
  assert.equal(canTransition(COMPLETED, RUNNING), true);
});
