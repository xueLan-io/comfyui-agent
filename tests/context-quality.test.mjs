import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeContextValue, sanitizeMessages, sanitizeText } from '../src/agent/schemas/context-sanitizer.mjs';
import { ConversationMemory } from '../src/agent/memory/conversation.mjs';
import { confirmationForPlan } from '../src/agent/schemas/confirmation-schema.mjs';
import { plannerToolContracts } from '../src/agent/schemas/tool-schema.mjs';
import { contextToPrompt } from '../src/agent/schemas/context-schema.mjs';

const generationTool = {
  name: 'comfyui',
  description: 'Queue generation. Cannot edit files.',
  input_schema: { type: 'object', properties: {} },
  output_schema: { type: 'object', properties: { images: { type: 'array' } } },
  side_effects: ['queue_generation', 'upload_reference_media', 'modify_runtime_node_parameters'],
  requires_confirmation: true,
  idempotent: false,
  retry: { mode: 'limited', max_attempts: 2 },
};

test('remote context removes secrets and keeps only local filenames', () => {
  const text = sanitizeText('apiKey="secret-value" path="D:\\Private Project\\reference.png" Authorization: Bearer token-value-123');
  assert.doesNotMatch(text, /secret-value|Private Project|token-value-123/);
  assert.match(text, /reference\.png/);
  assert.match(text, /REDACTED/);
});

test('context sanitizer omits raw workflows and secret fields', () => {
  const result = sanitizeContextValue({ apiKey: 'secret', workflow: { nodes: [1, 2] }, filename: 'safe.json' });
  assert.equal(result.apiKey, '[REDACTED]');
  assert.equal(result.workflow, '[OMITTED_WORKFLOW]');
  assert.equal(result.filename, 'safe.json');
});

test('remote messages truncate content and duplicate tool output', () => {
  const result = sanitizeMessages([
    { role: 'tool', content: 'same result' },
    { role: 'tool', content: 'same result' },
    { role: 'user', content: 'x'.repeat(50) },
  ], { maxContent: 10 });
  assert.equal(result.length, 2);
  assert.match(result[1].content, /TRUNCATED/);
});

test('conversation history keeps recent messages without a task summary', () => {
  const memory = new ConversationMemory();
  memory.add('user', 'draw a portrait seed 42');
  memory.add('agent', 'using the current anime style');
  memory.add('user', 'keep blue eyes');
  memory.add('agent', 'noted');
  memory.add('user', 'make it now');
  const messages = memory.getCompressedLLMMessages({ threshold: 4, recentCount: 2 });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].content, 'noted');
  assert.equal(messages[1].content, 'make it now');
  assert.equal(messages.some(message => message.role === 'system'), false);
});

test('planner contracts expose execution and confirmation semantics', () => {
  const [contract] = plannerToolContracts({ comfyui: generationTool });
  assert.deepEqual(Object.keys(contract), ['name', 'description', 'input_schema', 'output_schema', 'side_effects', 'requires_confirmation', 'idempotent', 'retry']);
  assert.equal(contract.requires_confirmation, true);
  assert.equal(contract.retry.mode, 'limited');
});

test('confirmation card includes media, parameters, batch, and limited retry', () => {
  const confirmation = confirmationForPlan({
    steps: [{
      id: 'step1',
      tool: 'comfyui',
      input: { workflowName: 'portrait.json', images: [{ path: 'D:\\private\\face.png' }], settings: { batch: 4 } },
    }],
  }, { tools: { comfyui: generationTool } });
  assert.equal(confirmation.required, true);
  assert.deepEqual(confirmation.actions.map(action => action.type), [
    'queue_generation',
    'upload_reference_media',
    'modify_node_parameters',
    'batch_generation',
    'limited_retry',
  ]);
  assert.match(confirmation.actions[1].detail, /face\.png/);
  assert.doesNotMatch(confirmation.actions[1].detail, /private/i);
});

test('manifest prompt profile is summarized instead of stringified', () => {
  const prompt = contextToPrompt({
    userRequest: '画一只猫',
    project: {},
    workflowManifest: {
      activeNodeCount: 1,
      editableNodeCount: 1,
      modelType: 'flux',
      commonSettings: { steps: 20, cfg: 3.5 },
      promptProfile: {
        family: 'flux',
        supportsNegative: false,
        currentPositive: 'a fluffy cat, detailed fur, cinematic lighting',
        currentNegative: '',
        positiveTargets: [{ nodeId: '12', input: 'text', type: 'CLIPTextEncode' }],
        negativeTargets: [],
        promptLists: [],
      },
      editableNodes: [{ id: '12', type: 'CLIPTextEncode', inputs: [{ name: 'clip' }, { name: 'text' }] }],
      outputNodes: [{ id: '9', type: 'VAEDecode' }],
    },
  });
  assert.match(prompt, /family="flux"/);
  assert.match(prompt, /supportsNegative=false/);
  assert.match(prompt, /currentPositive="a fluffy cat, detailed fur, cinematic lighting"/);
  assert.match(prompt, /targets: 12\(text\)/);
  assert.doesNotMatch(prompt, /\{"family"/);
});

test('node inputs are capped and node list lines are bounded', () => {
  const inputs = Array.from({ length: 20 }, (_, i) => ({ name: `input_${i}` }));
  const editableNodes = Array.from({ length: 40 }, (_, i) => ({ id: String(i + 1), type: 'TestNode', inputs }));
  const prompt = contextToPrompt({
    userRequest: '生成',
    project: {},
    workflowManifest: { editableNodeCount: 40, editableNodes },
  });
  const nodeLines = prompt.split('\n').filter(line => /^\s+- \d+ TestNode:/.test(line));
  assert.equal(nodeLines.length, 25);
  assert.match(prompt, /input_7, \.\.\./);
  assert.match(prompt, /\.\.\. and 15 more nodes/);
  assert.doesNotMatch(prompt, /input_19/);
});

test('huge manifest still bounds prompt size and omits raw profile JSON', () => {
  const editableNodes = Array.from({ length: 35 }, (_, i) => ({
    id: `n${i}`,
    type: 'KSampler',
    inputs: Array.from({ length: 12 }, (_, j) => ({ name: `in${j}` })),
  }));
  const prompt = contextToPrompt({
    userRequest: '生成',
    project: {},
    workflowManifest: {
      activeNodeCount: 35,
      editableNodeCount: 35,
      modelType: 'sdxl',
      commonSettings: { steps: 30 },
      promptProfile: {
        family: 'sdxl',
        supportsNegative: true,
        currentPositive: 'x'.repeat(300),
        currentNegative: 'y'.repeat(50),
        positiveTargets: [{ nodeId: 'n1', input: 'text', type: 'CLIPTextEncode' }],
        negativeTargets: [{ nodeId: 'n2', input: 'text', type: 'CLIPTextEncode' }],
        promptLists: [{ nodeId: 'n3', inputs: ['prompt_1', 'prompt_2'] }],
      },
      editableNodes,
      outputNodes: [{ id: 'n9', type: 'VAEDecode' }],
    },
  });
  assert.ok(prompt.split('\n').length <= 40);
  assert.match(prompt, /\.\.\. and 10 more nodes/);
  assert.match(prompt, /currentPositive="x{120}\.\.\."/);
  assert.match(prompt, /targets: n1\(text\), n2\(text\), n3\(prompt_1\), n3\(prompt_2\)/);
  assert.doesNotMatch(prompt, /\{"family"/);
});
