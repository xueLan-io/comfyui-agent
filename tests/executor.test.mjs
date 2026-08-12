import assert from 'node:assert/strict';
import test from 'node:test';
import { Executor } from '../src/agent/runtime/executor.mjs';
import { emit, on, AgentEventTypes } from '../src/agent/events/agent-events.mjs';

const mockTool = {
  name: 'mock_tool',
  description: 'A mock tool for testing',
  input_schema: { type: 'object', properties: { prompt: { type: 'string' } } },
  async execute(input) {
    return { success: true, prompt: input.prompt };
  },
};

const mockComfyUITool = {
  name: 'comfyui',
  description: 'ComfyUI tool',
  input_schema: { type: 'object', properties: { workflowName: { type: 'string' } } },
  async execute(input) {
    return { images: [{ filename: 'test.png' }], promptId: 'p1' };
  },
};

const failingTool = {
  name: 'failing',
  description: 'Always fails',
  input_schema: { type: 'object', properties: {} },
  async execute() {
    throw new Error('tool failure');
  },
};

test('executeStep calls tool.execute', async () => {
  const executor = new Executor({ mock_tool: mockTool }, null);
  const step = { id: 's1', tool: 'mock_tool', input: { prompt: 'hello' }, description: 'test' };
  const result = await executor.executeStep(step);
  assert.equal(result.result.success, true);
  assert.equal(result.result.prompt, 'hello');
  assert.ok(result.duration_ms >= 0);
});

test('executeStep returns error on unknown tool', async () => {
  const executor = new Executor({}, null);
  const step = { id: 's2', tool: 'nonexistent', input: {}, description: 'test' };
  const result = await executor.executeStep(step);
  assert.ok(result.error);
  assert.ok(result.error.includes('Unknown tool'));
});

test('executeStep emits events', async () => {
  const events = [];
  const unsub = on(AgentEventTypes.STEP, (e) => events.push(e));

  const executor = new Executor({ mock_tool: mockTool }, null);
  const step = { id: 's3', tool: 'mock_tool', input: { prompt: 'x' }, description: 'test' };
  await executor.executeStep(step);

  assert.ok(events.length >= 2);
  assert.equal(events[0].status, 'running');
  assert.equal(events[events.length - 1].status, 'completed');
  unsub();
});

test('executeStep preserves task and trace ownership on every event', async () => {
  const events = [];
  const stop = [
    on(AgentEventTypes.STEP, event => events.push(event)),
    on(AgentEventTypes.TOOL_CALL, event => events.push(event)),
    on(AgentEventTypes.TOOL_RESULT, event => events.push(event)),
  ];
  try {
    const executor = new Executor({ mock_tool: mockTool }, null);
    await executor.executeStep(
      { id: 'owned-step', tool: 'mock_tool', input: { prompt: 'x' }, description: 'owned test' },
      {
        eventMeta: { taskId: 'task_owned', traceId: 'trace_owned', turnId: 'turn_owned' },
        attemptId: 'task_owned_attempt_2',
        currentAttempt: 2,
      },
    );
  } finally {
    stop.forEach(unsubscribe => unsubscribe());
  }

  assert.ok(events.length >= 4);
  assert.ok(events.every(event => (
    event.taskId === 'task_owned'
    && event.traceId === 'trace_owned'
    && event.turnId === 'turn_owned'
    && event.attemptId === 'task_owned_attempt_2'
    && event.attempt === 2
  )));
});

test('executeStep cancelled returns skipped', async () => {
  const executor = new Executor({ mock_tool: mockTool }, null);
  executor.cancel();
  const step = { id: 's4', tool: 'mock_tool', input: {}, description: 'test' };
  const result = await executor.executeStep(step);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'cancelled');
});

test('executeStep enriches comfyui input', async () => {
  const executor = new Executor({ comfyui: mockComfyUITool }, null);
  const step = {
    id: 's5',
    tool: 'comfyui',
    input: { workflowName: 'test.json', settings: {} },
    description: 'comfyui test',
  };
  const ctx = { workflowDir: '/test', enhancedPrompt: 'enhanced prompt' };
  const result = await executor.executeStep(step, ctx);
  assert.ok(result.result.images);
});

test('executeStep propagates video media through the Agent context', async () => {
  const tool = {
    ...mockComfyUITool,
    async execute() { return { videos: [{ filename: 'result.mp4' }], promptId: 'p-video' }; },
  };
  const executor = new Executor({ comfyui: tool }, null);
  const context = {};
  const result = await executor.executeStep({
    id: 's-video', tool: 'comfyui', input: { workflowName: 'video.json' },
    description: 'video test', expected_output: 'videos',
  }, context);

  assert.equal(result.result.media.length, 1);
  assert.equal(context.lastVideos[0].filename, 'result.mp4');
  assert.equal(context.lastMedia[0].filename, 'result.mp4');
});

test('executeStep prefers the plan workflow over the project workflow', async () => {
  let captured = null;
  const tool = {
    name: 'comfyui',
    input_schema: { type: 'object', properties: { workflowName: { type: 'string' } } },
    async execute(input) {
      captured = input;
      return { images: [], promptId: 'p1' };
    },
  };
  const executor = new Executor({ comfyui: tool }, null);
  const step = {
    id: 's7',
    tool: 'comfyui',
    input: { workflowName: 'img2img.json' },
    description: 'img2img test',
  };
  await executor.executeStep(step, {
    workflowDir: '/test',
    project: { currentWorkflow: 'txt2img.json' },
    compiledPrompt: { positive: 'redraw' },
  });
  assert.equal(captured.workflowName, 'img2img.json');
});

test('executeStep marks an output mismatch as replan', async () => {
  const tool = {
    name: 'filesystem',
    input_schema: { type: 'object', properties: {} },
    async execute() {
      return { ok: true };
    },
  };
  const executor = new Executor({ filesystem: tool }, null);
  const step = { id: 's8', tool: 'filesystem', input: {}, description: 'list', expected_output: 'files' };
  const result = await executor.executeStep(step);
  assert.equal(result.failure.type, 'output_mismatch');
  assert.equal(result.failure.replan, true);
});

test('executeStep returns error on tool failure', async () => {
  const executor = new Executor({ failing: failingTool }, null);
  const step = { id: 's6', tool: 'failing', input: {}, description: 'fail test' };
  const result = await executor.executeStep(step);
  assert.ok(result.error);
  assert.equal(result.error, 'tool failure');
});
