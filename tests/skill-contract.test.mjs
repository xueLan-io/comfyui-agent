import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSkill } from '../src/agent/skills/skill-contract.mjs';
import { createSkillRegistry } from '../src/agent/skills/registry.mjs';
import { matchSkills } from '../src/agent/skills/matcher.mjs';
import { validatePlan } from '../src/agent/schemas/plan-schema.mjs';

test('legacy steps are adapted while explicit plan takes precedence', () => {
  const legacy = normalizeSkill({ name: 'Legacy', description: 'legacy', keywords: ['legacy'], steps: () => [{ tool: 'comfyui', expected_output: 'images' }] }, 'legacy');
  assert.equal(legacy.plan('x').steps.length, 1);
  const modern = normalizeSkill({ id: 'modern', name: 'Modern', description: 'modern', plan: () => ({ steps: [] }) });
  assert.deepEqual(modern.plan('x').steps, []);
});

test('registry rejects duplicate ids and matcher reports required media', () => {
  const skill = { id: 'inpaint', name: 'Inpaint', description: 'x', keywords: ['inpaint'], requirements: { media: [{ type: 'image', required: true }] }, steps: () => [] };
  assert.throws(() => createSkillRegistry({ builtin: { inpaint: skill }, custom: [skill] }), /Duplicate/);
  const registry = createSkillRegistry({ builtin: { inpaint: skill } });
  const result = matchSkills(registry.all(), 'inpaint this image', { attachedMedia: {} });
  assert.equal(result.clarification.reason, 'required_media_missing');
});

test('clarification plans are valid and empty executable steps are rejected otherwise', () => {
  assert.equal(validatePlan({ goal: 'need image', steps: [], metadata: { status: 'clarify' } }).valid, true);
  assert.equal(validatePlan({ goal: 'need image', steps: [] }).valid, false);
});
