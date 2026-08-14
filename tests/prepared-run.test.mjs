import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/agent/runtime/agent.mjs';
import { AgentEventTypes, on } from '../src/agent/events/agent-events.mjs';
import { ComfyUITool } from '../src/agent/tools/comfyui/index.mjs';
import { ANIME_QUALITY_BASELINE } from '../src/agent/tools/prompt/anime-presets.mjs';

test('confirmed preview executes the frozen plan without another LLM call', async () => {
  let llmCalls = 0;
  const recorded = [];
  const profile = {
    family: 'anima',
    format: 'tag_narrative',
    supportsNegative: true,
    currentNegative: 'low quality',
    promptLists: [{ nodeId: '447', inputs: ['prompt_1', 'prompt_2'] }],
    positiveTargets: [{ nodeId: '261', input: 'text' }],
    negativeTargets: [{ nodeId: '240', input: 'text' }],
  };
  const agent = Object.create(Agent.prototype);
  Object.assign(agent, {
    _running: false,
    _lastManifest: null,
    _artifacts: [],
    _preparedRuns: new Map(),
    workflowDir: '',
    sessionManager: {
      project: {
        get(name) {
          return { workflow: 'anima.json', promptMode: 'anime' }[name];
        },
      },
      conversation: {
        getLLMMessages: () => [],
        add: (role, content) => recorded.push({ role, content }),
      },
    },
    planner: {
      async createPlan() {
        return {
          goal: 'portrait',
          steps: [
            { id: 'step1', tool: 'prompt_enhance', input: { mode: 'anime', constraints: { preserveCharacterCount: true } } },
            { id: 'step2', tool: 'comfyui', input: { workflowName: 'anima.json' } },
          ],
        };
      },
    },
    llm: {
      isConfigured: true,
      async chat() {
        llmCalls++;
        return { content: JSON.stringify({ tags: ['masterpiece', '1girl'], narrative: 'A girl stands in soft light.', positive: '', negative: 'bad hands', self_check: { preserved: true, issues: [] } }) };
      },
    },
  });

  const timingEvents = [];
  const unsubscribe = on(AgentEventTypes.PROGRESS, event => {
    if (event.scope === 'timing') timingEvents.push(event);
  });
  let preview;
  try {
    preview = await agent.prepareGeneration('one girl', {
      workflowManifest: { workflowName: 'anima.json', modelType: 'anima', promptProfile: profile },
    });
  } finally {
    unsubscribe();
  }
  const taskTiming = timingEvents.filter(event => event.taskId === agent._taskId);
  assert.deepEqual(taskTiming.map(event => event.stage), [
    'plan_start',
    'plan_end',
    'enhance_start',
    'enhance_llm_start',
    'enhance_llm_end',
    'enhance_end',
  ]);
  for (const event of taskTiming.filter(event => event.stage.endsWith('_end'))) {
    assert.equal(typeof event.duration_ms, 'number');
    assert.ok(event.duration_ms >= 0);
    assert.equal(event.outcome, 'completed');
  }
  assert.equal(llmCalls, 1);
  assert.equal(preview.positive, `${ANIME_QUALITY_BASELINE}, 1girl\n\nA girl stands in soft light.`);
  assert.equal(preview.targets.length, 3);
  assert.ok(recorded.some(entry => entry.role === 'user' && entry.content === 'one girl'));

  let executedOptions;
  agent.run = async (_message, options) => {
    executedOptions = options;
    return { images: [] };
  };
  await agent.runPrepared(preview.previewId);

  assert.equal(llmCalls, 1);
  assert.equal(executedOptions.preparedPlan.steps.some(step => step.tool === 'prompt_enhance'), false);
  assert.equal(executedOptions.compiledPrompt.positive, preview.positive);
});

test('refinement emits a compiler status before the single compiler call and preview', async () => {
  const events = [];
  let compilerCalls = 0;
  const profile = {
    family: 'anima',
    format: 'tag_narrative',
    supportsNegative: true,
    positiveTargets: [{ nodeId: '261', input: 'text' }],
    negativeTargets: [{ nodeId: '240', input: 'text' }],
  };
  const agent = new Agent({ llmConfig: { providers: [] } });
  Object.assign(agent, {
    workflowDir: '',
    _artifacts: [],
    _lastManifest: { workflowName: 'anima.json' },
    planner: {
      async createPlan() {
        events.push('plan-complete');
        return {
          goal: 'refine portrait',
          steps: [
            { id: 'enhance', tool: 'prompt_enhance', input: { mode: 'anime' } },
            { id: 'generate', tool: 'comfyui', input: { workflowName: 'anima.json' } },
          ],
        };
      },
    },
    llm: {
      isConfigured: true,
      async chat(input) {
        compilerCalls++;
        const compilerInput = JSON.parse(input.messages[1].content);
        assert.equal(compilerInput.latestRequest, '优化光线 构图');
        assert.match(compilerInput.interpretedPrompt, /1person/);
        events.push('compiler-call');
        return {
          content: JSON.stringify({
            tags: ['best quality', 'masterpiece', '1person'],
            narrative: 'A single person stands in a softly lit, balanced composition.',
            positive: '',
            negative: 'extra fingers',
            self_check: { preserved: true, issues: [] },
          }),
        };
      },
    },
  });
  agent.project.set('workflow', 'anima.json');
  agent.project.set('lastPrompt', 'best quality, masterpiece, 1person, solo, standing');

  const unsubscribe = on(AgentEventTypes.STATUS, event => {
    if (event.taskId !== agent.taskId) return;
    if (event.status === 'planning' && event.message === '正在根据修改要求编译提示词...') events.push('compiler-status');
    if (event.status === 'awaiting_confirmation') events.push('awaiting-confirmation');
  });
  try {
    const preview = await agent.prepareGeneration('优化光线 构图', {
      intent: 'refine',
      workflowManifest: { workflowName: 'anima.json', modelType: 'anima', promptProfile: profile },
    });
    assert.equal(preview.status, 'prepared');
  } finally {
    unsubscribe();
  }

  assert.equal(compilerCalls, 1);
  assert.deepEqual(events, [
    'plan-complete',
    'compiler-status',
    'compiler-call',
    'awaiting-confirmation',
  ]);
});

test('cancelling prompt compilation does not create a preview or failure state', async () => {
  const profile = {
    family: 'anima',
    format: 'tag_narrative',
    supportsNegative: true,
    positiveTargets: [{ nodeId: '261', input: 'text' }],
    negativeTargets: [{ nodeId: '240', input: 'text' }],
  };
  const agent = new Agent({ llmConfig: { providers: [] } });
  let compilerStarted;
  const started = new Promise(resolve => { compilerStarted = resolve; });
  Object.assign(agent, {
    workflowDir: '',
    _artifacts: [],
    _lastManifest: { workflowName: 'anima.json' },
    planner: {
      async createPlan() {
        return {
          goal: 'portrait',
          steps: [
            { id: 'enhance', tool: 'prompt_enhance', input: { mode: 'anime' } },
            { id: 'generate', tool: 'comfyui', input: { workflowName: 'anima.json' } },
          ],
        };
      },
    },
    llm: {
      isConfigured: true,
      cancel() {},
      async chat(input) {
        compilerStarted();
        await new Promise((_, reject) => {
          if (input.signal.aborted) {
            const error = new Error('模型请求已取消');
            error.code = 'LLM_CANCELLED';
            reject(error);
            return;
          }
          input.signal.addEventListener('abort', () => {
            const error = new Error('模型请求已取消');
            error.code = 'LLM_CANCELLED';
            reject(error);
          }, { once: true });
        });
      },
    },
  });
  agent.project.set('workflow', 'anima.json');
  const originalCancel = ComfyUITool.cancel;
  ComfyUITool.cancel = async () => ({ status: 'cancelled' });
  const statuses = [];
  const unsubscribe = on(AgentEventTypes.STATUS, event => {
    if (event.taskId === agent.taskId) statuses.push(event.status);
  });
  try {
    const preparation = agent.prepareGeneration('one girl', {
      workflowManifest: { workflowName: 'anima.json', modelType: 'anima', promptProfile: profile },
    });
    await started;
    const cancellation = await agent.cancel();
    const result = await preparation;

    assert.equal(cancellation.cancelled, true);
    assert.deepEqual(result, { cancelled: true, taskId: cancellation.taskId });
    assert.equal(agent._promptCompileController, null);
    assert.equal(agent._preparedRuns.size, 0);
    assert.equal(agent.state, 'cancelled');
    assert.equal(agent.taskManager.get(cancellation.taskId).state, 'cancelled');
    assert.ok(!statuses.includes('awaiting_confirmation'));
    assert.ok(!statuses.includes('failed'));
  } finally {
    unsubscribe();
    ComfyUITool.cancel = originalCancel;
  }
});

test('confirmed preview executes user-edited positive and negative prompts', async () => {
  const agent = Object.create(Agent.prototype);
  const previewId = 'preview_edit';
  agent._preparedRuns = new Map([[previewId, {
    userMessage: 'original request',
    plan: { steps: [{ id: 'step1', tool: 'comfyui', input: {} }] },
    compiledPrompt: { positive: 'original positive', negative: 'original negative', tags: ['original'] },
    workflowManifest: { workflowName: 'test.json' },
    options: {},
  }]]);
  agent.sessionManager = {
    project: {
      get() {
        return undefined;
      },
    },
  };

  let executedOptions;
  agent.run = async (_message, options) => {
    executedOptions = options;
    return { images: [] };
  };

  await agent.runPrepared(previewId, { positive: ' edited positive ', negative: ' edited negative ' });

  assert.equal(executedOptions.compiledPrompt.positive, 'edited positive');
  assert.equal(executedOptions.compiledPrompt.enhanced, 'edited positive');
  assert.equal(executedOptions.compiledPrompt.negative, 'edited negative');
});

test('workflow change is flagged against the last used workflow', async () => {
  const profile = { family: 'anima', format: 'tag_narrative', supportsNegative: false, promptLists: [] };
  const agent = Object.create(Agent.prototype);
  Object.assign(agent, {
    _running: false,
    _lastManifest: { workflowName: 'anima_old.json' },
    _artifacts: [],
    _preparedRuns: new Map(),
    workflowDir: '',
    sessionManager: {
      project: {
        get(name) {
          return { workflow: 'anima_old.json', promptMode: 'anime' }[name];
        },
      },
      conversation: { getLLMMessages: () => [], add: () => {} },
    },
    planner: {
      async createPlan() {
        return {
          goal: 'portrait',
          steps: [{ id: 'step1', tool: 'comfyui', input: { workflowName: 'anima_new.json' } }],
        };
      },
    },
    llm: {
      isConfigured: true,
      async chat() {
        return { content: JSON.stringify({ tags: [], narrative: '', positive: '', negative: '', self_check: { preserved: true, issues: [] } }) };
      },
    },
  });

  const preview = await agent.prepareGeneration('one girl', {
    workflowName: 'anima_new.json',
    workflowManifest: { workflowName: 'anima_new.json', modelType: 'anima', promptProfile: profile },
  });
  const actions = (preview.confirmation?.actions || []).map(action => action.type);
  assert.ok(actions.includes('change_workflow'));

  agent._state = 'idle';
  agent._preparedRuns.clear();
  const same = await agent.prepareGeneration('one girl', {
    workflowName: 'anima_new.json',
    workflowManifest: { workflowName: 'anima_new.json', modelType: 'anima', promptProfile: profile },
  });
  assert.ok(!(same.confirmation?.actions || []).some(action => action.type === 'change_workflow'));
});

test('removing a research fact recompiles the prepared prompt', async () => {
  let llmCalls = 0;
  const agent = Object.create(Agent.prototype);
  const profile = { family: 'generic', supportsNegative: true };
  Object.assign(agent, {
    _preparedRuns: new Map([['preview_facts', {
      userMessage: 'Hero',
      plan: { steps: [{ id: 'step1', tool: 'comfyui', input: {} }] },
      compiledPrompt: { positive: 'long blue hair, blue eyes', negative: '', tags: [] },
      workflowManifest: { workflowName: 'test.json' },
      options: {},
      compileInput: {
        prompt: 'Hero',
        mode: 'anime-character',
        promptProfile: profile,
        constraints: {},
        referenceContext: {
          hair: 'long blue hair',
          eyes: 'blue eyes',
          evidence: [
            { field: 'hair', quote: 'long blue hair', url: 'https://example.com/hero' },
            { field: 'eyes', quote: 'blue eyes', url: 'https://example.com/hero' },
          ],
          sources: [{ title: 'Hero', url: 'https://example.com/hero', trustLevel: 'official' }],
        },
        llmProvider: {
          async chat(input) {
            llmCalls++;
            const request = JSON.parse(input.messages[1].content);
            const hair = request.referenceContext.hair;
            return { content: JSON.stringify({ tags: [], narrative: hair || 'A hero portrait.', positive: hair || 'A hero portrait.', negative: '', self_check: { preserved: true, issues: [] } }) };
          },
        },
      },
    }]]),
    _thinkingStream: () => () => {},
    sessionManager: { project: { get: () => undefined } },
  });
  let executed;
  agent.run = async (_message, options) => { executed = options; return { images: [] }; };

  await agent.runPrepared('preview_facts', {
    appearanceFacts: {
      hair: '',
      eyes: 'blue eyes',
      evidence: [{ field: 'eyes', quote: 'blue eyes', url: 'https://example.com/hero' }],
    },
  });

  assert.equal(llmCalls, 1);
  assert.doesNotMatch(executed.compiledPrompt.positive, /long blue hair/);
  assert.match(executed.compiledPrompt.positive, /hero portrait/);
});

function digestBindingAgent({ llmCalls = { count: 0 } } = {}) {
  const profile = {
    family: 'anima',
    format: 'tag_narrative',
    supportsNegative: true,
    currentNegative: 'low quality',
    promptLists: [{ nodeId: '447', inputs: ['prompt_1', 'prompt_2'] }],
    positiveTargets: [{ nodeId: '261', input: 'text' }],
    negativeTargets: [{ nodeId: '240', input: 'text' }],
  };
  const agent = Object.create(Agent.prototype);
  Object.assign(agent, {
    _running: false,
    _lastManifest: null,
    _artifacts: [],
    _preparedRuns: new Map(),
    workflowDir: '',
    sessionManager: {
      project: { get: name => ({ workflow: 'anima.json', promptMode: 'anime' }[name]) },
      conversation: { getLLMMessages: () => [], add: () => {} },
    },
    planner: {
      async createPlan() {
        return {
          goal: 'portrait',
          steps: [
            { id: 'step1', tool: 'prompt_enhance', input: { mode: 'anime', constraints: { preserveCharacterCount: true } } },
            { id: 'step2', tool: 'comfyui', input: { workflowName: 'anima.json' } },
          ],
        };
      },
    },
    llm: {
      isConfigured: true,
      async chat() {
        llmCalls.count++;
        return { content: JSON.stringify({ tags: ['masterpiece'], narrative: 'A girl.', positive: '', negative: 'bad hands', self_check: { preserved: true, issues: [] } }) };
      },
    },
  });
  return agent;
}

test('prepared generation preview carries a confirmation digest', async () => {
  const agent = digestBindingAgent();
  const preview = await agent.prepareGeneration('one girl', {
    workflowManifest: { workflowName: 'anima.json', modelType: 'anima', promptProfile: { family: 'anima', format: 'tag_narrative', supportsNegative: true, currentNegative: 'low quality', promptLists: [{ nodeId: '447', inputs: ['prompt_1', 'prompt_2'] }] } },
  });
  assert.match(preview.requestDigest, /^sha256:[0-9a-f]{64}$/);
});

test('runPrepared rejects a confirmation whose digest does not bind to the preview', async () => {
  const agent = digestBindingAgent();
  const preview = await agent.prepareGeneration('one girl', {
    workflowManifest: { workflowName: 'anima.json', modelType: 'anima', promptProfile: { family: 'anima', format: 'tag_narrative', supportsNegative: true, currentNegative: 'low quality', promptLists: [{ nodeId: '447', inputs: ['prompt_1', 'prompt_2'] }] } },
  });
  agent.run = async () => { throw new Error('should not execute'); };
  await assert.rejects(
    () => agent.runPrepared(preview.previewId, {
      confirmation: { accepted: true, digest: 'sha256:deadbeef', requestId: preview.requestId, previewId: preview.previewId },
    }),
    error => error.code === 'CONFIRMATION_INVALID',
  );
  // rejected preview stays prepared and usable
  assert.equal(agent._preparedRuns.get(preview.previewId).status, 'prepared');
});

test('runPrepared rejects a confirmation that is not accepted', async () => {
  const agent = digestBindingAgent();
  const preview = await agent.prepareGeneration('one girl', {
    workflowManifest: { workflowName: 'anima.json', modelType: 'anima', promptProfile: { family: 'anima', format: 'tag_narrative', supportsNegative: true, currentNegative: 'low quality', promptLists: [{ nodeId: '447', inputs: ['prompt_1', 'prompt_2'] }] } },
  });
  agent.run = async () => { throw new Error('should not execute'); };
  await assert.rejects(
    () => agent.runPrepared(preview.previewId, {
      confirmation: { accepted: false, digest: preview.requestDigest, requestId: preview.requestId, previewId: preview.previewId },
    }),
    error => error.code === 'CONFIRMATION_INVALID',
  );
});

test('runPrepared executes with a matching confirmation digest', async () => {
  const agent = digestBindingAgent();
  const preview = await agent.prepareGeneration('one girl', {
    workflowManifest: { workflowName: 'anima.json', modelType: 'anima', promptProfile: { family: 'anima', format: 'tag_narrative', supportsNegative: true, currentNegative: 'low quality', promptLists: [{ nodeId: '447', inputs: ['prompt_1', 'prompt_2'] }] } },
  });
  let executed = false;
  agent.run = async () => { executed = true; return { images: [] }; };
  await agent.runPrepared(preview.previewId, {
    confirmation: { accepted: true, digest: preview.requestDigest, requestId: preview.requestId, previewId: preview.previewId },
  });
  assert.equal(executed, true);
});

test('runPrepared still works without a confirmation object (backward compatibility)', async () => {
  const agent = digestBindingAgent();
  const preview = await agent.prepareGeneration('one girl', {
    workflowManifest: { workflowName: 'anima.json', modelType: 'anima', promptProfile: { family: 'anima', format: 'tag_narrative', supportsNegative: true, currentNegative: 'low quality', promptLists: [{ nodeId: '447', inputs: ['prompt_1', 'prompt_2'] }] } },
  });
  let executed = false;
  agent.run = async () => { executed = true; return { images: [] }; };
  await agent.runPrepared(preview.previewId, { positive: ' edited ' });
  assert.equal(executed, true);
});
