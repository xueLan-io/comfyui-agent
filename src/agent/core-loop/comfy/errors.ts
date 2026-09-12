/**
 * Failure compression.
 *
 * ComfyUI failures arrive as large, nested blobs (Python tracebacks, node
 * validation dumps, stack frames). Feeding one back to the model verbatim is
 * exactly the "context rot" trap the research notes warn about, and it buries
 * the one line that matters.
 *
 * Every error that can re-enter context goes through `compactError` first: it
 * keeps the actionable fields and drops the prose. See docs/research/2026-landscape.md §2.
 */

export interface CompactError {
  code: string;
  message: string;
  /** Which node the failure is attributed to, when known. */
  node?: string;
  /** Input/type detail worth showing the model, when short enough. */
  detail?: string;
  /** True when retrying with different arguments could plausibly succeed. */
  recoverable: boolean;
  /** Short, imperative next step for the model. */
  hint?: string;
}

export class ComfyError extends Error {
  override readonly name = 'ComfyError';
  readonly code: string;
  readonly recoverable: boolean;
  readonly node: string | undefined;
  readonly detail: string | undefined;

  constructor(
    code: string,
    message: string,
    recoverable = true,
    node?: string,
    detail?: string,
  ) {
    super(message);
    this.code = code;
    this.recoverable = recoverable;
    this.node = node;
    this.detail = detail;
  }

  toCompact(): CompactError {
    return {
      code: this.code,
      message: this.message,
      ...(this.node !== undefined ? { node: this.node } : {}),
      ...(this.detail !== undefined ? { detail: truncate(this.detail, 400) } : {}),
      recoverable: this.recoverable,
    };
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/** Trim a traceback-like string to its final, most specific line. */
function lastMeaningfulLine(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.length > 0 ? (lines[lines.length - 1] as string) : '';
}

/**
 * Map a raw ComfyUI WebSocket `execution_error` payload into a compact error.
 *
 * `node_type` + `exception_message` are the two fields that tell the model what
 * to change; `node_id` is what tells it where.
 */
export function compactExecutionError(payload: {
  node_id?: string;
  node_type?: string;
  exception_type?: string;
  exception_message?: string;
  traceback?: string[] | string;
}): CompactError {
  const traceback = Array.isArray(payload.traceback)
    ? payload.traceback.join('\n')
    : (payload.traceback ?? '');

  const message =
    payload.exception_message?.trim() ||
    lastMeaningfulLine(traceback) ||
    'ComfyUI reported an execution error.';

  return {
    code: 'EXECUTION_ERROR',
    message: truncate(message, 500),
    ...(payload.node_id !== undefined ? { node: payload.node_id } : {}),
    ...(payload.node_type !== undefined ? { detail: `node_type=${payload.node_type}` } : {}),
    recoverable: true,
    hint: payload.node_type
      ? `Inspect the inputs of ${payload.node_type} node ${payload.node_id ?? ''} and correct them, then resubmit.`
      : 'Inspect the failing node inputs and resubmit.',
  };
}

/** Compact ComfyUI's POST /prompt 400 body: { error: { message, details } }. */
export function compactPromptRejection(payload: {
  error?: { type?: string; message?: string; details?: string };
  node_errors?: Record<string, { errors?: Array<{ message?: string; details?: string }> }>;
}): CompactError {
  const base =
    payload.error?.message?.trim() || payload.error?.details?.trim() || 'Prompt was rejected.';

  // node_errors is the actionable part: it names the nodes that failed validation.
  const nodeIssues: string[] = [];
  let firstNode: string | undefined;
  for (const [nodeId, info] of Object.entries(payload.node_errors ?? {})) {
    const messages = (info.errors ?? [])
      .map((e) => e.message ?? e.details ?? '')
      .filter((m) => m.length > 0);
    if (messages.length > 0) {
      firstNode ??= nodeId;
      nodeIssues.push(`${nodeId}: ${messages.join('; ')}`);
    }
  }

  return {
    code: 'PROMPT_REJECTED',
    message: truncate(base, 400),
    ...(firstNode !== undefined ? { node: firstNode } : {}),
    ...(nodeIssues.length > 0 ? { detail: truncate(nodeIssues.join(' | '), 600) } : {}),
    recoverable: true,
    hint: 'Fix the named node inputs and call submit_workflow again.',
  };
}

/** Any thrown value -> a compact error that is safe to put in context. */
export function toCompactError(error: unknown, fallbackCode = 'TOOL_ERROR'): CompactError {
  if (error instanceof ComfyError) return error.toCompact();
  if (error instanceof Error) {
    return {
      code: fallbackCode,
      message: truncate(error.message, 500),
      recoverable: true,
    };
  }
  return {
    code: fallbackCode,
    message: truncate(String(error), 500),
    recoverable: true,
  };
}
