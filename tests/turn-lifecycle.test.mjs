import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/agent/runtime/agent.mjs';
import { ConversationMemory } from '../src/agent/memory/conversation.mjs';
import { normalizeIntentDecision } from '../src/agent/schemas/intent-schema.mjs';

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

test('handleTurn keeps modeHint as a preference and writes one user message per turn', async () => {
  const agent = fakeTurnAgent([
    { intent: 'chat', action: 'reply', target: 'none', missing: [], confidence: 0.9 },
    { intent: 'generate', action: 'prepare', target: 'new', missing: [], confidence: 0.9 },
  ]);

  const reply = await agent.handleTurn({ text: 'explain the workflow', modeHint: 'generate' });
  const preview = await agent.handleTurn({ text: 'make a cat', modeHint: 'answer' });
  const messages = agent.conversation.toJSON();

  assert.equal(reply.action, 'reply');
  assert.equal(preview.action, 'prepare');
  assert.equal(messages.filter(message => message.role === 'user').length, 2);
  assert.equal(messages.filter(message => message.role === 'agent').length, 1);
  assert.equal(messages[0].modeHint, 'generate');
  assert.equal(messages[2].modeHint, 'answer');
});

test('clarification follow-up is a new turn without duplicating the original user message', async () => {
  const agent = fakeTurnAgent([
    { intent: 'generate', action: 'clarify', target: 'new', missing: ['subject'], question: 'What should I generate?' },
    { intent: 'generate', action: 'prepare', target: 'new', missing: [], confidence: 1 },
  ]);

  const first = await agent.handleTurn({ text: 'generate something', modeHint: 'answer' });
  const second = await agent.handleTurn({ text: 'a cat', modeHint: 'answer' });
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
