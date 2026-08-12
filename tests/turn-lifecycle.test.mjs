import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/agent/runtime/agent.mjs';
import { ConversationMemory } from '../src/agent/memory/conversation.mjs';
import { normalizeIntentDecision } from '../src/agent/schemas/intent-schema.mjs';
import { AgentEventTypes, on } from '../src/agent/events/agent-events.mjs';

function fakeTurnAgent(decisions) {
  const agent = Object.create(Agent.prototype);
  const state = { pending: null, sessionMemory: {} };
  const conversation = new ConversationMemory();
  Object.assign(agent, {
    _state: 'idle',
    sessionManager: {
      conversation,
      getSessionState: () => state,
      setSessionState(patch) {
        Object.assign(state, patch);
        return state;
      },
      getSessionMemory: () => state.sessionMemory,
    },
    routeIntent: async () => decisions.shift(),
    clarify(message, decision) {
      const response = decision.question || '请补充信息';
      this._writeTurnMessage('agent', response, { kind: 'clarification' }, decision.sourceTurnId);
      state.pending = { request: decision.request || message, intent: decision.intent, question: response };
      return { response, missing: decision.missing || [] };
    },
    chat: async function chat(message, options) {
      this._writeTurnMessage('agent', `reply:${message}`, { kind: 'reply' }, options.turnId);
      return { response: `reply:${message}` };
    },
    prepareGeneration: async () => ({ previewId: 'preview_test', positive: 'a cat' }),
  });
  return agent;
}

test('intent protocol normalizes query and confirmation fields', () => {
  const decision = normalizeIntentDecision({
    intent: 'runtime_query',
    action: 'reply',
    target: 'last_prompt',
    slots: { parameters: { steps: 20 } },
    confidence: 1.2,
    requiresConfirmation: true,
    sourceTurnId: 'turn_1',
  });
  assert.equal(decision.intent, 'query');
  assert.equal(decision.action, 'reply');
  assert.equal(decision.confidence, 1);
  assert.deepEqual(decision.slots.parameters, { steps: 20 });
  assert.equal(decision.requiresConfirmation, true);
  assert.equal(decision.sourceTurnId, 'turn_1');
});

test('intent protocol keeps the model execution decision', () => {
  const decision = normalizeIntentDecision({
    intent: 'generate',
    action: 'prepare',
    execution: { kind: 'video', needsResearch: true, needsConfirmation: true },
  });
  assert.deepEqual(decision.execution, { kind: 'video', needsResearch: true, needsConfirmation: true });
});

test('handleTurn preserves an LLM generation prepare decision in creative mode', async () => {
  const agent = fakeTurnAgent([
    { intent: 'chat', action: 'reply', target: 'none', missing: [], confidence: 0.9 },
    { intent: 'generate', action: 'prepare', target: 'new', missing: [], confidence: 0.9 },
  ]);

  const reply = await agent.handleTurn({ text: 'explain the workflow', modeHint: 'generate' });
  const preview = await agent.handleTurn({ text: 'make a cat', modeHint: 'creative' });
  const messages = agent.conversation.toJSON();

  assert.equal(reply.action, 'reply');
  assert.equal(preview.action, 'prepare');
  assert.equal(messages.filter(message => message.role === 'user').length, 2);
  assert.equal(messages.filter(message => message.role === 'agent').length, 1);
  assert.equal(messages[0].modeHint, 'generate');
  assert.equal(messages[2].modeHint, 'creative');
});

test('handleTurn returns cancellation instead of a generation preview', async () => {
  const agent = fakeTurnAgent([
    { intent: 'generate', action: 'prepare', target: 'new', missing: [], confidence: 0.9 },
  ]);
  agent.prepareGeneration = async () => ({ cancelled: true, taskId: 'task_cancelled' });

  const result = await agent.handleTurn({ text: 'make a cat', modeHint: 'creative' });

  assert.equal(result.action, 'cancelled');
  assert.equal(result.taskId, 'task_cancelled');
  assert.equal(result.preview, undefined);
});

test('handleTurn marks explicit cancellation as cancelled in turn timing', async () => {
  const agent = fakeTurnAgent([
    { intent: 'cancel', action: 'reply', target: 'current', missing: [], confidence: 1 },
  ]);
  agent.cancel = async () => ({ cancelled: true, taskId: 'task_cancelled' });
  const events = [];
  const unsubscribe = on(AgentEventTypes.PROGRESS, event => {
    if (event.scope === 'timing' && event.turnId === 'turn_timing_cancel') events.push(event);
  });

  try {
    const result = await agent.handleTurn({ text: 'cancel this', turnId: 'turn_timing_cancel' });
    assert.equal(result.action, 'reply');
  } finally {
    unsubscribe();
  }

  assert.equal(events.at(-1).stage, 'turn_end');
  assert.equal(events.at(-1).outcome, 'cancelled');
});

test('handleTurn emits paired timing events for intent and turn lifecycles', async () => {
  const agent = fakeTurnAgent([
    { intent: 'chat', action: 'reply', target: 'none', missing: [], confidence: 0.9 },
  ]);
  const events = [];
  const unsubscribe = on(AgentEventTypes.PROGRESS, event => {
    if (event.scope === 'timing' && event.turnId === 'turn_timing') events.push(event);
  });

  try {
    await agent.handleTurn({ text: 'explain the workflow', turnId: 'turn_timing' });
  } finally {
    unsubscribe();
  }

  assert.deepEqual(events.map(event => event.stage), ['turn_start', 'intent_start', 'intent_end', 'turn_end']);
  assert.deepEqual(events.filter(event => event.stage.endsWith('_end')).map(event => event.outcome), ['completed', 'completed']);
  for (const event of events.filter(event => event.stage.endsWith('_end'))) {
    assert.equal(event.turnId, 'turn_timing');
    assert.equal(typeof event.duration_ms, 'number');
    assert.ok(event.duration_ms >= 0);
  }
});

test('handleTurn closes timing events when intent routing fails', async () => {
  const agent = fakeTurnAgent([]);
  agent.routeIntent = async () => {
    throw new Error('intent unavailable');
  };
  const events = [];
  const unsubscribe = on(AgentEventTypes.PROGRESS, event => {
    if (event.scope === 'timing' && event.turnId === 'turn_timing_error') events.push(event);
  });

  try {
    await assert.rejects(agent.handleTurn({ text: 'make a cat', turnId: 'turn_timing_error' }), /intent unavailable/);
  } finally {
    unsubscribe();
  }

  assert.deepEqual(events.map(event => event.stage), ['turn_start', 'intent_start', 'intent_end', 'turn_end']);
  assert.deepEqual(events.filter(event => event.stage.endsWith('_end')).map(event => event.outcome), ['error', 'error']);
});

test('clarification follow-up is a new turn without duplicating the original user message', async () => {
  const agent = fakeTurnAgent([
    { intent: 'generate', action: 'clarify', target: 'new', missing: ['subject'], question: 'What should I generate?' },
    { intent: 'generate', action: 'prepare', target: 'new', missing: [], confidence: 1 },
  ]);

  const first = await agent.handleTurn({ text: 'generate something', modeHint: 'creative' });
  const second = await agent.handleTurn({ text: 'a cat', modeHint: 'creative' });
  const messages = agent.conversation.toJSON();

  assert.equal(first.action, 'clarify');
  assert.equal(second.action, 'prepare');
  assert.deepEqual(messages.filter(message => message.role === 'user').map(message => message.content), ['generate something', 'a cat']);
  assert.equal(messages.filter(message => message.role === 'agent').length, 1);
});

test('handleTurn persists attachment metadata without local paths', async () => {
  const agent = fakeTurnAgent([
    { intent: 'chat', action: 'reply', target: 'none', missing: [], confidence: 0.9 },
  ]);

  await agent.handleTurn({
    text: 'describe this reference',
    media: {
      images: [{ path: 'C:\\private\\reference.png', name: 'reference.png', kind: 'image' }],
      videos: [{ path: 'C:\\private\\clip.mp4', name: 'clip.mp4', kind: 'video' }],
    },
  });

  assert.deepEqual(agent.conversation.messages[0].attachments, [
    { name: 'reference.png', kind: 'image' },
    { name: 'clip.mp4', kind: 'video' },
  ]);
  assert.equal(JSON.stringify(agent.conversation.messages).includes('private'), false);
});

test('handleTurn accepts an image-only turn', async () => {
  const agent = fakeTurnAgent([
    { intent: 'chat', action: 'reply', target: 'none', missing: [], confidence: 0.9 },
  ]);

  const result = await agent.handleTurn({
    text: '',
    media: { images: [{ path: 'C:\\private\\reference.png', name: 'reference.png', kind: 'image' }] },
  });

  assert.equal(result.action, 'reply');
  assert.equal(agent.conversation.messages[0].content, '请结合这张图片继续处理我的请求。');
  assert.deepEqual(agent.conversation.messages[0].attachments, [{ name: 'reference.png', kind: 'image' }]);
});
