import { assertDirectExecutionPolicy, directGenerationRequest, normalizeGenerationResult } from '../generation-contract.mjs';
import { validateDirectRequest } from './direct-validator.mjs';
import { classifyFailure } from '../../agent/optimizer/retry-policy.mjs';
import { checkEditedPrompt } from '../../agent/optimizer/prompt-guard.mjs';
import { evaluateTechnical } from '../../agent/schemas/evaluation-schema.mjs';
import { assertSandboxMedia } from '../../agent/security/sandbox.mjs';
import { freezeRuntimeRequest, runtimeRequestDigest } from '../runtime-parameters-contract.mjs';
import { estimateGenerationTime } from '../generation-time-estimate.mjs';

function promptChecks(request) {
  return checkEditedPrompt({ positive: request.positive, negative: request.negative })
    .map(issue => ({ type: issue.type, level: issue.severity || 'medium', message: issue.detail }));
}

function mediaWorkflowMode(media = {}) {
  if (media.masks?.length > 0) return 'inpaint';
  if (media.images?.length > 0) return 'img2img';
  return '';
}

function previewFor(request, workflow, validation, previewId) {
  const profile = workflow.promptProfile || {};
  const checks = [...validation.checks, ...promptChecks(request)];
  const targets = (profile.promptLists || []).flatMap(target => (target.inputs || []).map(input => ({
    nodeId: String(target.nodeId),
    input,
    polarity: 'positive',
  })));
  if (targets.length === 0) targets.push(...(profile.positiveTargets || []).map(target => ({ ...target, polarity: 'positive' })));
  if (profile.supportsNegative) targets.push(...(profile.negativeTargets || []).map(target => ({ ...target, polarity: 'negative' })));

  return {
    id: previewId,
    previewId,
    requestId: request.requestId,
    turnId: request.turnId || '',
    projectId: request.projectId || '',
    sessionId: request.sessionId || '',
    principalId: request.principalId || '',
    tenantId: request.tenantId || '',
    source: 'direct',
    origin: request.origin,
    presetId: request.presetId || '',
    presetOrigin: request.presetOrigin || '',
    mode: 'raw',
    model: profile.family || workflow.modelType || 'generic',
    modelType: profile.family || workflow.modelType || 'generic',
    format: profile.format || 'narrative',
    positive: request.positive,
    negative: request.negative,
    originalPositive: request.positive,
    originalNegative: request.negative,
    supportsNegative: profile.supportsNegative !== false,
    aiModified: false,
    workflow: {
      name: request.workflowName,
      valid: validation.valid,
      modelReady: workflow.modelReady !== false,
    },
    workflowName: request.workflowName,
    settings: request.settings || {},
    nodeOverrides: request.nodeOverrides || {},
    outputNodeIds: request.outputNodeIds || null,
    media: request.media || {},
    parameters: request.settings || {},
    timeEstimate: estimateGenerationTime({
      modelType: workflow.modelType || profile.family || 'generic',
      settings: request.settings,
       resolution: workflow.workflowProfile?.resolution || {},
       runtime: workflow.preflight?.runtime || {},
    }),
    preflight: validation,
    requestDigest: runtimeRequestDigest(request),
    checks,
    warnings: checks.filter(check => check.level === 'warning' || check.level === 'medium').map(check => check.message),
    issues: checks.filter(check => check.level === 'error'),
    targets,
    confirmation: {
      required: true,
      actions: [
        { type: 'source', label: 'Source', detail: request.origin },
        { type: 'prompt', label: 'Prompt mode', detail: 'Original text' },
        { type: 'workflow', label: 'Workflow', detail: request.workflowName },
      ],
    },
    status: 'prepared',
  };
}

export class DirectService {
  constructor({ executor, workflowDir = '' } = {}) {
    if (!executor) throw new Error('DirectService requires a ComfyUI executor');
    this.executor = executor;
    this.workflowDir = workflowDir;
    this._previews = new Map();
    this._running = false;
  }

  setWorkflowDir(workflowDir) {
    this.workflowDir = workflowDir;
  }

  get isRunning() {
    return this._running;
  }

  get isBusy() {
    return this._running || this._previews.size > 0;
  }

  async _resolveWorkflow(request) {
    const mode = mediaWorkflowMode(request.media);
    const requested = await this.executor.inspect(request.workflowName, this.workflowDir);
    const supportedModes = requested?.capabilities?.modes || [];
    const supportsReferenceMedia = (request.media.images?.length > 0 && (supportedModes.includes('img2video') || supportedModes.includes('upscale')))
      || (request.media.videos?.length > 0 && supportedModes.includes('video2video'));
    if (!mode || supportedModes.includes(mode) || supportsReferenceMedia) return { workflowName: request.workflowName, manifest: requested };
    const candidates = (await this.executor.discover?.(this.workflowDir)) || [];
    const match = candidates.find(item => item.capabilities?.modes?.includes(mode));
    if (!match) return { workflowName: request.workflowName, manifest: requested };
    return { workflowName: match.name, manifest: await this.executor.inspect(match.name, this.workflowDir) };
  }

  async prepare(input, { sandboxInput = {}, signal } = {}) {
    if (signal?.aborted) {
      const error = new Error('Direct generation cancelled');
      error.code = 'GENERATION_CANCELLED';
      throw error;
    }
    const request = assertDirectExecutionPolicy(directGenerationRequest(input));
    assertSandboxMedia({ ...sandboxInput, ...request.media });
    const resolved = await this._resolveWorkflow(request);
    // Workflow inspection can finish after the caller's preparation timeout.
    // Never publish a preview for a request that has already been cancelled.
    if (signal?.aborted) {
      const error = new Error('Direct generation cancelled');
      error.code = 'GENERATION_CANCELLED';
      throw error;
    }
    const workflow = resolved.manifest;
    request.workflowName = resolved.workflowName;
    const validation = validateDirectRequest(request, workflow);
    const previewId = `direct_preview_${request.requestId}`;
    const preview = previewFor(request, workflow, validation, previewId);
    const frozenRequest = freezeRuntimeRequest(request);
    preview.frozenRuntimeRequest = frozenRequest;
    this._previews.set(previewId, { request: frozenRequest, frozenRuntimeRequest: frozenRequest, workflow, preview: { ...preview, expiresAt: Date.now() + 15 * 60 * 1000 }, sandboxInput });
    return preview;
  }


  getPreview(previewId) {
    const prepared = this._previews.get(previewId);
    if (prepared?.preview.expiresAt && prepared.preview.expiresAt <= Date.now()) { this._previews.delete(previewId); return null; }
    return prepared?.preview || null;
  }

  discardPreview(previewId) {
    return { discarded: this._previews.delete(previewId) };
  }

  async run(previewId, edits = {}, options = {}) {
    const prepared = this._previews.get(previewId);
    if (!prepared) throw new Error('Direct generation preview expired; prepare it again');
    if (prepared.preview.expiresAt && prepared.preview.expiresAt <= Date.now()) { this._previews.delete(previewId); throw new Error('Direct generation preview expired; prepare it again'); }
    if (prepared.preview.status !== 'prepared') {
      const error = new Error('Direct generation preview is already being consumed');
      error.code = 'GENERATION_PREVIEW_BUSY';
      throw error;
    }
    prepared.preview.status = 'consuming';
    let completed = false;
    try {
    const request = assertDirectExecutionPolicy(directGenerationRequest({
      ...prepared.frozenRuntimeRequest,
      positive: typeof edits.positive === 'string' ? edits.positive : prepared.request.positive,
      negative: typeof edits.negative === 'string' ? edits.negative : prepared.request.negative,
    }));
    assertSandboxMedia({ ...prepared.sandboxInput, ...request.media });
    const workflow = await this.executor.inspect(request.workflowName, this.workflowDir);
    const validation = validateDirectRequest(request, workflow);
    if (!validation.valid) {
      const error = new Error(validation.checks.filter(check => check.level === 'error').map(check => check.message).join('; '));
      error.failureType = 'preflight_failed'; error.retryable = false; error.preflight = validation;
      throw error;
    }

    this._running = true;
    const isCancelled = () => options.signal?.aborted || options.isCancelled?.() === true;
    const throwIfCancelled = () => {
      if (!isCancelled()) return;
      const error = Object.assign(new Error('Direct generation cancelled'), {
        code: 'GENERATION_CANCELLED',
        failureType: 'cancelled',
        retryable: false,
      });
      throw error;
    };
    const waitBeforeRetry = async delayMs => {
      throwIfCancelled();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        const abort = () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('Direct generation cancelled'), {
            code: 'GENERATION_CANCELLED',
            failureType: 'cancelled',
            retryable: false,
          }));
        };
        if (options.signal?.aborted) {
          abort();
          return;
        }
        options.signal?.addEventListener('abort', abort, { once: true });
      });
      throwIfCancelled();
    };
    try {
      const maxAttempts = request.executionPolicy.retry ? 2 : 1;
      let attempt = 0;
      let result;
      let lastError;
      while (attempt < maxAttempts) {
        throwIfCancelled();
        attempt++;
        try {
          result = await this.executor.execute(request, {
            workflowDir: this.workflowDir,
            clientId: options.clientId,
            sandboxInput: prepared.sandboxInput,
            onProgress: options.onProgress,
            signal: options.signal,
          });
          if (!result || typeof result !== 'object') {
            lastError = Object.assign(new Error('No images in output'), { failureType: 'empty_output', retryable: true });
          } else {
            result = normalizeGenerationResult(result);
            if (!result.media.length) {
              lastError = Object.assign(new Error('No media in output'), { failureType: 'empty_output', retryable: true, promptId: result.promptId || '' });
            } else if (request.executionPolicy.evaluate) {
              result.technicalEvaluation = evaluateTechnical(result);
              if (result.technicalEvaluation.passed) break;
              lastError = Object.assign(new Error(result.technicalEvaluation.detail), { failureType: 'empty_output', retryable: true });
            } else {
              break;
            }
          }
        } catch (error) {
          lastError = error;
        }

        throwIfCancelled();
        const failure = classifyFailure(lastError, { tool: 'comfyui' });
        if (lastError?.promptId || lastError?.failureType === 'observe_unknown' || lastError?.failureType === 'submit_unknown') {
          throw lastError;
        }
        if (!failure.retryable || attempt >= maxAttempts) throw lastError;
        await waitBeforeRetry(1000 * attempt);
        request.settings = { ...request.settings, seed: Math.floor(Math.random() * 0xFFFFFFFF) };
        options.onProgress?.({ stage: 'retrying', message: `直接生成重试 ${attempt}/${maxAttempts - 1}` });
      }
      if (!result) throw lastError || new Error('Direct generation produced no result');
      completed = true;
      return normalizeGenerationResult({
        ...result,
        requestId: request.requestId,
        taskId: request.requestId,
        projectId: request.projectId,
        sessionId: request.sessionId,
        source: 'direct',
        origin: request.origin,
        promptIssues: promptChecks(request),
        executionPolicy: request.executionPolicy,
        settings: { ...request.settings },
        parameters: { ...request.settings },
        attempt: attempt,
      });
    } finally {
      this._running = false;
      if (completed) this._previews.delete(previewId);
      else prepared.preview.status = 'prepared';
    }
     } catch (error) {
       if (error?.code === 'GENERATION_CANCELLED' || options.signal?.aborted) this._previews.delete(previewId);
       else prepared.preview.status = 'prepared';
       throw error;
    }
  }

  cancel() {
    return this.executor.cancel();
  }
}
