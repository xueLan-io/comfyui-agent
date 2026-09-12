/**
 * Typed run events. The loop emits these; the CLI renders them and the tracer
 * persists them. Keeping them typed (rather than free-form log strings) is what
 * makes a run reconstructable after the fact.
 */

import type { TokenUsage, ToolCall, ToolResult } from './types.ts';

export type RunEvent =
  | { type: 'run_start'; runId: string; input: string; dryRun: boolean; model: string }
  | { type: 'step_start'; step: number; estimatedTokens: number }
  | { type: 'model_decision'; step: number; text: string; toolCalls: readonly ToolCall[]; usage?: TokenUsage }
  | { type: 'tool_call'; step: number; call: ToolCall }
  | { type: 'tool_result'; step: number; name: string; result: ToolResult; durationMs: number }
  | { type: 'compaction'; step: number; beforeTokens: number; afterTokens: number; summarized: number }
  | { type: 'note'; step: number; text: string }
  | { type: 'run_end'; runId: string; status: RunStatus; steps: number; durationMs: number; output?: unknown }
  | { type: 'error'; step?: number; message: string; code?: string };

export type RunStatus = 'completed' | 'dry_run' | 'max_steps' | 'timeout' | 'failed' | 'refused';

export type RunEventListener = (event: RunEvent) => void;

/** Fan-out helper so CLI, tracer, and tests can each observe independently. */
export function makeEventBus(listeners: readonly RunEventListener[]): RunEventListener {
  return (event) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // An observer must never break the run.
      }
    }
  };
}
