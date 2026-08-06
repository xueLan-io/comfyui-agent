function widgetIndex(node, inputName) {
  let index = 0;
  for (const input of node.inputs || []) {
    if (input.name === inputName) return index;
    if (input.widget || input.link == null || input.link < 0) index++;
  }
  return -1;
}

function setWidget(node, names, value) {
  if (value === undefined || !node.widgets_values) return false;
  const name = names.find(candidate => (node.inputs || []).some(input => input.name === candidate));
  if (!name) return false;
  if (!Array.isArray(node.widgets_values) && typeof node.widgets_values === 'object') {
    if (!Object.prototype.hasOwnProperty.call(node.widgets_values, name)) return false;
    node.widgets_values[name] = value;
    return true;
  }
  const index = widgetIndex(node, name);
  if (index < 0 || index >= node.widgets_values.length) return false;
  node.widgets_values[index] = value;
  return true;
}

function findH3Node(workflow) {
  return (workflow.nodes || []).find(node => /minimaxh3referencetovideo/i.test(node.type || ''));
}

function activeNodes(workflow) {
  const active = (workflow.nodes || []).filter(node => node.mode === 0);
  return active.length > 0 ? active : workflow.nodes || [];
}

function patchLinkedWidget(workflow, node, inputName, value) {
  if (value === undefined) return false;
  const input = (node.inputs || []).find(item => item.name === inputName);
  if (!input || input.link == null || input.link < 0) return false;
  const link = (workflow.links || []).find(item => item[0] === input.link);
  const source = link && (workflow.nodes || []).find(item => String(item.id) === String(link[1]));
  if (!source || !Array.isArray(source.widgets_values)) return false;
  source.widgets_values[0] = value;
  return true;
}

export const MiniMaxH3Adapter = {
  name: 'minimax_h3',
  adaptationOnly: true,
  description: 'MiniMax H3 video workflow adapter; adaptation and preflight only when model files are unavailable',

  describe(workflow) {
    const nodes = activeNodes(workflow);
    const h3 = findH3Node(workflow);
    const inputs = new Set((h3?.inputs || []).map(input => input.name));
    const outputNodes = nodes.filter(node => /savevideo|videocombine|createvideo/i.test(node.type || ''));
    const references = [...inputs].filter(name => /^ref_images\.|^ref_videos\./i.test(name));
    return {
      modelType: 'minimax_h3',
      h3NodeType: h3?.type || null,
      supportsTextToVideo: Boolean(h3 && inputs.has('prompt')),
      supportsImageToVideo: references.some(name => /^ref_images\./i.test(name)),
      supportsVideoReference: references.some(name => /^ref_videos\./i.test(name)),
      supportsAudio: inputs.has('ref_audios.ref_audio_0') || inputs.has('audio'),
      referenceImageSlots: references.filter(name => /^ref_images\./i.test(name)).length,
      referenceVideoSlots: references.filter(name => /^ref_videos\./i.test(name)).length,
      outputNodeTypes: outputNodes.map(node => node.type),
      adaptationOnly: true,
      requiredModelFiles: nodes.flatMap(node => node.properties?.models || []).map(model => ({ name: model.name, directory: model.directory, url: model.url })),
    };
  },

  prepare(workflow, input = {}) {
    const h3 = findH3Node(workflow);
    if (!h3) return workflow;
    const values = {
      prompt: input.prompt || input.positive,
      width: input.width || input.settings?.width,
      height: input.height || input.settings?.height,
      length: input.frames || input.settings?.frames,
    };
    for (const [name, value] of Object.entries(values)) {
      if (!patchLinkedWidget(workflow, h3, name, value)) setWidget(h3, [name], value);
    }
    setWidget(h3, ['ref_image_size'], input.refImageSize);
    for (const node of workflow.nodes || []) {
      setWidget(node, ['fps', 'frame_rate'], input.fps);
      setWidget(node, ['noise_seed', 'seed'], input.seed || input.settings?.seed);
      setWidget(node, ['steps'], input.steps || input.settings?.steps);
    }
    return workflow;
  },
};
