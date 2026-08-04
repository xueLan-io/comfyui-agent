import assert from 'node:assert/strict';
import test from 'node:test';
import { insertPromptPart, removePromptPart, reorderPromptPart, splitPromptParts, updatePromptWeight } from '../src/components/prompt-parser.mjs';

test('prompt parts keep commas inside balanced parentheses', () => {
  const parts = splitPromptParts('(masterpiece, best quality:1.2), blue eyes');

  assert.deepEqual(parts.map(part => part.source), ['(masterpiece, best quality:1.2)', 'blue eyes']);
  assert.equal(parts[0].raw, 'masterpiece, best quality');
  assert.equal(parts[0].weight, 1.2);
});

test('weight changes preserve the original weighted syntax', () => {
  const text = '(masterpiece, best quality:1.2), <lora:detail:0.8>';

  assert.equal(updatePromptWeight(text, 0, 0.1), '(masterpiece, best quality:1.3), <lora:detail:0.8>');
  assert.equal(updatePromptWeight(text, 1, 0.1), text);
});

test('implicit parentheses can be lowered without rewriting special syntax', () => {
  assert.equal(updatePromptWeight('(blue eyes), red hair', 0, -0.1), 'blue eyes, red hair');
  assert.equal(updatePromptWeight('<lora:detail:0.8>, red hair', 0, 0.1), '<lora:detail:0.8>, red hair');
});

test('prompt part removal keeps neighboring syntax intact', () => {
  const text = '(masterpiece, best quality:1.2), blue eyes, red hair';

  assert.equal(removePromptPart(text, 0), 'blue eyes, red hair');
  assert.equal(removePromptPart(text, 1), '(masterpiece, best quality:1.2), red hair');
  assert.equal(removePromptPart(text, 2), '(masterpiece, best quality:1.2), blue eyes');
});

test('prompt parts can be inserted beside an existing affinity group', () => {
  assert.equal(insertPromptPart('face, hair', 'eyes', 1), 'face, eyes, hair');
  assert.equal(insertPromptPart('face, hair', 'eyes'), 'face, hair, eyes');
});

test('prompt parts can be reordered without losing weighted syntax', () => {
  const text = '(face:1.2), hair, eyes';
  assert.equal(reorderPromptPart(text, 2, 0), 'eyes, (face:1.2), hair');
  assert.equal(reorderPromptPart(text, 0, 2), 'hair, eyes, (face:1.2)');
});
