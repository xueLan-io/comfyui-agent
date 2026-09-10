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

test('duplicate capture does not mutate the in-memory profile', async () => {
  const { dir, path } = await memoryFile();
  try {
    const memory = new LongTermMemory({ filePath: path });
    await memory.init();
    await memory.captureSession('p', { summary: SAMPLE_SUMMARY, workflowName: 'anima.json' });
    // Same summary under a different workflow: dedup must short-circuit before
    // merging profile signals, so 'other.json' never shows up as a phantom
    // workflow count (in-memory or persisted).
    const duplicate = await memory.captureSession('p', { summary: SAMPLE_SUMMARY, workflowName: 'other.json' });
    assert.deepEqual(duplicate, { captured: false, reason: 'duplicate' });
    const state = memory.projectState('p');
    assert.deepEqual(Object.keys(state.profile.workflows).sort(), ['anima.json']);
    assert.equal(state.profile.workflows['anima.json'], 1);
    assert.equal(state.segmentCount, 1);
    const stored = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(Object.keys(stored.projects.p.profile.workflows).sort(), ['anima.json']);
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

test('recall returns profile and ranked segments; empty when nothing stored', () => {
  const memory = new LongTermMemory();
  memory.data.projects['p'] = {
    profile: {
      styles: ['用户喜欢冷色系风格'],
      disliked: ['避免过多文字元素'],
      notes: [],
      workflows: { 'anima.json': 3 },
    },
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
  // query ranking: '车站' matches m2 only, so m2's fact appears before m1's
  assert.ok(context.indexOf('用户提到车站') < context.indexOf('夜景插画偏好高对比'), 'm2 should be ranked first');
  assert.equal(new LongTermMemory().recall('empty'), '');
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
  // Cleared projects report an empty state (single shape) rather than null.
  assert.equal(memory.projectState('p1').segmentCount, 0);
  assert.equal(memory.projectState('p1').segments.length, 0);
  assert.ok(memory.projectState('p2'));
  await memory.clear();
  assert.equal(Object.keys(memory.data.projects).length, 0);
});

test('settings toggle gates capture and recall and persists', async () => {
  const { dir, path } = await memoryFile();
  try {
    const memory = new LongTermMemory({ filePath: path });
    await memory.init();
    assert.deepEqual(memory.getSettings(), { enabled: true });
    await memory.setSettings({ enabled: false });
    const gated = await memory.captureSession('p', { summary: SAMPLE_SUMMARY, workflowName: 'a.json' });
    assert.deepEqual(gated, { captured: false, reason: 'disabled' });
    assert.equal(memory.projectState('p').segmentCount, 0);
    // Reload from disk: the flag survives restarts.
    const reloaded = new LongTermMemory({ filePath: path });
    await reloaded.init();
    assert.equal(reloaded.getSettings().enabled, false);
    assert.equal(reloaded.recall('p', { query: '夜色' }), '');
    await reloaded.setUserNotes(['始终用中文回复']);
    // Disabled gates user-level recall too.
    assert.equal(reloaded.recall('p'), '');
    await reloaded.setSettings({ enabled: true });
    assert.match(reloaded.recall('p'), /始终用中文回复/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('user notes persist, dedupe, cap, and recall across projects', async () => {
  const memory = new LongTermMemory({ limits: { userNotes: 3 } });
  await memory.init();
  await memory.setUserNotes(['中文回复', '中文回复', '', '偏好动漫风格', '夜间任务', '第四条被挤出']);
  assert.deepEqual(memory.data.user.notes, ['偏好动漫风格', '夜间任务', '第四条被挤出']);
  // User notes recall even when the project itself has nothing stored.
  const context = memory.recall('fresh-project', { query: '风格' });
  assert.match(context, /用户全局备忘/);
  assert.match(context, /偏好动漫风格/);
  // And they come first, before project profile lines.
  await memory.captureSession('p', { summary: { facts: ['用户喜欢冷色系风格'] } });
  const mixed = memory.recall('p');
  assert.ok(mixed.indexOf('用户全局备忘') < mixed.indexOf('风格偏好与约定'), 'user notes should come first');
});

test('deleteSegment removes exactly one segment', async () => {
  const memory = new LongTermMemory();
  await memory.init();
  await memory.captureSession('p', { summary: { facts: ['第一条'] } });
  await memory.captureSession('p', { summary: { facts: ['第二条'] } });
  const [first] = memory.projectState('p').segments;
  const result = await memory.deleteSegment('p', first.id);
  assert.deepEqual(result, { removed: true, segments: 1 });
  const remaining = memory.projectState('p').segments;
  assert.equal(remaining.length, 1);
  assert.ok(!remaining.some(segment => segment.id === first.id));
  assert.deepEqual(await memory.deleteSegment('p', 'missing-id'), { removed: false });
  assert.deepEqual(await memory.deleteSegment('other-project', first.id), { removed: false });
});

test('recall ranks CJK queries via bigram overlap', () => {
  const memory = new LongTermMemory();
  memory.data.projects['p'] = {
    profile: { styles: [], disliked: [], notes: [], workflows: {} },
    segments: [
      { id: 'm1', hash: 'a', summary: { facts: ['夜色下的车站构图'] }, createdAt: 100 },
      { id: 'm2', hash: 'b', summary: { facts: ['白天海滩场景'] }, createdAt: 200 },
    ],
  };
  // Whole-run token cannot substring-match, bigrams ('夜色','色车','车站') can.
  const context = memory.recall('p', { query: '夜色车站', limit: 1 });
  assert.match(context, /夜色下的车站构图/);
  assert.ok(!context.includes('白天海滩'), 'non-matching segment should be excluded at limit 1');
});

test('projectState carries global settings and user notes', async () => {
  const memory = new LongTermMemory();
  await memory.init();
  await memory.setUserNotes(['全局备忘']);
  await memory.setSettings({ enabled: false });
  const state = memory.projectState('p');
  assert.deepEqual(state.settings, { enabled: false });
  assert.deepEqual(state.user, { notes: ['全局备忘'] });
  const global = memory.projectState('');
  assert.deepEqual(global.settings, { enabled: false });
  assert.deepEqual(global.user, { notes: ['全局备忘'] });
});

test('hashText is stable and scoped', () => {
  assert.equal(hashText('same'), hashText('same'));
  assert.notEqual(hashText('same'), hashText('different'));
  assert.match(hashText('x'), /^[0-9a-f]{16}$/);
});
