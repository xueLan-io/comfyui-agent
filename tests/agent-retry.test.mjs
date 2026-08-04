import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/agent/runtime/agent.mjs';
import { AgentEventTypes, on } from '../src/agent/events/agent-events.mjs';

function makeAgent() {
  return new Agent({ llmConfig: { provider: 'openai-compatible', model: 'gpt-4o' } });
}

test('transient ComfyUI failure retries and succeeds', async () => {
  const agent = makeAgent();
  let calls = 0;
  agent.executor.executeStep = async () => {
    calls++;
    if (calls === 1) {
      return {
        error: 'ECONNREFUSED',
        failure: { type: 'comfyui_transient', retryable: true, reason: 'ComfyUI connection refused' },
      };
    }
    return { result: { images: [{}], compiledPrompt: { mode: 'raw', positive: 'p', issues: [] } } };
  };

  const output = await agent._executeWithRetry(
    { id: 'step1', tool: 'comfyui', input: {}, description: 'gen' },
    { userRequest: 'x' },
  );

  assert.equal(calls, 2);
  assert.ok(output.result.images.length > 0);
});

test('workflow-not-found failure does not retry', async () => {
  const agent = makeAgent();
  let calls = 0;
  agent.executor.executeStep = async () => {
    calls++;
    return { error: 'Workflow not found: missing.json' };
  };

  const output = await agent._executeWithRetry(
    { id: 'step1', tool: 'comfyui', input: {}, description: 'gen' },
    { userRequest: 'x' },
  );

  assert.equal(calls, 1);
  assert.match(output.error, /Workflow not found/);
});

test('empty image output retries with a new seed and reports the change', async () => {
  const agent = makeAgent();
  let calls = 0;
  const seeds = [];
  const events = [];
  const unsubscribe = on(AgentEventTypes.STATUS, event => events.push(event));
  agent.executor.executeStep = async (step, ctx) => {
    calls++;
    seeds.push(ctx.executionSettings?.seed);
    if (calls === 1) return { result: { images: [], compiledPrompt: { mode: 'raw', positive: 'p', issues: [] } } };
    return { result: { images: [{}], compiledPrompt: { mode: 'raw', positive: 'p', issues: [] } } };
  };

  const output = await agent._executeWithRetry(
    { id: 'step1', tool: 'comfyui', input: {}, description: 'gen' },
    { userRequest: 'x' },
  );
  unsubscribe();

  assert.equal(calls, 2);
  assert.notEqual(seeds[1], seeds[0]);
  const retry = events.find(event => event.retry);
  assert.equal(retry.retry.failureType, 'empty_output');
  assert.ok(retry.retry.parameterChanges.some(change => change.parameter === 'settings'));
  assert.ok(output.result.images.length > 0);
});

test('cancelled retry does not submit another step', async () => {
  const agent = makeAgent();
  let calls = 0;
  agent.executor.executeStep = async () => {
    calls++;
    agent.executor.cancel();
    return { error: 'ECONNREFUSED', failure: { type: 'comfyui_transient', retryable: true } };
  };

  const output = await agent._executeWithRetry(
    { id: 'step1', tool: 'comfyui', input: {}, description: 'gen' },
    { userRequest: 'x' },
  );

  assert.equal(calls, 1);
  assert.equal(output.skipped, true);
  assert.equal(output.reason, 'cancelled');
});

test('retry counts are limited per step and across the task', async () => {
  const agent = new Agent({
    llmConfig: { provider: 'openai-compatible', model: 'gpt-4o' },
    retryPolicyOptions: { maxRetriesPerStep: 2, maxRetriesPerTask: 2 },
  });
  let calls = 0;
  agent.executor.executeStep = async () => {
    calls++;
    return { error: 'queue temporarily unavailable', failure: { type: 'comfyui_transient', retryable: true } };
  };

  await agent._executeWithRetry(
    { id: 'step1', tool: 'comfyui', input: {}, description: 'gen 1' },
    { userRequest: 'x' },
  );
  await agent._executeWithRetry(
    { id: 'step2', tool: 'comfyui', input: {}, description: 'gen 2' },
    { userRequest: 'x' },
  );

  assert.equal(calls, 4);
});

test('rewrite_prompt recompiles the prompt and re-executes', async () => {
  const agent = makeAgent();
  let calls = 0;
  let recompiles = 0;
  agent.executor.executeStep = async (step, ctx) => {
    calls++;
    if (calls === 1) {
      return { result: { images: [{}], compiledPrompt: { mode: 'cinematic', positive: 'bad prompt', issues: [{ type: 'constraint', severity: 'high', detail: '用户指定的颜色未保留：红色' }] } } };
    }
    return { result: { images: [{}], compiledPrompt: { mode: 'cinematic', positive: 'rewritten prompt', issues: [] } } };
  };
  agent._recompilePrompt = async (ctx, decision) => {
    recompiles++;
    assert.ok(decision.modification.includes('颜色未保留'));
    return { positive: 'rewritten prompt', mode: 'cinematic', negative: '', issues: [] };
  };

  const output = await agent._executeWithRetry(
    { id: 'step1', tool: 'comfyui', input: {}, description: 'gen' },
    { userRequest: '戴红色帽子的女孩' },
  );

  assert.equal(calls, 2);
  assert.equal(recompiles, 1);
  assert.equal(output.result.compiledPrompt.positive, 'rewritten prompt');
});

test('rewrite in raw mode recompiles the prompt when the fix changes it', async () => {
  const agent = makeAgent();
  let calls = 0;
  let recompiles = 0;
  agent.executor.executeStep = async (step, ctx) => {
    calls++;
    if (calls === 1) {
      return { result: { images: [{}], compiledPrompt: { mode: 'raw', positive: 'p', issues: [{ type: 'constraint', severity: 'high', detail: 'x' }] } } };
    }
    return { result: { images: [{}], compiledPrompt: { mode: 'raw', positive: 'p fixed', issues: [] } } };
  };
  agent._recompilePrompt = async () => {
    recompiles++;
    return { positive: 'p fixed', mode: 'raw', negative: '', issues: [] };
  };

  const output = await agent._executeWithRetry(
    { id: 'step1', tool: 'comfyui', input: {}, description: 'gen' },
    { userRequest: 'x' },
  );

  assert.equal(calls, 2);
  assert.equal(recompiles, 1);
  assert.equal(output.result.compiledPrompt.positive, 'p fixed');
});

test('rewrite in raw mode falls back to a new seed when the prompt is unchanged', async () => {
  const agent = makeAgent();
  let calls = 0;
  let recompiles = 0;
  const seeds = [];
  agent.executor.executeStep = async (step, ctx) => {
    calls++;
    seeds.push(ctx.executionSettings?.seed);
    if (calls === 1) {
      return { result: { images: [{}], compiledPrompt: { mode: 'raw', positive: 'p', issues: [{ type: 'constraint', severity: 'high', detail: 'x' }] } } };
    }
    return { result: { images: [{}], compiledPrompt: { mode: 'raw', positive: 'p', issues: [] } } };
  };
  agent._recompilePrompt = async () => {
    recompiles++;
    return { positive: 'p', mode: 'raw', negative: '', issues: [] };
  };

  const output = await agent._executeWithRetry(
    { id: 'step1', tool: 'comfyui', input: {}, description: 'gen' },
    { userRequest: 'x' },
  );

  assert.equal(calls, 2);
  assert.equal(recompiles, 1);
  assert.notEqual(seeds[1], seeds[0]);
  assert.ok(output.result.images.length > 0);
});

test('clean result accepts without retries', async () => {
  const agent = makeAgent();
  let calls = 0;
  const seeds = [];
  agent.executor.executeStep = async (step, ctx) => {
    calls++;
    seeds.push(ctx.executionSettings?.seed);
    return { result: { images: [{}], compiledPrompt: { mode: 'raw', positive: 'p', issues: [] } } };
  };

  const output = await agent._executeWithRetry(
    { id: 'step1', tool: 'comfyui', input: {}, description: 'gen' },
    { userRequest: 'x' },
  );

  assert.equal(calls, 1);
  assert.equal(seeds[1], undefined);
  assert.ok(output.result.images.length > 0);
});

test('runPrepared re-checks edited prompts for conflicts', async () => {
  const agent = makeAgent();
  agent.run = async (userMessage, options) => options;
  agent._preparedRuns.set('p1', {
    userMessage: '晴天野餐',
    compiledPrompt: { positive: '晴天野餐', negative: '', issues: [], mode: 'raw' },
    plan: { steps: [] },
    workflowManifest: null,
    options: {},
  });

  const options = await agent.runPrepared('p1', { positive: '晴天, 野外', negative: '雨天' });
  const issues = options.compiledPrompt.issues;
  assert.ok(issues.some(issue => issue.type === 'conflict' && issue.detail.includes('雨天')));
});

test('runPrepared clean edits produce no new issues', async () => {
  const agent = makeAgent();
  agent.run = async (userMessage, options) => options;
  agent._preparedRuns.set('p1', {
    userMessage: 'a cat',
    compiledPrompt: { positive: 'a cat', negative: '', issues: [], mode: 'cinematic' },
    plan: { steps: [] },
    workflowManifest: null,
    options: {},
  });

  const options = await agent.runPrepared('p1', { positive: 'a cat sitting', negative: '' });
  assert.deepEqual(options.compiledPrompt.issues, []);
});
