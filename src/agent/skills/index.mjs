import { Txt2ImgSkill } from './txt2img.mjs';
import { Img2ImgSkill } from './img2img.mjs';
import { CharacterSkill } from './character.mjs';
import { VideoSkill } from './video.mjs';
import { UpscaleSkill } from './upscale.mjs';
import { ControlNetSkill } from './controlnet.mjs';
import { LoraSkill } from './lora.mjs';
import { BatchSkill } from './batch.mjs';
import { externalSkillManifest, normalizeExternalSkill } from './external.mjs';
import { createSkillRegistry } from './registry.mjs';
import { HighFrequencySkills } from './high-frequency.mjs';

export const SKILLS = {
  txt2img: Txt2ImgSkill,
  img2img: Img2ImgSkill,
  character: CharacterSkill,
  video: VideoSkill,
  upscale: UpscaleSkill,
  controlnet: ControlNetSkill,
  lora: LoraSkill,
  batch: BatchSkill,
};

const BUILTIN_SKILLS = { ...SKILLS, ...HighFrequencySkills };

export const SKILL_CONTRACT_VERSION = '1.0';

export function createConfiguredSkillRegistry(options = {}) {
  return createSkillRegistry({ builtin: options.builtin || BUILTIN_SKILLS, custom: options.custom || customSkills, external: options.external || [] });
}

export function skillCandidates(request, context = {}) {
  return createConfiguredSkillRegistry().match(request, context);
}

export function skillManifest(skills = SKILLS, enabled = {}) {
  return Object.entries(skills).map(([id, skill]) => ({
    id,
    name: skill.name || id,
    description: skill.description || '',
    version: skill.version || SKILL_CONTRACT_VERSION,
    enabled: enabled[id] !== false,
    ...(skill.external ? externalSkillManifest(skill) : {
      capabilities: ['plan', 'comfyui_generation'],
      sideEffects: ['comfyui_generation'],
      requiresConfirmation: true,
    }),
  }));
}

export function skillRegistry(skills = SKILLS, enabled = {}) {
  return Object.fromEntries(skillManifest(skills, enabled).map(item => [item.id, item]));
}

export function createCustomSkill(config = {}) {
  const mode = config.promptMode || 'raw';
  return {
    name: config.id || config.name,
    description: config.description || '',
    version: config.version || SKILL_CONTRACT_VERSION,
    steps(userIntent, context = {}) {
      const steps = [];
      if (mode !== 'raw') steps.push({ tool: 'prompt_enhance', input: { prompt: userIntent, mode }, description: `Enhance prompt (${mode} mode)`, expected_output: 'prompt' });
      steps.push({ tool: 'comfyui', input: { workflowName: context.workflowName || '', prompts: [], workflowDir: context.workflowDir || '' }, description: config.description || `Execute ${config.name || config.id}`, expected_output: 'images' });
      return steps;
    },
  };
}

const ROUTES = {
  character: ['角色', '人物', '立绘', '人设', 'character', 'oc', '表情包'],
  video: ['视频', '动画', '动图', '短片', '短视频', '动态图', '短剧', '动画视频', 'video', 'animate', 'motion', 'mp4'],
  img2img: ['图生图', '重绘', '局部重绘', 'inpaint', '参考图', 'img2img', 'image to image', '改图', '换背景'],
  controlnet: ['控制网络', '姿态', '骨架', '深度', '线稿', 'openpose', 'controlnet', 'pose', 'depth'],
  lora: ['lora', '加lora', '换模型'],
  upscale: ['放大', '高清', '超分', 'upscale', '2x', '4x', 'hi-res', '超分辨率'],
  batch: ['对比', '多个方案', '变体', '几个版本', '批量', 'batch', 'variant', 'versions'],
  txt2img: ['文生图', 'text to image', 'txt2img'],
};

const PRIORITY = ['character', 'video', 'controlnet', 'lora', 'upscale', 'img2img', 'batch', 'txt2img'];

const MEDIA_EDIT_HINTS = /(这张|照片|参考图|原图)/i;
const VIDEO_STYLE_MARKERS = /(风格|画风|插画|立绘|\bstyle\b|\banime\b)/i;

let systemEnabled = {
  txt2img: true,
  img2img: true,
  character: true,
  video: true,
  upscale: true,
  controlnet: true,
  lora: true,
  batch: true,
};
let customSkills = [];

function keywordHits(message, keywords) {
  return keywords.reduce((score, keyword) => score + (message.includes(keyword) ? 1 : 0), 0);
}

function skillScore(message, name) {
  const base = keywordHits(message, ROUTES[name]);
  if (name === 'img2img' && MEDIA_EDIT_HINTS.test(message)) return base + 2;
  if (name === 'video' && base > 0 && VIDEO_STYLE_MARKERS.test(message)) return base - 1;
  return base;
}

function dynamicSkill(config) {
  return { ...createCustomSkill(config), custom: true };
}

export function configureSkills(config = {}) {
  systemEnabled = { ...systemEnabled, ...(config.systemEnabled || {}) };
  customSkills = [
    ...(Array.isArray(config.custom) ? config.custom : []),
    ...(Array.isArray(config.external) ? config.external : []),
  ].filter(item => item?.enabled !== false).map(item => {
    if (item?.external && typeof item.steps !== 'function') {
      try { return normalizeExternalSkill(item, item.source || 'config'); } catch { return null; }
    }
    return item;
  }).filter(Boolean);
}

export function matchSkill(message = '', options = {}) {
  const normalized = message.toLowerCase();

  const requestedId = String(options.skillId || '').trim().toLowerCase();
  if (requestedId) {
    const explicit = customSkills.find(skill => String(skill.id).toLowerCase() === requestedId);
    if (explicit) return dynamicSkill(explicit);
  }

  const customHits = customSkills
    .map(skill => ({
      skill,
      score: keywordHits(normalized, (skill.keywords || []).map(keyword => String(keyword).toLowerCase())),
    }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (customHits.length > 0) return dynamicSkill(customHits[0].skill);

  const ranked = PRIORITY
    .filter(name => systemEnabled[name] !== false && SKILLS[name])
    .map(name => ({ name, score: skillScore(normalized, name) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (ranked.length > 0) return SKILLS[ranked[0].name];

  if (systemEnabled.txt2img !== false) return SKILLS.txt2img;
  const fallback = Object.keys(SKILLS).find(name => systemEnabled[name] !== false);
  return fallback ? SKILLS[fallback] : null;
}
