import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';
import { PromptLibraryTool } from '../src/agent/tools/prompt-library/index.mjs';

const bundledData = new URL('../../prompts_collected/extracted/ALL_tag_metadata.tsv', import.meta.url);
const hasBundledData = await access(bundledData).then(() => true).catch(() => false);

test('prompt library searches English tags', async t => {
  if (!hasBundledData) return t.skip('optional prompt library data is not included in the source repository');
  const result = await PromptLibraryTool.execute({ query: 'cat_ears', limit: 5 });
  assert.equal(result.error, undefined);
  assert.ok(result.total > 0);
  assert.ok(result.results.some(item => item.tag === 'cat_ears'));
  assert.equal(result.results[0].translation, '猫耳');
});

test('prompt library searches Chinese translations', async t => {
  if (!hasBundledData) return t.skip('optional prompt library data is not included in the source repository');
  const result = await PromptLibraryTool.execute({ query: '猫耳', limit: 5 });
  assert.ok(result.total > 0);
  assert.ok(result.results.some(item => item.translation === '猫耳'));
});

test('prompt library filters by group', async t => {
  if (!hasBundledData) return t.skip('optional prompt library data is not included in the source repository');
  const result = await PromptLibraryTool.execute({ query: 'blue', group: '服装', limit: 5 });
  assert.ok(result.total > 0);
  for (const item of result.results) assert.equal(item.group, '服装');
});

test('prompt library limits results', async t => {
  if (!hasBundledData) return t.skip('optional prompt library data is not included in the source repository');
  const result = await PromptLibraryTool.execute({ query: 'hair', limit: 3 });
  assert.ok(result.results.length <= 3);
});

test('prompt library lists groups', async t => {
  if (!hasBundledData) return t.skip('optional prompt library data is not included in the source repository');
  const result = await PromptLibraryTool.execute({ action: 'groups' });
  assert.ok(result.groups.length >= 80);
  const characters = result.groups.find(item => item.group === '角色与作品');
  assert.ok(characters && characters.count > 10000);
});

test('prompt library returns error for missing data', async () => {
  const original = process.env.COMFY_AGENT_PROMPT_LIB_DIR;
  process.env.COMFY_AGENT_PROMPT_LIB_DIR = 'C:\\nonexistent\\dir';
  const { PromptLibraryTool: reloaded } = await import(`../src/agent/tools/prompt-library/index.mjs?fresh=${Date.now()}`);
  const result = await reloaded.execute({ query: 'cat' });
  assert.ok(result.error);
  if (original === undefined) delete process.env.COMFY_AGENT_PROMPT_LIB_DIR;
  else process.env.COMFY_AGENT_PROMPT_LIB_DIR = original;
});
