/**
 * The ComfyUI API-format workflow model.
 *
 * Two shapes exist and must not be confused:
 *
 *   UI format  — the editor's graph: { nodes: [...], links: [...], groups: [...] }
 *   API format — what POST /prompt accepts, a flat map:
 *                { "3": { class_type: "KSampler", inputs: { ... } } }
 *
 * We build, validate, and submit API format exclusively. A connected input is
 * `[upstream_node_id, output_slot]`; a literal input is a JSON scalar or array.
 *
 * Reference: docs/research/2026-landscape.md §8
 */

import { z } from 'zod';

/** `[upstream_node_id, slot_index]` — a link to another node's output. */
export const linkSchema = z.tuple([z.string(), z.number().int().min(0)]);
export type Link = z.infer<typeof linkSchema>;

export type InputValue = string | number | boolean | null | Link | InputValue[];

export const nodeSchema = z.object({
  class_type: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).default({}),
  /** Optional editor cosmetics; harmless to carry and useful in traces. */
  _meta: z.object({ title: z.string() }).partial().optional(),
});
export type WorkflowNode = z.infer<typeof nodeSchema>;

/** Node id -> node. ComfyUI ids are numeric strings, but the key is a string. */
export const apiWorkflowSchema = z.record(z.string().min(1), nodeSchema);
export type ApiWorkflow = z.infer<typeof apiWorkflowSchema>;

export function isLink(value: unknown): value is Link {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'number' &&
    Number.isInteger(value[1])
  );
}

/**
 * Index every node referenced by a link. Used by the validator to distinguish
 * "missing node" from "bad wiring".
 */
export function collectLinkTargets(inputs: Record<string, unknown>): Link[] {
  const links: Link[] = [];
  for (const value of Object.values(inputs)) {
    if (isLink(value)) links.push(value);
  }
  return links;
}
