import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

export const EXTERNAL_SKILL_SCHEMA_VERSION = '1.0';
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ALLOWED_MODES = new Set(['raw', 'cinematic', 'anime', 'photorealistic', 'concept']);
const ALLOWED_TOOLS = new Set(['prompt_enhance', 'comfyui']);

function text(value, fallback = '', max = 500) {
  const result = String(value ?? fallback).trim();
  return result.slice(0, max);
}

function list(value, max = 32) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(item => text(item, '', 80).toLowerCase())
    .filter(Boolean))].slice(0, max);
}

function safeSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const allowed = ['seed', 'steps', 'cfg', 'width', 'height', 'batch', 'frames', 'fps', 'denoise', 'sampler', 'scheduler'];
  return Object.fromEntries(allowed
    .filter(key => value[key] !== undefined && (typeof value[key] === 'number' || typeof value[key] === 'string'))
    .map(key => [key, value[key]]));
}

export function validateExternalSkill(value, source = '') {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, errors: ['Skill manifest must be an object'] };
  if (!ID_PATTERN.test(value.id || '')) errors.push('id must match ^[a-z0-9][a-z0-9_-]{0,63}$');
  if (!text(value.name, '', 120)) errors.push('name is required');
  if (!text(value.description, '', 500)) errors.push('description is required');
  if (!Array.isArray(value.keywords) || value.keywords.length === 0) errors.push('keywords must contain at least one item');
  const target = value.target || {};
  if (target.tool && !ALLOWED_TOOLS.has(target.tool)) errors.push(`unsupported target tool: ${target.tool}`);
  if (target.workflowName !== undefined && !/^[^\\/:*?"<>|]{1,160}(\.json)?$/i.test(String(target.workflowName))) errors.push('target.workflowName is not a safe workflow name');
  if (target.promptMode && !ALLOWED_MODES.has(target.promptMode)) errors.push(`unsupported prompt mode: ${target.promptMode}`);
  return { valid: errors.length === 0, errors, source };
}

export function normalizeExternalSkill(value, source = '') {
  const validation = validateExternalSkill(value, source);
  if (!validation.valid) throw new Error(`Invalid external Skill${source ? ` (${source})` : ''}: ${validation.errors.join('; ')}`);
  const target = value.target || {};
  const mode = target.promptMode || value.promptMode || 'raw';
  const tool = target.tool || 'comfyui';
  return {
    id: value.id,
    name: text(value.name, value.id, 120),
    description: text(value.description, '', 500),
    version: text(value.version, EXTERNAL_SKILL_SCHEMA_VERSION, 32),
    keywords: list(value.keywords),
    source: text(source || value.source, '', 1000),
    external: true,
    enabled: value.enabled !== false,
    target: {
      tool,
      workflowName: text(target.workflowName, '', 160),
      promptMode: mode,
      settings: safeSettings(target.settings),
    },
    steps(userIntent, context = {}) {
      const steps = [];
      if (mode !== 'raw') steps.push({
        tool: 'prompt_enhance',
        input: { prompt: userIntent, mode, constraints: { externalSkill: value.id } },
        description: `Enhance prompt for ${value.name}`,
        expected_output: 'prompt',
      });
      if (tool === 'comfyui') steps.push({
        tool: 'comfyui',
        skill: value.id,
        input: {
          workflowName: target.workflowName || '',
          workflowDir: context.workflowDir || '',
          prompts: [],
          images: context.images || [],
          masks: context.masks || [],
          settings: { ...target.settings },
        },
        description: `Execute external Skill: ${value.name}`,
        expected_output: 'images',
      });
      return steps;
    },
  };
}

export async function loadExternalSkillFile(filePath) {
  if (extname(filePath).toLowerCase() !== '.json') throw new Error(`External Skill must be a .json manifest: ${basename(filePath)}`);
  const raw = JSON.parse(await readFile(filePath, 'utf8'));
  return normalizeExternalSkill(raw, filePath);
}

export function externalSkillManifest(skill) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    version: skill.version || EXTERNAL_SKILL_SCHEMA_VERSION,
    keywords: skill.keywords || [],
    source: skill.source || '',
    external: true,
    enabled: skill.enabled !== false,
    target: skill.target || {},
    capabilities: ['plan', 'comfyui_generation'],
    sideEffects: ['comfyui_generation'],
    requiresConfirmation: true,
  };
}

export function externalSkillConfig(skill) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    version: skill.version || EXTERNAL_SKILL_SCHEMA_VERSION,
    keywords: [...(skill.keywords || [])],
    source: skill.source || '',
    enabled: skill.enabled !== false,
    target: {
      tool: skill.target?.tool || 'comfyui',
      workflowName: skill.target?.workflowName || '',
      promptMode: skill.target?.promptMode || 'raw',
      settings: { ...(skill.target?.settings || {}) },
    },
  };
}
