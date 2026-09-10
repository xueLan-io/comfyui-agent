import { emit, AgentEventTypes } from '../events/agent-events.ts';
import { validateToolInput } from '../schemas/tool-schema.ts';
import { matchesExpectedOutput } from '../schemas/plan-schema.ts';
import { classifyFailure } from '../optimizer/retry-policy.mjs';
import { ComfyExecutor } from '../../runtime/executor/comfy-executor.mjs';
import { createSandboxPolicy, SandboxViolation, SANDBOX_AUTHORIZED_FILES } from '../security/sandbox.mjs';
import { normalizeGenerationResult } from '../../runtime/generation-contract.ts';
import type { ToolDefinition } from '../schemas/tool-schema.ts';
import type { PlanStep } from '../schemas/plan-schema.ts';
import type { LLMProvider } from '../llm/provider.ts';

export interface StepFailure {
  type: string;
  retryable: boolean;
  replan?: boolean;
  reason?: string;
  [key: string]: unknown;
}

export interface StepExecutionResult {
  skipped?: boolean;
  reason?: string;
  error?: string;
  failure?: StepFailure;
  result?: any;
  context?: Record<string, any>;
  duration_ms?: number;
}

export class Executor {
  tools: Record<string, any>;
  llm: LLMProvider;
  sandbox: any;
  comfyExecutor: ComfyExecutor;
  private _abort = false;
  private _controller: AbortController | null = null;
  private _stepTimings: Record<string, number> = {};
  // Run-scoped abort: fires on cancel() for EVERY await of the current run
  // (including retry backoff sleeps between steps), not just the active
  // step controller. reset() re-arms it at the start of each run.
  private _runAbort: AbortController;

  constructor(toolRegistry: Record<string, any>, llmProvider: LLMProvider, sandbox?: any) {
    this.tools = toolRegistry;
    this.llm = llmProvider;
    this.sandbox = sandbox || createSandboxPolicy();
    this._runAbort = new AbortController();
    this.comfyExecutor = new ComfyExecutor(this.tools.comfyui);
  }

  cancel(): void {
    this._abort = true;
    this._runAbort.abort('cancelled');
    this._controller?.abort('cancelled');
  }

  reset(): void {
    this._abort = false;
    this._controller = null;
    this._runAbort = new AbortController();
  }

  get cancelled(): boolean {
    return this._abort;
  }

  get runSignal(): AbortSignal {
    return this._runAbort.signal;
  }

  async executeStep(step: PlanStep, context: Record<string, any> = {}): Promise<StepExecutionResult> {
    // Task and trace ownership originates in Agent and must follow every step event.
    const eventMeta: Record<string, any> = {
      ...(context.eventMeta || {}),
      attemptId: context.attemptId || '',
      attempt: context.currentAttempt || 0,
    };
    if (this._abort) {
      emit(AgentEventTypes.STEP, {
        ...eventMeta,
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
    const parentSignal: AbortSignal | undefined = context.signal;
    const abortFromParent = () => controller.abort(parentSignal!.reason || 'cancelled');
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort(parentSignal.reason || 'cancelled');
      else parentSignal.addEventListener('abort', abortFromParent, { once: true });
    }

    emit(AgentEventTypes.STEP, {
      ...eventMeta,
      stepId: step.id,
      tool: step.tool,
      skill: step.skill || '',
      status: 'running',
      description: step.description,
    });

    emit(AgentEventTypes.TOOL_CALL, {
      ...eventMeta,
      stepId: step.id,
      tool: step.tool,
      input: step.input,
    });

    try {
      const tool = this.tools[step.tool];
      if (!tool) throw new Error(`Unknown tool: "${step.tool}"`);

      const stepInput = step.input || {};
      const SANDBOXED_TOOLS = new Set(['filesystem', 'filesystem_mutate', 'comfyui', 'inspect_image']);
      const trustedWorkflowDir = Object.prototype.hasOwnProperty.call(context, 'workflowDir')
        ? context.workflowDir
        : (() => {
            // Fail closed: for sandboxed file-access tools the workflow root
            // must come from the trusted runtime context, never from LLM input.
            if (SANDBOXED_TOOLS.has(step.tool)) throw new SandboxViolation('Sandbox root (workflowDir) is missing from the execution context');
            return stepInput.workflowDir;
          })();
      const enrichedInput: Record<PropertyKey, any> = {
        ...stepInput,
        workflowDir: trustedWorkflowDir,
        llmProvider: stepInput.llmProvider !== false ? this.llm : undefined,
        signal: controller.signal,
      };

      if (step.tool === 'filesystem') {
        enrichedInput.root = stepInput.root || 'workflow';
        enrichedInput.relativePath = stepInput.relativePath || '';
      }
      if (step.tool === 'filesystem_mutate') {
        // Fail closed: the mutation-execute flag is only honored after the
        // runtime confirmed the mutation; an LLM-written execute:true is
        // otherwise forced to preview mode.
        enrichedInput.execute = context.confirmedFileMutation === true;
      }

      // Sandboxed tools always receive their roots from the trusted runtime
      // context — LLM-supplied roots are discarded, never merged.
      if (SANDBOXED_TOOLS.has(step.tool)) {
        enrichedInput.allowedRoots = context.filesystemRoots || [];
        enrichedInput.comfyRoot = context.comfyRoot || '';
      }
      if (context.attachedMedia) {
        enrichedInput[SANDBOX_AUTHORIZED_FILES] = ['images', 'masks', 'videos']
          .flatMap(kind => context.attachedMedia[kind] || [])
          .map((item: any) => typeof item === 'string' ? item : item?.path)
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
            ...((plannedNodeOverrides[nodeId] || {}) as Record<string, any>),
            ...(inputs as Record<string, any>),
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

      let result: any = step.tool === 'comfyui'
        ? await this.comfyExecutor.executeToolInput(enrichedInput, {
          workflowDir: trustedWorkflowDir,
          sandboxInput: enrichedInput.sandboxInput,
          onProgress: context.onProgress,
          // The comfy path must receive the step controller, not the raw
          // parent signal: ComfyExecutor.executeToolInput spreads options over
          // the input, so context.signal (possibly undefined) would discard
          // the controller and break executor.cancel() for comfy steps.
          signal: controller.signal,
        } as any)
        : await tool.execute!(enrichedInput);
      if (step.tool === 'comfyui') result = normalizeGenerationResult(result);
      const duration = Date.now() - startTime;
      this._stepTimings[step.id] = duration;

      if (result?.error) {
        const failure = classifyFailure(result.error, { tool: step.tool, action: stepInput.action });
        emit(AgentEventTypes.TOOL_RESULT, {
          ...eventMeta,
          stepId: step.id,
          tool: step.tool,
          success: false,
          error: result.error,
          failure,
          duration_ms: duration,
        });
        emit(AgentEventTypes.STEP, {
          ...eventMeta,
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
        const failure: StepFailure = { type: 'output_mismatch', retryable: false, replan: true, reason: error };
        emit(AgentEventTypes.TOOL_RESULT, {
          ...eventMeta,
          stepId: step.id,
          tool: step.tool,
          success: false,
          error,
          failure,
          duration_ms: duration,
        });
        emit(AgentEventTypes.STEP, {
          ...eventMeta,
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
        context.availableWorkflows = result.files.map((f: any) => f.name);
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
        ...eventMeta,
        stepId: step.id,
        tool: step.tool,
        result,
        success: true,
        duration_ms: duration,
      });

      emit(AgentEventTypes.STEP, {
        ...eventMeta,
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
      const err = error as Error;

      if (this._abort || controller.signal.aborted || err.name === 'AbortError') {
        emit(AgentEventTypes.STEP, {
          ...eventMeta,
          stepId: step.id,
          tool: step.tool,
          status: 'skipped',
          description: `${step.description} (cancelled)`,
          duration_ms: duration,
        });
        return { skipped: true, reason: 'cancelled', duration_ms: duration };
      }

      const failure = classifyFailure(err, { tool: step.tool, action: step.input?.action });
      emit(AgentEventTypes.TOOL_RESULT, {
        ...eventMeta,
        stepId: step.id,
        tool: step.tool,
        success: false,
        error: err.message,
        failure,
        duration_ms: duration,
      });

      emit(AgentEventTypes.STEP, {
        ...eventMeta,
        stepId: step.id,
        tool: step.tool,
        skill: step.skill || '',
        status: 'error',
        description: step.description,
        error: err.message,
        failureType: failure.type,
        duration_ms: duration,
      });

      return { error: err.message, failure, duration_ms: duration };
    } finally {
      parentSignal?.removeEventListener('abort', abortFromParent);
      if (this._controller === controller) this._controller = null;
    }
  }
}
