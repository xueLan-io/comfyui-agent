function widgetIndex(node, inputName) {
  let index = 0;
  for (const input of node.inputs || []) {
    const linked = input.link != null && input.link >= 0;
    if (input.name === inputName) return linked ? -1 : index;
    if (!linked && (input.widget || input.link == null || input.link < 0)) index++;
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
  const active = (workflow.nodes || []).filter(node => node.mode === undefined || node.mode === 0);
  return active.length > 0 ? active : workflow.nodes || [];
}

function patchLinkedWidget(workflow, node, inputName, value) {
  if (value === undefined) return false;
  const input = (node.inputs || []).find(item => item.name === inputName);
  if (!input || input.link == null || input.link < 0) return false;
  const link = (workflow.links || []).find(item => item[0] === input.link);
  const source = link && (workflow.nodes || []).find(item => String(item.id) === String(link[1]));
  if (!source) return false;
  return setWidget(source, [inputName, 'value'], value);
}

export const MiniMaxH3Adapter = {
  name: 'minimax_h3',
  adaptationOnly: false,
  description: 'MiniMax H3 video workflow adapter with runtime preflight and reference media support',

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
      supportsDuration: inputs.has('length'),
      supportsResolution: inputs.has('width') && inputs.has('height'),
      supportsFps: nodes.some(node => (node.inputs || []).some(input => /^(fps|frame_rate|framerate)$/i.test(input.name || ''))),
      referenceImageSlots: references.filter(name => /^ref_images\./i.test(name)).length,
      referenceVideoSlots: references.filter(name => /^ref_videos\./i.test(name)).length,
      outputNodeTypes: outputNodes.map(node => node.type),
      adaptationOnly: false,
      requiredModelFiles: nodes.flatMap(node => node.properties?.models || []).map(model => ({ name: model.name, directory: model.directory, url: model.url })),
    };
  },

  prepare(workflow, input = {}) {
    const h3 = findH3Node(workflow);
    if (!h3) return workflow;
    const settings = input.settings || {};
    const values = {
      prompt: input.prompt ?? input.positive,
      width: input.width ?? settings.width,
      height: input.height ?? settings.height,
      length: input.frames ?? settings.frames,
    };
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) continue;
      const input = (h3.inputs || []).find(item => item.name === name);
      if (input?.link != null && input.link >= 0) {
        if (!patchLinkedWidget(workflow, h3, name, value)) {
          throw new Error(`MiniMax H3 linked input cannot be patched: ${name}`);
        }
      } else if (!setWidget(h3, [name], value)) {
        throw new Error(`MiniMax H3 input cannot be patched: ${name}`);
      }
    }
    setWidget(h3, ['ref_image_size'], input.refImageSize ?? settings.refImageSize);
    for (const node of workflow.nodes || []) {
      setWidget(node, ['fps', 'frame_rate', 'framerate'], input.fps ?? settings.fps);
      setWidget(node, ['noise_seed', 'seed'], input.seed ?? settings.seed);
      setWidget(node, ['steps'], input.steps ?? settings.steps);
      setWidget(node, ['guidance', 'guidance_scale', 'cfg', 'cfg_scale'], input.guidance ?? settings.cfg);
    }
    return workflow;
  },
};
