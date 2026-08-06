function numericSize(value, fallback) {
  const match = String(value || '').match(/^(\d+)x(\d+)$/i);
  if (!match) return fallback;
  return { width: Number(match[1]), height: Number(match[2]) };
}

function setInputWidget(node, names, value) {
  if (!node.widgets_values || value === undefined) return false;
  let index = -1;
  let widgetIndex = 0;
  for (const input of node.inputs || []) {
    const isWidget = Boolean(input.widget) || !input.link || input.link < 0;
    if (names.includes(String(input.name || '').toLowerCase())) {
      index = widgetIndex;
      break;
    }
    if (isWidget) widgetIndex++;
  }
  if (index < 0 || index >= node.widgets_values.length) return false;
  node.widgets_values[index] = value;
  return true;
}

function countPromptTargets(nodes) {
  return nodes.filter(node => /textencode|prompt/i.test(node.type || '')).length;
}

export const WanAdapter = {
  name: 'wan',
  description: 'Wan video workflow adapter - supports text/image-to-video dimensions, frames, FPS, and guidance',

  describe(wf) {
    const nodes = wf.nodes || [];
    return {
      modelType: 'wan',
      videoNodes: nodes.filter(node => /wan|video|vhs/i.test(node.type || '')).map(node => node.type),
      promptSlots: countPromptTargets(nodes),
      supportsImageInput: nodes.some(node => /loadimage|image.?to.?video|wan/i.test(node.type || '')),
      supportsVideoOutput: nodes.some(node => /video|vhs|save.*gif|gif.*save/i.test(node.type || '')),
    };
  },

  prepare(wf, input = {}) {
    const size = numericSize(input.size, null);
    const frames = input.frames;
    const fps = input.fps;
    const guidance = input.guidance ?? input.settings?.cfg;

    for (const node of wf.nodes || []) {
      if (!node.widgets_values) continue;
      if (size) {
        setInputWidget(node, ['width'], size.width);
        setInputWidget(node, ['height'], size.height);
      }
      setInputWidget(node, ['frames', 'frame_count', 'video_length', 'length'], frames);
      setInputWidget(node, ['fps', 'frame_rate', 'framerate'], fps);
      setInputWidget(node, ['guidance', 'guidance_scale', 'cfg', 'cfg_scale'], guidance);
    }
    return wf;
  },
};
