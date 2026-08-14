import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/agent/runtime/agent.mjs';
import { AgentEventTypes, on, off } from '../src/agent/events/agent-events.mjs';

test('character research preserves generation after search failure', async () => {
  const events = [];
  const listener = event => events.push(event);
  on(AgentEventTypes.STEP, listener);
  const agent = Object.create(Agent.prototype);
  Object.assign(agent, {
    _taskId: 'task-research',
    _traceId: 'trace-research',
    llm: { isConfigured: true },
    tools: { web: { async execute() { return { error: 'connection refused' }; } } },
  });

  try {
    const context = await agent._researchCharacter('generate Hero character appearance', { allowNetwork: true });
    assert.equal(context.researchStatus, 'search_failed');
    assert.match(context.researchMessage, /未使用在线资料/);
    assert.deepEqual(context.sources, []);
    assert.equal(events.at(-1).status, 'warning');
    assert.equal(events.at(-1).researchStatus, 'search_failed');
  } finally {
    off(AgentEventTypes.STEP, listener);
  }
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

test('character research inherits structured search API settings from the agent', async () => {
  let input;
  const agent = Object.create(Agent.prototype);
  Object.assign(agent, {
    _taskId: 'task-research',
    _traceId: 'trace-research',
    llm: { isConfigured: false },
    researchConfig: {
      searchApi: 'searxng',
      searchApiBaseUrl: 'http://127.0.0.1:8888',
    },
    tools: {
      web: {
        async execute(value) {
          input = value;
          return { error: 'connection refused' };
        },
      },
    },
  });

  await agent._researchCharacter('《原神》 沃雅妮莎 介绍', { allowNetwork: true });
  assert.equal(input.searchApi, 'searxng');
  assert.equal(input.searchApiBaseUrl, 'http://127.0.0.1:8888');
});
