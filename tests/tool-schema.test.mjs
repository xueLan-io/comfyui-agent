import assert from 'node:assert/strict';
import test from 'node:test';
import { validateToolDefinition, validateToolInput } from '../src/agent/schemas/tool-schema.mjs';

test('validateToolDefinition passes valid tool', () => {
  const tool = {
    name: 'test_tool',
    description: 'A test',
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    side_effects: [],
    requires_confirmation: false,
    idempotent: true,
    retry: { mode: 'never' },
    execute() {},
  };
  const result = validateToolDefinition(tool);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test('validateToolDefinition rejects missing name', () => {
  const tool = { description: 'No name', input_schema: {}, execute() {} };
  const result = validateToolDefinition(tool);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('name')));
});

test('validateToolInput passes valid input', () => {
  const tool = {
    input_schema: {
      type: 'object',
      properties: { prompt: { type: 'string' } },
      required: ['prompt'],
    },
  };
  const result = validateToolInput(tool, { prompt: 'hello' });
  assert.equal(result.valid, true);
});

test('validateToolInput catches missing required', () => {
  const tool = {
    input_schema: {
      type: 'object',
      properties: { prompt: { type: 'string' } },
      required: ['prompt'],
    },
  };
  const result = validateToolInput(tool, {});
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('prompt')));
});

test('validateToolInput catches type mismatch', () => {
  const tool = {
    input_schema: {
      type: 'object',
      properties: { count: { type: 'number' } },
    },
  };
  const result = validateToolInput(tool, { count: 'not a number' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('count')));
});

test('validateToolInput catches invalid enum', () => {
  const tool = {
    input_schema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['a', 'b'] } },
    },
  };
  const result = validateToolInput(tool, { mode: 'c' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('mode')));
});
