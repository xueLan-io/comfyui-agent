import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/agent/runtime/agent.mjs';
import { AgentEventTypes, on } from '../src/agent/events/agent-events.mjs';

test('agent state transitions emit stage progress without fake percentages', () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'test' } });
  const events = [];
  const unsubscribe = on(AgentEventTypes.PROGRESS, event => events.push(event));
  try {
    agent._transitionState('classifying', { message: 'Classifying request' });
    agent._transitionState('planning', { message: 'Planning task' });
    agent._transitionState('completed', { message: 'Done' });
  } finally {
    unsubscribe();
  }

  assert.deepEqual(events.map(event => [event.scope, event.stage, event.percent]), [
    ['agent', 'classifying', null],
    ['agent', 'planning', null],
    ['agent', 'completed', 100],
  ]);
});
