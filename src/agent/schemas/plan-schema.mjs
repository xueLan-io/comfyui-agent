import { validateToolInput } from './tool-schema.mjs';

const EXPECTED_OUTPUTS = ['prompt', 'images', 'videos', 'files', 'validation', 'web', 'workflow', 'models', 'image', 'logs', 'patch', 'queue', 'status', 'media', 'revision', 'service', 'artifact', 'results', 'any'];
export const MAX_PLAN_STEPS = 6;

const PlanStepSchema = {
  type: 'object',
  required: ['id', 'tool', 'input', 'description', 'expected_output'],
  properties: {
    id: { type: 'string', pattern: '^step\\d+$', description: 'Unique step identifier' },
    tool: {
      type: 'string',
      description: 'Tool name from the active tool registry',
    },
    skill: {
      type: 'string',
      pattern: '^[a-z][a-z0-9_-]*$',
      description: 'Optional skill context',
    },
    input: {
      type: 'object',
      description: 'Tool-specific input parameters',
    },
    description: { type: 'string', maxLength: 120, description: 'Human-readable step description' },
    expected_output: {
      type: 'string',
      enum: EXPECTED_OUTPUTS,
      description: 'What this step should produce',
    },
    depends_on: {
      type: 'array',
      items: { type: 'string', pattern: '^step\\d+$' },
      description: 'Steps that must complete first',
    },
    optional: { type: 'boolean', description: 'If true, failure does not abort the plan' },
  },
};

const AgentPlanSchema = {
  type: 'object',
  required: ['goal', 'steps'],
  properties: {
    goal: { type: 'string', maxLength: 500, description: 'The user\'s original goal' },
    steps: {
      type: 'array',
      items: PlanStepSchema,
      minItems: 1,
      maxItems: MAX_PLAN_STEPS,
    },
    metadata: {
      type: 'object',
      properties: {
        model_hint: { type: 'string', description: 'Suggested model family (sdxl, flux, sd15)' },
        style_hint: { type: 'string', description: 'Suggested style category' },
        complexity: { type: 'string', enum: ['simple', 'moderate', 'complex'] },
      },
    },
  },
};

function toolInputForValidation(step, context = {}) {
  const input = { ...(step.input || {}) };
  if ((input.workflowDir === undefined || input.workflowDir === '') && context.workflowDir) {
    input.workflowDir = context.workflowDir;
  }
  return input;
}

function supportsExpectedOutput(step, tool) {
  if (step.expected_output === 'any') return true;
  if (!tool) return false;

  if (Array.isArray(tool.output_types) && tool.output_types.length > 0) return tool.output_types.includes(step.expected_output);

  const properties = tool.output_schema?.properties || {};
  if (step.expected_output === 'prompt') return tool.name === 'prompt_enhance' || Boolean(properties.enhanced || properties.positive);
  if (step.expected_output === 'images') return tool.name === 'comfyui' || Boolean(properties.images);
  if (step.expected_output === 'videos') return tool.name === 'comfyui' || Boolean(properties.videos);
  if (step.expected_output === 'files') {
    return tool.name === 'filesystem' && ['list', 'list_images'].includes(step.input?.action)
      || Boolean(properties.files);
  }
  if (step.expected_output === 'validation') {
    return tool.name === 'filesystem' && step.input?.action === 'validate'
      || Boolean(properties.valid);
  }
  if (step.expected_output === 'web') {
    return tool.name === 'web' && ['search', 'open'].includes(step.input?.action)
      || Boolean(properties.results || properties.page);
  }
  if (step.expected_output === 'workflow') {
    return tool.name === 'workflow_inspect'
      || Boolean(properties.workflow || properties.nodes || properties.matches);
  }
  if (step.expected_output === 'image') {
    return tool.name === 'inspect_image' || Boolean(properties.image);
  }
  if (step.expected_output === 'models') {
    return tool.name === 'system' && ['models', 'search_models'].includes(step.input?.action)
      || Boolean(properties.models || properties.results);
  }
  if (step.expected_output === 'logs') {
    return tool.name === 'system' && step.input?.action === 'log'
      || Boolean(properties.entries || properties.queue);
  }
  if (step.expected_output === 'patch') {
    return tool.name === 'workflow_patch' || tool.name === 'workflow_mutation_preview' || Boolean(properties.diff);
  }
  if (step.expected_output === 'results') {
    return tool.name === 'prompt_library' || Boolean(properties.results);
  }
  return false;
}

export function matchesExpectedOutput(step, result, tool) {
  if (!step?.expected_output || step.expected_output === 'any') return true;
  if (!result || result.error) return false;
  if (step.expected_output === 'prompt') return typeof result.enhanced === 'string' || typeof result.positive === 'string';
  if (step.expected_output === 'images') return Array.isArray(result.images);
  if (step.expected_output === 'videos') return Array.isArray(result.videos);
  if (step.expected_output === 'files') return Array.isArray(result.files);
  if (step.expected_output === 'validation') return typeof result.valid === 'boolean';
  if (step.expected_output === 'web') return Array.isArray(result.results) || Boolean(result.page);
  if (step.expected_output === 'workflow') {
    return Boolean(result.workflow || result.workflowName || result.nodes || result.matches || result.valid !== undefined);
  }
  if (step.expected_output === 'image') return Boolean(result.image || result.images);
  if (step.expected_output === 'models') return Array.isArray(result.results) || Boolean(result.models);
  if (step.expected_output === 'logs') return Array.isArray(result.entries) || Boolean(result.queue);
  if (step.expected_output === 'patch') return Array.isArray(result.diff);
  if (step.expected_output === 'results') return Array.isArray(result.results);
  return Boolean(tool?.output_schema?.properties?.[step.expected_output] && result[step.expected_output] !== undefined);
}

function hasDependencyCycle(steps, ids) {
  const visiting = new Set();
  const visited = new Set();

  function visit(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const step = steps.find(item => item?.id === id);
    for (const dependency of step?.depends_on || []) {
      if (ids.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  return [...ids].some(visit);
}

function validateWorkflowControls(step, context, errors, prefix) {
  const manifest = context.workflowManifest;
  if (!manifest || step.tool !== 'comfyui') return;

  const editable = new Map((manifest.editableNodes || []).map(node => [String(node.id), new Set((node.inputs || []).map(input => input.name))]));
  for (const [nodeId, inputs] of Object.entries(step.input?.nodeOverrides || {})) {
    if (!editable.has(String(nodeId))) {
      errors.push(`${prefix}.input.nodeOverrides.${nodeId}: node is not editable or does not exist`);
      continue;
    }
    for (const inputName of Object.keys(inputs || {})) {
      if (!editable.get(String(nodeId)).has(inputName)) {
        errors.push(`${prefix}.input.nodeOverrides.${nodeId}.${inputName}: input is not editable or does not exist`);
      }
    }
  }

  const outputIds = new Set((manifest.outputNodes || []).map(node => String(node.id)));
  for (const nodeId of step.input?.outputNodeIds || []) {
    if (!outputIds.has(String(nodeId))) errors.push(`${prefix}.input.outputNodeIds: unknown output node "${nodeId}"`);
  }
}

function validateDependencies(steps, errors) {
  const ids = new Set(steps.map(step => step?.id).filter(Boolean));
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index] || {};
    for (const dependency of step.depends_on || []) {
      if (!ids.has(dependency)) {
        errors.push(`steps[${index}].depends_on: unknown step "${dependency}"`);
      } else {
        const dependencyIndex = steps.findIndex(item => item?.id === dependency);
        if (dependencyIndex >= index) {
          errors.push(`steps[${index}].depends_on: "${dependency}" must appear before this step`);
        }
      }
    }
  }
  if (hasDependencyCycle(steps, ids)) errors.push('Plan dependencies contain a cycle');
}

function validateFilesystemAuthorization(step, errors, prefix) {
  if (step.tool !== 'filesystem') return;
  if (['write', 'delete', 'remove', 'move', 'copy'].includes(step.input?.action)) {
    errors.push(`${prefix}.input.action: filesystem write and mutation actions are not authorized`);
  }
  for (const field of ['path', 'content']) {
    if (Object.prototype.hasOwnProperty.call(step.input || {}, field)) {
      errors.push(`${prefix}.input.${field}: file mutation inputs are not authorized`);
    }
  }
}

export function validatePlan(input, options = {}) {
  const errors = [];
  const context = options.context || {};
  const tools = options.tools || {};
  const registeredTools = Object.keys(tools).length > 0 ? new Set(Object.keys(tools)) : null;
  const maxSteps = Math.min(options.maxSteps || MAX_PLAN_STEPS, MAX_PLAN_STEPS);

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['Plan must be a non-null object'] };
  }
  if (typeof input.goal !== 'string' || !input.goal.trim()) errors.push('Plan must have a non-empty "goal" string');
  const isClarification = input.metadata?.status === 'clarify';
  if (!Array.isArray(input.steps) || (input.steps.length === 0 && !isClarification)) {
    errors.push('Plan must have at least one step');
    return { valid: false, errors };
  }
  if (isClarification) return { valid: errors.length === 0, errors };
  if (input.steps.length > maxSteps) errors.push(`Plan exceeds maximum of ${maxSteps} steps`);

  const seen = new Set();
  for (let index = 0; index < input.steps.length; index++) {
    const step = input.steps[index];
    const prefix = `steps[${index}]`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      errors.push(`${prefix}: step must be an object`);
      continue;
    }

    for (const field of ['id', 'tool', 'input', 'description', 'expected_output']) {
      if (!Object.prototype.hasOwnProperty.call(step, field)) errors.push(`${prefix}: missing "${field}"`);
    }
    if (typeof step.id !== 'string' || !/^step\d+$/.test(step.id || '')) errors.push(`${prefix}.id: must match stepN`);
    if (step.id && seen.has(step.id)) errors.push(`${prefix}: duplicate id "${step.id}"`);
    if (step.id) seen.add(step.id);
    if (typeof step.tool !== 'string' || (registeredTools && !registeredTools.has(step.tool))) errors.push(`${prefix}.tool: tool is not registered`);
    if (!step.input || typeof step.input !== 'object' || Array.isArray(step.input)) errors.push(`${prefix}.input: must be an object`);
    if (typeof step.description !== 'string' || !step.description.trim()) errors.push(`${prefix}.description: must be a non-empty string`);
    if (typeof step.description === 'string' && step.description.length > 120) errors.push(`${prefix}.description: exceeds maximum length`);
    if (typeof step.expected_output !== 'string' || !EXPECTED_OUTPUTS.includes(step.expected_output)) {
      errors.push(`${prefix}.expected_output: invalid or missing output type`);
    }
    if (step.depends_on !== undefined && (!Array.isArray(step.depends_on) || step.depends_on.some(id => typeof id !== 'string'))) {
      errors.push(`${prefix}.depends_on: must be an array of step ids`);
    }
    if (step.optional !== undefined && typeof step.optional !== 'boolean') errors.push(`${prefix}.optional: must be boolean`);

    const tool = tools[step.tool];
    if (tool && step.input && typeof step.input === 'object' && !Array.isArray(step.input)) {
      const validation = validateToolInput(tool, toolInputForValidation(step, context));
      for (const error of validation.errors) errors.push(`${prefix}.input: ${error}`);
      if (!supportsExpectedOutput(step, tool)) errors.push(`${prefix}.expected_output: does not match ${step.tool} output`);
    }
    validateWorkflowControls(step, context, errors, prefix);
    validateFilesystemAuthorization(step, errors, prefix);

    if (step.tool === 'comfyui' && context.availableWorkflows?.length > 0 && step.input?.workflowName) {
      if (!context.availableWorkflows.includes(step.input.workflowName)) {
        errors.push(`${prefix}.input.workflowName: workflow "${step.input.workflowName}" does not exist`);
      }
    }
  }

  validateDependencies(input.steps, errors);
  const hasGeneration = input.steps.some(step => step?.tool === 'comfyui' && (step.expected_output === 'images' || step.expected_output === 'videos'));
  const hasFilesystemMutation = input.steps.some(step => step?.tool === 'filesystem_mutate');
  if (!hasGeneration && !hasFilesystemMutation) {
    errors.push('Plan must contain a ComfyUI generation step with expected_output "images" or "videos"');
  }

  return { valid: errors.length === 0, errors };
}

function normalizePlan(plan) {
  if (!plan || !Array.isArray(plan.steps)) return null;

  return {
    goal: plan.goal || 'Image generation',
    steps: plan.steps.map((step, index) => ({
      id: step.id || `step${index + 1}`,
      tool: step.tool || 'comfyui',
      skill: step.skill || '',
      input: step.input || {},
      description: step.description || `Step ${index + 1}`,
      expected_output: step.expected_output || 'any',
      depends_on: Array.isArray(step.depends_on) ? [...step.depends_on] : [],
      optional: step.optional || false,
    })),
    metadata: plan.metadata || {},
  };
}

const PlanTemplates = {
  txt2img: (userPrompt, workflowName, promptMode = 'raw') => ({
    goal: userPrompt,
    steps: [
      ...(promptMode === 'raw' ? [] : [{
        id: 'step1',
        tool: 'prompt_enhance',
        input: { prompt: userPrompt, mode: promptMode },
        description: 'Enhance prompt for text-to-image',
        expected_output: 'prompt',
      }]),
      {
        id: promptMode === 'raw' ? 'step1' : 'step2',
        tool: 'comfyui',
        input: {
          workflowName: workflowName || '',
          prompt: userPrompt,
          workflowDir: '',
        },
        description: 'Execute text-to-image workflow',
        expected_output: 'images',
      },
    ],
  }),
  img2img: (userPrompt, workflowName = 'img2img.json', promptMode = 'raw') => ({
    goal: userPrompt,
    steps: [
      ...(promptMode === 'raw' ? [] : [{
        id: 'step1',
        tool: 'prompt_enhance',
        input: { prompt: userPrompt, mode: promptMode },
        description: 'Enhance prompt for image-to-image',
        expected_output: 'prompt',
      }]),
      {
        id: promptMode === 'raw' ? 'step1' : 'step2',
        tool: 'comfyui',
        skill: 'img2img',
        input: {
          workflowName,
          prompt: userPrompt,
          workflowDir: '',
        },
        description: 'Execute image-to-image workflow',
        expected_output: 'images',
      },
    ],
  }),
};

export { PlanStepSchema, AgentPlanSchema, normalizePlan, PlanTemplates };
