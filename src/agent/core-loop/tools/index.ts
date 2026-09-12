import { ToolRegistry } from './registry.ts';
import { getNodeSchema, listModels, searchNodeTypes } from './discovery.ts';
import { buildWorkflow, getWorkflow, validateWorkflowTool } from './build.ts';
import { getOutput, interrupt, submitWorkflow, waitForResult } from './execute.ts';
import { getQueue, serverStatus } from './status.ts';
import type { AnyToolDefinition } from './types.ts';

/**
 * The canonical tool set.
 *
 * Order in this array becomes the order of `tools/list` and the model's tool
 * list, which is why it is grouped by phase (orient → discover → assemble →
 * execute) rather than alphabetized: a deterministic order that mirrors the
 * intended workflow is easier to read in a trace, and it is still stable across
 * runs, which is what prompt caching needs (docs/research/2026-landscape.md §4).
 *
 * Ten tools is already at the upper end of "few, non-overlapping" — the research
 * notes are explicit that tool schemas sit in context on every call. New
 * capability should extend an existing tool before adding another.
 */
export const ALL_TOOLS: readonly AnyToolDefinition[] = [
  // orient
  serverStatus,
  getQueue,
  // discover
  searchNodeTypes,
  getNodeSchema,
  listModels,
  // assemble
  buildWorkflow,
  getWorkflow,
  validateWorkflowTool,
  // execute
  submitWorkflow,
  waitForResult,
  getOutput,
  interrupt,
] as const;

export function createToolRegistry(
  definitions: readonly AnyToolDefinition[] = ALL_TOOLS,
): ToolRegistry {
  return new ToolRegistry(definitions);
}

export { ToolRegistry };
