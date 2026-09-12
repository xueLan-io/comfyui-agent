/**
 * The node catalogue index.
 *
 * Implements ADR 0003. The full `/object_info` payload is hundreds of KB on a
 * typical install; putting it in context would consume the model's entire
 * attention budget before the user's request is even read. So:
 *
 *   - fetch once per process, index in memory
 *   - `search()` returns a few compact hits (names + one-liners, no schemas)
 *   - `getSchema()` returns ONE node's inputs, projected to the fields a builder
 *     needs, with real enum values so the model cannot invent a filename
 *
 * The projection is also what makes `get_node_schema` cheap to call repeatedly.
 */

import type { ObjectInfoNode, ObjectInfoResponse } from './client.ts';

export type InputKind = 'type' | 'enum';

export interface CompactInput {
  name: string;
  required: boolean;
  /** "INT", "STRING", "IMAGE", "MODEL", … or "ENUM" for a closed value set. */
  type: string;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  multiline?: boolean;
  /** Present for enums; truncated with `valuesTruncated` when long. */
  values?: string[];
  valuesTruncated?: boolean;
  totalValues?: number;
}

export interface CompactNodeSchema {
  class_type: string;
  display_name?: string;
  category?: string;
  description?: string;
  output_types: string[];
  output_node: boolean;
  deprecated: boolean;
  required: CompactInput[];
  optional: CompactInput[];
}

export interface NodeSearchHit {
  class_type: string;
  display_name?: string;
  category?: string;
  summary?: string;
  output_types: string[];
  is_output_node: boolean;
  required_input_count: number;
}

/** Cap enum values returned per input. ComfyUI has folders with thousands of files. */
const MAX_ENUM_VALUES = 40;
const MAX_DESCRIPTION = 200;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Parse one ComfyUI input spec.
 *
 * Spec shape: `[typeOrOptions, optionsObject?]` where `typeOrOptions` is either
 * a type string (`"INT"`) or an array of allowed values (`["euler", ...]`).
 * Newer builds and custom nodes sometimes use `{type, ...}` or a `COMBO` type
 * with `options`; those are handled rather than dropped.
 */
export function parseInputSpec(name: string, spec: unknown, required: boolean): CompactInput {
  const base: CompactInput = { name, required, type: 'UNKNOWN' };

  if (typeof spec === 'string') {
    // Permissive form: some custom nodes list a bare type string.
    return { ...base, type: spec };
  }

  if (!Array.isArray(spec) || spec.length === 0) {
    const dict = asRecord(spec);
    if (dict && typeof dict['type'] === 'string') {
      return { ...base, type: dict['type'] as string };
    }
    return base;
  }

  const [typeRaw, optsRaw] = spec;
  const opts = asRecord(optsRaw) ?? {};

  let type = 'UNKNOWN';
  let values: string[] | undefined;

  if (Array.isArray(typeRaw)) {
    // Closed value set straight in the spec: e.g. sampler names.
    type = 'ENUM';
    values = typeRaw.filter((v): v is string => typeof v === 'string');
  } else if (typeof typeRaw === 'string') {
    type = typeRaw;
    // A COMBO's values live in opts.options on recent builds.
    const optionList = opts['options'];
    if (type === 'COMBO' && Array.isArray(optionList)) {
      type = 'ENUM';
      values = optionList.filter((v): v is string => typeof v === 'string');
    }
  } else {
    const dict = asRecord(typeRaw);
    if (dict && typeof dict['type'] === 'string') type = dict['type'] as string;
  }

  const result: CompactInput = { ...base, type };

  const def = opts['default'];
  if (typeof def === 'string' || typeof def === 'number' || typeof def === 'boolean') {
    // Defaults for enums can be enormous folder listings; keep them short.
    result.default = typeof def === 'string' && def.length > MAX_DESCRIPTION ? `${def.slice(0, MAX_DESCRIPTION)}…` : def;
  }
  if (typeof opts['min'] === 'number') result.min = opts['min'];
  if (typeof opts['max'] === 'number') result.max = opts['max'];
  if (opts['multiline'] === true) result.multiline = true;

  if (values) {
    result.totalValues = values.length;
    if (values.length > MAX_ENUM_VALUES) {
      // Keep the default visible even in a truncated list — it is the strongest hint.
      const head = values.slice(0, MAX_ENUM_VALUES);
      if (typeof result.default === 'string' && !head.includes(result.default)) {
        head[MAX_ENUM_VALUES - 1] = result.default;
      }
      result.values = head;
      result.valuesTruncated = true;
    } else {
      result.values = values;
    }
  }

  return result;
}

export interface ModelFolderSummary {
  /** Model filenames grouped by folder, e.g. checkpoints -> [...]. */
  folders: Record<string, string[]>;
}

/**
 * In-memory index over one `/object_info` snapshot.
 *
 * Search is deterministic keyword scoring rather than embeddings: it needs no
 * extra dependency, returns identical results for identical input (better for
 * tests and prompt caching), and the `search` contract leaves room for a
 * semantic implementation later (ADR 0003).
 */
export class ObjectInfoIndex {
  private readonly nodes: Map<string, ObjectInfoNode>;
  private readonly searchIndex: Array<{ classType: string; haystack: string }>;

  constructor(raw: ObjectInfoResponse) {
    this.nodes = new Map(Object.entries(raw));
    this.searchIndex = [];
    for (const [classType, node] of this.nodes) {
      const parts = [
        classType,
        node.display_name ?? '',
        node.name ?? '',
        node.category ?? '',
        node.description ?? '',
        Array.isArray(node.output_name) ? node.output_name.join(' ') : '',
        Array.isArray(node.output) ? node.output.join(' ') : '',
      ];
      this.searchIndex.push({
        classType,
        haystack: parts.join(' ').toLowerCase().replace(/[_/]/g, ' '),
      });
    }
  }

  get size(): number {
    return this.nodes.size;
  }

  has(classType: string): boolean {
    return this.nodes.has(classType);
  }

  /** All class types, sorted — deterministic ordering for prompt-cache friendliness. */
  classTypes(): string[] {
    return [...this.nodes.keys()].sort();
  }

  /**
   * Keyword search over class name, display name, category, description, and
   * output names. Returns compact hits only — never schemas.
   */
  search(query: string, limit = 8): NodeSearchHit[] {
    const tokens = query
      .toLowerCase()
      .split(/[\s,._/]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 1);

    if (tokens.length === 0) return [];

    const scored: Array<{ score: number; classType: string }> = [];

    for (const entry of this.searchIndex) {
      let score = 0;
      const classLower = entry.classType.toLowerCase();

      for (const token of tokens) {
        if (classLower === token) score += 100;
        else if (classLower.includes(token)) score += 40;
        if (entry.haystack.includes(token)) score += 12;
      }

      if (score > 0) {
        // Prefer standard/core nodes: a custom node with a similar name is
        // usually not what a first attempt wants.
        if (entry.classType.includes('+') || entry.classType.includes('.')) score -= 15;
        const node = this.nodes.get(entry.classType);
        if (node?.output_node) score += 20;
        scored.push({ score, classType: entry.classType });
      }
    }

    scored.sort((a, b) =>
      b.score !== a.score ? b.score - a.score : a.classType.localeCompare(b.classType),
    );

    return scored
      .slice(0, Math.max(1, limit))
      .map((s) => this.toSearchHit(s.classType))
      .filter((h): h is NodeSearchHit => h !== undefined);
  }

  private toSearchHit(classType: string): NodeSearchHit | undefined {
    const node = this.nodes.get(classType);
    if (!node) return undefined;
    const requiredCount = Object.keys(node.input?.required ?? {}).length;
    const summary = node.description?.trim();
    return {
      class_type: classType,
      ...(node.display_name ? { display_name: node.display_name } : {}),
      ...(node.category ? { category: node.category } : {}),
      ...(summary ? { summary: summary.slice(0, MAX_DESCRIPTION) } : {}),
      output_types: Array.isArray(node.output) ? node.output.map(String) : [],
      is_output_node: node.output_node === true,
      required_input_count: requiredCount,
    };
  }

  /**
   * Full projected schema for exactly one node — the progressive-disclosure step.
   * Returns undefined when the class_type does not exist, which lets the caller
   * produce a "did you mean" style error instead of a crash.
   */
  getSchema(classType: string): CompactNodeSchema | undefined {
    const node = this.nodes.get(classType);
    if (!node) return undefined;

    const required: CompactInput[] = Object.entries(node.input?.required ?? {}).map(([name, spec]) =>
      parseInputSpec(name, spec, true),
    );
    const optional: CompactInput[] = Object.entries(node.input?.optional ?? {}).map(([name, spec]) =>
      parseInputSpec(name, spec, false),
    );

    return {
      class_type: classType,
      ...(node.display_name ? { display_name: node.display_name } : {}),
      ...(node.category ? { category: node.category } : {}),
      ...(node.description ? { description: node.description.slice(0, MAX_DESCRIPTION) } : {}),
      output_types: Array.isArray(node.output) ? node.output.map(String) : [],
      output_node: node.output_node === true,
      deprecated: node.deprecated === true,
      required: required.sort((a, b) => a.name.localeCompare(b.name)),
      optional: optional.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /**
   * Enum values available for one input of one node.
   *
   * This is the Poka-yoke primitive: it lets the builder fill a model filename
   * or sampler from the server's real list. For folder-backed inputs the
   * `/models/{folder}` route is more current, so a caller may prefer that.
   */
  enumValues(classType: string, inputName: string): string[] | undefined {
    const node = this.nodes.get(classType);
    if (!node) return undefined;
    const spec = node.input?.required?.[inputName] ?? node.input?.optional?.[inputName];
    if (spec === undefined) return undefined;
    const parsed = parseInputSpec(inputName, spec, true);
    return parsed.values;
  }
}
