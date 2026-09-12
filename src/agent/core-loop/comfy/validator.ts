/**
 * The validation gate.
 *
 * Per the research notes (§1, §8), a rule-based check before execution is the
 * strongest form of "verify work" available and it burns no tokens. `submit_workflow`
 * refuses to POST anything that has not passed here, and that refusal is
 * enforced in the tool layer — not merely requested in the prompt.
 *
 * Design bias: never produce a false error. A gate that rejects a workable
 * workflow is worse than useless, because the model will then thrash trying to
 * satisfy a rule ComfyUI does not have. So anything genuinely ambiguous is
 * reported at `warning` severity.
 */

import type { CompactNodeSchema } from './objectInfo.ts';
import { collectLinkTargets, isLink, type ApiWorkflow } from './workflow.ts';

export type FindingSeverity = 'error' | 'warning';

export interface ValidationFinding {
  severity: FindingSeverity;
  code: string;
  message: string;
  node?: string;
  input?: string;
  hint?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationFinding[];
  warnings: ValidationFinding[];
  /** Node ids that feed an output node and will therefore execute. */
  reachable: string[];
  outputNodes: string[];
}

/** Narrow view of the node catalogue — satisfied by `ObjectInfoIndex`. */
export interface NodeCatalog {
  has(classType: string): boolean;
  getSchema(classType: string): CompactNodeSchema | undefined;
}

/** Types that are filled as literals rather than by wiring. */
const LITERAL_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO', 'ENUM']);

/**
 * A declared input/output type is treated as a connection type when it is an
 * upper-case identifier that is not a literal. This is deliberately structural
 * (rather than a hardcoded list of ComfyUI types) so custom-node types are
 * covered too, with "*" and "ANY" as explicit wildcards.
 */
function isConnectionType(type: string): boolean {
  if (type === '*' || type === 'ANY' || type === 'UNKNOWN') return false;
  if (LITERAL_TYPES.has(type)) return false;
  return /^[A-Z][A-Z0-9_]*$/.test(type);
}

function typesCompatible(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  if (expected === '*' || expected === 'ANY' || actual === '*' || actual === 'ANY') return true;
  if (expected === 'UNKNOWN' || actual === 'UNKNOWN') return true;
  return false;
}

/**
 * Validate an API-format workflow against the live node catalogue.
 *
 * Checks: node existence, required inputs, link targets, output slots, link type
 * compatibility, cycles, allowlist, and the presence of an output node.
 */
export function validateWorkflow(
  workflow: ApiWorkflow,
  catalog: NodeCatalog,
  options: { nodeAllowlist?: readonly string[] } = {},
): ValidationResult {
  const errors: ValidationFinding[] = [];
  const warnings: ValidationFinding[] = [];
  const allowlist = options.nodeAllowlist ?? [];
  const nodeIds = Object.keys(workflow);

  if (nodeIds.length === 0) {
    errors.push({
      severity: 'error',
      code: 'EMPTY_WORKFLOW',
      message: 'The workflow has no nodes.',
      hint: 'Add at least a checkpoint loader, a text encoder, a sampler, and a save-image node.',
    });
    return { valid: false, errors, warnings, reachable: [], outputNodes: [] };
  }

  const schemas = new Map<string, CompactNodeSchema | undefined>();

  // --- 1. Node existence, allowlist, deprecation ---------------------------
  for (const nodeId of nodeIds) {
    const node = workflow[nodeId];
    if (!node) continue;
    const classType = node.class_type;
    const schema = catalog.getSchema(classType);
    schemas.set(nodeId, schema);

    if (!schema) {
      const suggestion = catalog.has(classType) ? undefined : 'Call search_node_types to find the correct class_type.';
      errors.push({
        severity: 'error',
        code: 'UNKNOWN_NODE',
        message: `Node ${nodeId} uses class_type "${classType}", which this ComfyUI server does not provide.`,
        node: nodeId,
        ...(suggestion ? { hint: suggestion } : {}),
      });
      continue;
    }
    if (schema.deprecated) {
      warnings.push({
        severity: 'warning',
        code: 'DEPRECATED_NODE',
        message: `Node ${nodeId} (${classType}) is deprecated on this server.`,
        node: nodeId,
      });
    }
    if (allowlist.length > 0 && !allowlist.includes(classType)) {
      errors.push({
        severity: 'error',
        code: 'NODE_NOT_ALLOWED',
        message: `Node ${nodeId} (${classType}) is not in the configured allowlist.`,
        node: nodeId,
        hint: `Permitted class_types: ${allowlist.join(', ')}`,
      });
    }
  }

  // --- 2. Inputs: required presence, link integrity, type compatibility ----
  for (const nodeId of nodeIds) {
    const node = workflow[nodeId];
    const schema = schemas.get(nodeId);
    if (!node || !schema) continue;

    for (const input of schema.required) {
      if (!(input.name in node.inputs)) {
        // A required input carrying a default is accepted by ComfyUI when
        // omitted; flag it so the model knows, but do not block.
        if (input.default !== undefined || input.values !== undefined) {
          warnings.push({
            severity: 'warning',
            code: 'REQUIRED_INPUT_OMITTED',
            message: `Node ${nodeId} (${node.class_type}) omits required input "${input.name}"; ComfyUI will use its default.`,
            node: nodeId,
            input: input.name,
          });
        } else {
          errors.push({
            severity: 'error',
            code: 'MISSING_REQUIRED_INPUT',
            message: `Node ${nodeId} (${node.class_type}) is missing required input "${input.name}" (${input.type}).`,
            node: nodeId,
            input: input.name,
            hint: `Call get_node_schema("${node.class_type}") for the full input list.`,
          });
        }
      }
    }

    // Reject inputs that the node does not declare at all.
    const declared = new Set([...schema.required, ...schema.optional].map((i) => i.name));
    for (const inputName of Object.keys(node.inputs)) {
      if (!declared.has(inputName)) {
        warnings.push({
          severity: 'warning',
          code: 'UNKNOWN_INPUT',
          message: `Node ${nodeId} (${node.class_type}) has input "${inputName}", which that node does not declare; ComfyUI will ignore it.`,
          node: nodeId,
          input: inputName,
        });
      }
    }

    const inputSpecs = new Map([...schema.required, ...schema.optional].map((i) => [i.name, i]));

    for (const value of Object.values(node.inputs)) {
      if (!isLink(value)) continue;
      const [targetId] = value;
      const targetNode = workflow[targetId];

      if (!targetNode) {
        errors.push({
          severity: 'error',
          code: 'LINK_TARGET_MISSING',
          message: `Node ${nodeId} links to node "${targetId}", which is not in the workflow.`,
          node: nodeId,
          hint: `Add node "${targetId}" or point the link at an existing node id. Existing ids: ${nodeIds.join(', ')}`,
        });
      }
    }

    for (const [inputName, value] of Object.entries(node.inputs)) {
      if (!isLink(value)) continue;
      const [targetId, slot] = value;
      const targetSchema = schemas.get(targetId);
      if (!targetSchema) continue; // already reported above

      const outputTypes = targetSchema.output_types;
      if (outputTypes.length === 0) {
        errors.push({
          severity: 'error',
          code: 'LINK_FROM_SOURCELESS_NODE',
          message: `Node ${nodeId} input "${inputName}" links to ${targetId} (${targetSchema.class_type}), which produces no outputs.`,
          node: nodeId,
          input: inputName,
        });
        continue;
      }
      const actualType = outputTypes[slot];
      if (actualType === undefined) {
        errors.push({
          severity: 'error',
          code: 'LINK_SLOT_OUT_OF_RANGE',
          message: `Node ${nodeId} input "${inputName}" links to slot ${slot} of ${targetId} (${targetSchema.class_type}), which has ${outputTypes.length} output(s).`,
          node: nodeId,
          input: inputName,
          hint: `Valid slots for ${targetSchema.class_type}: 0..${outputTypes.length - 1} (${outputTypes.join(', ')})`,
        });
        continue;
      }

      const spec = inputSpecs.get(inputName);
      if (spec && (isConnectionType(spec.type) || LITERAL_TYPES.has(spec.type))) {
        if (!typesCompatible(spec.type, actualType)) {
          errors.push({
            severity: 'error',
            code: 'LINK_TYPE_MISMATCH',
            message: `Node ${nodeId} input "${inputName}" expects ${spec.type} but ${targetId} slot ${slot} produces ${actualType}.`,
            node: nodeId,
            input: inputName,
            hint: `Rewire "${inputName}" to a node whose output type is ${spec.type}.`,
          });
        }
      }
    }
  }

  // --- 3. Cycles (ComfyUI cannot execute a cyclic graph) -------------------
  const cycle = detectCycle(workflow);
  if (cycle) {
    errors.push({
      severity: 'error',
      code: 'CYCLE_DETECTED',
      message: `The workflow contains a cycle: ${cycle.join(' -> ')}`,
      hint: 'Remove the loop; ComfyUI executes the graph as a DAG.',
    });
  }

  // --- 4. Output nodes ----------------------------------------------------
  const outputNodes = nodeIds.filter((id) => schemas.get(id)?.output_node === true);
  if (outputNodes.length === 0) {
    errors.push({
      severity: 'error',
      code: 'NO_OUTPUT_NODE',
      message: 'The workflow has no output node, so it would produce nothing.',
      hint: 'Connect the result to a SaveImage (or PreviewImage) node.',
    });
  }

  const reachable = outputNodes.length > 0 ? reachableFrom(workflow, outputNodes) : [];

  // Unreachable nodes are not an error — ComfyUI simply does not execute them —
  // but they usually mean a mis-wire, so they are worth surfacing.
  for (const nodeId of nodeIds) {
    if (!reachable.includes(nodeId) && outputNodes.length > 0) {
      const node = workflow[nodeId];
      warnings.push({
        severity: 'warning',
        code: 'NODE_UNREACHABLE',
        message: `Node ${nodeId} (${node?.class_type ?? '?'}) is not reachable from any output node and will not execute.`,
        node: nodeId,
      });
    }
  }

  return { valid: errors.length === 0, errors, warnings, reachable, outputNodes };
}

/** Depth-first search for a back edge. Returns the cycle path when found. */
export function detectCycle(workflow: ApiWorkflow): string[] | undefined {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of Object.keys(workflow)) color.set(id, WHITE);

  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    color.set(id, GRAY);
    stack.push(id);

    const node = workflow[id];
    if (node) {
      for (const link of collectLinkTargets(node.inputs)) {
        const next = link[0];
        if (!workflow[next]) continue;
        const state = color.get(next);
        if (state === GRAY) {
          const start = stack.indexOf(next);
          return [...stack.slice(start), next];
        }
        if (state === WHITE) {
          const found = visit(next);
          if (found) return found;
        }
      }
    }

    stack.pop();
    color.set(id, BLACK);
    return undefined;
  };

  for (const id of Object.keys(workflow)) {
    if (color.get(id) === WHITE) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return undefined;
}

/** Nodes that (transitively) feed the given roots. */
export function reachableFrom(workflow: ApiWorkflow, roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = workflow[id];
    if (!node) continue;
    for (const link of collectLinkTargets(node.inputs)) {
      if (workflow[link[0]]) queue.push(link[0]);
    }
  }
  return [...seen].sort();
}

/**
 * Render findings as compact text for the model.
 *
 * Only `error` and `warning` lines, capped, with the hint inline — a validation
 * report is exactly the kind of tool result that must stay small.
 */
export function formatValidationResult(result: ValidationResult, maxFindings = 20): string {
  if (result.valid && result.warnings.length === 0) {
    return `VALID. ${result.outputNodes.length} output node(s), ${result.reachable.length} node(s) will execute.`;
  }
  const lines: string[] = [];
  lines.push(result.valid ? 'VALID (with warnings).' : `INVALID: ${result.errors.length} error(s).`);
  const shown = [...result.errors, ...result.warnings].slice(0, maxFindings);
  for (const finding of shown) {
    const where = finding.node ? ` [node ${finding.node}${finding.input ? `.${finding.input}` : ''}]` : '';
    lines.push(`${finding.severity === 'error' ? 'ERROR' : 'WARN'} ${finding.code}${where}: ${finding.message}`);
    if (finding.hint) lines.push(`  hint: ${finding.hint}`);
  }
  const total = result.errors.length + result.warnings.length;
  if (total > shown.length) lines.push(`…and ${total - shown.length} more finding(s).`);
  return lines.join('\n');
}
