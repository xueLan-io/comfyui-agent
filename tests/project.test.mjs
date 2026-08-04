import assert from 'node:assert/strict';
import test from 'node:test';
import { ProjectMemory } from '../src/agent/memory/project.mjs';

test('set and get field', () => {
  const proj = new ProjectMemory();
  proj.set('workflow', 'test.json');
  assert.equal(proj.get('workflow'), 'test.json');
});

test('snapshot saves to history', () => {
  const proj = new ProjectMemory();
  proj.set('goal', 'cat');
  proj.snapshot();
  assert.equal(proj.history.length, 1);
  assert.equal(proj.history[0].goal, 'cat');
  assert.ok(proj.history[0].ts > 0);
});

test('history capped at 50', () => {
  const proj = new ProjectMemory();
  for (let i = 0; i < 55; i++) proj.snapshot();
  assert.equal(proj.history.length, 50);
});

test('restore from history', () => {
  const proj = new ProjectMemory();
  proj.set('goal', 'first');
  proj.snapshot();
  proj.set('goal', 'second');
  const restored = proj.restore();
  assert.equal(restored, true);
  assert.equal(proj.get('goal'), 'first');
});

test('clear resets all fields', () => {
  const proj = new ProjectMemory();
  proj.set('workflow', 'x');
  proj.set('model', 'y');
  proj.clear();
  assert.equal(proj.get('workflow'), '');
  assert.equal(proj.get('model'), '');
});

test('loadFrom and toJSON roundtrip', () => {
  const proj = new ProjectMemory();
  proj.set('style', 'anime');
  proj.snapshot();
  const json = proj.toJSON();
  const proj2 = new ProjectMemory();
  proj2.loadFrom(json);
  assert.equal(proj2.get('style'), 'anime');
  assert.equal(proj2.history.length, 1);
});

test('onChange callback fires', () => {
  let called = false;
  const proj = new ProjectMemory(() => { called = true; });
  proj.set('goal', 'test');
  assert.equal(called, true);
});
