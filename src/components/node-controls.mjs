export const EMPTY_GENERATION_CONTROLS = {
  settings: {},
  nodeOverrides: {},
  outputNodeIds: null,
};

export function cloneGenerationControls(controls = EMPTY_GENERATION_CONTROLS) {
  return {
    settings: { ...(controls.settings || {}) },
    nodeOverrides: Object.fromEntries(
      Object.entries(controls.nodeOverrides || {}).map(([nodeId, inputs]) => [nodeId, { ...inputs }]),
    ),
    outputNodeIds: Array.isArray(controls.outputNodeIds) ? [...controls.outputNodeIds] : null,
  };
}

export function parseControlValue(definition, rawValue) {
  const type = String(definition?.type || '').toLowerCase();
  if (['number', 'int', 'float'].includes(type) || typeof definition?.value === 'number') {
    if (rawValue === '') return undefined;
    const value = Number(rawValue);
    return Number.isFinite(value) ? value : undefined;
  }
  if (type === 'boolean' || typeof definition?.value === 'boolean') {
    if (rawValue === '') return undefined;
    return rawValue === true || rawValue === 'true';
  }
  if (type === 'select' && rawValue === '') return undefined;
  return String(rawValue);
}

export function setSettingControl(controls, name, value) {
  const next = cloneGenerationControls(controls);
  if (value === undefined) delete next.settings[name];
  else next.settings[name] = value;
  return next;
}

export function setNodeControl(controls, nodeId, inputName, value) {
  const next = cloneGenerationControls(controls);
  const inputs = { ...(next.nodeOverrides[nodeId] || {}) };
  if (value === undefined) delete inputs[inputName];
  else inputs[inputName] = value;

  if (Object.keys(inputs).length === 0) delete next.nodeOverrides[nodeId];
  else next.nodeOverrides[nodeId] = inputs;
  return next;
}

export function toggleOutputControl(controls, nodeId, outputNodes) {
  const allIds = outputNodes.map(node => String(node.id));
  const selected = Array.isArray(controls.outputNodeIds)
    ? controls.outputNodeIds.map(String)
    : allIds;
  const id = String(nodeId);
  const nextSelected = selected.includes(id)
    ? selected.filter(value => value !== id)
    : [...selected, id];

  if (nextSelected.length === 0) return controls;
  const next = cloneGenerationControls(controls);
  next.outputNodeIds = nextSelected.length === allIds.length ? null : nextSelected;
  return next;
}

export function countControlChanges(controls) {
  const settingCount = Object.keys(controls.settings || {}).length;
  const nodeCount = Object.values(controls.nodeOverrides || {})
    .reduce((total, inputs) => total + Object.keys(inputs || {}).length, 0);
  return settingCount + nodeCount + (Array.isArray(controls.outputNodeIds) ? 1 : 0);
}
