import assert from 'node:assert/strict';
import test from 'node:test';
import { ComfyUITool } from '../src/agent/tools/comfyui/index.mjs';
import { FilesystemTool } from '../src/agent/tools/filesystem/index.mjs';
import { FilesystemMutateTool } from '../src/agent/tools/filesystem/mutate.mjs';
import { PromptEnhanceTool } from '../src/agent/tools/prompt/enhance.mjs';
import { SystemTool } from '../src/agent/tools/system/index.mjs';
import { WorkflowInspectTool } from '../src/agent/tools/comfyui/workflow-inspect.mjs';
import { InspectImageTool } from '../src/agent/tools/comfyui/image-inspect.mjs';
import { WorkflowPatchTool } from '../src/agent/tools/comfyui/workflow-patch.mjs';
import { validatePlan } from '../src/agent/schemas/plan-schema.mjs';
import { confirmationForPlan } from '../src/agent/schemas/confirmation-schema.mjs';

const tools = {
  comfyui: ComfyUITool,
  prompt_enhance: PromptEnhanceTool,
  filesystem: FilesystemTool,
  filesystem_mutate: FilesystemMutateTool,
  system: SystemTool,
  workflow_inspect: WorkflowInspectTool,
  inspect_image: InspectImageTool,
  workflow_patch: WorkflowPatchTool,
};

function basePlan() {
  return {
    goal: 'generate an image',
    steps: [{
      id: 'step1',
      tool: 'comfyui',
      input: { workflowName: 'test.json', workflowDir: '' },
      description: 'Generate image',
      expected_output: 'images',
    }],
  };
}

function context() {
  return { workflowDir: 'C:/workflows', availableWorkflows: ['test.json'] };
}

test('plan requires registered tools and all required fields', () => {
  const validation = validatePlan({
    goal: 'test',
    steps: [{ id: 'step1', tool: 'missing', input: {}, description: 'bad' }],
  }, { tools, context: context() });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => error.includes('tool is not registered')));
  assert.ok(validation.errors.some(error => error.includes('missing "expected_output"')));
});

test('plan validates tool inputs and expected output types', () => {
  const plan = basePlan();
  plan.steps[0].input.workflowName = 42;
  plan.steps[0].expected_output = 'prompt';
  const validation = validatePlan(plan, { tools, context: context() });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => error.includes('Invalid type for "workflowName"')));
  assert.ok(validation.errors.some(error => error.includes('does not match comfyui output')));
});

test('plan rejects unknown, forward, and cyclic dependencies', () => {
  const plan = basePlan();
  plan.steps.push({
    id: 'step2',
    tool: 'comfyui',
    input: { workflowName: 'test.json', workflowDir: '' },
    description: 'Second generation',
    expected_output: 'images',
    depends_on: ['missing'],
  });
  plan.steps[0].depends_on = ['step2'];
  plan.steps[1].depends_on.push('step1');
  const validation = validatePlan(plan, { tools, context: context() });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => error.includes('unknown step')));
  assert.ok(validation.errors.some(error => error.includes('cycle')));
});

test('plan enforces step limit and a ComfyUI generation step', () => {
  const plan = {
    goal: 'metadata only',
    steps: Array.from({ length: 7 }, (_, index) => ({
      id: `step${index + 1}`,
      tool: 'system',
      input: { action: 'status' },
      description: `Check ${index + 1}`,
      expected_output: 'any',
    })),
  };
  const validation = validatePlan(plan, { tools, context: context() });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => error.includes('maximum of 6')));
  assert.ok(validation.errors.some(error => error.includes('ComfyUI generation step')));
});

test('filesystem mutation actions are unauthorized', () => {
  const plan = basePlan();
  plan.steps.unshift({
    id: 'step0',
    tool: 'filesystem',
    input: { action: 'write', workflowDir: '', path: 'x.txt', content: 'blocked' },
    description: 'Write file',
    expected_output: 'any',
  });
  const validation = validatePlan(plan, { tools, context: context() });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => error.includes('mutation actions are not authorized')));
  assert.ok(validation.errors.some(error => error.includes('Invalid value for "action"')));
});

test('filesystem_mutate plans are valid and require file confirmation', () => {
  const plan = {
    goal: 'update a project note',
    steps: [{
      id: 'step1',
      tool: 'filesystem_mutate',
      input: { action: 'edit', root: 'project', path: 'notes.txt', old: 'old', new: 'new' },
      description: 'Edit the project note',
      expected_output: 'files',
    }],
  };
  const validation = validatePlan(plan, { tools, context: { ...context(), workflowDir: 'C:/workflows' } });
  assert.equal(validation.valid, true);
  const confirmation = confirmationForPlan(plan, { tools });
  assert.equal(confirmation.required, true);
  assert.match(confirmation.actions[0].detail, /project\/notes\.txt/);
});

test('workflow node controls must match the manifest', () => {
  const plan = basePlan();
  plan.steps[0].input.nodeOverrides = { '9': { steps: 20 } };
  plan.steps[0].input.outputNodeIds = ['99'];
  const validation = validatePlan(plan, {
    tools,
    context: {
      ...context(),
      workflowManifest: {
        editableNodes: [{ id: '1', inputs: [{ name: 'steps' }] }],
        outputNodes: [{ id: '2' }],
      },
    },
  });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => error.includes('node is not editable')));
  assert.ok(validation.errors.some(error => error.includes('unknown output node')));
});

test('plans using the inspection and preview tools are valid', () => {
  const plan = {
    goal: 'check the workflow before generating',
    steps: [
      {
        id: 'step1',
        tool: 'workflow_inspect',
        input: { action: 'validate', workflowName: 'test.json' },
        description: 'Validate workflow structure and models',
        expected_output: 'workflow',
      },
      {
        id: 'step2',
        tool: 'workflow_patch',
        input: { action: 'preview', workflow: 'test.json', settings: { steps: 32 } },
        description: 'Preview sampling changes',
        expected_output: 'patch',
      },
      {
        id: 'step3',
        tool: 'inspect_image',
        input: { action: 'inspect', image: { path: 'output/result.png' } },
        description: 'Inspect the previous output',
        expected_output: 'image',
      },
      {
        id: 'step4',
        tool: 'comfyui',
        input: { workflowName: 'test.json' },
        description: 'Generate image',
        expected_output: 'images',
      },
    ],
  };
  const validation = validatePlan(plan, { tools, context: context() });
  assert.equal(validation.valid, true);
});

test('expected_output must match the inspection and patch tools', () => {
  const plan = basePlan();
  plan.steps.unshift({
    id: 'step0',
    tool: 'workflow_inspect',
    input: { action: 'validate', workflowName: 'test.json' },
    description: 'Validate workflow',
    expected_output: 'patch',
  });
  const validation = validatePlan(plan, { tools, context: context() });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => error.includes('does not match workflow_inspect output')));
});
