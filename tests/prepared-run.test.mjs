import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/agent/runtime/agent.mjs';

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

  const preview = await agent.prepareGeneration('one girl', {
    workflowManifest: { workflowName: 'anima.json', modelType: 'anima', promptProfile: profile },
  });
  assert.equal(llmCalls, 1);
  assert.equal(preview.positive, 'masterpiece, 1girl\n\nA girl stands in soft light.');
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
