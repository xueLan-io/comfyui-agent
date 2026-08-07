import assert from 'node:assert/strict';
import test from 'node:test';
import { LLMProvider } from '../src/agent/llm/provider.mjs';
import { TaskManager } from '../src/agent/runtime/task-manager.mjs';

test('task trace persists schema and recovery metadata', () => {
  const manager = new TaskManager({ get: () => [], set() {}, async save() {} });
  manager.create({ id: 'task', projectId: 'p', sessionId: 's', traceId: 'trace' });
  manager.update('task', { recovery: { state: 'user_confirmation_required', attempts: 2, lastCheckedAt: 10 } });
  const trace = manager.getTrace('task');
  assert.equal(trace.taskSchemaVersion, 2);
  assert.equal(trace.recovery.state, 'user_confirmation_required');
});

test('LLM provider forwards caller signal to provider instance', async () => {
  let received;
  const provider = new LLMProvider({ providers: [{ id: 'cloud', name: 'Cloud', type: 'openai-compatible', baseUrl: 'http://example.test', apiKey: 'x', models: [{ id: 'model' }] }], active: { providerId: 'cloud', modelId: 'model', strategy: 'manual' } });
  const entry = provider._manual;
  entry.instance.chat = async options => { received = options.signal; return { content: 'ok' }; };
  const controller = new AbortController();
  await provider.chat({ messages: [{ role: 'user', content: 'x' }], signal: controller.signal });
  assert.equal(received, controller.signal);
});
