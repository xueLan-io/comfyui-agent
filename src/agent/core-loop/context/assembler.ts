import type { ChatMessage, ToolCall, ToolResult } from '../core/types.ts';
import type { ToolDescriptor } from '../core/types.ts';
import { estimateContextTokens } from './budget.ts';

/**
 * Builds the model's message list.
 *
 * This is the one place context is constructed, which is what makes the
 * context-engineering rules enforceable rather than aspirational. Two
 * properties are deliberate:
 *
 *  - The system prompt sits at the "Goldilocks" altitude from the research
 *    notes (§2): specific about the rules a model cannot infer (API-format
 *    graph shape, validate-before-submit, use real enumerations) and silent
 *    about anything the tools already enforce by construction.
 *  - Tool results are capped in size on the way in. Even a well-behaved tool can
 *    return something large; the cap is the backstop that keeps one runaway
 *    result from consuming the window.
 */

/** Hard ceiling on a single tool result's rendered size, in characters. */
export const MAX_TOOL_RESULT_CHARS = 4_000;

/** How many recent messages are never touched by compaction. */
export const KEEP_RECENT_MESSAGES = 8;

export interface AssembleOptions {
  tools: readonly ToolDescriptor[];
  dryRun: boolean;
  nodeCount?: number;
  /** Rendered scratchpad block, if the agent has taken any notes. */
  scratchpad?: string;
}

/**
 * The system prompt.
 *
 * Sectioned rather than prose, per the guidance to use labeled sections. The
 * content is about *rules and formats*; it does not enumerate nodes or models,
 * because those are discovered at runtime — putting them here would be the very
 * inlining that ADR 0003 forbids.
 */
export function buildSystemPrompt(options: AssembleOptions): string {
  const toolNames = options.tools.map((t) => t.name).sort().join(', ');

  const sections: string[] = [];

  sections.push(
    [
      '<role>',
      'You are ComfyAgent, an agent that turns a natural-language image request into a',
      'working ComfyUI workflow, validates it, submits it, and reports the generated',
      'image. You operate a ComfyUI server that is already running.',
      '</role>',
    ].join('\n'),
  );

  sections.push(
    [
      '<workflow_rules>',
      'You build workflows in ComfyUI *API format*: a flat JSON object mapping a node id',
      '(a string like "1") to an object with two fields, "class_type" (a node class the',
      'server reports) and "inputs".',
      '',
      'Inputs are either literals (a string, number, or boolean) or a LINK, which is a',
      'two-element array [upstream_node_id, output_slot_index] referring to another',
      "node's output. The slot index is 0-based.",
      '',
      'Rules that will get a workflow rejected:',
      '- The graph must be acyclic; ComfyUI executes it as a DAG.',
      '- Every linked node id must exist in the same workflow.',
      '- Every required input of every node must be present.',
      '- A linked input\'s source output type must match what the target input accepts.',
      '- At least one node must be an output node (for example SaveImage), or nothing',
      '  is produced.',
      '</workflow_rules>',
    ].join('\n'),
  );

  sections.push(
    [
      '<tool_guidance>',
      `Available tools: ${toolNames}.`,
      '',
      'Discover, then build:',
      '1. Call search_node_types to find candidate node classes. It returns compact hits,',
      '   not schemas. Then call get_node_schema for the specific classes you will use.',
      '2. Call list_models to get the real checkpoint/model filenames. Never invent one.',
      '3. Call build_workflow with a declarative node list. It returns a workflow_id.',
      '4. Call validate_workflow and read the findings. Fix errors and rebuild if needed.',
      '5. Call submit_workflow, then wait_for_result.',
      '',
      'Prefer batching independent lookups in one turn: several get_node_schema calls at',
      'once cost one round trip instead of many.',
      '',
      'Workflows are referenced by id, not retyped. build_workflow returns a short id;',
      'pass it as workflow_id to validate_workflow and submit_workflow. If you omit it,',
      'the most recently built workflow is used. Never paste a whole workflow back into a',
      'tool call.',
      '</tool_guidance>',
    ].join('\n'),
  );

  sections.push(
    [
      '<constraints>',
      '- Never invent a node class_type, a model filename, a sampler name, or a scheduler',
      '  name. Take each from the server via the tools.',
      '- submit_workflow refuses any workflow that has not passed validate_workflow. That',
      '  is enforced, not advisory.',
      '- Errors come back as structured values. Read them, correct the cause, and retry;',
      '  do not repeat an identical failing call.',
      '- Keep reports short. State what you built, whether it validated, and where the',
      '  output is. Do not narrate each step.',
      '</constraints>',
    ].join('\n'),
  );

  if (options.dryRun) {
    sections.push(
      [
        '<run_mode mode="dry-run">',
        'Dry-run is ON. submit_workflow will simulate submission and will NOT queue real',
        'work; wait_for_result will return a simulated result. Build and validate the',
        'workflow as normal, then report it as ready to run. Do not claim an image was',
        'produced.',
        '</run_mode>',
      ].join('\n'),
    );
  }

  if (options.nodeCount !== undefined) {
    sections.push(
      [
        '<server_state>',
        `The connected ComfyUI server exposes ${options.nodeCount} node classes.`,
        'They are not listed here. Use search_node_types to find what you need.',
        '</server_state>',
      ].join('\n'),
    );
  }

  if (options.scratchpad && options.scratchpad.length > 0) {
    sections.push(options.scratchpad);
  }

  return sections.join('\n\n');
}

/** The initial message list for a run: system prompt, optional history, then the wrapped request. */
export function createInitialMessages(options: {
  systemPrompt: string;
  userInput: string;
  /** Prior turns projected from the session thread. Inserted before the request. */
  history?: readonly ChatMessage[];
}): ChatMessage[] {
  return [
    { role: 'system', content: options.systemPrompt },
    ...(options.history ?? []),
    {
      role: 'user',
      content: `<request>\n${options.userInput}\n</request>`,
    },
  ];
}

/**
 * Render a tool result as a message the model will read.
 *
 * Serialized to JSON rather than prose so the model sees the same structure the
 * tool produced, and capped so a single large payload cannot flood the window.
 */
export function toolResultMessage(call: ToolCall, result: ToolResult): ChatMessage {
  const body = renderToolResult(result);
  const truncated = body.length > MAX_TOOL_RESULT_CHARS;
  const content = truncated
    ? `${body.slice(0, MAX_TOOL_RESULT_CHARS)}\n[result truncated at ${MAX_TOOL_RESULT_CHARS} characters]`
    : body;

  return {
    role: 'tool',
    toolCallId: call.id,
    toolName: call.name,
    content,
  };
}

export function renderToolResult(result: ToolResult): string {
  const payload = result.ok
    ? result.content
    : { error: true, code: result.errorCode ?? 'ERROR', ...(result.content as object) };
  try {
    return JSON.stringify(payload);
  } catch {
    return JSON.stringify({ error: 'Tool result was not serializable.' });
  }
}

/** Token estimate for the assembled context. Used by the loop's step budget. */
export function contextTokens(
  messages: readonly ChatMessage[],
  tools: readonly ToolDescriptor[],
): number {
  return estimateContextTokens(messages, tools);
}
