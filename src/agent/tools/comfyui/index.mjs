import { readdirSync, existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join, basename, relative } from 'path';
import { randomUUID } from 'crypto';
import { WorkflowAdapter, resolveWorkflowPath } from './workflow-adapter.mjs';
import { applyWorkflowOverrides, capReferenceImageResolution, extractCommonSettings, injectExecutionPrompts, injectInputMedia, isEditableValue, referenceMediaInjected, selectExecutionOutputs, selectPreferredExecutionOutputs } from './node-overrides.mjs';
import { artifactFromComfyUIImage, createArtifact } from '../../schemas/artifact-schema.mjs';
import { ComfyUIClient, queueContains } from './client.mjs';
import { workflowToPrompt, findNodeGroup, checkModelRequirements, getInputDefinition, describeInput } from './prompt-builder.mjs';
import { assertSandboxMedia, resolveSandboxFile } from '../../security/sandbox.mjs';

let client = new ComfyUIClient();

const VIDEO_EXT = ['mp4', 'webm', 'mov', 'mkv', 'avi'];

function isVideoRef(item) {
  const name = item?.filename || '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 && VIDEO_EXT.includes(name.slice(dot + 1).toLowerCase());
}

const MEDIA_INPUT_NAMES = {
  image: ['image'],
  mask: ['image'],
  video: ['video', 'video_path', 'video_file'],
};

function mediaKindForClassType(classType) {
  if (/loadimagemask/i.test(classType || '')) return 'mask';
  if (/^loadimage$/i.test(classType || '')) return 'image';
  if (/video/i.test(classType || '')) return 'video';
  return '';
}

function extractInputMedia(prompt) {
  const result = { images: [], masks: [], videos: [] };
  for (const [nodeId, node] of Object.entries(prompt || {})) {
    const kind = mediaKindForClassType(node?.class_type);
    if (!kind) continue;
    const inputNames = MEDIA_INPUT_NAMES[kind] || [];
    for (const inputName of inputNames) {
      const value = node.inputs?.[inputName];
      if (typeof value === 'string' && value) {
        result[kind].push(value);
        break;
      }
    }
  }
  return result;
}

export const ComfyUITool = {
  name: 'comfyui',
  description: 'Queue one local ComfyUI workflow. It cannot edit workflow files, choose undeclared nodes, or guarantee deterministic output.',
  category: 'generation',
  tags: ['comfyui', 'image', 'generation'],
  timeout_ms: 600000,
  side_effects: ['queue_generation', 'upload_reference_media', 'modify_runtime_node_parameters'],
  requires_confirmation: true,
  idempotent: false,
  retry: { mode: 'limited', max_attempts: 2 },

  output_schema: {
    type: 'object',
    properties: {
      promptId: { type: 'string' },
      images: { type: 'array', items: { type: 'object' } },
      videos: { type: 'array', items: { type: 'object' } },
      isVideoWorkflow: { type: 'boolean' },
      outputNodeIds: { type: 'array', items: { type: 'string' } },
      executionStatus: { type: 'string' },
      status: { type: 'string' },
      error: { type: 'string' },
    },
  },

  input_schema: {
    type: 'object',
    properties: {
      workflowName: { type: 'string', description: 'Workflow filename (e.g. txt2img.json)' },
      prompts: { type: 'array', items: { type: 'string' }, description: 'Prompts to inject' },
      prompt: { type: 'string', description: 'Single prompt (alternative to prompts array)' },
      workflowDir: { type: 'string', description: 'Directory containing workflow files' },
      size: { type: 'string', description: 'Resolution hint (e.g. 1024x1024)' },
      guidance: { type: 'number', description: 'Guidance scale (Flux)' },
      frames: { type: 'number', description: 'Frame count (AnimateDiff)' },
      settings: { type: 'object', description: 'Common runtime controls such as seed, steps, cfg, size, and batch' },
      nodeOverrides: { type: 'object', description: 'Exact node input overrides keyed by node id' },
      outputNodeIds: { type: 'array', items: { type: 'string' }, description: 'Output node ids to execute; omitted selects one preferred direct image output' },
      images: { type: 'array', description: 'Local image files (path string or {path, name}) uploaded and injected into LoadImage nodes' },
      masks: { type: 'array', description: 'Local mask files (path string or {path, name}) uploaded and injected into LoadImageMask nodes for inpainting' },
      videos: { type: 'array', description: 'Local video files (path string or {path, name}) uploaded and injected into video loader nodes' },
    },
    required: ['workflowName', 'workflowDir'],
  },

  setClient(instance) {
    client = instance || new ComfyUIClient();
  },

  get client() {
    return client;
  },

  async execute(input) {
    const { workflowName, workflowDir } = input;
    const filePath = resolveWorkflowPath(workflowDir, workflowName);

    assertSandboxMedia(input);

    if (!existsSync(filePath)) {
      throw new Error(`Workflow not found: ${workflowName}`);
    }

    const resolved = await WorkflowAdapter.resolve(workflowName, workflowDir);
    const adaptedWf = await WorkflowAdapter.prepareInput(workflowName, workflowDir, input);

    const objectInfo = await client.objectInfo();
    const prompt = workflowToPrompt(adaptedWf, objectInfo);
    const modelRequirements = checkModelRequirements(resolved.modelRequirements || [], objectInfo);
    const missingModels = modelRequirements.filter(item => item.available === false);
    if (missingModels.length > 0) {
      const error = new Error(`Workflow model files are missing: ${missingModels.map(item => item.value).join(', ')}`);
      error.failureType = 'model_missing';
      error.retryable = false;
      throw error;
    }
    const knownOutputIds = Object.entries(prompt)
      .filter(([, node]) => objectInfo[node.class_type]?.output_node === true)
      .map(([nodeId]) => nodeId);
    if (Array.isArray(input.outputNodeIds)) {
      const unknownOutputId = input.outputNodeIds.find(nodeId => !knownOutputIds.includes(String(nodeId)));
      if (unknownOutputId !== undefined) throw new Error(`Output node not found: ${unknownOutputId}`);
    }
    const selectedOutputIds = Array.isArray(input.outputNodeIds)
      ? input.outputNodeIds
      : selectPreferredExecutionOutputs(prompt, knownOutputIds);
    const removedOutputs = selectExecutionOutputs(prompt, selectedOutputIds, knownOutputIds);
    const executionPrompts = Array.isArray(input.prompts) && input.prompts.length > 0
      ? input.prompts
      : input.prompt ? [input.prompt] : [];
    const compiledPrompt = input.compiledPrompt || {
      positive: executionPrompts[0] || '',
      positivePrompts: executionPrompts,
      negative: input.negativePrompt || resolved.promptProfile.currentNegative,
    };
    if (compiledPrompt.negative?.trim() && resolved.promptProfile.supportsNegative === false) {
      const error = new Error('Current workflow has no usable negative prompt input');
      error.failureType = 'negative_prompt_unsupported';
      error.replan = true;
      throw error;
    }
    const promptOverrides = injectExecutionPrompts(prompt, compiledPrompt, resolved.promptProfile);
    if (executionPrompts.length > 0 && !promptOverrides.some(item => item.polarity === 'positive')) {
      const error = new Error('The workflow has no injectable positive prompt input');
      error.failureType = 'prompt_not_injected';
      error.replan = true;
      throw error;
    }
    const overrideReport = applyWorkflowOverrides(prompt, input.settings, input.nodeOverrides);
    const invalidNodeOverride = overrideReport.ignored.find(item => item.source === 'node');
    if (invalidNodeOverride) {
      throw new Error(`Node input not found: ${invalidNodeOverride.nodeId}.${invalidNodeOverride.input}`);
    }
    if (overrideReport.applied.length > 0 || promptOverrides.length > 0) {
      input.onProgress?.({
        stage: 'configuring',
        message: `已配置提示词和 ${overrideReport.applied.length} 个节点参数`,
        applied: overrideReport.applied.length,
      });
    }
    let uploaded;
    try {
      uploaded = await this._uploadMedia(input);
    } catch (error) {
      error.failureType = 'comfyui_upload';
      error.retryable = false;
      throw error;
    }
    if (uploaded.total > 0) {
      const mediaReport = injectInputMedia(prompt, uploaded);
      if (!referenceMediaInjected(uploaded, mediaReport)) {
        const error = new Error('Reference media was not connected to a loader node');
        error.failureType = 'reference_not_connected';
        error.replan = true;
        throw error;
      }
      input.onProgress?.({
        stage: 'media',
        message: `已上传 ${uploaded.total} 个媒体文件，注入 ${mediaReport.applied.length} 个加载节点`,
        applied: mediaReport.applied.length,
        ignored: mediaReport.ignored,
      });
    }
    if (uploaded.images.length > 0) {
      const resolutionReport = capReferenceImageResolution(prompt, objectInfo);
      if (resolutionReport.applied > 0) {
        input.onProgress?.({
          stage: 'preprocess',
          message: `Reference image resized to a maximum dimension of ${resolutionReport.largestSize}px before VAE encoding`,
          applied: resolutionReport.applied,
        });
      }
    }
    const clientId = input.clientId || randomUUID();
    const progressSocket = await client.openProgressSocket(clientId, prompt, input.onProgress);
    let promptId;
    let rawImages;
    let rawVideos;

    try {
      input.onProgress?.({ stage: 'submit_started', message: '正在提交工作流' });
      const result = typeof client.submit === 'function'
        ? await client.submit(prompt, clientId)
        : { promptId: (await client.queuePrompt(prompt, clientId)).prompt_id };

      promptId = result.promptId;
      input.onProgress?.({ stage: 'queued', promptId, message: '工作流已进入队列', percent: 0 });
      const history = typeof client.observe === 'function'
        ? await client.observe(promptId, 1000, input.signal)
        : await client.waitForCompletion(promptId, 1000, input.signal);
      const imageNodeIds = this._imageNodeIds(history);
      if (selectedOutputIds.length > 0 && !selectedOutputIds.some(id => imageNodeIds.has(String(id)))) {
        const error = new Error('Selected output node did not produce an image');
        error.failureType = 'output_mismatch';
        error.replan = true;
        throw error;
      }
      const mediaItems = this._extractMedia(history, selectedOutputIds);
      rawImages = mediaItems.filter(item => !isVideoRef(item));
      rawVideos = mediaItems.filter(isVideoRef);
      const imageChecks = typeof client.inspectImage === 'function'
        ? await Promise.all(rawImages.map(image => client.inspectImage(image).catch(() => ({
          filename: image.filename,
          exists: false,
          readable: false,
          validFormat: false,
        }))))
        : [];
      input.onProgress?.({ stage: 'completed', promptId, message: '工作流执行完成', percent: 100 });
      const status = history.status || {};
      const executionStatus = status.status_str || (status.completed ? 'success' : 'unknown');
      const executionResult = {
        promptId,
        images: rawImages,
        videos: rawVideos.map(v => ({ filename: v.filename, subfolder: v.subfolder || '', type: v.type || 'output' })),
        isVideoWorkflow: Boolean(input.frames) || /animatediff|video/i.test(String(resolved?.modelType || '')),
        imageChecks,
        outputNodeIds: selectedOutputIds.map(String),
        imageNodeIds: [...imageNodeIds],
        expectedBatch: Number.isInteger(input.settings?.batch) ? input.settings.batch : null,
        executionStatus,
        nodeErrors: status.status_str && status.status_str !== 'success' ? [status.status_str] : [],
        compiledPrompt,
        workflowName,
        modelType: resolved?.modelType || 'generic',
        overrides: overrideReport,
        promptOverrides: promptOverrides.length,
        removedOutputs,
        status: 'completed',
      };
      const artifactSource = { taskId: '', tool: 'comfyui', workflowName, modelType: resolved?.modelType || 'generic' };
      executionResult.artifacts = rawImages.map(img => artifactFromComfyUIImage(img, artifactSource, { promptId }));
      executionResult.promptArtifact = createArtifact('prompt', { ...artifactSource, tool: 'comfyui' }, {
        prompt: input.prompt || (input.prompts || [])[0] || '',
        operation: 'txt2img',
        promptId,
      });
      return executionResult;
    } finally {
      progressSocket?.close();
    }
  },

  async _uploadMedia(input) {
    const uploaded = { images: [], masks: [], videos: [], total: 0 };

    async function uploadEntries(kind, entries, options = {}) {
      const refs = [];
      for (const entry of entries || []) {
        const item = typeof entry === 'string' ? { path: entry } : entry || {};
        if (!item.path) throw new Error(`Missing path in comfyui ${kind} input`);
        const filePath = input.sandboxInput ? resolveSandboxFile(input.sandboxInput, item.path) : item.path;
        if (!existsSync(filePath)) throw new Error(`Media file not found: ${filePath}`);
        const name = item.name || basename(filePath);
        const ref = await client.uploadMedia(kind, name, await readFile(filePath), { type: 'input', ...options });
        refs.push({ name: ref.name, subfolder: ref.subfolder || '', type: ref.type || 'input' });
      }
      return refs;
    }

    uploaded.images = await uploadEntries('image', input.images);
    if (Array.isArray(input.masks) && input.masks.length > 0) {
      const originalRef = uploaded.images[0]
        ? { filename: uploaded.images[0].name, subfolder: uploaded.images[0].subfolder, type: uploaded.images[0].type }
        : null;
      uploaded.masks = await uploadEntries('mask', input.masks, originalRef ? { originalRef } : {});
    }
    uploaded.videos = await uploadEntries('video', input.videos);
    uploaded.total = uploaded.images.length + uploaded.masks.length + uploaded.videos.length;
    return uploaded;
  },

  async inspectWorkflow(workflowName, workflowDir) {
    const resolved = await WorkflowAdapter.resolve(workflowName, workflowDir);
    if (!resolved) throw new Error(`Workflow not found: ${workflowName}`);

    const objectInfo = await client.objectInfo();
    const prompt = workflowToPrompt(resolved.workflow, objectInfo);
    const modelRequirements = checkModelRequirements(resolved.modelRequirements || [], objectInfo);
    const sourceNodes = new Map((resolved.workflow.nodes || []).map(node => [String(node.id), node]));
    const editableNodes = [];
    const outputNodes = [];

    for (const [nodeId, promptNode] of Object.entries(prompt)) {
      const sourceNode = sourceNodes.get(nodeId);
      const typeDefinition = objectInfo[promptNode.class_type];
      if (typeDefinition?.output_node === true) {
        outputNodes.push({
          id: nodeId,
          type: promptNode.class_type,
          title: sourceNode?.title || typeDefinition?.display_name || promptNode.class_type,
          group: findNodeGroup(sourceNode || {}, resolved.workflow.groups),
        });
      }
      const inputs = Object.entries(promptNode.inputs || {})
        .filter(([, value]) => isEditableValue(value))
        .map(([inputName, value]) => describeInput(
          inputName,
          value,
          getInputDefinition(typeDefinition, inputName),
        ));

      if (inputs.length === 0) continue;
      editableNodes.push({
        id: nodeId,
        type: promptNode.class_type,
        title: sourceNode?.title || typeDefinition?.display_name || promptNode.class_type,
        group: findNodeGroup(sourceNode || {}, resolved.workflow.groups),
        inputs,
      });
    }

    return {
      workflowName,
      modelType: resolved.modelType,
      promptProfile: resolved.promptProfile,
      capabilities: resolved.capabilities,
      workflowProfile: {
        ...resolved.workflowProfile,
        modelRequirements,
      },
      modelRequirements,
      missingModels: modelRequirements.filter(item => item.available === false),
      modelReady: modelRequirements.every(item => item.available !== false),
      nodeCount: resolved.workflow.nodes?.length || 0,
      activeNodeCount: Object.keys(prompt).length,
      editableNodeCount: editableNodes.length,
      outputNodeCount: outputNodes.length,
      outputNodes,
      preferredOutputNodeIds: selectPreferredExecutionOutputs(prompt, outputNodes.map(node => node.id)),
      promptSlots: resolved.info?.promptSlots || 0,
      commonSettings: extractCommonSettings(prompt),
      inputMedia: extractInputMedia(prompt, objectInfo),
      editableNodes,
    };
  },

  async discover(workflowDir) {
    if (!workflowDir || !existsSync(workflowDir)) return [];

    const files = [];
    const walk = dir => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.includes('backup')) {
          files.push(relative(workflowDir, join(dir, entry.name)).split('\\').join('/'));
        }
      }
    };
    walk(workflowDir);

    const result = [];
    for (const f of files) {
      try {
        const info = await WorkflowAdapter.resolve(f, workflowDir);
        result.push({
          name: f,
          modelType: info?.modelType || 'generic',
          capabilities: info?.capabilities || { family: info?.modelType || 'generic', modes: [], labels: [] },
          workflowProfile: info?.workflowProfile || null,
          promptSlots: info?.info?.promptSlots || 0,
        });
      } catch {
        result.push({ name: f, modelType: 'unknown', promptSlots: 0 });
      }
    }
    return result;
  },

  async validate(workflowName, workflowDir) {
    try {
      const resolved = await WorkflowAdapter.resolve(workflowName, workflowDir);
      if (!resolved) return { valid: false, error: 'File not found' };
      return {
        valid: true,
        modelType: resolved.modelType,
        capabilities: resolved.capabilities,
        workflowProfile: resolved.workflowProfile,
        modelRequirements: resolved.modelRequirements,
        adapterAvailable: resolved.adapter !== null,
        promptSlots: resolved.info?.promptSlots || 0,
        nodeCount: resolved.workflow.nodes?.length || 0,
      };
    } catch (e) {
      return { valid: false, error: e.message };
    }
  },

  async monitor(promptId) {
    const queue = await client.queue();
    const history = await client.history(promptId);
    const running = queueContains(queue.queue_running, promptId);
    const pending = queueContains(queue.queue_pending, promptId);

    if (history[promptId]) return { status: 'completed', history: history[promptId] };
    if (running) return { status: 'running' };
    if (pending) return { status: 'queued' };
    return { status: 'unknown' };
  },

  async recoverResult(promptId, history = null) {
    const entry = history || await client.fetchResult(promptId);
    if (!entry) throw new Error(`ComfyUI history is unavailable for prompt ${promptId}`);
    const imageNodeIds = this._imageNodeIds(entry);
    const mediaItems = this._extractMedia(entry);
    return {
      promptId,
      images: mediaItems.filter(item => !isVideoRef(item)),
      videos: mediaItems.filter(isVideoRef),
      imageNodeIds: [...imageNodeIds],
      executionStatus: entry.status?.status_str || (entry.status?.completed ? 'success' : 'unknown'),
      status: 'completed',
    };
  },

  async recentImages(limit = 1) {
    const history = await client.historyRecent(limit);
    const entries = Object.values(history || {});
    return entries.flatMap(entry => this._extractMedia(entry));
  },

  async cancel(promptId) {
    if (promptId) {
      await client.queueDelete([promptId]);
      await client.interrupt(promptId);
    } else {
      await client.interrupt();
    }
    return { status: 'cancelled', promptId };
  },

  _extractMedia(result, selectedOutputIds = null) {
    const outputs = result.outputs || {};
    const images = [];
    const allowed = Array.isArray(selectedOutputIds) && selectedOutputIds.length > 0
      ? new Set(selectedOutputIds.map(String))
      : null;
    for (const nodeId of Object.keys(outputs)) {
      if (allowed && !allowed.has(String(nodeId))) continue;
      const nodeOutputs = outputs[nodeId];
      for (const key of Object.keys(nodeOutputs)) {
        const items = nodeOutputs[key];
        if (Array.isArray(items)) {
          for (const item of items) {
            if (item.filename) images.push(item);
          }
        }
      }
    }
    return images;
  },

  _imageNodeIds(result) {
    const ids = new Set();
    for (const [nodeId, nodeOutputs] of Object.entries(result.outputs || {})) {
      if (Object.values(nodeOutputs || {}).some(items => Array.isArray(items) && items.some(item => item?.filename))) ids.add(String(nodeId));
    }
    return ids;
  },
};
