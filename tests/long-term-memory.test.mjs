import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LongTermMemory, distillProfileSignals, hashText } from '../src/agent/memory/long-term.mjs';

async function memoryFile() {
  const dir = await mkdtemp(join(tmpdir(), 'comfy-memory-'));
  return { dir, path: join(dir, 'memory.json') };
}

const SAMPLE_SUMMARY = {
  objective: '生成一张夜色车站的动漫插画',
  decisions: ['确认使用 anima 工作流'],
  constraints: ['用户偏好高对比光效', '不要使用低质量标签'],
  completed: ['第一版构图已完成'],
  openItems: ['等待用户确认色调'],
  facts: ['用户喜欢冷色系风格', '避免过多文字元素'],
};

test('distillProfileSignals buckets facts into style/disliked/notes', () => {
  const signals = distillProfileSignals(SAMPLE_SUMMARY, 'anima.json');
  assert.ok(signals.styles.some(text => text.includes('高对比光效')));
  assert.ok(signals.styles.some(text => text.includes('冷色系风格')));
  assert.ok(signals.disliked.some(text => text.includes('不要使用低质量标签')));
  assert.ok(signals.disliked.some(text => text.includes('避免过多文字元素')));
  assert.deepEqual(signals.workflows, { 'anima.json': 1 });
});

test('captureSession stores a deduped segment and persists atomically', async () => {
  const { dir, path } = await memoryFile();
  try {
    const memory = new LongTermMemory({ filePath: path });
    await memory.init();
    const first = await memory.captureSession('project-a', { summary: SAMPLE_SUMMARY, workflowName: 'anima.json', sourceTurnId: 'turn-1' });
    assert.equal(first.captured, true);
    const duplicate = await memory.captureSession('project-a', { summary: SAMPLE_SUMMARY, workflowName: 'anima.json' });
    assert.deepEqual(duplicate, { captured: false, reason: 'duplicate' });
    const stored = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(stored.projects['project-a'].segments.length, 1);
    assert.equal(stored.projects['project-a'].profile.workflows['anima.json'], 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('segments are capped per project', async () => {
  const memory = new LongTermMemory({ limits: { segmentsPerProject: 3 } });
  await memory.init();
  for (let index = 0; index < 5; index++) {
    await memory.captureSession('p', { summary: { facts: [`fact-${index}`] } });
  }
  const state = memory.projectState('p');
  assert.equal(state.segmentCount, 3);
});

test('recall returns profile, cards, and ranked segments; empty when nothing stored', () => {
  const memory = new LongTermMemory();
  memory.data.projects['p'] = {
    profile: {
      styles: ['用户喜欢冷色系风格'],
      disliked: ['避免过多文字元素'],
      notes: [],
      workflows: { 'anima.json': 3 },
    },
    characterCards: { Alice: { name: 'Alice', description: '蓝发双马尾', appearance: '蓝发', outfit: '校服', pose: '', tags: [], notes: '', updatedAt: 1 } },
    segments: [
      { id: 'm1', hash: 'a', summary: { facts: ['夜景插画偏好高对比'], decisions: [] }, createdAt: 100 },
      { id: 'm2', hash: 'b', summary: { facts: ['用户提到车站'], decisions: [] }, createdAt: 200 },
    ],
  };
  const context = memory.recall('p', { query: '车站 夜景' });
  assert.match(context, /长期记忆/);
  assert.match(context, /冷色系风格/);
  assert.match(context, /避免过多文字元素/);
  assert.match(context, /anima\.json（3 次）/);
  assert.match(context, /Alice/);
  // query ranking: '车站' matches m2 only, so m2's fact appears before m1's
  assert.ok(context.indexOf('用户提到车站') < context.indexOf('夜景插画偏好高对比'), 'm2 should be ranked first');
  assert.equal(new LongTermMemory().recall('empty'), '');
});

test('character cards can be upserted, deleted, and survive persistence', async () => {
  const { dir, path } = await memoryFile();
  try {
    const memory = new LongTermMemory({ filePath: path });
    await memory.init();
    await memory.upsertCharacterCard('p', { name: 'Alice', description: '蓝发双马尾' });
    await memory.upsertCharacterCard('p', { name: 'Alice', description: '蓝发双马尾，冷色瞳孔' });
    const reloaded = new LongTermMemory({ filePath: path });
    await reloaded.init();
    assert.equal(reloaded.projectState('p').characterCards.length, 1);
    assert.equal(reloaded.projectState('p').characterCards[0].description, '蓝发双马尾，冷色瞳孔');
    assert.equal(await reloaded.deleteCharacterCard('p', 'Alice'), true);
    assert.equal(await reloaded.deleteCharacterCard('p', 'Alice'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('setProfile replaces lists and adjusts workflow counts', async () => {
  const memory = new LongTermMemory();
  await memory.init();
  await memory.captureSession('p', { summary: { facts: ['x'] }, workflowName: 'a.json' });
  await memory.setProfile('p', { styles: ['自定义风格'], workflows: { 'a.json': 0, 'b.json': 2 } });
  const state = memory.projectState('p');
  assert.deepEqual(state.profile.styles, ['自定义风格']);
  assert.equal(state.profile.workflows['a.json'], undefined);
  assert.equal(state.profile.workflows['b.json'], 2);
});

test('clear removes one project or everything', async () => {
  const memory = new LongTermMemory();
  await memory.init();
  await memory.captureSession('p1', { summary: { facts: ['a'] } });
  await memory.captureSession('p2', { summary: { facts: ['b'] } });
  await memory.clear('p1');
  assert.equal(memory.projectState('p1'), null);
  assert.ok(memory.projectState('p2'));
  await memory.clear();
  assert.equal(Object.keys(memory.data.projects).length, 0);
});

test('hashText is stable and scoped', () => {
  assert.equal(hashText('same'), hashText('same'));
  assert.notEqual(hashText('same'), hashText('different'));
  assert.match(hashText('x'), /^[0-9a-f]{16}$/);
});
