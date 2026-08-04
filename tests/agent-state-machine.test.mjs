import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../src/agent/runtime/agent.mjs';
import { TaskManager, canTransition } from '../src/agent/runtime/task-manager.mjs';
import { JSONFileStore } from '../src/agent/memory/store.mjs';

test('task state transitions reject invalid edges', () => {
  assert.equal(canTransition('executing', 'observing'), true);
  assert.equal(canTransition('executing', 'planning'), false);
  const manager = new TaskManager(null);
  manager.create({ id: 'state-task', kind: 'run' });
  manager.transition('state-task', 'classifying');
  assert.throws(() => manager.transition('state-task', 'completed'), /Invalid task state transition/);
});

test('replanning runs once with compact remaining-step context', async () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'gpt-4o' }, maxReplans: 1 });
  agent._taskId = 'replan-task';
  agent._traceId = 'trace-replan';
  agent.taskManager.create({ id: agent._taskId, kind: 'run', traceId: agent._traceId });
  agent.taskManager.transition(agent._taskId, 'classifying');
  agent.taskManager.transition(agent._taskId, 'planning');
  agent.taskManager.transition(agent._taskId, 'executing');
  agent.taskManager.transition(agent._taskId, 'observing');
  agent._state = 'observing';
  let calls = 0;
  let request;
  agent.planner.replan = async (input) => {
    calls++;
    request = input;
    return {
      goal: 'goal',
      steps: [{ id: 'step3', tool: 'comfyui', input: { workflowName: 'fixed.json' }, description: 'new output', expected_output: 'images' }],
    };
  };

  const result = await agent._replanPlan(
    { goal: 'goal', steps: [
      { id: 'step1', tool: 'prompt_enhance', input: {}, description: 'done', expected_output: 'prompt' },
      { id: 'step2', tool: 'comfyui', input: {}, description: 'broken', expected_output: 'images' },
    ] },
    1,
    { id: 'step2', tool: 'comfyui' },
    { error: 'Selected output node did not produce an image', failure: { replan: true, reason: 'bad output' } },
    { userRequest: 'goal', project: { currentWorkflow: 'fixed.json' }, workflowManifest: {}, attachedMedia: null },
    [{ id: 'step1', tool: 'prompt_enhance', output: { imageCount: 0 } }],
  );

  assert.equal(calls, 1);
  assert.equal(agent.state, 'executing');
  assert.equal(result.steps[0].id, 'step3');
  assert.equal(request.userGoal, 'goal');
  assert.deepEqual(Object.keys(request).sort(), ['completedSteps', 'currentError', 'failureType', 'remainingSteps', 'resultSummary', 'userGoal', 'workflow']);

  const second = await agent._replanPlan(
    { goal: 'goal', steps: [] },
    0,
    { id: 'step3' },
    { error: 'bad again', failure: { replan: true } },
    { userRequest: 'goal', workflowManifest: {} },
    [],
  );
  assert.equal(second, null);
  assert.equal(calls, 1);
});

test('replanning limit is configurable and passes the failure type', async () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'gpt-4o' }, maxReplans: 2 });
  agent._taskId = 'replan-2';
  agent._traceId = 'trace-replan-2';
  agent.taskManager.create({ id: agent._taskId, kind: 'run', traceId: agent._traceId });
  agent.taskManager.transition(agent._taskId, 'classifying');
  agent.taskManager.transition(agent._taskId, 'planning');
  agent.taskManager.transition(agent._taskId, 'executing');
  agent.taskManager.transition(agent._taskId, 'observing');
  agent._state = 'observing';
  let calls = 0;
  let request;
  agent.planner.replan = async (input) => {
    calls++;
    request = input;
    return { goal: 'g', steps: [{ id: 'new1', tool: 'comfyui', input: {}, description: 'd', expected_output: 'images' }] };
  };
  const ctx = { userRequest: 'goal', workflowManifest: {} };

  const first = await agent._replanPlan({ goal: 'g', steps: [] }, 0, { id: 's1' }, { error: 'e1', failure: { type: 'empty_output', replan: true } }, ctx, []);
  assert.ok(first);
  assert.equal(request.failureType, 'empty_output');

  agent.taskManager.transition(agent._taskId, 'observing');
  agent._state = 'observing';
  const second = await agent._replanPlan({ goal: 'g', steps: [] }, 0, { id: 's2' }, { error: 'e2', failure: { type: 'comfyui_transient', replan: true } }, ctx, []);
  assert.ok(second);
  assert.equal(request.failureType, 'comfyui_transient');
  assert.equal(calls, 2);

  agent.taskManager.transition(agent._taskId, 'observing');
  agent._state = 'observing';
  const third = await agent._replanPlan({ goal: 'g', steps: [] }, 0, { id: 's3' }, { error: 'e3', failure: { type: 'permanent', replan: true } }, ctx, []);
  assert.equal(third, null);
  assert.equal(calls, 2);
});

test('chat queues while the agent is already running', async () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'gpt-4o' } });
  agent._running = true;
  const result = await agent.chat('你好');
  assert.deepEqual(result.queued, true);
  assert.equal(result.position, 1);
  agent._running = false;
});

test('feedback is stored on the local task record', () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'gpt-4o' } });
  agent._taskId = 'feedback-task';
  agent.taskManager.create({ id: agent._taskId, kind: 'run' });
  const result = agent.recordFeedback('satisfied');
  assert.equal(result.recorded, true);
  assert.equal(agent.taskManager.get(agent._taskId).feedback[0].type, 'satisfied');
});

test('chat and prepareGeneration refuse to run while a preview awaits confirmation', async () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'gpt-4o' } });
  agent._state = 'awaiting_confirmation';
  agent._preparedRuns.set('preview_x', { userMessage: 'a cat' });
  await assert.rejects(() => agent.chat('你好'), /请先确认或取消/);
  await assert.rejects(() => agent.prepareGeneration('生成一只猫'), /请先确认或取消/);
  assert.equal(agent.state, 'awaiting_confirmation');
});

test('feedback attaches to the last generation task, not a later chat task', () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'gpt-4o' } });
  agent.taskManager.create({ id: 'run-1', kind: 'run' });
  agent.taskManager.create({ id: 'chat-1', kind: 'chat' });
  agent._taskId = 'chat-1';
  const result = agent.recordFeedback('satisfied');
  assert.equal(result.recorded, true);
  assert.equal(result.taskId, 'run-1');
  assert.equal(agent.taskManager.get('run-1').feedback[0].type, 'satisfied');
  assert.equal(agent.taskManager.get('chat-1').feedback.length, 0);
});

test('feedback without any generation task is not recorded', () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'gpt-4o' } });
  agent._taskId = 'chat-1';
  const result = agent.recordFeedback('satisfied');
  assert.equal(result.recorded, false);
});

test('cancel only interrupts the matching task', async () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'gpt-4o' } });
  agent._taskId = 'current-task';
  agent._state = 'executing';
  const stale = await agent.cancel('stale-task');
  assert.deepEqual(stale, { cancelled: false, reason: 'task_not_current' });
  assert.equal(agent._state, 'executing');

  const match = await agent.cancel('current-task');
  assert.deepEqual(match, { cancelled: true, taskId: 'current-task' });
  assert.equal(agent._state, 'cancelled');
});

test('cancel drops queued tasks so they do not execute afterwards', async () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'gpt-4o' } });
  agent._running = true;
  let ran = false;
  const queued = agent._enqueue(() => { ran = true; });
  assert.deepEqual(queued, { queued: true, position: 1 });
  agent._taskId = 'cancel-task';
  agent._state = 'executing';
  await agent.cancel('cancel-task');
  assert.equal(agent._pendingQueue.length, 0);
  agent._running = false;
  await agent._drainQueue();
  assert.equal(ran, false);
});

test('drainQueue skips queued tasks once a cancel was requested', async () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'gpt-4o' } });
  agent._running = true;
  let ran = false;
  agent._enqueue(() => { ran = true; });
  agent._cancelRequested = true;
  agent._running = false;
  await agent._drainQueue();
  assert.equal(ran, false);
});

test('run() does not re-record a request already added at prepare time', async () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'gpt-4o' } });
  agent._state = 'awaiting_confirmation';
  agent._taskId = 'task-x';
  agent._traceId = 'trace-x';
  agent.workflowDir = '';
  agent.taskManager.create({ id: 'task-x', kind: 'run', traceId: 'trace-x' });
  agent.taskManager.transition('task-x', 'classifying');
  agent.taskManager.transition('task-x', 'planning');
  agent.taskManager.transition('task-x', 'awaiting_confirmation');
  agent._executeWithRetry = async () => {
    agent._transitionState('observing', { currentStep: 'step1', currentAttempt: 1, promptId: '', lastError: '' });
    return { result: { images: [], enhanced: 'a cat' } };
  };

  await agent.run('a cat', {
    intent: 'generate',
    preparedPlan: {
      goal: 'g',
      steps: [{ id: 'step1', tool: 'comfyui', input: { workflowName: 'anima.json', workflowDir: '' }, description: 'generate', expected_output: 'images' }],
    },
    compiledPrompt: { positive: 'a cat' },
  });

  assert.equal(agent.state, 'completed');
  const roles = agent.conversation.getLLMMessages().map(message => message.role);
  assert.equal(roles.filter(role => role === 'user').length, 0);
  assert.ok(roles.some(role => role === 'assistant'));
});

test('markAbandoned converts non-terminal tasks to abandoned', () => {
  const manager = new TaskManager(null);
  manager.create({ id: 'running', kind: 'run' });
  manager.create({ id: 'queued', kind: 'run' });
  manager.transition('running', 'classifying');
  manager.create({ id: 'done', kind: 'run' });
  manager.transition('done', 'classifying');
  manager.transition('done', 'planning');
  manager.transition('done', 'completed');
  manager.markAbandoned();
  assert.equal(manager.get('running').state, 'abandoned');
  assert.equal(manager.get('queued').state, 'abandoned');
  assert.equal(manager.get('done').state, 'completed');
});

test('abandon resets runtime state and session state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comfy-abandon-'));
  try {
    const agent = new Agent({
      llmConfig: { provider: 'openai-compatible', model: 'gpt-4o' },
      userDataPath: dir,
    });
    await agent.init();
    agent._taskId = 'abandoned-task';
    agent._running = true;
    agent._state = 'executing';
    agent.taskManager.create({ id: 'abandoned-task', kind: 'run' });
    agent.taskManager.transition('abandoned-task', 'classifying');
    await agent.abandon();
    assert.equal(agent.taskManager.get('abandoned-task').state, 'abandoned');
    assert.equal(agent._running, false);
    assert.equal(agent.sessionManager.getSessionState().state, 'idle');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init recovers abandoned tasks from disk and resets running session state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comfy-recover-'));
  try {
    const first = new Agent({
      llmConfig: { provider: 'openai-compatible', model: 'gpt-4o' },
      userDataPath: dir,
    });
    await first.init();
    first._taskId = 'stuck';
    first.taskManager.create({ id: 'stuck', kind: 'run' });
    first.taskManager.transition('stuck', 'classifying');
    await first.taskManager.persist();

    const second = new Agent({
      llmConfig: { provider: 'openai-compatible', model: 'gpt-4o' },
      userDataPath: dir,
    });
    await second.init();
    assert.equal(second.taskManager.get('stuck').state, 'abandoned');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconfigureLLM rejects while the agent is busy and works when idle', () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'gpt-4o' } });
  agent._running = true;
  assert.throws(() => agent.reconfigureLLM({ model: 'gpt-5' }), /Agent is busy/);
  agent._running = false;
  agent.reconfigureLLM({ model: 'gpt-5' });
  assert.equal(agent.llmConfig.model, 'gpt-5');
});
