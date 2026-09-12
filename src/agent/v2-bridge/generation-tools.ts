import { randomInt } from 'node:crypto';

import { z } from 'zod';

import { defineTool, type AnyToolDefinition } from '../core-loop/tools/types.ts';
import type { ToolResult } from '../core-loop/core/types.ts';
import type { JobManager } from '../core-loop/jobs.ts';
import type { ApprovalGate } from '../core-loop/guardrails/approval.ts';

/**
 * Generation tools for the v2 kernel (agent-v2-design.md §4, first slice).
 *
 * P3 — generate_image does NOT execute inline: it prepares a preview through
 * the legacy direct path, asks the gate once (P5 — the confirmation is this one
 * call, not a pipeline state), registers a background Job, and returns the job
 * id immediately so the turn keeps flowing. The host wires JobManager.onSettled
 * to append a task_notification into the thread.
 *
 * The heavy lifting (prompt compilation, workflow resolution, ComfyUI
 * execution, cancellation) stays in the injected runner — the legacy direct
 * service — so this file contains no ComfyUI code at all. That is the
 * copy-don't-share boundary in practice: adapt at the seam, do not fork the
 * execution chain.
 */

export interface GenerationPreview {
  previewId: string;
  /** Human/model-readable summary for the confirmation card. */
  summary: string;
  mode: string;
}

export interface GenerationRunResult {
  artifactIds: string[];
  summary: string;
  seed?: string;
}

/** Structural surface of the legacy DirectService the tools consume. */
export interface GenerationRunner {
  prepare(input: {
    prompt: string;
    negativePrompt?: string;
    workflowPath?: string;
  }): Promise<GenerationPreview>;
  run(
    previewId: string,
    edits: Record<string, unknown>,
    report: (progress: number) => void,
    signal: AbortSignal,
  ): Promise<GenerationRunResult>;
  cancel(previewId: string): void;
}

export interface GenerationToolDeps {
  jobs: JobManager;
  approvals: ApprovalGate;
  runner: GenerationRunner;
}

const denied = (action: string, reason?: string): ToolResult => ({
  ok: false,
  errorCode: 'APPROVAL_DENIED',
  content: {
    error: `The user declined ${action}.`,
    ...(reason ? { reason } : {}),
    hint: 'Do not retry this action. Briefly acknowledge and stop.',
  },
});

export function createGenerationTools(deps: GenerationToolDeps): readonly AnyToolDefinition[] {
  const generateImage = defineTool({
    name: 'generate_image',
    description:
      'Generate an image from a text prompt through the configured ComfyUI workflow. ' +
      'Returns a job_id immediately — generation runs in the background and the result ' +
      'is reported automatically when it finishes. A confirmation card with the compiled ' +
      'preview is shown to the user first; if they decline, do NOT retry. ' +
      'Keep prompts descriptive; the workflow handles technical parameters.',
    schema: z.object({
      prompt: z.string().min(1).describe('What the image should show. Be specific and concrete.'),
      negative_prompt: z
        .string()
        .optional()
        .describe('What to avoid in the image. Omit to use the workflow default.'),
      workflow_path: z
        .string()
        .optional()
        .describe('Absolute path to a .json workflow file. Omit to use the project default.'),
    }),
    // The tool runs its own single confirmation below; the registry's blanket
    // mutating-gate would ask twice for the same action.
    mutating: false,
    handler: async (input) => {
      let preview;
      try {
        preview = await deps.runner.prepare({
          prompt: input.prompt,
          ...(input.negative_prompt !== undefined ? { negativePrompt: input.negative_prompt } : {}),
          ...(input.workflow_path !== undefined ? { workflowPath: input.workflow_path } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          errorCode: 'PREPARE_FAILED',
          content: {
            error: `Could not prepare the generation: ${message}`,
            hint: 'Check that a valid workflow is selected, then correct and retry.',
          },
        };
      }

      const decision = await deps.approvals.request({
        action: 'generate_image',
        detail: preview.summary,
      });
      if (!decision.approved) return denied('generate_image', decision.reason);

      const job = deps.jobs.start({
        tool: 'generate_image',
        summary: input.prompt,
        run: async (report, signal) => {
          const result = await deps.runner.run(
            preview.previewId,
            {},
            (progress) => report(progress),
            signal,
          );
          return result.artifactIds;
        },
      });

      return {
        ok: true,
        content: {
          job_id: job.id,
          status: 'running',
          mode: preview.mode,
          note: 'Generation moved to a background job. The result is reported automatically; you may keep responding.',
        },
      };
    },
  });

  const reroll = defineTool({
    name: 'reroll',
    description:
      'Re-generate with the same prompt but a new random seed (the "reroll" button). ' +
      'Runs as a background job exactly like generate_image and requires the same ' +
      'one-time confirmation.',
    schema: z.object({
      prompt: z.string().min(1).describe('The same prompt as the generation being rerolled.'),
      workflow_path: z.string().optional().describe('Workflow to reroll against. Defaults to the project default.'),
    }),
    mutating: false,
    handler: async (input) => {
      let preview;
      try {
        preview = await deps.runner.prepare({
          prompt: input.prompt,
          ...(input.workflow_path !== undefined ? { workflowPath: input.workflow_path } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, errorCode: 'PREPARE_FAILED', content: { error: message } };
      }

      const decision = await deps.approvals.request({ action: 'reroll', detail: preview.summary });
      if (!decision.approved) return denied('reroll', decision.reason);

      const job = deps.jobs.start({
        tool: 'reroll',
        summary: `reroll: ${input.prompt}`,
        run: async (report, signal) => {
          const result = await deps.runner.run(
            preview.previewId,
            { seed: randomInt(0, 2 ** 31) },
            (progress) => report(progress),
            signal,
          );
          return result.artifactIds;
        },
      });
      return {
        ok: true,
        content: { job_id: job.id, status: 'running', note: 'Reroll running as a background job.' },
      };
    },
  });

  return [generateImage, reroll];
}
