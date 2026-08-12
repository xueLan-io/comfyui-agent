import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/agent/runtime/agent.mjs';
import { AgentEventTypes, on } from '../src/agent/events/agent-events.mjs';

test('Agent chat applies local preference, 1024 output budget, and context window', async () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'test-model', apiKey: 'test-key' } });
  let request;
  agent.llm = {
    isConfigured: true,
    getContextWindow: () => 128,
    async chat(input) {
      request = input;
      return { content: '好的' };
    },
  };

  await agent.chat('你好');

  assert.equal(request.prefer, undefined);
  assert.equal(request.maxTokens, 1024);
  assert.ok(request.messages.length >= 1);
  assert.ok(request.messages[0].role === 'system');
});

test('Agent chat separates response language from local workflow prompt language', async () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'test-model', apiKey: 'test-key' } });
  let request;
  agent.llm = {
    isConfigured: true,
    getContextProfile: () => ({ mode: 'local', contextWindow: 4096, maxInputTokens: 4096, maxRecentTurns: 20 }),
    async chat(input) {
      request = input;
      return { content: 'ok' };
    },
  };

  await agent.chat('帮我写一个提示词', {
    intent: 'prompt_edit',
    workflowManifest: {
      workflowName: 'local.json',
      promptProfile: { family: 'anima', format: 'tag_narrative', supportsNegative: true },
    },
  });

  const system = String(request.messages[0].content);
  assert.match(system, /解释、建议和问题使用用户的语言/);
  assert.match(system, /正向和负向提示词使用英文且不混用中文/);
});

test('Agent chat uses the persisted turn message ID for streamed replies', async () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'test-model', apiKey: 'test-key' } });
  agent.llm = {
    isConfigured: true,
    getContextProfile: () => ({ mode: 'local', contextWindow: 4096, maxInputTokens: 4096, maxRecentTurns: 20 }),
    async chat({ onChunk }) {
      onChunk('partial response');
      return { content: 'partial response' };
    },
  };
  const messages = [];
  const unsubscribe = on(AgentEventTypes.MESSAGE, message => messages.push(message));

  try {
  await agent.chat('你好', { turnId: 'turn_stream_test' });
  } finally {
    unsubscribe();
  }

  const assistantMessages = messages.filter(message => message.role === 'agent');
  assert.equal(assistantMessages.length, 2);
  assert.deepEqual(assistantMessages.map(message => message.messageId), [
    'turn_stream_test:agent',
    'turn_stream_test:agent',
  ]);
  assert.equal(assistantMessages[0].delta, 'partial response');
  assert.equal(assistantMessages[0].sequence, 0);
  assert.equal(assistantMessages.at(-1).done, true);
  assert.equal(agent.taskManager.get(assistantMessages.at(-1).taskId).turnId, 'turn_stream_test');
});

test('a second turn streams under its own task after intent policy checks', async () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'test-model', apiKey: 'test-key' } });
  agent.llm = {
    isConfigured: true,
    getContextProfile: () => ({ mode: 'cloud', contextWindow: 4096, maxInputTokens: 4096, maxRecentTurns: 20 }),
    async chat({ onChunk }) {
      onChunk('reply');
      return { content: 'reply' };
    },
  };
  const events = [];
  const unsubscribe = on(AgentEventTypes.MESSAGE, event => events.push(event));
  try {
    await agent.chat('first turn', { turnId: 'turn_first' });
    const firstTaskId = agent._taskId;
    agent._policyPreprocessing = true;
    agent.llm.setPolicyStateHandler?.({ state: 'reviewing' });
    agent._policyPreprocessing = false;
    await agent.chat('second turn', { turnId: 'turn_second' });

    const secondStream = events.find(event => event.turnId === 'turn_second' && event.streaming);
    assert.ok(secondStream);
    assert.notEqual(secondStream.taskId, firstTaskId);
    assert.equal(secondStream.taskId, agent._taskId);
  } finally {
    unsubscribe();
  }
});

test('pre-processing policy progress never inherits a completed task identity', () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'test-model', apiKey: 'test-key' } });
  agent._taskId = 'completed_task';
  agent._traceId = 'completed_trace';
  agent._policyPreprocessing = true;
  const events = [];
  const unsubscribe = on(AgentEventTypes.PROGRESS, event => events.push(event));
  try {
    agent.llm._policyStateHandler({ state: 'reviewing' });
    agent.llm._policyStateHandler({ state: 'cloud_allowed' });
    agent.llm._policyStateHandler({ state: 'idle' });
  } finally {
    unsubscribe();
  }

  assert.equal(events.length, 3);
  assert.deepEqual(events.map(event => event.taskId), ['', '', '']);
  assert.deepEqual(events.map(event => event.traceId), ['', '', '']);
});

test('Agent chat retries once when a cloud model returns empty text', async () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'test-model', apiKey: 'test-key' } });
  let calls = 0;
  const requests = [];
  agent.llm = {
    isConfigured: true,
    getContextProfile: () => ({ mode: 'cloud', contextWindow: 4096, maxInputTokens: 4096, maxRecentTurns: 20 }),
    async chat(input) {
      calls += 1;
      requests.push(input.messages);
      return { content: calls === 1 ? '' : 'recovered reply' };
    },
  };

  const result = await agent.chat('show reply types');

  assert.equal(calls, 2);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(result.response, 'recovered reply');
});

test('Agent chat retries a transient provider failure without changing messages', async () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'test-model', apiKey: 'test-key' } });
  const requests = [];
  agent.llm = {
    isConfigured: true,
    getContextProfile: () => ({ mode: 'cloud', contextWindow: 4096, maxInputTokens: 4096, maxRecentTurns: 20 }),
    async chat(input) {
      requests.push(input.messages);
      if (requests.length === 1) {
        const error = new Error('connection reset');
        error.code = 'LLM_NETWORK_ERROR';
        throw error;
      }
      return { content: 'recovered reply' };
    },
  };

  const result = await agent.chat('show reply types');

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(result.response, 'recovered reply');
});

test('Agent chat clears a partial stream before retrying it', async () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'test-model', apiKey: 'test-key' } });
  let calls = 0;
  agent.llm = {
    isConfigured: true,
    getContextProfile: () => ({ mode: 'cloud', contextWindow: 4096, maxInputTokens: 4096, maxRecentTurns: 20 }),
    async chat({ onChunk }) {
      calls += 1;
      if (calls === 1) {
        onChunk('partial');
        const error = new Error('stream interrupted');
        error.code = 'LLM_STREAM_INTERRUPTED';
        throw error;
      }
      onChunk('complete');
      return { content: 'complete' };
    },
  };
  const messages = [];
  const unsubscribe = on(AgentEventTypes.MESSAGE, message => messages.push(message));
  try {
    await agent.chat('retry stream', { turnId: 'turn_retry_stream' });
  } finally {
    unsubscribe();
  }

  assert.equal(calls, 2);
  assert.equal(messages.filter(message => message.role === 'agent').at(-1).content, 'complete');
  assert.ok(messages.some(message => message.streaming && message.reset === true));
});

test('Agent chat reports a length-limited final stream', async () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'test-model', apiKey: 'test-key' } });
  agent.llm = {
    isConfigured: true,
    getContextProfile: () => ({ mode: 'cloud', contextWindow: 4096, maxInputTokens: 4096, maxRecentTurns: 20 }),
    async chat({ onChunk }) {
      onChunk('truncated reply');
      return { content: 'truncated reply', finishReason: 'length' };
    },
  };
  const messages = [];
  const unsubscribe = on(AgentEventTypes.MESSAGE, message => messages.push(message));
  try {
    await agent.chat('long answer', { turnId: 'turn_length_limit' });
  } finally {
    unsubscribe();
  }

  const final = messages.at(-1);
  assert.equal(final.finishReason, 'length');
  assert.equal(final.outputTruncated, true);
});

test('Agent chat escalates the output budget when a reasoning model exhausts it on thinking', async () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'test-model', apiKey: 'test-key' } });
  let calls = 0;
  const requests = [];
  agent.llm = {
    isConfigured: true,
    getContextProfile: () => ({ mode: 'cloud', contextWindow: 4096, maxInputTokens: 4096, maxRecentTurns: 20 }),
    async chat(input) {
      calls += 1;
      requests.push(input);
      if (calls === 1) {
        return { content: '', finishReason: 'length' };
      }
      return { content: 'recovered after budget bump' };
    },
  };

  const result = await agent.chat('show reply types');

  assert.equal(calls, 2);
  assert.ok(requests[1].maxTokens > requests[0].maxTokens, 'retry must use a larger output budget');
  assert.equal(requests[1].reasoningEffort, 'low');
  assert.equal(result.response, 'recovered after budget bump');
});

test('Agent chat surfaces an unrecoverable budget-exhausted empty response as a failure', async () => {
  const agent = new Agent({ llmConfig: { provider: 'openai-compatible', model: 'test-model', apiKey: 'test-key' } });
  agent.llm = {
    isConfigured: true,
    getContextProfile: () => ({ mode: 'cloud', contextWindow: 4096, maxInputTokens: 4096, maxRecentTurns: 20 }),
    async chat() {
      return { content: '', finishReason: 'length' };
    },
  };

  await assert.rejects(
    agent.chat('show reply types'),
    error => error.code === 'EMPTY_MODEL_RESPONSE',
  );
});
