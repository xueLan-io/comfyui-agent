export function composePresetLayers(presets = [], input = {}) {
  if (presets.length < 2) throw new Error('至少选择两个预设进行组合');
  return {
    title: input.title || presets.map(item => item.title).join(' + '),
    description: input.description || `组合自：${presets.map(item => item.title).join('、')}`,
    positive: presets.map(item => item.positive).filter(Boolean).join(', '),
    negative: presets.map(item => item.negative).filter(Boolean).join(', '),
    parameters: Object.assign({}, ...presets.map(item => item.parameters || {})),
    nodeOverrides: Object.assign({}, ...presets.map(item => item.nodeOverrides || {})),
    workflowName: presets.find(item => item.workflowName)?.workflowName || '',
    origin: 'composition',
    components: presets.map(item => item.id),
    tags: [...new Set(presets.flatMap(item => item.tags || []))],
    extensions: { composition: { components: presets.map(item => item.id) } },
  };
}
