import assert from 'node:assert/strict';
import test from 'node:test';
import { TEMPLATES, TEMPLATE_GROUPS } from '../src/provider-templates.js';

const SUPPORTED_TYPES = new Set(['ollama', 'openai-compatible']);

test('every provider template uses a type the runtime can execute', () => {
  for (const [key, template] of Object.entries(TEMPLATES)) {
    assert.ok(SUPPORTED_TYPES.has(template.type), `${key}: unsupported type "${template.type}"`);
  }
});

test('every provider template has the required shape', () => {
  for (const [key, template] of Object.entries(TEMPLATES)) {
    assert.equal(typeof template.id, 'string', `${key}: missing id`);
    assert.ok(template.id, `${key}: empty id`);
    assert.equal(typeof template.name, 'string', `${key}: missing name`);
    assert.ok(template.name, `${key}: empty name`);
    assert.equal(typeof template.baseUrl, 'string', `${key}: missing baseUrl`);
    // The explicit "Custom Provider" template intentionally starts with an
    // empty baseUrl that the user fills in; every other template must be usable
    // as-is.
    if (key !== 'customprovider') {
      assert.ok(/^https?:\/\/.+/i.test(template.baseUrl), `${key}: invalid baseUrl "${template.baseUrl}"`);
    }
    assert.ok(Array.isArray(template.models) && template.models.length > 0, `${key}: no models`);
    for (const model of template.models) {
      assert.equal(typeof model.id, 'string', `${key}: model missing id`);
      if (key !== 'customprovider') assert.ok(model.id, `${key}: empty model id`);
    }
  }
});

test('template keys are unique', () => {
  const keys = Object.keys(TEMPLATES);
  assert.equal(new Set(keys).size, keys.length);
});

test('every TEMPLATE_GROUPS entry references an existing template and every template is grouped', () => {
  const grouped = new Set();
  for (const group of TEMPLATE_GROUPS) {
    assert.ok(group.key && group.labelKey, 'group missing key/labelKey');
    for (const id of group.ids) {
      assert.ok(TEMPLATES[id], `group "${group.key}" references unknown template "${id}"`);
      assert.ok(!grouped.has(id), `template "${id}" listed in more than one group`);
      grouped.add(id);
    }
  }
  for (const key of Object.keys(TEMPLATES)) {
    assert.ok(grouped.has(key), `template "${key}" is not listed in any group`);
  }
});

test('no duplicate (name, baseUrl) pairs across templates', () => {
  const seen = new Set();
  for (const [key, template] of Object.entries(TEMPLATES)) {
    const pair = `${template.name}||${template.baseUrl}`;
    assert.ok(!seen.has(pair), `duplicate template pair "${pair}" (${key})`);
    seen.add(pair);
  }
});
