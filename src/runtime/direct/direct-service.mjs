import { assertDirectExecutionPolicy, directGenerationRequest, normalizeGenerationResult } from '../generation-contract.mjs';
import { validateDirectRequest } from './direct-validator.mjs';
import { classifyFailure } from '../../agent/optimizer/retry-policy.mjs';
import { checkEditedPrompt } from '../../agent/optimizer/prompt-guard.mjs';
import { evaluateTechnical } from '../../agent/schemas/evaluation-schema.mjs';
import { assertSandboxMedia } from '../../agent/security/sandbox.mjs';

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
    preflight: validation,
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
    if (!mode || requested?.capabilities?.modes?.includes(mode)) return { workflowName: request.workflowName, manifest: requested };
    const candidates = (await this.executor.discover?.(this.workflowDir)) || [];
    const match = candidates.find(item => item.capabilities?.modes?.includes(mode));
    if (!match) return { workflowName: request.workflowName, manifest: requested };
    return { workflowName: match.name, manifest: await this.executor.inspect(match.name, this.workflowDir) };
  }

  async prepare(input, { sandboxInput = {} } = {}) {
    const request = assertDirectExecutionPolicy(directGenerationRequest(input));
    assertSandboxMedia({ ...sandboxInput, ...request.media });
    const resolved = await this._resolveWorkflow(request);
    const workflow = resolved.manifest;
    request.workflowName = resolved.workflowName;
    const validation = validateDirectRequest(request, workflow);
    const previewId = `direct_preview_${request.requestId}`;
    const preview = previewFor(request, workflow, validation, previewId);
    this._previews.set(previewId, { request, workflow, preview, sandboxInput });
    return preview;
  }


  getPreview(previewId) {
    return this._previews.get(previewId)?.preview || null;
  }

  discardPreview(previewId) {
    return { discarded: this._previews.delete(previewId) };
  }

  async run(previewId, edits = {}, options = {}) {
    const prepared = this._previews.get(previewId);
    if (!prepared) throw new Error('Direct generation preview expired; prepare it again');
    if (prepared.preview.status !== 'prepared') {
      const error = new Error('Direct generation preview is already being consumed');
      error.code = 'GENERATION_PREVIEW_BUSY';
      throw error;
    }
    prepared.preview.status = 'consuming';

    const request = assertDirectExecutionPolicy(directGenerationRequest({
      ...prepared.request,
      positive: typeof edits.positive === 'string' ? edits.positive : prepared.request.positive,
      negative: typeof edits.negative === 'string' ? edits.negative : prepared.request.negative,
    }));
    assertSandboxMedia({ ...prepared.sandboxInput, ...request.media });
    const workflow = await this.executor.inspect(request.workflowName, this.workflowDir);
    const validation = validateDirectRequest(request, workflow);
    if (!validation.valid) throw new Error(validation.checks.filter(check => check.level === 'error').map(check => check.message).join('; '));

    this._running = true;
    let completed = false;
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
              lastError = Object.assign(new Error('No media in output'), { failureType: 'empty_output', retryable: true });
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
      });
    } finally {
      this._running = false;
      if (completed) this._previews.delete(previewId);
      else prepared.preview.status = 'prepared';
    }
  }

  cancel() {
    return this.executor.cancel();
  }
}
