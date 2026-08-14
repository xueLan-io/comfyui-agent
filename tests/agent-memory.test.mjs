import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/agent/runtime/agent.mjs';
import { LongTermMemory } from '../src/agent/memory/long-term.mjs';

function stubAgent({ memory } = {}) {
  const agent = Object.create(Agent.prototype);
  Object.defineProperty(agent, 'project', {
    configurable: true,
    writable: true,
    value: { get: name => ({ workflow: 'anima.json' }[name]) },
  });
  Object.defineProperty(agent, 'conversation', {
    configurable: true,
    writable: true,
    value: { getArchiveCandidate: () => [] },
  });
  Object.assign(agent, {
    memory,
    projectId: 'project_default',
    _traceId: 'trace-1',
    _requestId: 'request-1',
    sessionManager: {
      activeProjectId: 'project-a',
      setSessionState: () => {},
    },
  });
  return agent;
}

test('_memoryContext returns recall for the active project and empty string without memory', async () => {
  const memory = new LongTermMemory();
  await memory.init();
  await memory.captureSession('project-a', { summary: { facts: ['用户偏好冷色系风格'] }, workflowName: 'anima.json' });
  const agent = stubAgent({ memory });
  const context = await agent._memoryContext('帮我生成');
  assert.match(context, /长期记忆/);
  assert.match(context, /冷色系风格/);

  const bare = stubAgent();
  assert.equal(await bare._memoryContext('hi'), '');
});

test('_prepareConversationArchive distills an archived segment into long-term memory', async () => {
  const memory = new LongTermMemory();
  await memory.init();
  const agent = stubAgent({ memory });
  agent.conversation = {
    getArchiveCandidate: (recent, max) => [
      { messageId: 'm1', ts: 1, role: 'user', content: '用 anima 工作流生成夜色车站' },
      { messageId: 'm2', ts: 2, role: 'agent', content: '好的，我会使用 anima 工作流。' },
      { messageId: 'm3', ts: 3, role: 'user', content: '偏好冷色系，不要文字元素' },
      { messageId: 'm4', ts: 4, role: 'agent', content: '已记录约束。' },
    ],
  };
  agent.llm = {
    isConfigured: true,
    async chat() {
      return { content: JSON.stringify({ objective: '生成夜色车站插画', decisions: [], constraints: ['不要文字元素'], completed: [], openItems: [], facts: ['用户偏好冷色系', '使用 anima 工作流'] }) };
    },
  };
  const archive = await agent._prepareConversationArchive({
    recentCount: 8,
    mode: 'local',
    inputBudget: 0,
    currentMessages: [
      { role: 'user', content: '用 anima 工作流生成夜色车站插画，偏好冷色系，不要文字元素。' },
      { role: 'agent', content: '好的，我会使用 anima 工作流并保持冷色系。' },
    ],
  });
  assert.ok(archive.segments.length >= 1);
  const state = memory.projectState('project-a');
  assert.ok(state, 'memory should have a project entry');
  assert.ok(state.segmentCount >= 1, 'memory should have captured the segment');
  assert.ok(state.profile.styles.some(text => text.includes('冷色系')));
  assert.equal(state.profile.workflows['anima.json'] >= 1, true);
});
