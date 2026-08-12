import assert from 'node:assert/strict';
import test from 'node:test';
import { matchingSlashCommands, parseSlashCommand } from '../src/runtime/slash-commands.mjs';

const skills = [{ id: 'inpaint', name: '局部重绘', aliases: ['局部重绘'], description: '修补图片', enabled: true }];

test('parses localized built-in commands', () => {
  assert.equal(parseSlashCommand('/压缩', skills).command.action, 'compact');
  assert.equal(parseSlashCommand('/context', skills).command.action, 'context');
});

test('parses localized skill commands and preserves prompt', () => {
  const parsed = parseSlashCommand('/局部重绘 去掉水印', skills);
  assert.equal(parsed.command.id, 'inpaint');
  assert.equal(parsed.argument, '去掉水印');
});

test('filters command menu before an argument is entered', () => {
  assert.deepEqual(matchingSlashCommands('/压', skills).map(item => item.id), ['compact']);
  assert.deepEqual(matchingSlashCommands('/inpaint 处理', skills), []);
});
