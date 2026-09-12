import { z } from 'zod';

import type { ObjectInfoIndex } from '../comfy/objectInfo.ts';
import { toCompactError } from '../comfy/errors.ts';
import { defineTool, type ToolContext, type ToolResult } from './types.ts';

/**
 * Discovery tools: the just-in-time retrieval path (ADR 0003).
 *
 * Together these implement the Poka-yoke guarantee — the model can see which
 * node classes exist, what each input requires, and which model/sampler values
 * are actually available, so it never has to guess a filename.
 */

/** Cap returned hits: more is not better, it is just more context spent. */
const DEFAULT_SEARCH_LIMIT = 6;
const MAX_SEARCH_LIMIT = 15;

/**
 * Every catalog lookup goes through here so an unreachable server becomes a
 * compact structured result instead of a thrown error with a stack trace.
 * Errors are values the model can act on (see AGENTS.md, rule 3).
 */
async function ensureCatalog(ctx: ToolContext): Promise<ObjectInfoIndex | undefined> {
  try {
    return await ctx.catalog.ensure();
  } catch {
    return undefined;
  }
}

function unreachableResult(): ToolResult {
  return {
    ok: false,
    errorCode: 'COMFY_UNREACHABLE',
    content: {
      error: 'The ComfyUI node catalogue could not be loaded because the server is unreachable.',
      hint: 'Call server_status for diagnostics, or stop and report that ComfyUI must be started.',
    },
  };
}

export const searchNodeTypes = defineTool({
  name: 'search_node_types',
  description:
    'Search the connected ComfyUI server for node classes matching a keyword query. ' +
    'Matches against class name, display name, category, description, and output names. ' +
    'Returns compact hits — class_type, display name, category, output types, and the ' +
    'number of required inputs — but NOT input schemas. Follow up with get_node_schema ' +
    'for any class you intend to use. Example queries: "checkpoint loader", "sampler", ' +
    '"save image", "vae decode", "empty latent".',
  schema: z.object({
    query: z
      .string()
      .min(1)
      .describe('Keywords describing the node you need, e.g. "checkpoint loader" or "ksampler".'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_SEARCH_LIMIT)
      .optional()
      .describe(`Maximum hits to return. Defaults to ${DEFAULT_SEARCH_LIMIT}.`),
  }),
  mutating: false,
  handler: async (input, ctx) => {
    const index = await ensureCatalog(ctx);
    if (!index) return unreachableResult();
    const hits = index.search(input.query, input.limit ?? DEFAULT_SEARCH_LIMIT);

    if (hits.length === 0) {
      return {
        ok: true,
        content: {
          query: input.query,
          matches: [],
          note: `No node class matched "${input.query}". Try a broader or different keyword, or check server_status to confirm the server is the one you expect.`,
          total_node_classes: index.size,
        },
      };
    }

    return {
      ok: true,
      content: {
        query: input.query,
        count: hits.length,
        matches: hits,
        total_node_classes: index.size,
      },
    };
  },
});

export const getNodeSchema = defineTool({
  name: 'get_node_schema',
  description:
    "Return the full input specification for one ComfyUI node class: every required and " +
    'optional input with its type, default, numeric range, and — for enumerated inputs — ' +
    'the actual allowed values from this server (for example real sampler and scheduler ' +
    'names). Also returns the output types, which you need in order to wire links: ' +
    'output slot indexes are 0-based, in the order listed. Call this for each class before ' +
    'building a workflow. Uses the exact class_type string, e.g. "KSampler".',
  schema: z.object({
    class_type: z
      .string()
      .min(1)
      .describe('Exact node class name from search_node_types, e.g. "KSampler".'),
  }),
  mutating: false,
  handler: async (input, ctx) => {
    const index = await ensureCatalog(ctx);
    if (!index) return unreachableResult();
    const schema = index.getSchema(input.class_type);

    if (!schema) {
      const similar = index.search(input.class_type, 5).map((hit) => hit.class_type);
      return {
        ok: false,
        errorCode: 'UNKNOWN_NODE',
        content: {
          error: `This server has no node class named "${input.class_type}".`,
          ...(similar.length > 0
            ? { did_you_mean: similar }
            : { note: 'Use search_node_types to find the correct class_type.' }),
        },
      };
    }

    ctx.note(`Read schema for ${input.class_type}.`);
    return { ok: true, content: schema };
  },
});

/** Model folders most likely to matter. Others can be requested by name. */
const COMMON_MODEL_FOLDERS = [
  'checkpoints',
  'vae',
  'loras',
  'controlnet',
  'clip',
  'clip_vision',
  'embeddings',
  'upscale_models',
  'diffusion_models',
  'text_encoders',
] as const;

export const listModels = defineTool({
  name: 'list_models',
  description:
    'List the model filenames actually installed on the ComfyUI server, optionally ' +
    'restricted to one folder. Use this to obtain real checkpoint/VAE/LoRA filenames — ' +
    'never invent one. With no folder argument it lists the common folders ' +
    '(checkpoints, vae, loras, controlnet, clip, diffusion_models, text_encoders, and ' +
    'others). Pass an exact folder name such as "checkpoints" to list just that folder ' +
    'with no truncation.',
  schema: z.object({
    folder: z
      .string()
      .min(1)
      .optional()
      .describe('Exact model folder name, e.g. "checkpoints". Omit to list common folders.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe('Maximum filenames per folder. Defaults to 50.'),
  }),
  mutating: false,
  handler: async (input, ctx) => {
    const limit = input.limit ?? 50;
    try {
      if (input.folder) {
        const files = await ctx.comfy.getModels(input.folder);
        const shown = files.slice(0, limit);
        return {
          ok: true,
          content: {
            folder: input.folder,
            count: files.length,
            files: shown,
            ...(files.length > shown.length ? { truncated: true } : {}),
          },
        };
      }

      const folders: Record<string, string[]> = {};
      const counts: Record<string, number> = {};
      const failures: string[] = [];

      // Sequential rather than parallel: this runs against a local server and a
      // predictable request order keeps logs and traces readable.
      for (const folder of COMMON_MODEL_FOLDERS) {
        try {
          const files = await ctx.comfy.getModels(folder);
          if (files.length === 0) continue;
          counts[folder] = files.length;
          folders[folder] = files.slice(0, limit);
        } catch {
          // A missing folder is normal — most installs lack several of these.
          failures.push(folder);
        }
      }

      if (Object.keys(folders).length === 0) {
        return {
          ok: true,
          content: {
            folders: {},
            note: 'No models found in the common folders. The server may have its models in non-standard folders; try passing an explicit folder name.',
            ...(failures.length > 0 ? { unavailable_folders: failures } : {}),
          },
        };
      }

      return {
        ok: true,
        content: {
          counts,
          folders,
          ...(Object.values(counts).some((c) => c > limit) ? { truncated: true } : {}),
        },
      };
    } catch (error) {
      const compact = toCompactError(error, 'MODEL_LIST_FAILED');
      return { ok: false, errorCode: compact.code, content: compact };
    }
  },
});
