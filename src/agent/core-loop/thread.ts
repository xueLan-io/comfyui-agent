import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * The conversation thread (agent-v2-design.md §2, P7 event sourcing).
 *
 * The thread is the single source of truth for a session: user messages,
 * assistant text, tool calls and their results, and system events (e.g. job
 * notifications) are all first-class records appended to one JSONL file —
 * one line per record, `agent-data/threads/<sessionId>.jsonl`. UI, traces, and
 * crash recovery are all projections of this log: recovery = replay.
 *
 * Writes are serialized through a promise chain so concurrent appends cannot
 * interleave partial lines. A failed append must throw: losing a thread record
 * silently would corrupt the "thread is the truth" invariant.
 */

export type ThreadRole = 'user' | 'agent' | 'tool' | 'system';

export interface ThreadToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ThreadMessage {
  id: string;
  ts: string;
  role: ThreadRole;
  /** Plain text for user/agent/system; compact JSON summary for tool results. */
  content: string;
  /** Present on agent messages that requested tools. */
  toolCall?: ThreadToolCall;
  /** Present on tool messages; the call this result answers. */
  toolCallId?: string;
  toolName?: string;
  /** Addressable products (images/files) produced by or referenced in this message. */
  artifactRefs?: Array<{ id: string; kind: string; path: string }>;
  /** Job this message is about (tool results and task notifications). */
  jobId?: string;
  meta?: Record<string, unknown>;
}

export interface ThreadAppendInput {
  role: ThreadRole;
  content: string;
  toolCall?: ThreadToolCall;
  toolCallId?: string;
  toolName?: string;
  artifactRefs?: Array<{ id: string; kind: string; path: string }>;
  jobId?: string;
  meta?: Record<string, unknown>;
  /** Tests inject a deterministic clock; defaults to Date.now. */
  now?: () => Date;
}

export class Thread {
  private readonly messages: ThreadMessage[] = [];
  private queue: Promise<void> = Promise.resolve();
  private seq = 0;
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Replay an existing thread file, or start empty when it does not exist. */
  static async load(filePath: string): Promise<Thread> {
    const thread = new Thread(filePath);
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch {
      return thread; // new session — empty thread
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let record: ThreadMessage;
      try {
        record = JSON.parse(trimmed) as ThreadMessage;
      } catch {
        // A torn final line (crash mid-write) is trailing garbage, not truth —
        // skip it rather than poisoning the whole replay.
        continue;
      }
      if (record && typeof record === 'object' && typeof record.role === 'string') {
        thread.messages.push(record);
      }
    }
    thread.seq = thread.messages.length;
    return thread;
  }

  get size(): number {
    return this.messages.length;
  }

  all(): readonly ThreadMessage[] {
    return this.messages;
  }

  /** Records after the given index — used by incremental UI projection. */
  since(index: number): readonly ThreadMessage[] {
    return this.messages.slice(Math.max(0, index));
  }

  /**
   * Append one record: updates memory immediately (the loop reads it back for
   * the next LLM call) and persists to the JSONL log asynchronously in order.
   */
  append(input: ThreadAppendInput): ThreadMessage {
    const now = (input.now ?? (() => new Date()))();
    this.seq += 1;
    const message: ThreadMessage = {
      id: `m${this.seq}`,
      ts: now.toISOString(),
      role: input.role,
      content: input.content,
      ...(input.toolCall ? { toolCall: input.toolCall } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.artifactRefs ? { artifactRefs: input.artifactRefs } : {}),
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
    };
    this.messages.push(message);
    const line = `${JSON.stringify(message)}\n`;
    this.queue = this.queue
      .then(() => mkdir(dirname(this.filePath), { recursive: true }))
      .then(() => appendFile(this.filePath, line, 'utf8'));
    return message;
  }

  /** Resolve once every queued append has been written. Call before exit/tests. */
  async flush(): Promise<void> {
    await this.queue;
  }
}

/** Canonical thread path for a session (design §2: agent-data/threads/<id>.jsonl). */
export function threadPath(dataRoot: string, sessionId: string): string {
  return join(dataRoot, 'threads', `${sessionId}.jsonl`);
}
