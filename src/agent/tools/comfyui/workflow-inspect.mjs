import { WorkflowAdapter } from './workflow-adapter.mjs';
import { ComfyUITool } from './index.mjs';
import { workflowToPrompt, findNodeGroup, checkModelRequirements, describeInput, getInputDefinition } from './prompt-builder.mjs';
import { isEditableValue } from './node-overrides.mjs';
import { buildPreflightReport } from '../../../runtime/preflight-contract.mjs';
import { inspectRuntimeCapabilities } from '../../../runtime/runtime-capabilities.mjs';

function resolveMediaRef(value = '') {
  const parts = String(value).split('/');
  return parts.length > 1
    ? { filename: parts.slice(1).join('/'), subfolder: parts[0] }
    : { filename: parts[0], subfolder: '' };
}

function sourceLabel(prompt, nodeId) {
  const node = prompt[String(nodeId)];
  return node ? `${node.class_type} #${nodeId}` : `#${nodeId}`;
}

function buildSnapshot(workflowName, resolved, prompt, objectInfo) {
  const sourceNodes = new Map((resolved.workflow.nodes || []).map(node => [String(node.id), node]));
  const sourceLinks = new Map((resolved.workflow.links || []).map(link => [String(link[0]), link]));
  const typeDefinition = node => objectInfo[node.class_type] || {};

  const nodes = Object.entries(prompt).map(([nodeId, promptNode]) => {
    const sourceNode = sourceNodes.get(nodeId);
    const definition = typeDefinition(promptNode);
    const inputs = Object.entries(promptNode.inputs || {}).map(([inputName, value]) => ({
      name: inputName,
      value: Array.isArray(value) ? { linked: sourceLabel(prompt, value[0]), output: value[1] } : value,
      editable: isEditableValue(value),
      type: describeInput(inputName, value, getInputDefinition(definition, inputName)).type,
    }));
    return {
      id: nodeId,
      type: promptNode.class_type,
      title: sourceNode?.title || definition.display_name || promptNode.class_type,
      group: findNodeGroup(sourceNode || {}, resolved.workflow.groups),
      output: definition.output_node === true,
      inputs,
    };
  }).sort((a, b) => Number(a.id) - Number(b.id));

  const sampler = extractSampler(prompt);
  const links = [...sourceLinks.values()].map(([linkId, srcNode, srcOut, dstNode, dstIn]) => ({
    id: String(linkId),
    from: `${srcNode}.${srcOut}`,
    to: `${dstNode}.${dstIn}`,
  }));

  return {
    workflowName,
    modelType: resolved.modelType,
    promptProfile: resolved.promptProfile,
    capabilities: resolved.capabilities,
    nodeCount: nodes.length,
    links,
    sampler,
    resolution: resolved.workflowProfile?.resolution || null,
    modelFiles: resolved.modelRequirements || [],
    outputNodes: nodes.filter(node => node.output).map(({ id, type, title, group }) => ({ id, type, title, group })),
    nodes,
  };
}

function extractSampler(prompt) {
  for (const node of Object.values(prompt)) {
    if (!/ksampler/i.test(node.class_type || '')) continue;
    const result = {};
    for (const name of ['steps', 'cfg', 'denoise', 'sampler_name', 'scheduler']) {
      const value = node.inputs?.[name];
      if (value !== undefined && !Array.isArray(value)) result[name] = value;
    }
    if (Object.keys(result).length > 0) return result;
  }
  return null;
}

function findNodeInputValue(node, names) {
  for (const name of names) {
    const value = node.inputs?.[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

function linkTargetIsConditioning(prompt, value) {
  if (!Array.isArray(value)) return false;
  const source = prompt[String(value[0])];
  if (!source) return false;
  return /condition|encode|clip/i.test(source.class_type || '')
    || Array.isArray(source.inputs?.conditioning);
}

function validateLinks(workflow, issues) {
  const activeIds = new Set((workflow.nodes || [])
    .filter(node => node.mode !== 4)
    .map(node => String(node.id)));
  const outputsByNode = new Map();
  for (const node of workflow.nodes || []) {
    outputsByNode.set(String(node.id), (node.outputs || []).length);
  }
  const linkIds = new Set((workflow.links || []).map(link => String(link[0])));
  const usedLinks = new Set();

  for (const node of workflow.nodes || []) {
    if (node.mode === 4) continue;
    for (const input of node.inputs || []) {
      if (input.link == null || input.link < 0) continue;
      const linkId = String(input.link);
      usedLinks.add(linkId);
      if (!linkIds.has(linkId)) {
        issues.push({ severity: 'error', code: 'broken_link', nodeId: String(node.id), message: `节点 #${node.id}(${node.type}) 的输入 ${input.name} 引用了不存在的连线 ${linkId}` });
      }
    }
  }

  for (const link of workflow.links || []) {
    const [linkId, srcNode, srcOut] = link;
    const src = String(srcNode);
    if (!activeIds.has(src)) {
      issues.push({ severity: 'error', code: 'broken_link', message: `连线 ${linkId} 指向不存在的激活源节点 #${src}` });
      continue;
    }
    const outputs = outputsByNode.get(src) || 0;
    if (Number(srcOut) >= outputs) {
      issues.push({ severity: 'error', code: 'broken_link', message: `连线 ${linkId} 指向节点 #${src} 的越界输出 ${srcOut}（该节点只有 ${outputs} 个输出）` });
    }
  }

  for (const linkId of linkIds) {
    if (!usedLinks.has(linkId)) {
      issues.push({ severity: 'warning', code: 'dangling_link', message: `连线 ${linkId} 未被任何激活节点使用` });
    }
  }
}

function validatePromptStructure(prompt, issues) {
  const samplers = Object.entries(prompt).filter(([, node]) => /ksampler/i.test(node.class_type || ''));
  const hasVideoOutput = Object.values(prompt).some(node => /(?:save|combine|output).*(?:video|gif|webp)|(?:video|gif|webp).*(?:save|combine|output)/i.test(node.class_type || ''));
  if (samplers.length === 0 && !hasVideoOutput) {
    issues.push({ severity: 'error', code: 'sampler_missing', message: '工作流中没有任何 KSampler 采样节点' });
    return;
  }

  for (const [nodeId, node] of samplers) {
    for (const polarity of ['positive', 'negative']) {
      const value = node.inputs?.[polarity];
      if (value === undefined) {
        issues.push({ severity: 'warning', code: 'prompt_unconnected', nodeId, message: `采样节点 #${nodeId} 缺少 ${polarity} 提示词输入` });
        continue;
      }
      if (!linkTargetIsConditioning(prompt, value)) {
        issues.push({ severity: 'warning', code: 'prompt_unconnected', nodeId, message: `采样节点 #${nodeId} 的 ${polarity} 提示词未连接到文本编码节点` });
      }
    }
    const denoise = node.inputs?.denoise;
    if (denoise !== undefined && (denoise < 0 || denoise > 1)) {
      issues.push({ severity: 'warning', code: 'denoise_range', nodeId, message: `采样节点 #${nodeId} 的 denoise=${denoise} 超出 [0,1] 合理范围` });
    }
  }

  const hasVaeDecode = Object.values(prompt).some(node => /vaedecode/i.test(node.class_type || ''));
  const hasSaveImage = Object.values(prompt).some(node => /saveimage/i.test(node.class_type || ''));
  if (hasSaveImage && !hasVaeDecode) {
    issues.push({ severity: 'warning', code: 'vae_missing', message: '工作流有保存图片节点但缺少 VAEDecode，输出可能不完整' });
  }
  if (hasVideoOutput && !Object.values(prompt).some(node => /video|animatediff|wan|hunyuan|ltx/i.test(node.class_type || ''))) {
    issues.push({ severity: 'warning', code: 'video_node_missing', message: '工作流包含视频输出节点但没有识别到视频生成节点' });
  }
}

async function validateMedia(prompt, client, issues) {
  const entries = Object.entries(prompt)
    .filter(([, node]) => /loadimagemask/i.test(node.class_type || ''))
    .map(([nodeId, node]) => ({ nodeId, kind: 'mask', value: findNodeInputValue(node, ['image']) }))
    .concat(Object.entries(prompt)
      .filter(([, node]) => /^loadimage$/i.test(node.class_type || ''))
      .map(([nodeId, node]) => ({ nodeId, kind: 'image', value: findNodeInputValue(node, ['image']) })));

  for (const entry of entries) {
    if (typeof entry.value !== 'string' || !entry.value) {
      issues.push({ severity: 'error', code: 'input_media_empty', nodeId: entry.nodeId, message: `加载节点 #${entry.nodeId} 没有指定 ${entry.kind === 'mask' ? '蒙版' : '图片'} 文件` });
      continue;
    }
    if (typeof client.inspectImage !== 'function') continue;
    const ref = resolveMediaRef(entry.value);
    const result = await client.inspectImage({ ...ref, type: 'input' }).catch(() => null);
    if (result && result.exists === false) {
      issues.push({ severity: 'error', code: 'input_media_missing', nodeId: entry.nodeId, message: `加载节点 #${entry.nodeId} 引用的 ${entry.kind} 文件不存在：${entry.value}` });
    }
  }
}

export const WorkflowInspectTool = {
  name: 'workflow_inspect',
  description: 'Inspect a local ComfyUI workflow: full node inputs, links, sampler parameters, model files, and structural/model/media validation. Read-only.',
  category: 'management',
  tags: ['workflow', 'inspect', 'validate', 'comfyui'],
  timeout_ms: 20000,
  side_effects: [],
  requires_confirmation: false,
  idempotent: true,
  retry: { mode: 'limited', max_attempts: 1 },
  output_schema: {
    type: 'object',
    properties: {
      workflowName: { type: 'string' },
      nodes: { type: 'array', items: { type: 'object' } },
      matches: { type: 'array', items: { type: 'object' } },
      sampler: { type: 'object' },
      modelFiles: { type: 'array', items: { type: 'object' } },
      issues: { type: 'array', items: { type: 'object' } },
      valid: { type: 'boolean' },
      error: { type: 'string' },
    },
  },
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['snapshot', 'node', 'find', 'validate'], description: 'Action to perform' },
      workflowName: { type: 'string', description: 'Workflow filename (e.g. img2img.json)' },
      workflowDir: { type: 'string', description: 'Directory containing workflow files' },
      nodeId: { type: 'string', description: 'Node id for the node action' },
      type: { type: 'string', description: 'Node type or type fragment to match (find)' },
      input: { type: 'string', description: 'Input name that must exist on the node (find)' },
      value: { type: 'string', description: 'Value fragment to match on scalar inputs (find)' },
      limit: { type: 'number', description: 'Max matches for find' },
    },
    required: ['action', 'workflowName', 'workflowDir'],
  },

  async execute({ action, workflowName, workflowDir, nodeId, type, input, value, limit }) {
    const resolved = await WorkflowAdapter.resolve(workflowName, workflowDir);
    if (!resolved) return { workflowName, error: `Workflow not found: ${workflowName}` };
    const client = ComfyUITool.client;
    const objectInfo = await client.objectInfo().catch(() => ({}));

    if (action === 'snapshot') {
      const prompt = workflowToPrompt(resolved.workflow, objectInfo);
      return buildSnapshot(workflowName, resolved, prompt, objectInfo);
    }

    if (action === 'node') {
      if (!nodeId) return { workflowName, error: 'nodeId is required for the node action' };
      const prompt = workflowToPrompt(resolved.workflow, objectInfo);
      const key = String(nodeId);
      const promptNode = prompt[key];
      if (!promptNode) return { workflowName, error: `Node #${nodeId} is not active in ${workflowName}` };
      const sourceNode = (resolved.workflow.nodes || []).find(node => String(node.id) === key);
      const definition = objectInfo[promptNode.class_type] || {};
      const inputs = Object.entries(promptNode.inputs || {}).map(([inputName, inputValue]) => ({
        name: inputName,
        value: Array.isArray(inputValue) ? { linked: sourceLabel(prompt, inputValue[0]), output: inputValue[1] } : inputValue,
        editable: isEditableValue(inputValue),
        type: describeInput(inputName, inputValue, getInputDefinition(definition, inputName)).type,
      }));
      return {
        workflowName,
        node: {
          id: key,
          type: promptNode.class_type,
          title: sourceNode?.title || definition.display_name || promptNode.class_type,
          group: findNodeGroup(sourceNode || {}, resolved.workflow.groups),
          output: definition.output_node === true,
          inputs,
        },
      };
    }

    if (action === 'find') {
      const prompt = workflowToPrompt(resolved.workflow, objectInfo);
      const sourceNodes = new Map((resolved.workflow.nodes || []).map(node => [String(node.id), node]));
      const typePattern = type ? new RegExp(String(type).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
      const matches = [];
      for (const [nodeKey, promptNode] of Object.entries(prompt)) {
        if (typePattern && !typePattern.test(promptNode.class_type)) continue;
        if (input && !Object.prototype.hasOwnProperty.call(promptNode.inputs || {}, input)) continue;
        if (value !== undefined) {
          const scalar = Object.entries(promptNode.inputs || {})
            .filter(([, v]) => isEditableValue(v))
            .some(([, v]) => String(v).toLowerCase().includes(String(value).toLowerCase()));
          if (!scalar) continue;
        }
        const sourceNode = sourceNodes.get(nodeKey);
        const definition = objectInfo[promptNode.class_type] || {};
        const inputs = Object.entries(promptNode.inputs || {})
          .filter(([, v]) => isEditableValue(v))
          .map(([inputName, inputValue]) => ({
            name: inputName,
            value: inputValue,
            type: describeInput(inputName, inputValue, getInputDefinition(definition, inputName)).type,
          }));
        matches.push({
          id: nodeKey,
          type: promptNode.class_type,
          title: sourceNode?.title || definition.display_name || promptNode.class_type,
          group: findNodeGroup(sourceNode || {}, resolved.workflow.groups),
          inputs,
        });
        if (matches.length >= (Number(limit) || 20)) break;
      }
      return { workflowName, matches, count: matches.length };
    }

    if (action === 'validate') {
      const issues = [];
      validateLinks(resolved.workflow, issues);
      const prompt = workflowToPrompt(resolved.workflow, objectInfo);
      validatePromptStructure(prompt, issues);
      const requirements = checkModelRequirements(resolved.modelRequirements || [], objectInfo);
      for (const requirement of requirements) {
        if (requirement.available === false) {
          issues.push({
            severity: 'error',
            code: 'model_missing',
            nodeId: requirement.nodeId,
            message: `模型文件缺失：${requirement.kind}/${requirement.value}`,
          });
        }
      }
      await validateMedia(prompt, client, issues);
      const preflight = buildPreflightReport({
        issues,
        modelRequirements: requirements,
        capabilities: resolved.capabilities,
        modelType: resolved.modelType,
        adapterAvailable: resolved.adapter !== null,
        adaptationOnly: resolved.adapter?.adaptationOnly === true,
        adapterCapabilities: resolved.info,
      });
      const runtimeCheck = await inspectRuntimeCapabilities({
        client,
        requireConnection: false,
        requireFfmpeg: resolved.capabilities?.modes?.some(mode => /video/.test(mode)),
      });
      preflight.issues.push(...runtimeCheck.issues);
      preflight.runtime = runtimeCheck.runtime;
      preflight.issueCount = preflight.issues.length;
      preflight.errorCount = preflight.issues.filter(issue => issue.severity === 'error').length;
      preflight.valid = preflight.errorCount === 0;
      return {
        workflowName,
        modelType: resolved.modelType,
        ...preflight,
        sampler: extractSampler(prompt),
      };
    }

    return { workflowName, error: `Unknown action: ${action}` };
  },
};
