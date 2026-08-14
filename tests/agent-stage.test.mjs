import assert from 'node:assert/strict';
import test from 'node:test';
import { agentStageState } from '../src/runtime/agent-stage.mjs';

test('Agent stage mapping exposes ordered execution lifecycle', () => {
  assert.equal(agentStageState('classifying').index, 0);
  assert.equal(agentStageState('planning').index, 1);
  assert.equal(agentStageState('executing').index, 2);
  assert.equal(agentStageState('observing').index, 3);
  assert.equal(agentStageState('completed').index, 4);
  assert.equal(agentStageState('replanning').index, 1);
  assert.equal(agentStageState('retrying').index, 2);
});

test('Agent stage mapping suppresses non-execution states', () => {
  for (const status of ['idle', 'clarifying', 'awaiting_confirmation', 'failed', 'cancelled', '']) {
    assert.equal(agentStageState(status), null);
  }
});
