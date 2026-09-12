import type { ChatMessage } from '../core/types.ts';
import { KEEP_RECENT_MESSAGES, MAX_TOOL_RESULT_CHARS } from './assembler.ts';
import { estimateMessagesTokens } from './budget.ts';

/**
 * Context compaction.
 *
 * The research notes (§2) describe three long-horizon techniques: compaction,
 * structured note-taking, and sub-agents. This module implements the light form
 * — "tool result clearing" — plus trimming of stale assistant preamble. Notes
 * live in `scratchpad.ts`; sub-agents are out of scope (ADR 0004).
 *
 * Why not an LLM summarizer here: it would cost a model call per compaction and
 * introduce nondeterminism into the regression suite, while the real bloat in
 * this agent is *tool results* (node schemas, catalogue slices), not
 * conversation. Clearing those is deterministic, free, and sufficient. A
 * summarizer is the natural upgrade if conversational history ever grows.
 */

export interface CompactionConfig {
  /** Trigger compaction above this many estimated tokens. */
  thresholdTokens: number;
  /** Messages at the tail that are never modified. */
  keepRecent?: number;
}

export interface CompactionOutcome {
  messages: ChatMessage[];
  compacted: boolean;
  beforeTokens: number;
  afterTokens: number;
  /** How many messages were rewritten. */
  clearedMessages: number;
}

/** A cleared tool result is replaced with this shape, retaining the tool name. */
function clearedPlaceholder(message: ChatMessage): string {
  const size = message.content.length;
  return `[cleared ${message.toolName ?? 'tool'} result: ${size} chars omitted]`;
}

export function compact(
  messages: readonly ChatMessage[],
  config: CompactionConfig,
): CompactionOutcome {
  const beforeTokens = estimateMessagesTokens(messages);
  const keepRecent = config.keepRecent ?? KEEP_RECENT_MESSAGES;

  if (beforeTokens <= config.thresholdTokens) {
    return {
      messages: [...messages],
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
      clearedMessages: 0,
    };
  }

  // Never touch the system prompt or the most recent turns: the system prompt
  // carries the rules, and recent turns carry the active goal.
  const cutoff = Math.max(1, messages.length - keepRecent);
  let cleared = 0;

  const next = messages.map((message, index) => {
    if (index === 0) return message; // system prompt
    if (index >= cutoff) return message; // recent window

    if (message.role === 'tool' && message.content.length > 180) {
      cleared += 1;
      return { ...message, content: clearedPlaceholder(message) };
    }

    // Long assistant narration is low-signal once its tool calls are done.
    if (message.role === 'assistant' && message.content.length > MAX_TOOL_RESULT_CHARS / 2) {
      cleared += 1;
      return { ...message, content: `${message.content.slice(0, 200)}… [trimmed]` };
    }

    return message;
  });

  const afterTokens = estimateMessagesTokens(next);
  return {
    messages: next,
    compacted: cleared > 0,
    beforeTokens,
    afterTokens,
    clearedMessages: cleared,
  };
}
