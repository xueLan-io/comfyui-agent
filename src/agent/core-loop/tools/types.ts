import type { z } from 'zod';

import type { ToolDescriptor, ToolResult } from '../core/types.ts';
import type { Logger } from '../observe/logger.ts';
import type { ComfyClient } from '../comfy/client.ts';
import type { NodeCatalogService } from '../comfy/catalog.ts';
import type { ExecutionOutcome, WaitOptions } from '../comfy/ws.ts';
import type { WorkflowStore } from '../comfy/workflowStore.ts';
import type { GuardrailPolicy } from '../guardrails/policy.ts';
import type { ApprovalGate } from '../guardrails/approval.ts';
import type { Scratchpad } from '../context/scratchpad.ts';
import type { RunEvent } from '../core/events.ts';
import type { ImageRef } from '../comfy/ws.ts';

/**
 * Concrete things a run produced, as opposed to what the model said about them.
 *
 * Tools write here and the loop reads it, so the final report is grounded in
 * recorded facts rather than parsed out of the model's prose.
 */
export interface RunArtifacts {
  /** Images the server produced for this run. */
  images: ImageRef[];
  /** Prompt ids this run submitted (or would have, in dry-run). */
  promptIds: string[];
  /** True once submit_workflow has run at all. */
  submitted: boolean;
  /** True when that submission was simulated. */
  simulated: boolean;
}

export function createRunArtifacts(): RunArtifacts {
  return { images: [], promptIds: [], submitted: false, simulated: false };
}

/**
 * The socket surface tools need.
 *
 * Structural, not the concrete ComfySocket class: the desktop demo mode and
 * tests substitute their own implementations, which TypeScript would otherwise
 * reject because ComfySocket has private fields.
 */
export interface ExecutionSocket {
  waitForResult(promptId: string, options?: WaitOptions): Promise<ExecutionOutcome>;
  close(): void;
}

/** Everything a tool handler is allowed to touch. Supplied by the composition root. */
export interface ToolContext {
  readonly comfy: ComfyClient;
  /** Lazily loaded node catalogue. Call `ensure()` before any lookup. */
  readonly catalog: NodeCatalogService;
  readonly socket: ExecutionSocket;
  /** Session state: built workflows and their recorded validation status. */
  readonly workflows: WorkflowStore;
  /** Concrete products of this run, recorded by tools rather than inferred. */
  readonly artifacts: RunArtifacts;
  /** Correlates this run's WebSocket events with its submissions. */
  readonly clientId: string;
  readonly policy: GuardrailPolicy;
  readonly approvals: ApprovalGate;
  readonly scratchpad: Scratchpad;
  readonly logger: Logger;
  /** Emit a short note that surfaces in the CLI and the trace. */
  readonly note: (text: string) => void;
  /** Non-fatal event sink, wired to the run event bus. */
  readonly emit: (event: RunEvent) => void;
}

/**
 * A tool, parameterised by the *input* its handler receives.
 *
 * Prefer `defineTool` below over annotating with this type directly: hand-writing
 * the input type duplicates the schema and drifts from it, and under
 * exactOptionalPropertyTypes it also has to spell out `| undefined` on every
 * optional field.
 */
export interface ToolDefinition<Input = unknown> {
  name: string;
  /**
   * Written like a docstring for a junior engineer — name every unit, format,
   * and constraint the model cannot infer (docs/research/2026-landscape.md §1).
   */
  description: string;
  schema: z.ZodType<Input, unknown>;
  /**
   * True if the tool can change ComfyUI state or consume resources. Mutating
   * tools go through the approval gate when dry-run is off, and their handlers
   * short-circuit to a simulated result when dry-run is on.
   */
  mutating: boolean;
  handler: (input: Input, ctx: ToolContext) => Promise<ToolResult>;
}

/**
 * Declare a tool with its input type inferred from the schema.
 *
 * This is what keeps the schema and the handler signature in agreement: change
 * the Zod schema and the handler's parameter type follows, with no second place
 * to update.
 */
export function defineTool<Schema extends z.ZodType>(definition: {
  name: string;
  description: string;
  schema: Schema;
  mutating: boolean;
  handler: (input: z.infer<Schema>, ctx: ToolContext) => Promise<ToolResult>;
}): ToolDefinition<z.infer<Schema>> {
  return definition as ToolDefinition<z.infer<Schema>>;
}

/**
 * The registry holds tools of unrelated input types, so its element type must
 * erase the input parameter. `any` is deliberate: `never` makes every real tool
 * unassignable, and `unknown` makes handlers expecting a specific shape
 * unassignable under contravariance.
 */
export type AnyToolDefinition = ToolDefinition<any>;

export type { ToolDescriptor, ToolResult };
