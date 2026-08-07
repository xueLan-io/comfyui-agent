import { readFileSync, existsSync } from 'fs';
import { isAbsolute, relative, resolve } from 'path';
import { buildPromptProfile } from './prompt-profile.mjs';
import { MODEL_INPUTS } from './prompt-builder.mjs';
import { resolveSandboxPath } from '../../security/sandbox.mjs';

const ADAPTERS = new Map();

function activeNodes(workflow) {
  const nodes = workflow.nodes || [];
  const active = nodes.filter(node => node.mode === 0);
  return active.length > 0 ? active : nodes;
}

function widgetValues(node) {
  if (Array.isArray(node.widgets_values)) return node.widgets_values;
  if (node.widgets_values && typeof node.widgets_values === 'object') return Object.values(node.widgets_values);
  return [];
}

function workflowModelRequirements(workflow) {
  return activeNodes(workflow).flatMap(node => {
    const definition = MODEL_INPUTS.get(node.type);
    if (!definition) return [];

    const value = widgetValue(node, definition.input);
    if (typeof value !== 'string' || !value) return [];

    return [{ nodeId: String(node.id), nodeType: node.type, kind: definition.kind, input: definition.input, value }];
  });
}

function workflowCapabilities(workflow, family) {
  const types = activeNodes(workflow).map(node => node.type || '');
  const has = pattern => types.some(type => pattern.test(type));
  const h3 = activeNodes(workflow).find(node => /minimaxh3referencetovideo/i.test(node.type || ''));
  const h3Inputs = new Set((h3?.inputs || []).map(input => input.name));
  const modes = [];
  const inpaint = has(/loadimagemask/i) && has(/vaeencode(?:forinpaint)?/i);

  if (has(/ksampler/i) && has(/emptylatentimage/i) && !has(/^loadimage$/i)) modes.push('txt2img');
  if (has(/^loadimage$/i) && has(/vaeencode/i) && !inpaint) modes.push('img2img');
  if (inpaint) modes.push('inpaint');
  if (!has(/ksampler/i) && has(/upscale|imagescale|esrgan/i)) modes.push('upscale');
  if (has(/video|wan|animatediff|hunyuan|ltx|minimaxh3|referencetovideo/i) && has(/save|combine|output|vhs/i)) {
    modes.push(has(/^loadimage$/i) || has(/image.?to.?video/i) ? 'img2video' : 'txt2video');
  }
  if (h3Inputs.size > 0) {
    if (h3Inputs.has('prompt') && !modes.includes('txt2video')) modes.push('txt2video');
    if ([...h3Inputs].some(name => /^ref_images\./i.test(name)) && !modes.includes('img2video')) modes.push('img2video');
    if ([...h3Inputs].some(name => /^ref_videos\./i.test(name)) && !modes.includes('video2video')) modes.push('video2video');
  }

  const labelFamily = family === 'anima' ? 'anime' : family;
  return { family, modes, labels: modes.map(mode => `${labelFamily}_${mode}`) };
}

function widgetValue(node, inputName) {
  const widgetInputs = (node.inputs || []).filter(input => input.widget || input.name === inputName);
  const hasSeedControl = widgetInputs[0]?.name === 'seed'
    && node.widgets_values?.length === widgetInputs.length + 1;
  let index = 0;
  for (const input of node.inputs || []) {
    if (input.widget || input.name === inputName) {
      if (input.name === inputName) return node.widgets_values?.[index];
      index++;
      if (input.widget?.control_after_generate || (hasSeedControl && input.name === 'seed')) index++;
    }
  }
  return undefined;
}

function workflowResolution(workflow) {
  const latentNode = activeNodes(workflow).find(node =>
    /emptylatentimage|empty(?:sd3|flux|advanced)latentimage/i.test(node.type || ''),
  );
  if (latentNode) {
    const width = Number(widgetValue(latentNode, 'width'));
    const height = Number(widgetValue(latentNode, 'height'));
    if (Number.isFinite(width) && Number.isFinite(height)) return { width, height };
  }

  const scaleNode = activeNodes(workflow).find(node => /imagescaleby/i.test(node.type || ''));
  const scaleBy = scaleNode ? Number(widgetValue(scaleNode, 'scale_by')) : NaN;
  return Number.isFinite(scaleBy) ? { scaleBy } : null;
}

function workflowRecommendedParameters(workflow) {
  const sampler = activeNodes(workflow).find(node => /ksampler/i.test(node.type || ''));
  if (!sampler) return {};

  const parameters = {};
  for (const inputName of ['steps', 'cfg', 'sampler_name', 'scheduler', 'denoise']) {
    const value = widgetValue(sampler, inputName);
    if (value !== undefined) parameters[inputName] = value;
  }
  return parameters;
}

function workflowProfile(workflow, modelType, capabilities, requirements) {
  return {
    labels: capabilities.labels,
    modes: capabilities.modes,
    modelType,
    modelFiles: requirements.filter(item => !['loras', 'controlnet', 'upscale_models'].includes(item.kind)),
    loraFiles: requirements.filter(item => item.kind === 'loras'),
    controlnetFiles: requirements.filter(item => item.kind === 'controlnet'),
    upscaleModelFiles: requirements.filter(item => item.kind === 'upscale_models'),
    resolution: workflowResolution(workflow),
    recommendedParameters: workflowRecommendedParameters(workflow),
  };
}

export function resolveWorkflowPath(workflowDir, workflowName) {
  if (!workflowDir || !workflowName || typeof workflowName !== 'string') {
    throw new Error('Workflow directory and filename are required');
  }
  if (isAbsolute(workflowName) || !workflowName.toLowerCase().endsWith('.json')) {
    throw new Error(`Invalid workflow filename: ${workflowName}`);
  }
  if (!existsSync(workflowDir)) {
    const baseDir = resolve(workflowDir);
    const filePath = resolve(baseDir, workflowName);
    const relativePath = relative(baseDir, filePath);
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error(`Workflow path is outside the configured directory: ${workflowName}`);
    }
    return filePath;
  }
  try {
    return resolveSandboxPath({ workflowDir }, workflowName);
  } catch (error) {
    throw new Error(`Workflow path is outside the configured directory: ${workflowName}`, { cause: error });
  }
}

export class WorkflowAdapter {
  static register(name, adapter) {
    ADAPTERS.set(name, adapter);
  }

  static get(name) {
    return ADAPTERS.get(name);
  }

  static list() {
    return Array.from(ADAPTERS.keys());
  }

  static detect(workflowJson) {
    const nodes = workflowJson.nodes || [];
    const active = nodes.filter(node => node.mode === 0);
    const inspected = active.length > 0 ? active : nodes;
    const signature = inspected
      .flatMap(node => [node.type, node.title, ...widgetValues(node), ...(node.properties?.models || []).flatMap(model => [model.name, model.directory])])
      .filter(value => typeof value === 'string')
      .join(' ');
    const types = inspected.map(n => n.type);

    if (/minimaxh3|mini.?max.?h3|qwen3vl.*minimax_h3/i.test(signature)) return 'minimax_h3';
    if (/miaomiao|anima(?!tediff)/i.test(signature)) return 'anima';
    if (types.some(t => t.includes('Flux') || t.includes('flux'))) return 'flux';
    if (/\bwan(?:2|\s|_|-|\.)/i.test(signature) || types.some(type => /wanvideosampler/i.test(type || ''))) return 'wan';
    if (types.some(t => t.includes('SDXL') || t.includes('sdxl'))) return 'sdxl';
    if (types.some(t => t.includes('AnimateDiff') || t.includes('animatediff'))) return 'animatediff';
    if (types.some(t => t.includes('ControlNet') || t.includes('controlnet'))) return 'controlnet';
    if (types.some(t => t.includes('IPAdapter') || t.includes('ipadapter') || t.includes('IP-Adapter'))) return 'ipadapter';

    return 'generic';
  }

  static async resolve(workflowName, workflowDir) {
    const filePath = resolveWorkflowPath(workflowDir, workflowName);
    if (!existsSync(filePath)) return null;

    const wf = JSON.parse(readFileSync(filePath, 'utf-8'));
    const modelType = WorkflowAdapter.detect(wf);
    const promptProfile = buildPromptProfile(wf, modelType);
    const adapter = ADAPTERS.get(modelType);
    const capabilities = workflowCapabilities(wf, modelType);
    const modelRequirements = workflowModelRequirements(wf);

    return {
      workflow: wf,
      filename: workflowName,
      modelType,
      promptProfile,
      capabilities,
      modelRequirements,
      workflowProfile: workflowProfile(wf, modelType, capabilities, modelRequirements),
      adapter: adapter || null,
      info: adapter ? adapter.describe(wf) : { promptSlots: WorkflowAdapter._countPromptSlots(wf) },
    };
  }

  static _countPromptSlots(wf) {
    let count = 0;
    for (const node of wf.nodes || []) {
      if (node.type === 'easy promptList' && node.widgets_values) {
        count += node.widgets_values.length;
      }
    }
    return count;
  }

  static async prepareInput(workflowName, workflowDir, userInput) {
    const resolved = await WorkflowAdapter.resolve(workflowName, workflowDir);
    if (!resolved) throw new Error(`Workflow not found: ${workflowName}`);

    if (resolved.adapter) {
      return resolved.adapter.prepare(resolved.workflow, userInput);
    }

    return WorkflowAdapter._defaultPrepare(resolved.workflow, userInput);
  }

  static _defaultPrepare(wf, input) {
    return wf;
  }
}
