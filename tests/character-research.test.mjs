import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/agent/runtime/agent.mjs';

test('character research preserves generation after search failure', async () => {
  const agent = Object.create(Agent.prototype);
  Object.assign(agent, {
    _taskId: 'task-research',
    _traceId: 'trace-research',
    llm: { isConfigured: true },
    tools: { web: { async execute() { return { error: 'connection refused' }; } } },
  });

  const context = await agent._researchCharacter('generate Hero character appearance', { allowNetwork: true });
  assert.equal(context.researchStatus, 'search_failed');
  assert.match(context.researchMessage, /未使用在线资料/);
  assert.deepEqual(context.sources, []);
});

test('disabled character research returns an explicit offline status', async () => {
  const agent = Object.create(Agent.prototype);
  Object.assign(agent, {
    _taskId: 'task-research',
    _traceId: 'trace-research',
    llm: { isConfigured: true },
    tools: { web: { async execute() { return { error: '未进行在线检索', researchStatus: 'disabled' }; } } },
  });

  const context = await agent._researchCharacter('generate Hero character appearance', { allowNetwork: false });
  assert.equal(context.researchStatus, 'disabled');
  assert.equal(context.researchMessage, '未进行在线检索');
});
