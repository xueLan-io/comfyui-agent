import { emit, AgentEventTypes } from '../events/agent-events.mjs';
import { validateToolInput } from '../schemas/tool-schema.mjs';
import { matchesExpectedOutput } from '../schemas/plan-schema.mjs';
import { classifyFailure } from '../optimizer/retry-policy.mjs';
import { ComfyExecutor } from '../../runtime/executor/comfy-executor.mjs';
import { createSandboxPolicy, SANDBOX_AUTHORIZED_FILES } from '../security/sandbox.mjs';
import { normalizeGenerationResult } from '../../runtime/generation-contract.mjs';

export class Executor {
  constructor(toolRegistry, llmProvider, sandbox) {
    this.tools = toolRegistry;
    this.llm = llmProvider;
    this.sandbox = sandbox || createSandboxPolicy();
    this._abort = false;
    this._controller = null;
    this._stepTimings = {};
    this.comfyExecutor = new ComfyExecutor(this.tools.comfyui);
  }

  cancel() {
    this._abort = true;
    this._controller?.abort('cancelled');
  }

  reset() {
    this._abort = false;
    this._controller = null;
  }

  get cancelled() {
    return this._abort;
  }

  async executeStep(step, context = {}) {
    if (this._abort) {
      emit(AgentEventTypes.STEP, {
        stepId: step.id,
        tool: step.tool,
        status: 'skipped',
        description: `${step.description} (cancelled)`,
      });
      return { skipped: true, reason: 'cancelled' };
    }

    const startTime = Date.now();
    const controller = new AbortController();
    this._controller = controller;
    const parentSignal = context.signal;
    const abortFromParent = () => controller.abort(parentSignal.reason || 'cancelled');
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort(parentSignal.reason || 'cancelled');
      else parentSignal.addEventListener('abort', abortFromParent, { once: true });
    }

    emit(AgentEventTypes.STEP, {
      stepId: step.id,
      tool: step.tool,
      skill: step.skill || '',
      status: 'running',
      description: step.description,
    });

    emit(AgentEventTypes.TOOL_CALL, {
      stepId: step.id,
      tool: step.tool,
      input: step.input,
    });

    try {
      const tool = this.tools[step.tool];
      if (!tool) throw new Error(`Unknown tool: "${step.tool}"`);

      const stepInput = step.input || {};
      const trustedWorkflowDir = Object.prototype.hasOwnProperty.call(context, 'workflowDir')
        ? context.workflowDir
        : stepInput.workflowDir;
      const enrichedInput = {
        ...stepInput,
        workflowDir: trustedWorkflowDir,
        llmProvider: stepInput.llmProvider !== false ? this.llm : undefined,
        signal: controller.signal,
      };

      if (step.tool === 'filesystem') {
        enrichedInput.root = stepInput.root || 'workflow';
        enrichedInput.relativePath = stepInput.relativePath || '';
      }
      if (step.tool === 'filesystem_mutate' && context.confirmedFileMutation) {
        enrichedInput.execute = true;
      }

      if (context.filesystemRoots) enrichedInput.allowedRoots = context.filesystemRoots;
      if (context.comfyRoot) enrichedInput.comfyRoot = context.comfyRoot;
      if (context.attachedMedia) {
        enrichedInput[SANDBOX_AUTHORIZED_FILES] = ['images', 'masks', 'videos']
          .flatMap(kind => context.attachedMedia[kind] || [])
          .map(item => typeof item === 'string' ? item : item?.path)
          .filter(Boolean);
      }
      enrichedInput.sandboxInput = {
        workflowDir: trustedWorkflowDir,
        allowedRoots: context.filesystemRoots,
        comfyRoot: context.comfyRoot,
        [SANDBOX_AUTHORIZED_FILES]: enrichedInput[SANDBOX_AUTHORIZED_FILES] || [],
      };

      if (step.tool === 'comfyui') {
        if (stepInput.frozenRuntimeRequest) {
          const frozen = structuredClone(stepInput.frozenRuntimeRequest);
          enrichedInput.workflowName = frozen.workflow?.name || stepInput.workflowName;
          enrichedInput.prompt = frozen.prompt?.positive || '';
          enrichedInput.prompts = frozen.prompt?.positivePrompts || [];
          enrichedInput.negativePrompt = frozen.prompt?.negative || '';
          enrichedInput.settings = frozen.settings || {};
          enrichedInput.nodeOverrides = frozen.nodeOverrides || {};
          enrichedInput.images = frozen.media?.images || [];
          enrichedInput.masks = frozen.media?.masks || [];
          enrichedInput.videos = frozen.media?.videos || [];
          enrichedInput.outputNodeIds = frozen.outputNodeIds || [];
          enrichedInput.frozenRuntimeRequest = frozen;
        } else {
        const prompt = context.compiledPrompt?.positive || context.enhancedPrompt || stepInput.prompt || context.userRequest || '';
        enrichedInput.workflowName = stepInput.workflowName
          || context.project?.currentWorkflow
          || context.availableWorkflows?.[0]
          || '';
        enrichedInput.prompt = prompt;
        enrichedInput.compiledPrompt = context.compiledPrompt || stepInput.compiledPrompt;
        if (!Array.isArray(stepInput.prompts) || stepInput.prompts.length === 0) {
          enrichedInput.prompts = prompt ? [prompt] : [];
        }
        enrichedInput.onProgress = context.onProgress;
        enrichedInput.onPromptQueued = context.onPromptQueued;
        enrichedInput.clientId = context.clientId;
        enrichedInput.settings = {
          ...(stepInput.settings || {}),
          ...(context.executionSettings || {}),
        };
        const plannedNodeOverrides = stepInput.nodeOverrides || {};
        const manualNodeOverrides = context.nodeOverrides || {};
        enrichedInput.nodeOverrides = { ...plannedNodeOverrides };
        for (const [nodeId, inputs] of Object.entries(manualNodeOverrides)) {
          enrichedInput.nodeOverrides[nodeId] = {
            ...(plannedNodeOverrides[nodeId] || {}),
            ...inputs,
          };
        }
        enrichedInput.outputNodeIds = context.outputNodeIds
          || stepInput.outputNodeIds
          || undefined;
        }
      }
      if (step.tool === 'prompt_enhance' && context.characterResearch && !enrichedInput.referenceContext) {
        enrichedInput.referenceContext = context.characterResearch;
      }

      const inputValidation = validateToolInput(tool, enrichedInput);
      if (!inputValidation.valid) {
        throw new Error(`Invalid tool input: ${inputValidation.errors.join(', ')}`);
      }
      this.sandbox.assertToolCall(step.tool, enrichedInput);

      let result = step.tool === 'comfyui'
        ? await this.comfyExecutor.executeToolInput(enrichedInput, {
          workflowDir: trustedWorkflowDir,
          sandboxInput: enrichedInput.sandboxInput,
          onProgress: context.onProgress,
        })
        : await tool.execute(enrichedInput);
      if (step.tool === 'comfyui') result = normalizeGenerationResult(result);
      const duration = Date.now() - startTime;
      this._stepTimings[step.id] = duration;

      if (result?.error) {
        const failure = classifyFailure(result.error, { tool: step.tool, action: stepInput.action });
        emit(AgentEventTypes.TOOL_RESULT, {
          stepId: step.id,
          tool: step.tool,
          success: false,
          error: result.error,
          failure,
          duration_ms: duration,
        });
        emit(AgentEventTypes.STEP, {
          stepId: step.id,
          tool: step.tool,
          skill: step.skill || '',
          status: 'error',
          description: step.description,
          error: result.error,
          duration_ms: duration,
        });
        return { error: result.error, failure, duration_ms: duration };
      }

      if (!matchesExpectedOutput(step, result, tool)) {
        const error = `Unexpected output for step "${step.id}": expected ${step.expected_output}`;
        const failure = { type: 'output_mismatch', retryable: false, replan: true, reason: error };
        emit(AgentEventTypes.TOOL_RESULT, {
          stepId: step.id,
          tool: step.tool,
          success: false,
          error,
          failure,
          duration_ms: duration,
        });
        emit(AgentEventTypes.STEP, {
          stepId: step.id,
          tool: step.tool,
          skill: step.skill || '',
          status: 'error',
          description: step.description,
          error,
          duration_ms: duration,
        });
        return { error, failure, duration_ms: duration };
      }

      if (step.tool === 'filesystem' && result.files) {
        context.availableWorkflows = result.files.map(f => f.name);
      }
      if (step.tool === 'prompt_enhance' && result.enhanced) {
        context.enhancedPrompt = result.enhanced;
        context.compiledPrompt = result;
      }
      if (step.tool === 'comfyui') {
        context.lastMedia = result.media || [];
        context.lastImages = result.images || [];
        context.lastVideos = result.videos || [];
        context.lastPromptId = result.promptId;
      }
      if (step.tool === 'web' && !result.error) {
        context.characterResearch = result;
      }

      emit(AgentEventTypes.TOOL_RESULT, {
        stepId: step.id,
        tool: step.tool,
        result,
        success: true,
        duration_ms: duration,
      });

      emit(AgentEventTypes.STEP, {
        stepId: step.id,
        tool: step.tool,
        skill: step.skill || '',
        status: 'completed',
        description: step.description,
        duration_ms: duration,
      });

      return { result, context, duration_ms: duration };

    } catch (error) {
      const duration = Date.now() - startTime;

      if (this._abort || controller.signal.aborted || error.name === 'AbortError') {
        emit(AgentEventTypes.STEP, {
          stepId: step.id,
          tool: step.tool,
          status: 'skipped',
          description: `${step.description} (cancelled)`,
          duration_ms: duration,
        });
        return { skipped: true, reason: 'cancelled', duration_ms: duration };
      }

      const failure = classifyFailure(error, { tool: step.tool, action: step.input?.action });
      emit(AgentEventTypes.TOOL_RESULT, {
        stepId: step.id,
        tool: step.tool,
        success: false,
        error: error.message,
        failure,
        duration_ms: duration,
      });

      emit(AgentEventTypes.STEP, {
        stepId: step.id,
        tool: step.tool,
        skill: step.skill || '',
        status: 'error',
        description: step.description,
        error: error.message,
        failureType: failure.type,
        duration_ms: duration,
      });

      return { error: error.message, failure, duration_ms: duration };
    } finally {
      parentSignal?.removeEventListener('abort', abortFromParent);
      if (this._controller === controller) this._controller = null;
    }
  }
}
