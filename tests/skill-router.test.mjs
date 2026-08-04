import assert from 'node:assert/strict';
import test from 'node:test';
import { SKILLS, configureSkills, matchSkill } from '../src/agent/skills/index.mjs';
import { Planner } from '../src/agent/runtime/planner.mjs';
import { PlanTemplates, normalizePlan, validatePlan } from '../src/agent/schemas/plan-schema.mjs';

test('SKILLS registry contains all system skills', () => {
  assert.deepEqual(Object.keys(SKILLS).sort(), ['batch', 'character', 'controlnet', 'img2img', 'lora', 'txt2img', 'upscale', 'video']);
});

test('matchSkill routes character requests', () => {
  assert.equal(matchSkill('帮我设计一个游戏角色').name, 'character');
  assert.equal(matchSkill('Create an OC for my story').name, 'character');
});

test('matchSkill routes img2img requests', () => {
  assert.equal(matchSkill('图生图 把这张照片改成油画').name, 'img2img');
  assert.equal(matchSkill('img2img with reference image').name, 'img2img');
});

test('img2img skill picks the inpaint workflow for local repaint tasks', () => {
  const step = SKILLS.img2img.steps('局部重绘 抹掉水印', { promptMode: 'raw' }).at(-1);
  assert.equal(step.tool, 'comfyui');
  assert.equal(step.input.workflowName, 'inpaint.json');
});

test('img2img skill keeps the img2img workflow for general and style tasks', () => {
  for (const message of ['把这张照片改成油画', '参考图生成类似图片']) {
    const step = SKILLS.img2img.steps(message, { promptMode: 'raw' }).at(-1);
    assert.equal(step.input.workflowName, 'img2img.json');
  }
});

test('img2img skill defers to an explicitly selected workflow', () => {
  const step = SKILLS.img2img.steps('局部重绘 抹掉水印', { promptMode: 'raw', workflowName: 'custom-inpaint.json' }).at(-1);
  assert.equal(step.input.workflowName, 'custom-inpaint.json');
});

test('matchSkill routes video requests', () => {
  assert.equal(matchSkill('帮我生成一段动画').name, 'video');
  assert.equal(matchSkill('generate a 5 second video').name, 'video');
  assert.equal(matchSkill('做一个短视频').name, 'video');
});

test('character keywords yield to explicit image editing context', () => {
  assert.equal(matchSkill('把这张照片的人物改成水彩风格').name, 'img2img');
  assert.equal(matchSkill('参考图里的人物换件衣服').name, 'img2img');
});

test('anime style talk does not route to video', () => {
  assert.equal(matchSkill('生成动画风格的头像').name, 'txt2img');
});

test('matchSkill defaults to txt2img', () => {
  assert.equal(matchSkill('一只猫坐在窗台上').name, 'txt2img');
  assert.equal(matchSkill('').name, 'txt2img');
});

test('dynamic skill configuration honors toggles and custom keywords', () => {
  configureSkills({
    systemEnabled: { txt2img: true, img2img: false, character: true },
    custom: [{ id: 'poster', name: '海报', description: '海报工作流', keywords: ['海报'], promptMode: 'concept', enabled: true }],
  });
  assert.equal(matchSkill('制作一张海报').name, 'poster');
  assert.equal(matchSkill('图生图改一下').name, 'txt2img');
  configureSkills({ systemEnabled: { txt2img: true, img2img: true, character: true }, custom: [] });
});

test('Planner without LLM produces a skill-based fallback plan', async () => {
  const planner = new Planner(null);
  const plan = await planner.createPlan('一只猫在雨中，seed 42，尺寸 512x768', {
    project: { promptMode: 'raw' },
    workflowDir: 'D:/workflows',
  });

  assert.equal(plan.goal, '一只猫在雨中，seed 42，尺寸 512x768');
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].tool, 'comfyui');
  assert.equal(plan.steps[0].expected_output, 'images');
  assert.deepEqual(plan.steps[0].input.settings, { seed: 42, width: 512, height: 768 });
});

test('Planner fallback routes img2img skill and fills workflow', async () => {
  const planner = new Planner(null);
  const plan = await planner.createPlan('图生图 重绘这张照片', {
    project: { promptMode: 'raw' },
  });

  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].tool, 'comfyui');
  assert.equal(plan.steps[0].input.workflowName, 'img2img.json');
});

test('Planner fallback routes video skill', async () => {
  const planner = new Planner(null);
  const plan = await planner.createPlan('帮我生成一段动画', {
    project: { promptMode: 'raw' },
  });

  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].tool, 'comfyui');
});

test('character variation requests batch generations and keep user settings', async () => {
  const planner = new Planner(null);
  const plan = await planner.createPlan('给这个角色做一套表情包，seed 7', {
    project: { promptMode: 'raw' },
  });

  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].tool, 'prompt_enhance');
  assert.equal(plan.steps[0].input.constraints.task, 'character_design');
  assert.deepEqual(plan.steps[1].input.settings, { batch: 4, seed: 7 });
});

test('Planner fallback with enhance mode uses skill steps', async () => {
  const planner = new Planner(null);
  const plan = await planner.createPlan('角色立绘 女剑士', {
    project: { promptMode: 'cinematic' },
  });

  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].tool, 'prompt_enhance');
  assert.equal(plan.steps[0].input.constraints.preserveCharacterIdentity, true);
  assert.equal(plan.steps[0].input.constraints.preserveCharacterCount, true);
  assert.equal(plan.steps[0].input.constraints.preserveExplicitCamera, true);
  assert.equal(plan.steps[1].tool, 'comfyui');
});

test('PlanTemplates.img2img builds a valid plan', () => {
  const plan = PlanTemplates.img2img('油画风格', 'custom.json', 'cinematic');
  const normalized = normalizePlan(plan);

  assert.equal(normalized.steps[0].tool, 'prompt_enhance');
  assert.equal(normalized.steps[1].tool, 'comfyui');
  assert.equal(normalized.steps[1].skill, 'img2img');
  assert.equal(normalized.steps[1].input.workflowName, 'custom.json');
});

test('invalid dependencies are reported instead of being dropped', () => {
  const plan = {
    goal: 'test',
    steps: [
      { id: 'step1', tool: 'comfyui', input: {}, description: 'a', expected_output: 'images', depends_on: ['step2', 'missing', 'step1'] },
      { id: 'step2', tool: 'comfyui', input: {}, description: 'b', expected_output: 'images', depends_on: ['step1'] },
    ],
  };

  const normalized = normalizePlan(plan);
  assert.deepEqual(normalized.steps[0].depends_on, ['step2', 'missing', 'step1']);
  assert.deepEqual(normalized.steps[1].depends_on, ['step1']);
  const validation = validatePlan(normalized);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => error.includes('unknown step')));
  assert.ok(validation.errors.some(error => error.includes('cycle')));
});

test('matchSkill routes upscale requests', () => {
  assert.equal(matchSkill('把这张图放大 2x').name, 'upscale');
  assert.equal(matchSkill('帮我高清放大这张图').name, 'upscale');
});

test('matchSkill routes lora requests', () => {
  assert.equal(matchSkill('用 lora 换风格').name, 'lora');
  assert.equal(matchSkill('加lora 换个画风').name, 'lora');
});

test('matchSkill routes controlnet requests', () => {
  assert.equal(matchSkill('用姿态图做 controlnet 生成').name, 'controlnet');
  assert.equal(matchSkill('参考线稿图控制生成').name, 'controlnet');
});

test('matchSkill routes batch requests', () => {
  assert.equal(matchSkill('生成两个方案对比').name, 'batch');
  assert.equal(matchSkill('做几个变体版本').name, 'batch');
});
