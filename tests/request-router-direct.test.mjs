import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/agent/runtime/agent.mjs';
import { IntentRouter, ruleIntent } from '../src/agent/runtime/intent-router.mjs';

test('ordinary generation language is delegated to the LLM', () => {
  assert.equal(ruleIntent('I want a cyberpunk portrait'), null);
});

test('explicit AI generation has an offline fallback', () => {
  const decision = ruleIntent('AI generate a cyberpunk portrait', { aiAvailable: false });
  assert.equal(decision.intent, 'generate');
  assert.equal(decision.action, 'prepare');
});

test('Agent route preserves explicit AI generation when the model is offline', async () => {
  const agent = Object.create(Agent.prototype);
  agent.intentRouter = new IntentRouter(null);
  agent.sessionManager = {
    conversation: { getLLMMessages: () => [] },
    getSessionState: () => ({ phase: 'idle', pending: null }),
    project: { get: () => undefined },
  };
  const decision = await agent.routeIntent('AI generate', { media: null });
  assert.equal(decision.action, 'prepare');
  assert.equal(decision.intent, 'generate');
});
