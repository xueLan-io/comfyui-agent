import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolRegistry, validateToolDefinitions, validateUniqueNames } from '../src/agent/tools/registry.mjs';
import { Agent } from '../src/agent/runtime/agent.mjs';
import { buildAgentContext } from '../src/agent/schemas/context-schema.mjs';
import { validatePlan } from '../src/agent/schemas/plan-schema.mjs';

function tool(name, overrides = {}) {
  return {
    name,
    description: `${name} tool`,
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    output_schema: { type: 'object' },
    side_effects: [],
    requires_confirmation: false,
    idempotent: true,
    retry: { mode: 'never' },
    execute: async () => ({}),
    ...overrides,
  };
}

test('registry rejects duplicate names and invalid contracts', () => {
  assert.throws(() => validateUniqueNames([tool('same'), tool('same')]), /Duplicate tool name/);
  assert.throws(() => validateToolDefinitions([tool('bad', { execute: null })]), /bad/);
});

test('registry indexes tools and filters by category, permission, and surface', () => {
  const registry = createToolRegistry({ tools: [
    tool('read_workflow', { category: 'workflow', permission: 'read', surfaces: ['agent', 'mcp'], output_types: ['workflow'] }),
    tool('apply_workflow', { category: 'workflow', permission: 'mutate', surfaces: ['agent'], requires_confirmation: true }),
  ] });

  assert.equal(registry.get('read_workflow').name, 'read_workflow');
  assert.deepEqual(registry.list({ category: 'workflow', permission: 'read', surface: 'mcp' }).map(item => item.name), ['read_workflow']);
  assert.deepEqual(registry.list({ permission: 'mutate' }).map(item => item.name), ['apply_workflow']);
  assert.equal(registry.manifest({ category: 'workflow' })[0].output_types[0], 'workflow');
});

test('agent context can expose the active registry without a second tool list', () => {
  const agent = new Agent({ userDataPath: 'test-tool-registry' });
  const registered = Object.keys(agent.tools).sort();
  assert.deepEqual(buildAgentContext('test', { availableTools: registered }).availableTools, registered);
});

test('plan validation accepts tools added to the active registry without schema changes', () => {
  const agent = new Agent({ userDataPath: 'test-tool-registry' });
  const customTool = {
    name: 'custom_read',
    description: 'Custom read tool',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    output_schema: { type: 'object', properties: { status: { type: 'string' } } },
    side_effects: [],
    requires_confirmation: false,
    idempotent: true,
    retry: { mode: 'never' },
    execute: async () => ({ status: 'ok' }),
  };
  agent.toolRegistry.register(customTool);
  agent.tools = agent.toolRegistry.byName;
  const validation = validatePlan({
    goal: 'use a custom tool',
    steps: [
      { id: 'step1', tool: 'custom_read', input: {}, description: 'Read custom state', expected_output: 'any' },
      { id: 'step2', tool: 'comfyui', input: { workflowName: '', workflowDir: '' }, description: 'Generate image', expected_output: 'images' },
    ],
  }, { tools: agent.tools });
  assert.equal(validation.valid, true);
});
