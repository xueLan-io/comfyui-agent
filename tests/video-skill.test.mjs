import assert from 'node:assert/strict';
import test from 'node:test';
import { VideoSkill } from '../src/agent/skills/video.mjs';

test('VideoSkill adds the H3 template only for explicit H3 template requests', () => {
  const [enhance] = VideoSkill.steps('5秒武戏：白发女剑士挡住机械兽', {
    modelType: 'minimax_h3',
    promptMode: 'cinematic',
  });

  assert.equal(enhance.input.constraints.template, 'minimax_h3_video');
  assert.equal(enhance.input.constraints.duration, 5);
  assert.equal(enhance.input.constraints.videoMode, 'action');
});

test('VideoSkill preserves existing behavior for other video models', () => {
  const [enhance] = VideoSkill.steps('5秒武戏：白发女剑士挡住机械兽', {
    modelType: 'wan',
    promptMode: 'cinematic',
  });

  assert.equal(enhance.input.constraints.template, undefined);
  assert.equal(enhance.input.constraints.duration, undefined);
});
