function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

export function mergePresetOverrides(...layers) {
  const settings = {};
  const nodeOverrides = {};
  let outputNodeIds = null;
  for (const layer of layers) {
    const value = object(layer);
    Object.assign(settings, object(value.settings || value.parameters));
    Object.assign(nodeOverrides, object(value.nodeOverrides));
    if (Array.isArray(value.outputNodeIds)) outputNodeIds = value.outputNodeIds;
  }
  return { settings, nodeOverrides, outputNodeIds };
}

export function parseParameterOverrides(text = '{}') {
  const value = JSON.parse(String(text || '{}'));
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('参数覆盖必须是 JSON 对象');
  return value;
}
