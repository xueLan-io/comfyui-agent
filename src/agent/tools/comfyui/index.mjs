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
import { normalizeGenerationResult } from '../../../runtime/generation-contract.mjs';
import { buildPreflightReport, preflightError } from '../../../runtime/preflight-contract.mjs';
import { inspectRuntimeCapabilities } from '../../../runtime/runtime-capabilities.mjs';
import { estimateGenerationResources } from '../../../runtime/resource-estimator.mjs';
import { stat } from 'node:fs/promises';
import { createManifestCache } from './manifest-cache.mjs';
import { createMetrics } from '../../../runtime/metrics.mjs';

let client = new ComfyUIClient();
export const runtimeMetrics = createMetrics();

export const workflowManifestCache = createManifestCache({
  resolveFile: ({ workflowName, workflowDir }) => resolveWorkflowPath(workflowDir, workflowName),
  resolveManifest: async ({ workflowName, workflowDir }) => WorkflowAdapter.resolve(workflowName, workflowDir),
  statFile: filePath => stat(filePath),
  metrics: runtimeMetrics,
});

// 目录级扫描缓存：签名不变则复用结果，避免意图切换时重复解析全部工作流。
const discoverCache = new Map();

const VIDEO_EXT = ['mp4', 'webm', 'mov', 'mkv', 'avi'];
const H3_REQUIRED_NODES = ['MiniMaxH3ReferenceToVideo', 'MiniMaxH3SigmaShift', 'EmptyMiniMaxH3LatentAV'];

function h3RuntimeIssues(modelType, objectInfo = {}) {
  if (modelType !== 'minimax_h3') return [];
  const missing = H3_REQUIRED_NODES.filter(name => !objectInfo[name]);
  return missing.length === 0 ? [] : [{
    severity: 'error',
    code: 'h3_runtime_unavailable',
    message: `MiniMax H3 nodes are not loaded: ${missing.join(', ')}`,
  }];
}

function isVideoRef(item) {
  const name = item?.filename || '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 && VIDEO_EXT.includes(name.slice(dot + 1).toLowerCase());
}

function historyStatus(entry = {}) {
  const status = entry.status || {};
  const value = status.status_str || (status.completed ? 'success' : 'unknown');
  if (value === 'success') return { completed: true, status: value };
  return {
    completed: false,
    status: value,
    error: status.messages?.at(-1)?.[1]?.exception_message || `ComfyUI execution ${value}`,
  };
}

async function assertValidMedia(images, videos, { expectedBatch = null } = {}) {
  if (images.length === 0 && videos.length === 0) {
    throw Object.assign(new Error('ComfyUI completed without media output'), { failureType: 'empty_output' });
  }
  if (expectedBatch && images.length > 0 && images.length < expectedBatch) {
    throw Object.assign(new Error(`ComfyUI returned ${images.length} images, expected at least ${expectedBatch}`), { failureType: 'output_mismatch' });
  }
  const imageChecks = typeof client.inspectImage === 'function' ? await Promise.all(images.map(image => client.inspectImage(image).catch(() => ({
    filename: image.filename, exists: false, readable: false, validFormat: false,
  })))) : [];
  if (imageChecks.some(check => !check.exists || !check.readable || !check.validFormat)) {
    const error = Object.assign(new Error('ComfyUI returned an invalid image output'), { failureType: 'invalid_output' });
    error.imageChecks = imageChecks;
    throw error;
  }
  const videoChecks = typeof client.inspectMedia === 'function' ? await Promise.all(videos.map(video => client.inspectMedia(video).catch(() => ({
    filename: video.filename, exists: false, readable: false,
  })))) : [];
  if (videoChecks.some(check => !check.exists || !check.readable)) {
    const error = Object.assign(new Error('ComfyUI returned an unreadable video output'), { failureType: 'invalid_output' });
    error.videoChecks = videoChecks;
    throw error;
  }
  return { imageChecks, videoChecks };
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
      frames: { type: 'number', description: 'Frame count (video workflows)' },
      fps: { type: 'number', description: 'Frames per second (video workflows)' },
      guidance: { type: 'number', description: 'Guidance scale for compatible video workflows' },
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
    const { workflowName, workflowDir, signal } = input;
    const filePath = resolveWorkflowPath(workflowDir, workflowName);

    assertSandboxMedia(input);

    if (!existsSync(filePath)) {
      throw new Error(`Workflow not found: ${workflowName}`);
    }

    const resolved = await WorkflowAdapter.resolve(workflowName, workflowDir);
    const adaptedWf = await WorkflowAdapter.prepareInput(workflowName, workflowDir, input);

    const adaptationOnly = resolved.adapter?.adaptationOnly === true;

    const objectInfo = await client.objectInfo();
    const prompt = workflowToPrompt(adaptedWf, objectInfo);
    const modelRequirements = checkModelRequirements(resolved.modelRequirements || [], objectInfo);
    const runtimeCheck = await inspectRuntimeCapabilities({
      client,
      requireConnection: true,
      requireFfmpeg: resolved.capabilities?.modes?.some(mode => /video/.test(mode)),
    });
    const resourceEstimate = estimateGenerationResources({
      modelType: resolved.modelType,
      capabilities: resolved.capabilities,
      resolution: resolved.workflowProfile?.resolution || {},
      settings: input.settings,
      frames: input.frames ?? input.settings?.frames,
      runtime: runtimeCheck.runtime,
      strict: true,
    });
    const preflight = buildPreflightReport({ modelRequirements, capabilities: resolved.capabilities, modelType: resolved.modelType, adapterAvailable: resolved.adapter !== null, adaptationOnly, adapterCapabilities: resolved.info, runtime: runtimeCheck.runtime, resourceEstimate });
    preflight.issues.push(...h3RuntimeIssues(resolved.modelType, objectInfo));
    preflight.issues.push(...resourceEstimate.issues);
    preflight.issues.push(...runtimeCheck.issues);
    preflight.issueCount = preflight.issues.length;
    preflight.errorCount = preflight.issues.filter(issue => issue.severity === 'error').length;
    preflight.valid = preflight.errorCount === 0;
    if (!preflight.valid) {
      const issue = preflight.issues.find(item => item.severity === 'error');
      throw preflightError(preflight, issue?.message, issue?.code === 'model_missing' ? 'model_missing' : issue?.code || 'preflight_failed');
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
    const promptRequired = resolved.capabilities?.promptRequired !== false
      && resolved.promptProfile?.promptRequired !== false;
    if (executionPrompts.length > 0 && promptRequired && !promptOverrides.some(item => item.polarity === 'positive')) {
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
    for (const [nodeId, node] of Object.entries(prompt)) {
      if (node.class_type === 'LoadImage' && !node.inputs?.image) {
        const error = new Error(`LoadImage node ${nodeId} has no image selected; please provide a reference image or choose one in the workflow`);
        error.failureType = 'loadimage_empty';
        error.retryable = false;
        throw error;
      }
    }
    const clientId = input.clientId || randomUUID();
    let progressSocket = null;
    for (let attempt = 0; attempt < 3 && !progressSocket; attempt++) {
      if (input.signal?.aborted) throw new Error('Generation cancelled');
      progressSocket = typeof client.openProgressSocket === 'function'
        ? await client.openProgressSocket(clientId, prompt, input.onProgress, input.signal)
        : null;
      if (!progressSocket && attempt < 2) await new Promise(resolve => setTimeout(resolve, 500));
    }
    let promptId;
    let rawImages;
    let rawVideos;

    try {
      input.onProgress?.({ stage: 'submit_started', message: '正在提交工作流' });
      const result = typeof client.submit === 'function'
        ? await client.submit(prompt, clientId, signal ? { signal } : undefined)
        : { promptId: (await client.queuePrompt(prompt, clientId, signal)).prompt_id };

      promptId = result.promptId;
      progressSocket?.setPromptId?.(promptId);
      input.onProgress?.({ stage: 'queued', promptId, message: '工作流已进入队列', percent: 0 });
      const history = typeof client.observe === 'function'
        ? await client.observe(promptId, 1000, input.signal)
        : await client.waitForCompletion(promptId, 1000, input.signal);
      const imageNodeIds = this._imageNodeIds(history);
      const mediaItems = this._extractMedia(history, selectedOutputIds);
      const videoNodeIds = new Set(mediaItems.filter(isVideoRef).map(item => String(item.nodeId || '')));
      if (selectedOutputIds.length > 0 && !selectedOutputIds.some(id => imageNodeIds.has(String(id)) || videoNodeIds.has(String(id)))) {
        const error = new Error('Selected output node did not produce media');
        error.failureType = 'output_mismatch';
        error.replan = true;
        throw error;
      }
      rawImages = mediaItems.filter(item => !isVideoRef(item));
      rawVideos = mediaItems.filter(isVideoRef);
      const state = historyStatus(history);
      if (!state.completed) throw Object.assign(new Error(state.error), { failureType: 'execution_failed' });
      const checks = await assertValidMedia(rawImages, rawVideos, {
        expectedBatch: Number.isInteger(input.settings?.batch) ? input.settings.batch : null,
      });
      input.onProgress?.({ stage: 'completed', promptId, message: '工作流执行完成', percent: 100 });
      const executionStatus = state.status;
      const executionResult = {
        promptId,
        images: rawImages,
        videos: rawVideos.map(v => ({ filename: v.filename, subfolder: v.subfolder || '', type: v.type || 'output' })),
        isVideoWorkflow: Boolean(input.frames ?? input.settings?.frames) || /wan|animatediff|video|minimax/i.test(String(resolved?.modelType || '')),
        imageChecks: checks.imageChecks,
        videoChecks: checks.videoChecks,
        outputNodeIds: selectedOutputIds.map(String),
        imageNodeIds: [...imageNodeIds],
        expectedBatch: Number.isInteger(input.settings?.batch) ? input.settings.batch : null,
        executionStatus,
        nodeErrors: [],
        compiledPrompt,
        workflowName,
        modelType: resolved?.modelType || 'generic',
        overrides: overrideReport,
        promptOverrides: promptOverrides.length,
        removedOutputs,
        status: 'completed',
        preflight,
      };
      const artifactSource = { taskId: '', tool: 'comfyui', workflowName, modelType: resolved?.modelType || 'generic' };
      executionResult.artifacts = rawImages.map(img => artifactFromComfyUIImage(img, artifactSource, { promptId }));
      executionResult.promptArtifact = createArtifact('prompt', { ...artifactSource, tool: 'comfyui' }, {
        prompt: input.prompt || (input.prompts || [])[0] || '',
        operation: 'txt2img',
        promptId,
      });
      return normalizeGenerationResult(executionResult);
    } catch (error) {
      // Once /prompt returned a prompt id, any later failure has an existing
      // remote execution. Retrying execute() would submit a second prompt.
      if (promptId) {
        error.promptId = error.promptId || promptId;
        error.failureType = error.failureType || 'observe_unknown';
        error.retryable = false;
      }
      throw error;
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
        if (input.signal?.aborted) throw Object.assign(new Error('Generation cancelled'), { code: 'GENERATION_CANCELLED' });
        const ref = await client.uploadMedia(kind, name, await readFile(filePath), {
          type: 'input',
          signal: input.signal,
          ...options,
        });
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

  async inspectWorkflow(workflowName, workflowDir, options = {}) {
    const resolved = await workflowManifestCache.get(workflowName, workflowDir, options);
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

      const runtimeCheck = await inspectRuntimeCapabilities({
      client,
      requireConnection: false,
      requireFfmpeg: resolved.capabilities?.modes?.some(mode => /video/.test(mode)),
      });
      const resourceEstimate = estimateGenerationResources({
        modelType: resolved.modelType,
        capabilities: resolved.capabilities,
        resolution: { ...resolved.workflowProfile?.resolution, ...extractCommonSettings(prompt) },
        settings: {},
        runtime: runtimeCheck.runtime,
      });
      const preflight = buildPreflightReport({
      issues: runtimeCheck.issues,
      modelRequirements,
      capabilities: resolved.capabilities,
      modelType: resolved.modelType,
      adapterAvailable: resolved.adapter !== null,
      adaptationOnly: resolved.adapter?.adaptationOnly === true,
      adapterCapabilities: resolved.info,
        runtime: runtimeCheck.runtime,
        resourceEstimate,
      });
      preflight.issues.push(...resourceEstimate.issues);
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
      preflight,
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

    // Signature: file name + size + mtime. Same tree means the same manifests,
    // so intent switches (txt2img -> img2img/upscale/...) no longer re-resolve
    // every workflow file.
    const signature = (await Promise.all(files.map(async name => {
      try {
        const info = await stat(join(workflowDir, name));
        return `${name}|${info.size}|${info.mtimeMs}`;
      } catch {
        return `${name}|missing`;
      }
    }))).join(';');
    const cached = discoverCache.get(workflowDir);
    if (cached && cached.signature === signature) return cached.result;

    const result = await Promise.all(files.map(async f => {
      try {
        const info = await WorkflowAdapter.resolve(f, workflowDir);
        return {
          name: f,
          modelType: info?.modelType || 'generic',
          capabilities: info?.capabilities || { family: info?.modelType || 'generic', modes: [], labels: [] },
          workflowProfile: info?.workflowProfile || null,
          promptSlots: info?.info?.promptSlots || 0,
        };
      } catch {
        return { name: f, modelType: 'unknown', promptSlots: 0 };
      }
    }));
    discoverCache.set(workflowDir, { signature, result });
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

    if (history[promptId]) {
      const state = historyStatus(history[promptId]);
      return state.completed
        ? { status: 'completed', history: history[promptId] }
        : { status: 'failed', history: history[promptId], message: state.error };
    }
    if (running) return { status: 'running', progress: { stage: 'executing', message: '工作流正在执行', indeterminate: true } };
    if (pending) return { status: 'queued', progress: { stage: 'queued', message: '工作流正在排队', indeterminate: true } };
    return { status: 'unknown' };
  },

  async recoverResult(promptId, history = null) {
    const entry = history || await client.fetchResult(promptId);
    if (!entry) throw new Error(`ComfyUI history is unavailable for prompt ${promptId}`);
    const state = historyStatus(entry);
    if (!state.completed) throw Object.assign(new Error(state.error), { failureType: 'execution_failed' });
    const imageNodeIds = this._imageNodeIds(entry);
    const mediaItems = this._extractMedia(entry);
    const images = mediaItems.filter(item => !isVideoRef(item));
    const videos = mediaItems.filter(isVideoRef);
    const checks = await assertValidMedia(images, videos);
    return normalizeGenerationResult({
      promptId,
      images,
      videos,
      imageNodeIds: [...imageNodeIds],
      imageChecks: checks.imageChecks,
      videoChecks: checks.videoChecks,
      executionStatus: state.status,
      status: 'completed',
    });
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
            if (item.filename) images.push({ ...item, nodeId: String(nodeId) });
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

// Stable atomic ComfyUI tools are re-exported here for callers that import the
// ComfyUI tool module directly instead of the package entry point.
export { RuntimeTools, RuntimeReadTools, RuntimeMutationTools, ComfyUIGetStatusTool, ComfyUIGetQueueTool, ComfyUIGetHistoryTool, ComfyUIGetObjectInfoTool, ComfyUIGetSystemStatsTool, ComfyUIGetOutputTool, ComfyUICancelPromptTool, ComfyUIInterruptTool } from './runtime.mjs';
export { WorkflowReadTools, WorkflowListTool, WorkflowReadTool, WorkflowSnapshotTool, WorkflowListNodesTool, WorkflowGetNodeTool, WorkflowFindNodesTool, WorkflowListOutputsTool, WorkflowValidateTool } from './workflow-read.mjs';
export { ComfyUIRuntimeParametersTool, compileRuntimeParameters } from './runtime-parameters.mjs';
export { WorkflowMutationTools, WorkflowMutationPreviewTool, WorkflowMutationCommitTool, WorkflowRevisionListTool, WorkflowRollbackTool } from './workflow-mutation-tools.mjs';
