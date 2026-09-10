import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/agent/runtime/agent.mjs';
import { Executor } from '../src/agent/runtime/executor.ts';
import { backoffDelay } from '../src/agent/runtime/execution-ops.ts';

const comfyToolBase = {
  name: 'comfyui',
  description: 'ComfyUI tool',
  input_schema: { type: 'object', properties: { workflowName: { type: 'string' } } },
};

test('executeStep forwards the step controller signal to the comfyui tool', async () => {
  let seenSignal = null;
  const tool = {
    ...comfyToolBase,
    async execute(input) {
      seenSignal = input.signal;
      return { images: [{ filename: 'ok.png' }], promptId: 'p-sig' };
    },
  };
  const executor = new Executor({ comfyui: tool }, null);
  await executor.executeStep(
    { id: 's-sig', tool: 'comfyui', input: { workflowName: 'w.json' }, description: 'signal passthrough' },
    { workflowDir: '/test' },
  );
  // The comfy path must receive a real step signal even when context.signal
  // is undefined; ComfyExecutor options must not discard it.
  assert.ok(seenSignal instanceof AbortSignal, 'comfyui tool did not receive an AbortSignal');
});

test('cancelling the executor aborts an in-flight comfyui step signal', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let seenSignal = null;
  const tool = {
    ...comfyToolBase,
    async execute(input) {
      seenSignal = input.signal;
      await gate;
      return { images: [], promptId: 'p-cancel' };
    },
  };
  const executor = new Executor({ comfyui: tool }, null);
  const running = executor.executeStep(
    { id: 's-cancel', tool: 'comfyui', input: { workflowName: 'w.json' }, description: 'cancel passthrough' },
    { workflowDir: '/test' },
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(seenSignal instanceof AbortSignal);
  executor.cancel();
  assert.equal(seenSignal.aborted, true, 'executor.cancel() must abort the in-flight comfy signal');
  release();
  await running;
});

test('executor run signal aborts on cancel and re-arms on reset', () => {
  const executor = new Executor({ comfyui: comfyToolBase }, null);
  const signal = executor.runSignal;
  executor.cancel();
  assert.equal(signal.aborted, true);
  executor.reset();
  assert.equal(executor.runSignal.aborted, false);
  assert.notEqual(executor.runSignal, signal);
});

test('backoffDelay rejects promptly when the signal aborts mid-wait', async () => {
  const controller = new AbortController();
  const pending = assert.rejects(backoffDelay(1, controller.signal), { name: 'AbortError' });
  controller.abort('cancelled');
  await pending;
});

test('backoffDelay rejects immediately when the signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(backoffDelay(1, controller.signal), { name: 'AbortError' });
});

test('backoffDelay still resolves after the delay without a signal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = backoffDelay(1);
  t.mock.timers.tick(2500);
  await pending;
});

test('a superseded run returns cancelled with its own taskId and leaves the new task untouched', async () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'gpt-4o' } });
  agent.workflowDir = '';
  // 规划阶段模拟“新任务已取代本运行”后旧运行才醒来抛错：代际推进 +
  // _taskId 易主，再抛一个 cancel 形状的迟到错误（如 backoff 中止）。
  agent.planner.createPlan = async () => {
    agent.taskManager.create({ id: 'task-new', kind: 'run', traceId: 'trace-new' });
    agent._taskId = 'task-new';
    agent._runEpoch += 1;
    const error = new Error('cancelled');
    error.name = 'AbortError';
    throw error;
  };

  const result = await agent.run('a cat', { intent: 'generate' });

  assert.equal(result.superseded, true);
  assert.equal(result.cancelled, true);
  assert.ok(result.taskId && result.taskId !== 'task-new', 'superseded run must report its own task id');
  // 外层 catch 若缺代际检查，会穿过取消检查把新任务误标为 failed 并写坏会话状态。
  assert.equal(agent.state, 'planning');
  assert.notEqual(agent.taskManager.get('task-new')?.state, 'failed');
  assert.notEqual(agent.sessionManager.getSessionState?.()?.taskStatus, 'failed');
});
