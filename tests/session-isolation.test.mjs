import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/agent/runtime/agent.mjs';
import { AgentEventTypes, emit, on } from '../src/agent/events/agent-events.mjs';

async function createAgent() {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: '' } });
  await agent.init();
  return agent;
}

test('switching sessions clears Agent runtime state and rebinds events', async () => {
  const agent = await createAgent();
  const projectId = agent.sessionManager.activeProjectId;
  const firstSessionId = agent.sessionManager.activeSessionId;
  const second = await agent.sessionManager.createSession('Second');
  agent._lastManifest = { workflowName: 'old.json' };
  agent._artifacts = [{ artifactId: 'old' }];
  agent._preparedRuns.set('preview_old', {});
  agent._taskId = 'task_old';
  agent._state = 'completed';

  await agent.useSession(projectId, firstSessionId);

  assert.equal(agent._lastManifest, null);
  assert.deepEqual(agent._artifacts, []);
  assert.equal(agent._preparedRuns.size, 0);
  assert.equal(agent._taskId, '');
  assert.equal(agent.state, 'idle');

  let received = null;
  const unsubscribe = on(AgentEventTypes.STATUS, event => { received = event; });
  await agent.useSession(projectId, second.id);
  emit(AgentEventTypes.STATUS, { status: 'idle' });
  unsubscribe();

  assert.equal(received.projectId, projectId);
  assert.equal(received.sessionId, second.id);
});

test('session changes reject an active Agent task', async () => {
  const agent = await createAgent();
  const projectId = agent.sessionManager.activeProjectId;
  const firstSessionId = agent.sessionManager.activeSessionId;
  const second = await agent.sessionManager.createSession('Second');
  agent._running = true;

  await assert.rejects(
    agent.useSession(projectId, firstSessionId),
    /请先取消后再切换会话/,
  );
});

test('deleting the active session rejects an active Agent task', async () => {
  const agent = await createAgent();
  const projectId = agent.sessionManager.activeProjectId;
  const firstSessionId = agent.sessionManager.activeSessionId;
  await agent.sessionManager.createSession('Second');
  await agent.useSession(projectId, firstSessionId);
  agent._running = true;

  await assert.rejects(
    agent.deleteSession(firstSessionId, projectId),
    /请先取消后再切换会话/,
  );
});
