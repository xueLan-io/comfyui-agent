export const PRESET_SCHEMA_VERSION = 2;

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizePresetExtensions(input = {}) {
  const extensions = isPlainObject(input.extensions) ? input.extensions : {};
  return {
    schemaVersion: Number(input.schemaVersion) || PRESET_SCHEMA_VERSION,
    extensions: {
      parameters: isPlainObject(extensions.parameters) ? extensions.parameters : {},
      workflow: isPlainObject(extensions.workflow) ? extensions.workflow : {},
      models: isPlainObject(extensions.models) ? extensions.models : {},
      composition: isPlainObject(extensions.composition) ? extensions.composition : {},
      evaluation: isPlainObject(extensions.evaluation) ? extensions.evaluation : {},
    },
  };
}

export function snapshotPreset(preset = {}, savedAt = Date.now()) {
  return {
    title: preset.title || '',
    positive: preset.positive || '',
    negative: preset.negative || '',
    parameters: { ...(preset.parameters || {}) },
    nodeOverrides: { ...(preset.nodeOverrides || {}) },
    workflow: preset.workflow || '',
    savedAt,
  };
}
