import { mergePresetOverrides } from './preset-overrides.mjs';

export function presetWorkflowName(preset = {}, fallback = '') {
  return preset.workflowName || preset.workflow || fallback || '';
}

export function presetDefaultControls(preset = {}) {
  return {
    settings: { ...(preset.parameters || {}) },
    nodeOverrides: { ...(preset.nodeOverrides || {}) },
    outputNodeIds: Array.isArray(preset.outputNodeIds) ? [...preset.outputNodeIds] : null,
  };
}

export function buildPresetGenerationRequest(preset = {}, context = {}) {
  const controls = context.controls || {};
  const defaults = presetDefaultControls(preset);
  const merged = mergePresetOverrides(
    { settings: controls.settings, nodeOverrides: controls.nodeOverrides, outputNodeIds: controls.outputNodeIds },
    defaults,
    context.overrides,
  );
  return {
    positive: String(preset.positive || ''),
    negative: String(preset.negative || ''),
    workflowName: presetWorkflowName(preset, context.workflowName),
    settings: merged.settings,
    nodeOverrides: merged.nodeOverrides,
    outputNodeIds: merged.outputNodeIds,
    media: { images: Array.isArray(preset.sourceImages) ? preset.sourceImages : [], videos: [] },
    source: 'direct',
    origin: 'preset',
    presetId: preset.id || '',
    presetOrigin: preset.origin || '',
  };
}
