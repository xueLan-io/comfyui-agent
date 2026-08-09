import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeExternalSkill, validateExternalSkill } from '../src/agent/skills/external.mjs';
import { configureSkills, matchSkill } from '../src/agent/skills/index.mjs';

const manifest = {
  id: 'comic-panel',
  name: 'Comic Panel',
  description: 'Generate a comic panel with a fixed workflow.',
  keywords: ['comic', '漫画分镜'],
  target: { tool: 'comfyui', workflowName: 'comic.json', promptMode: 'concept', settings: { width: 768, height: 1024, batch: 2 } },
};

test('external Skill manifests are validated and become safe plans', () => {
  assert.equal(validateExternalSkill(manifest).valid, true);
  const skill = normalizeExternalSkill(manifest, 'fixture.json');
  assert.equal(skill.external, true);
  assert.equal(skill.source, 'fixture.json');
  const step = skill.steps('two heroes').at(-1);
  assert.equal(step.input.workflowName, 'comic.json');
  assert.deepEqual(step.input.settings, { width: 768, height: 1024, batch: 2 });
  assert.equal(skill.steps('two heroes', { workflowName: 'other.json' }).at(-1).input.workflowName, 'comic.json');
});

test('external Skill routing uses keywords and never loads executable code', () => {
  configureSkills({ systemEnabled: { txt2img: true }, custom: [], external: [manifest] });
  assert.equal(matchSkill('make a comic panel').name, 'comic-panel');
  configureSkills({ systemEnabled: { txt2img: true }, custom: [], external: [] });
});

test('invalid external targets are rejected', () => {
  assert.equal(validateExternalSkill({ ...manifest, target: { tool: 'shell' } }).valid, false);
  assert.equal(validateExternalSkill({ ...manifest, target: { workflowName: '../secret.json' } }).valid, false);
});
