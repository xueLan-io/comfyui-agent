import type { ChatMessage, ToolDescriptor } from '../core/types.ts';

/**
 * Conservative token estimate.
 *
 * Deliberately not a real tokenizer: a tokenizer adds a dependency and is
 * model-specific, while this only needs to be good enough to trigger compaction
 * *before* the true limit. ~4 chars/token is the standard heuristic, and we
 * round up so the estimate errs high.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4) + 1;
}

export function estimateMessageTokens(message: ChatMessage): number {
  let total = 4; // per-message role/format overhead
  total += estimateTokens(message.content);
  if (message.toolCalls) {
    for (const call of message.toolCalls) {
      total += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.arguments));
    }
  }
  return total;
}

export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}

/**
 * Tool descriptors occupy context on every single call, which is why the
 * research notes push for few, small tools (docs/research/2026-landscape.md §2).
 */
export function estimateToolTokens(tools: readonly ToolDescriptor[]): number {
  let total = 0;
  for (const tool of tools) {
    total += estimateTokens(tool.name) + estimateTokens(tool.description);
    total += estimateTokens(JSON.stringify(tool.inputSchema));
  }
  return total;
}

export function estimateContextTokens(
  messages: readonly ChatMessage[],
  tools: readonly ToolDescriptor[],
): number {
  return estimateMessagesTokens(messages) + estimateToolTokens(tools);
}
