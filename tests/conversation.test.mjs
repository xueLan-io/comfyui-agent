import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationMemory } from '../src/agent/memory/conversation.mjs';
import { fitMessagesToContext } from '../src/agent/llm/provider.mjs';

test('add message', () => {
  const convo = new ConversationMemory();
  convo.add('user', 'hello');
  assert.equal(convo.length, 1);
  assert.equal(convo.messages[0].role, 'user');
  assert.equal(convo.messages[0].content, 'hello');
  assert.ok(convo.messages[0].ts > 0);
});

test('maxMessages truncates oldest', () => {
  const convo = new ConversationMemory(3);
  convo.add('user', 'a');
  convo.add('user', 'b');
  convo.add('user', 'c');
  convo.add('user', 'd');
  assert.equal(convo.length, 3);
  assert.equal(convo.messages[0].content, 'b');
  assert.equal(convo.messages[2].content, 'd');
});

test('getMessages with since filter', (_, done) => {
  const convo = new ConversationMemory();
  convo.add('user', 'a');
  const firstTs = convo.messages[0].ts;
  setTimeout(() => {
    convo.add('user', 'b');
    const recent = convo.getMessages({ since: firstTs });
    assert.equal(recent.length, 1);
    assert.equal(recent[0].content, 'b');
    done();
  }, 10);
});

test('getMessages with limit', () => {
  const convo = new ConversationMemory();
  convo.add('user', 'a');
  convo.add('user', 'b');
  convo.add('user', 'c');
  const last2 = convo.getMessages({ limit: 2 });
  assert.equal(last2.length, 2);
  assert.equal(last2[0].content, 'b');
});

test('getLLMMessages maps agent to assistant', () => {
  const convo = new ConversationMemory();
  convo.add('user', 'q');
  convo.add('agent', 'a');
  const llm = convo.getLLMMessages();
  assert.equal(llm[0].role, 'user');
  assert.equal(llm[1].role, 'assistant');
  assert.equal(llm[1].content, 'a');
});

test('context fitting retains the newest user request beside an oversized system prompt', () => {
  const messages = [
    { role: 'system', content: 'system '.repeat(400) },
    { role: 'user', content: 'previous question '.repeat(100) },
    { role: 'assistant', content: 'previous answer '.repeat(100) },
    { role: 'user', content: 'current request must remain visible' },
  ];

  const fitted = fitMessagesToContext(messages, 300);

  assert.equal(fitted.at(-1).role, 'user');
  assert.match(fitted.at(-1).content, /current request must remain visible/);
});

test('clear empties messages', () => {
  const convo = new ConversationMemory();
  convo.add('user', 'x');
  convo.clear();
  assert.equal(convo.length, 0);
});

test('rewind removes the edited message and all following context', () => {
  const convo = new ConversationMemory();
  convo.add('user', 'first');
  convo.add('agent', 'reply');
  convo.add('user', 'old follow-up');
  assert.equal(convo.rewind(2), true);
  assert.deepEqual(convo.messages.map(message => message.content), ['first', 'reply']);
  assert.equal(convo.rewind(8), false);
});

test('loadFrom and toJSON roundtrip', () => {
  const convo = new ConversationMemory();
  convo.add('user', 'saved');
  const json = convo.toJSON();
  const convo2 = new ConversationMemory();
  convo2.loadFrom(json);
  assert.equal(convo2.length, 1);
  assert.equal(convo2.messages[0].content, 'saved');
});

test('onChange callback fires', () => {
  let called = false;
  const convo = new ConversationMemory(100, () => { called = true; });
  convo.add('user', 'trigger');
  assert.equal(called, true);
});

test('removes every message belonging to a cancelled turn', () => {
  const convo = new ConversationMemory();
  convo.add('user', 'prompt', { turnId: 'turn_cancelled' });
  convo.add('agent', 'error', { turnId: 'turn_cancelled' });
  convo.add('user', 'keep', { turnId: 'turn_keep' });

  assert.equal(convo.removeByTurnId('turn_cancelled'), 2);
  assert.deepEqual(convo.messages.map(message => message.content), ['keep']);
});

test('long conversation keeps recent messages without a task summary', () => {
  const convo = new ConversationMemory();
  for (let i = 1; i <= 12; i++) {
    convo.add('user', `目标 ${i}，seed ${i}，width ${i}`);
    convo.add('agent', `回复 ${i}`);
  }
  const llm = convo.getCompressedLLMMessages({ threshold: 8, recentCount: 6 });
  assert.equal(llm.length, 6);
  assert.equal(llm[0].role, 'user');
  assert.match(llm[0].content, /目标 10/);
  assert.equal(llm[5].content, '回复 12');
  assert.equal(llm.some(message => message.role === 'system'), false);
});
