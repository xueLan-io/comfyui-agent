import { z } from 'zod';

import { formatValidationResult, validateWorkflow } from '../comfy/validator.ts';
import type { ApiWorkflow } from '../comfy/workflow.ts';
import { defineTool } from './types.ts';

/**
 * Workflow assembly and the validation gate.
 *
 * The input is declarative — a list of nodes — rather than a raw API-format
 * object. That is deliberate: it constrains what the model must produce to the
 * part it is actually good at (choosing nodes and wiring slots), and it lets us
 * reject a malformed shape with a precise error instead of a subtle mis-wire.
 */

/** Matches a link: a two-element [node_id, slot] pair. */
const linkSchema = z.tuple([z.string(), z.number().int().min(0)]);

const inputValueSchema = z.union([z.string(), z.number(), z.boolean(), linkSchema, z.null()]);

const nodeInputSchema: z.ZodType<Record<string, unknown>> = z.record(
  z.string(),
  z.union([inputValueSchema, z.array(inputValueSchema)]),
);

export const buildWorkflow = defineTool({
  name: 'build_workflow',
  description:
    'Assemble a ComfyUI workflow in API format from a declarative node list, register it, ' +
    'and return a short workflow_id. Each node needs an "id" (a string like "1"), a ' +
    '"class_type" (exactly as the server reports it), and "inputs".\n\n' +
    'Input values are either literals (string/number/boolean) or a LINK written as a ' +
    'two-element array [upstream_node_id, output_slot_index] — for example ' +
    '["1", 0] means the first output of node "1". Slot indexes are 0-based and follow the ' +
    'output order returned by get_node_schema.\n\n' +
    'This returns an id, not the whole workflow: pass that id to validate_workflow and ' +
    'submit_workflow instead of retyping the graph. Call validate_workflow immediately ' +
    'after building.',
  schema: z.object({
    nodes: z
      .array(
        z.object({
          id: z.string().min(1).describe('Node id, unique within the workflow, e.g. "1".'),
          class_type: z
            .string()
            .min(1)
            .describe('Exact node class name from the server, e.g. "KSampler".'),
          inputs: nodeInputSchema
            .optional()
            .describe('Input values: literals, or [node_id, slot] links.'),
        }),
      )
      .min(1)
      .describe('The workflow nodes. Wire them into a DAG that reaches an output node.'),
    title: z.string().optional().describe('Optional human-readable title for the workflow.'),
  }),
  mutating: false,
  handler: async (input, ctx) => {
    // Duplicate ids would silently overwrite each other in the map, so this is
    // checked before anything is registered.
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const node of input.nodes) {
      if (seen.has(node.id)) duplicates.push(node.id);
      seen.add(node.id);
    }
    if (duplicates.length > 0) {
      return {
        ok: false,
        errorCode: 'DUPLICATE_NODE_ID',
        content: {
          error: `Duplicate node id(s): ${[...new Set(duplicates)].join(', ')}.`,
          hint: 'Every node must have a unique id, since links refer to nodes by id.',
        },
      };
    }

    const workflow: ApiWorkflow = {};
    for (const node of input.nodes) {
      workflow[node.id] = {
        class_type: node.class_type,
        inputs: node.inputs ?? {},
        ...(input.title ? { _meta: { title: input.title } } : {}),
      };
    }

    const stored = ctx.workflows.add(workflow);
    ctx.note(`Built workflow ${stored.id} with ${input.nodes.length} nodes.`);

    const classTypes = [...new Set(input.nodes.map((n) => n.class_type))].sort();
    ctx.emit({
      type: 'note',
      step: 0,
      text: `Built ${stored.id}: ${classTypes.join(', ')}`,
    });

    return {
      ok: true,
      content: {
        workflow_id: stored.id,
        node_count: input.nodes.length,
        class_types: classTypes,
        next_step: `Call validate_workflow with workflow_id "${stored.id}".`,
      },
    };
  },
});

export const validateWorkflowTool = defineTool({
  name: 'validate_workflow',
  description:
    'Check a built workflow against the live node catalogue before running it. Reports ' +
    'errors and warnings for: unknown class_type, missing required inputs, links to ' +
    'non-existent nodes, output slots that do not exist, mismatched link types, cycles, ' +
    'and whether any output node is present. A successful pass is recorded against the ' +
    'workflow, and submit_workflow refuses any workflow that has not passed. Read every ' +
    'finding and fix the cause rather than re-running unchanged.',
  schema: z.object({
    workflow_id: z
      .string()
      .optional()
      .describe('Id from build_workflow. Defaults to the most recently built workflow.'),
  }),
  mutating: false,
  handler: async (input, ctx) => {
    const stored = ctx.workflows.resolve(input.workflow_id);
    if (!stored) {
      return {
        ok: false,
        errorCode: 'NO_WORKFLOW',
        content: {
          error:
            input.workflow_id === undefined
              ? 'No workflow has been built yet.'
              : `No workflow with id "${input.workflow_id}".`,
          hint: 'Call build_workflow first.',
        },
      };
    }

    let index;
    try {
      index = await ctx.catalog.ensure();
    } catch {
      return {
        ok: false,
        errorCode: 'COMFY_UNREACHABLE',
        content: {
          error: 'The workflow cannot be validated because the ComfyUI server is unreachable.',
          hint: 'Validation checks inputs against the live node catalogue. Call server_status for diagnostics.',
        },
      };
    }
    const result = validateWorkflow(stored.workflow, index, {
      nodeAllowlist: ctx.policy.nodeAllowlist,
    });

    ctx.workflows.recordValidation(stored.id, result);

    if (result.valid) {
      ctx.note(`Validated ${stored.id}: VALID (${result.warnings.length} warning(s)).`);
    } else {
      ctx.note(`Validated ${stored.id}: ${result.errors.length} error(s).`);
    }

    return {
      ok: true,
      content: {
        workflow_id: stored.id,
        valid: result.valid,
        error_count: result.errors.length,
        warning_count: result.warnings.length,
        will_execute: result.reachable,
        output_nodes: result.outputNodes,
        errors: result.errors,
        warnings: result.warnings,
        summary: formatValidationResult(result),
        ...(result.valid
          ? { next_step: `Call submit_workflow with workflow_id "${stored.id}".` }
          : { next_step: 'Fix the listed errors by calling build_workflow again, then validate again.' }),
      },
    };
  },
});

export const getWorkflow = defineTool({
  name: 'get_workflow',
  description:
    'Return the full API-format JSON of a built workflow, for inspection or debugging. ' +
    'Useful when you need to check exact wiring before submitting. Not needed in the ' +
    'normal build-validate-submit path.',
  schema: z.object({
    workflow_id: z
      .string()
      .optional()
      .describe('Id from build_workflow. Defaults to the most recently built workflow.'),
  }),
  mutating: false,
  handler: async (input, ctx) => {
    const stored = ctx.workflows.resolve(input.workflow_id);
    if (!stored) {
      return {
        ok: false,
        errorCode: 'NO_WORKFLOW',
        content: { error: 'No matching workflow. Call build_workflow first.' },
      };
    }
    return {
      ok: true,
      content: {
        workflow_id: stored.id,
        validation: stored.validation ?? null,
        workflow: stored.workflow,
      },
    };
  },
});
