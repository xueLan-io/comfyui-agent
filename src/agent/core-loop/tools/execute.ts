import { z } from 'zod';

import { ComfyError, compactPromptRejection, toCompactError } from '../comfy/errors.ts';
import { extractImages, type ExecutionOutcome } from '../comfy/ws.ts';
import { defineTool, type ToolContext } from './types.ts';

/**
 * Submission and execution.
 *
 * `submit_workflow` is the only tool that can consume GPU time, and it is the
 * one the safety story rests on. Its guard is structural, not advisory:
 *
 *   - the workflow must have a recorded *passing* validation (WorkflowStore)
 *   - under dry-run the handler returns a simulated result without contacting
 *     the server at all
 *   - otherwise the registry has already required human approval (it is marked
 *     `mutating`), so reaching the body means someone said yes
 *
 * Nothing here is inferred from the model's prose; each fact is recorded in
 * `ctx.artifacts` so the final report is grounded.
 */

export const submitWorkflow = defineTool({
  name: 'submit_workflow',
  description:
    'Submit a validated workflow to ComfyUI for execution. Refuses unless ' +
    'validate_workflow has passed for that workflow — this is enforced, so validate first.\n\n' +
    'Returns a prompt_id used to track the job. By default it then waits for the result ' +
    '(equivalent to calling wait_for_result), which is usually what you want; pass ' +
    'wait=false to return immediately after queuing.\n\n' +
    'In dry-run mode nothing is queued and the returned prompt_id is simulated. Report ' +
    'that accurately: do not claim an image was produced.',
  schema: z.object({
    workflow_id: z
      .string()
      .optional()
      .describe('Id from build_workflow. Defaults to the most recently built workflow.'),
    wait: z
      .boolean()
      .optional()
      .describe('Wait for execution to finish and return the result. Defaults to true.'),
    timeout_ms: z
      .number()
      .int()
      .min(1000)
      .max(3_600_000)
      .optional()
      .describe('How long to wait for execution, in milliseconds. Defaults to 300000.'),
  }),
  mutating: true,
  handler: async (input, ctx) => {
    // --- The gate. Enforced here, not requested in the prompt. --------------
    const readiness = ctx.workflows.isSubmittable(input.workflow_id);
    if (!readiness.ok) {
      return {
        ok: false,
        errorCode: 'NOT_VALIDATED',
        content: {
          error: readiness.reason,
          ...(readiness.hint ? { hint: readiness.hint } : {}),
        },
      };
    }

    const stored = ctx.workflows.resolve(input.workflow_id);
    if (!stored) {
      // isSubmittable already proved this cannot happen; kept for type narrowing.
      return { ok: false, errorCode: 'NO_WORKFLOW', content: { error: 'Workflow vanished.' } };
    }

    // --- Dry-run: simulate, touch nothing. ----------------------------------
    if (ctx.policy.dryRun) {
      const simulatedId = `dryrun_${stored.id}`;
      ctx.artifacts.submitted = true;
      ctx.artifacts.simulated = true;
      ctx.artifacts.promptIds.push(simulatedId);
      ctx.note(`Dry-run: simulated submission of ${stored.id}.`);
      return {
        ok: true,
        content: {
          simulated: true,
          prompt_id: simulatedId,
          workflow_id: stored.id,
          node_count: Object.keys(stored.workflow).length,
          note: 'Dry-run is enabled, so nothing was queued and no image was produced. The workflow is validated and ready to run with AGENT_DRY_RUN=false.',
        },
      };
    }

    // --- Real submission. ---------------------------------------------------
    try {
      const submission = await ctx.comfy.submitPrompt(stored.workflow, ctx.clientId);
      ctx.artifacts.submitted = true;
      ctx.artifacts.promptIds.push(submission.prompt_id);
      ctx.note(`Submitted ${stored.id} as prompt ${submission.prompt_id}.`);

      const base = {
        prompt_id: submission.prompt_id,
        workflow_id: stored.id,
        ...(submission.number !== undefined ? { queue_number: submission.number } : {}),
      };

      if (input.wait === false) {
        return {
          ok: true,
          content: { ...base, next_step: `Call wait_for_result with prompt_id "${submission.prompt_id}".` },
        };
      }

      const outcome = await ctx.socket.waitForResult(submission.prompt_id, {
        ...(input.timeout_ms !== undefined ? { timeoutMs: input.timeout_ms } : {}),
      });
      return await collectOutcome(outcome, base, ctx);
    } catch (error) {
      return handleSubmitError(error);
    }
  },
});

export const waitForResult = defineTool({
  name: 'wait_for_result',
  description:
    'Wait for a previously submitted prompt to reach a terminal state and return its ' +
    'outputs. Resolves on success, execution error, or interruption, and times out rather ' +
    'than hanging. Use this when submit_workflow was called with wait=false, or to resume ' +
    'tracking a job. Returns image filenames on success, or a structured error describing ' +
    'which node failed and why.',
  schema: z.object({
    prompt_id: z
      .string()
      .min(1)
      .optional()
      .describe('Prompt id from submit_workflow. Defaults to the most recently submitted one.'),
    timeout_ms: z
      .number()
      .int()
      .min(1000)
      .max(3_600_000)
      .optional()
      .describe('How long to wait, in milliseconds. Defaults to 300000.'),
  }),
  mutating: false,
  handler: async (input, ctx) => {
    const promptId = input.prompt_id ?? ctx.artifacts.promptIds[ctx.artifacts.promptIds.length - 1];

    if (!promptId) {
      return {
        ok: false,
        errorCode: 'NO_PROMPT_ID',
        content: {
          error: 'No prompt id was given and nothing has been submitted in this run.',
          hint: 'Call submit_workflow first, or pass an explicit prompt_id.',
        },
      };
    }

    if (ctx.policy.dryRun || promptId.startsWith('dryrun_')) {
      return {
        ok: true,
        content: {
          simulated: true,
          prompt_id: promptId,
          status: 'simulated',
          note: 'Dry-run is enabled; no execution occurred and no image exists. The workflow is validated and ready to run for real.',
        },
      };
    }

    try {
      const outcome = await ctx.socket.waitForResult(promptId, {
        ...(input.timeout_ms !== undefined ? { timeoutMs: input.timeout_ms } : {}),
      });
      return await collectOutcome(outcome, { prompt_id: promptId }, ctx);
    } catch (error) {
      return handleSubmitError(error);
    }
  },
});

export const interrupt = defineTool({
  name: 'interrupt',
  description:
    'Stop the currently executing workflow on the ComfyUI server. Use this as an escape ' +
    'hatch if a job is taking far too long or is clearly wrong. Queued jobs are unaffected ' +
    '— this interrupts the active execution only.',
  schema: z.object({}),
  mutating: true,
  handler: async (_input, ctx) => {
    if (ctx.policy.dryRun) {
      return {
        ok: true,
        content: { simulated: true, note: 'Dry-run is enabled; no interrupt was sent.' },
      };
    }
    try {
      await ctx.comfy.interrupt();
      ctx.note('Sent interrupt to ComfyUI.');
      return { ok: true, content: { interrupted: true } };
    } catch (error) {
      const compact = toCompactError(error, 'INTERRUPT_FAILED');
      return { ok: false, errorCode: compact.code, content: compact };
    }
  },
});

export const getOutput = defineTool({
  name: 'get_output',
  description:
    'Return the output images produced by a prompt, with their filenames and the local ' +
    'view URLs. Use this to report exactly what was generated after a successful ' +
    'wait_for_result.',
  schema: z.object({
    prompt_id: z
      .string()
      .min(1)
      .optional()
      .describe('Prompt id. Defaults to the most recently submitted prompt in this run.'),
  }),
  mutating: false,
  handler: async (input, ctx) => {
    const promptId = input.prompt_id ?? ctx.artifacts.promptIds[ctx.artifacts.promptIds.length - 1];
    if (!promptId) {
      return {
        ok: false,
        errorCode: 'NO_PROMPT_ID',
        content: { error: 'No prompt id available. Submit a workflow first.' },
      };
    }

    try {
      const history = await ctx.comfy.getHistory(promptId);
      const entry = history[promptId];
      if (!entry) {
        return {
          ok: false,
          errorCode: 'NOT_IN_HISTORY',
          content: {
            error: `Prompt ${promptId} is not in the server history yet.`,
            hint: 'It may still be running. Call wait_for_result.',
          },
        };
      }
      const images = extractImages((entry.outputs ?? {}) as Record<string, unknown>);
      return {
        ok: true,
        content: {
          prompt_id: promptId,
          status: entry.status?.status_str ?? 'unknown',
          images: images.map((image) => ({
            filename: image.filename,
            subfolder: image.subfolder,
            node: image.node,
            url: ctx.comfy.viewUrl({
              filename: image.filename,
              subfolder: image.subfolder,
              type: image.type,
            }),
          })),
        },
      };
    } catch (error) {
      const compact = toCompactError(error, 'OUTPUT_LOOKUP_FAILED');
      return { ok: false, errorCode: compact.code, content: compact };
    }
  },
});

/** Shared post-execution handling for submit and wait. */
async function collectOutcome(
  outcome: ExecutionOutcome,
  base: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ ok: boolean; errorCode?: string; content: unknown }> {
  if (outcome.status === 'error') {
    ctx.note(`Execution of ${outcome.promptId} failed.`);
    return {
      ok: false,
      errorCode: 'EXECUTION_ERROR',
      content: {
        ...base,
        status: 'error',
        error: outcome.error,
      },
    };
  }

  if (outcome.status === 'interrupted') {
    return {
      ok: false,
      errorCode: 'EXECUTION_INTERRUPTED',
      content: { ...base, status: 'interrupted', error: outcome.error },
    };
  }

  const images = extractImages(outcome.outputs);
  // A run may wait on the same prompt twice (submit with wait=true, then an
  // explicit wait_for_result); record each image once.
  const fresh = images.filter(
    (image) =>
      !ctx.artifacts.images.some(
        (existing) =>
          existing.filename === image.filename && existing.subfolder === image.subfolder,
      ),
  );
  for (const image of fresh) ctx.artifacts.images.push(image);

  ctx.note(
    images.length > 0
      ? `Prompt ${outcome.promptId} produced ${images.length} image(s).`
      : `Prompt ${outcome.promptId} finished with no images.`,
  );

  return {
    ok: true,
    content: {
      ...base,
      status: 'success',
      duration_ms: outcome.durationMs,
      cached_nodes: outcome.cachedNodes,
      images: images.map((image) => ({
        filename: image.filename,
        subfolder: image.subfolder,
        node: image.node,
        url: ctx.comfy.viewUrl({
          filename: image.filename,
          subfolder: image.subfolder,
          type: image.type,
        }),
      })),
      ...(images.length === 0
        ? { note: 'Execution succeeded but returned no images. The workflow may end in a node that produces no image output.' }
        : {}),
    },
  };
}

/** Turn submission failures into a compact, actionable result. */
function handleSubmitError(error: unknown): { ok: boolean; errorCode: string; content: unknown } {
  const payload = (error as { payload?: unknown }).payload;

  if (payload && typeof payload === 'object') {
    const compact = compactPromptRejection(
      payload as Parameters<typeof compactPromptRejection>[0],
    );
    return { ok: false, errorCode: compact.code, content: compact };
  }

  const compact = toCompactError(error, error instanceof ComfyError ? error.code : 'SUBMIT_FAILED');
  return { ok: false, errorCode: compact.code, content: compact };
}
