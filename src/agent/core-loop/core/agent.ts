import {
  buildSystemPrompt,
  createInitialMessages,
  toolResultMessage,
} from '../context/assembler.ts';
import { compact } from '../context/compactor.ts';
import { estimateContextTokens } from '../context/budget.ts';
import type { Note } from '../context/scratchpad.ts';
import type { ImageRef } from '../comfy/ws.ts';
import type { StoredWorkflow } from '../comfy/workflowStore.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ToolContext } from '../tools/types.ts';
import { makeEventBus, type RunEventListener, type RunStatus } from './events.ts';
import type { ChatMessage, ChatModel } from './types.ts';

/**
 * The agent loop.
 *
 * Deliberately hand-written and small (see ADR 0004). Everything the research
 * notes identify as load-bearing is enforced here, in code:
 *
 *   - the step budget, wall-clock deadline, and token ceiling are ours
 *   - results are compacted before re-entering context
 *   - a denied approval ends the run instead of being retried
 *   - every step is emitted as a typed event for the trace
 *
 * The loop is a reducer over messages: given state, produce the next state.
 * That is what makes a run inspectable and, later, resumable.
 */

export interface AgentConfig {
  maxSteps: number;
  timeoutMs: number;
  /** Estimated context size at which compaction kicks in. */
  compactionThresholdTokens?: number;
}

export interface AgentDeps {
  model: ChatModel;
  registry: ToolRegistry;
  toolContext: ToolContext;
  config: AgentConfig;
  listeners?: readonly RunEventListener[];
}

export interface RunRequest {
  input: string;
  runId: string;
  /** Node count for the system prompt's server-state section, when known. */
  nodeCount?: number;
  signal?: AbortSignal;
  /**
   * Prior conversation (projected from the session thread by the host). Placed
   * between the system prompt and the new user request; the loop treats it as
   * read-only context and never rewrites it.
   */
  history?: readonly ChatMessage[];
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  /** The model's closing text, or a synthesized explanation of why we stopped. */
  text: string;
  steps: number;
  durationMs: number;
  workflows: StoredWorkflow[];
  images: ImageRef[];
  promptIds: string[];
  notes: readonly Note[];
}

const DEFAULT_COMPACTION_THRESHOLD = 24_000;

export class Agent {
  private readonly emit: RunEventListener;
  private readonly deps: AgentDeps;

  constructor(deps: AgentDeps) {
    this.deps = deps;
    this.emit = makeEventBus(deps.listeners ?? []);
  }

  async run(request: RunRequest): Promise<RunResult> {
    const startedAt = Date.now();
    const deadline = startedAt + this.deps.config.timeoutMs;
    const { model, registry, toolContext, config } = this.deps;
    const tools = registry.descriptors();

    const systemPrompt = buildSystemPrompt({
      tools,
      dryRun: toolContext.policy.dryRun,
      ...(request.nodeCount !== undefined ? { nodeCount: request.nodeCount } : {}),
      scratchpad: toolContext.scratchpad.render(),
    });

    let messages: ChatMessage[] = createInitialMessages({
      systemPrompt,
      userInput: request.input,
      ...(request.history !== undefined ? { history: request.history } : {}),
    });

    this.emit({
      type: 'run_start',
      runId: request.runId,
      input: request.input,
      dryRun: toolContext.policy.dryRun,
      model: model.name,
    });

    let steps = 0;
    let status: RunStatus = 'max_steps';
    let finalText = '';

    const finish = (why: RunStatus, text: string): RunResult => {
      const durationMs = Date.now() - startedAt;
      this.emit({
        type: 'run_end',
        runId: request.runId,
        status: why,
        steps,
        durationMs,
        output: {
          images: toolContext.artifacts.images,
          promptIds: toolContext.artifacts.promptIds,
          workflows: toolContext.workflows.toJSON().map((w) => ({
            id: w.id,
            validated: w.validation?.valid ?? false,
          })),
        },
      });
      return {
        runId: request.runId,
        status: why,
        text,
        steps,
        durationMs,
        workflows: toolContext.workflows.toJSON(),
        images: toolContext.artifacts.images,
        promptIds: toolContext.artifacts.promptIds,
        notes: toolContext.scratchpad.all(),
      };
    };

    while (steps < config.maxSteps) {
      if (request.signal?.aborted) {
        return finish('failed', 'Run was cancelled.');
      }
      if (Date.now() > deadline) {
        this.emit({ type: 'error', message: `Wall-clock timeout after ${config.timeoutMs} ms.` });
        return finish('timeout', 'The run exceeded its time budget before finishing.');
      }

      const estimatedTokens = estimateContextTokens(messages, tools);
      steps += 1;
      this.emit({ type: 'step_start', step: steps, estimatedTokens });

      let decision;
      try {
        decision = await model.chat(messages, tools);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.emit({ type: 'error', step: steps, message, code: 'MODEL_FAILED' });
        return finish('failed', `The model call failed: ${message}`);
      }

      this.emit({
        type: 'model_decision',
        step: steps,
        text: decision.text,
        toolCalls: decision.toolCalls,
        ...(decision.usage !== undefined ? { usage: decision.usage } : {}),
      });

      // No tool calls means the model considers itself done.
      if (decision.toolCalls.length === 0) {
        finalText = decision.text.trim();
        status = toolContext.artifacts.submitted
          ? toolContext.artifacts.simulated
            ? 'dry_run'
            : 'completed'
          : 'completed';
        if (finalText.length === 0) {
          return finish('failed', 'The model stopped without producing a response.');
        }
        return finish(status, finalText);
      }

      messages.push({
        role: 'assistant',
        content: decision.text,
        toolCalls: decision.toolCalls,
      });

      // Executed in order rather than concurrently: a turn may contain several
      // build_workflow calls, and running those in parallel would make which one
      // "latest" depends on timing. Batching already saves the round trip, which
      // is the win we advertise to the model.
      let denied = false;
      for (const call of decision.toolCalls) {
        this.emit({ type: 'tool_call', step: steps, call });

        const toolStartedAt = Date.now();
        const result = await registry.dispatch(call, toolContext);
        const durationMs = Date.now() - toolStartedAt;

        this.emit({ type: 'tool_result', step: steps, name: call.name, result, durationMs });
        messages.push(toolResultMessage(call, result));

        if (result.errorCode === 'APPROVAL_DENIED') {
          denied = true;
          break;
        }
      }

      if (denied) {
        // A human said no. Retrying would be disrespectful and pointless.
        return finish('refused', 'Stopped: the requested action was not approved.');
      }

      const outcome = compact(messages, {
        thresholdTokens: config.compactionThresholdTokens ?? DEFAULT_COMPACTION_THRESHOLD,
      });
      if (outcome.compacted) {
        messages = outcome.messages;
        this.emit({
          type: 'compaction',
          step: steps,
          beforeTokens: outcome.beforeTokens,
          afterTokens: outcome.afterTokens,
          summarized: outcome.clearedMessages,
        });
      }

      if (steps >= config.maxSteps) break;
    }

    return finish(
      status,
      `Reached the ${config.maxSteps}-step limit before finishing. ${describeProgress(toolContext)}`,
    );
  }
}

function describeProgress(ctx: ToolContext): string {
  const workflows = ctx.workflows.toJSON();
  if (workflows.length === 0) return 'No workflow was built.';
  const latest = workflows[workflows.length - 1];
  if (!latest) return 'No workflow was built.';
  const validated = latest.validation?.valid ? 'validated' : 'not validated';
  return `The latest workflow (${latest.id}) is ${validated}.`;
}
