import { describe, expect, it } from 'vitest';

import { compact } from '../../src/agent/core-loop/context/compactor.js';
import { estimateMessagesTokens } from '../../src/agent/core-loop/context/budget.js';
import type { ChatMessage } from '../../src/agent/core-loop/core/types.js';

function bigToolMessage(id: string, size: number): ChatMessage {
  return { role: 'tool', toolCallId: id, toolName: 'search_node_types', content: 'x'.repeat(size) };
}

describe('compact', () => {
  it('is a no-op under the threshold', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello' },
    ];
    const outcome = compact(messages, { thresholdTokens: 10_000 });
    expect(outcome.compacted).toBe(false);
    expect(outcome.messages).toHaveLength(2);
  });

  it('clears old large tool results but keeps the system prompt and recent window', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'make an image' },
      bigToolMessage('a', 5_000),
      bigToolMessage('b', 5_000),
      bigToolMessage('c', 5_000),
      bigToolMessage('d', 5_000),
      { role: 'assistant', content: 'short preamble', toolCalls: [{ id: 'z', name: 't', arguments: {} }] },
      bigToolMessage('z', 60),
    ];
    const before = estimateMessagesTokens(messages);
    const outcome = compact(messages, { thresholdTokens: 500, keepRecent: 2 });

    expect(outcome.compacted).toBe(true);
    expect(outcome.afterTokens).toBeLessThan(outcome.beforeTokens);

    expect(outcome.messages[0]?.content).toBe('system prompt'); // untouched
    // keepRecent: 2 → the last two messages keep full content.
    expect(outcome.messages.at(-1)?.content.length).toBe(60);
    // Old big tool results are cleared.
    expect(outcome.messages[2]?.content).toContain('[cleared');
    expect(outcome.clearedMessages).toBe(4);
  });

  it('trims oversized assistant narration outside the recent window', () => {
    const longText = 'n'.repeat(3_000);
    const messages: ChatMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: longText },
      { role: 'assistant', content: 'recent' },
    ];
    const outcome = compact(messages, { thresholdTokens: 100, keepRecent: 1 });
    expect(outcome.messages[2]?.content).toContain('[trimmed]');
    expect((outcome.messages[2]?.content.length ?? 0)).toBeLessThan(220);
  });
});
