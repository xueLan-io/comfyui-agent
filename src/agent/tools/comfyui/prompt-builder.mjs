export const MODEL_INPUTS = new Map([
  ['CheckpointLoaderSimple', { kind: 'checkpoints', input: 'ckpt_name' }],
  ['UNETLoader', { kind: 'diffusion_models', input: 'unet_name' }],
  ['CLIPLoader', { kind: 'text_encoders', input: 'clip_name' }],
  ['VAELoader', { kind: 'vae', input: 'vae_name' }],
  ['LoraLoader', { kind: 'loras', input: 'lora_name' }],
  ['LoraLoaderModelOnly', { kind: 'loras', input: 'lora_name' }],
  ['ControlNetLoader', { kind: 'controlnet', input: 'control_net_name' }],
  ['UpscaleModelLoader', { kind: 'upscale_models', input: 'model_name' }],
]);

export function findNodeGroup(node, groups = []) {
  const position = Array.isArray(node.pos) ? node.pos : [node.pos?.[0], node.pos?.[1]];
  const x = Number(position?.[0]);
  const y = Number(position?.[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return '';

  return groups
    .filter(group => {
      const [left, top, width, height] = group.bounding || [];
      return x >= left && x <= left + width && y >= top && y <= top + height;
    })
    .sort((a, b) => (a.bounding?.[2] * a.bounding?.[3]) - (b.bounding?.[2] * b.bounding?.[3]))
    .at(0)?.title || '';
}

export function checkModelRequirements(requirements, objectInfo) {
  return requirements.map(requirement => {
    const definition = objectInfo[requirement.nodeType];
    const input = definition?.input?.required?.[requirement.input]
      || definition?.input?.optional?.[requirement.input];
    const options = Array.isArray(input?.[0]) ? input[0] : null;
    return { ...requirement, available: options ? options.includes(requirement.value) : null };
  });
}

function getInputDefinition(typeDefinition, inputName) {
  return typeDefinition?.input?.required?.[inputName]
    || typeDefinition?.input?.optional?.[inputName]
    || null;
}

function getInputOrder(typeDef) {
  if (!typeDef) return [];
  const order = [];
  for (const key of typeDef.input_order?.required || []) {
    const config = typeDef.input?.required?.[key];
    order.push({ name: key, config, optional: false });
  }
  for (const key of typeDef.input_order?.optional || []) {
    const config = typeDef.input?.optional?.[key];
    order.push({ name: key, config, optional: true });
  }
  return order;
}

function isWidgetType(type) {
  return ['INT', 'FLOAT', 'STRING', 'BOOLEAN'].includes(type) || Array.isArray(type);
}

export function workflowToPrompt(workflow, objectInfo = {}) {
  const prompt = {};
  const linkMap = {};
  const rerouteNodes = new Set();
  const mode0Nodes = new Set();

  for (const node of workflow.nodes || []) {
    const id = String(node.id);
    if (node.mode === 4) continue;
    mode0Nodes.add(id);
    if (node.type === 'Reroute') rerouteNodes.add(id);
  }

  for (const link of workflow.links || []) {
    const [linkId, srcNode, srcOut] = link;
    linkMap[linkId] = { srcNode: String(srcNode), srcOut };
  }

  function resolveSource(nodeId, outputIdx) {
    const id = String(nodeId);
    if (rerouteNodes.has(id)) {
      const node = workflow.nodes.find(n => String(n.id) === id);
      const inputs = node?.inputs || [];
      for (const inp of inputs) {
        if (inp.link != null && inp.link >= 0) {
          const link = linkMap[inp.link];
          if (link) return resolveSource(link.srcNode, link.srcOut);
        }
      }
    }
    return [id, outputIdx];
  }

  for (const node of workflow.nodes || []) {
    const id = String(node.id);
    if (node.mode === 4 || rerouteNodes.has(id)) continue;
    prompt[id] = { class_type: node.type, inputs: {} };
  }

  for (const node of workflow.nodes || []) {
    const id = String(node.id);
    if (node.mode === 4 || rerouteNodes.has(id)) continue;
    const p = prompt[id];
    const vals = node.widgets_values || [];
    const typeDef = objectInfo[node.type];
    const inputOrder = getInputOrder(typeDef);
    const inputs = node.inputs || [];
    let widgetIdx = 0;

    for (const entry of inputOrder) {
      const name = entry.name;
      const input = inputs.find(inp => inp.name === name);
      const hasLink = input && input.link != null && input.link >= 0;
      const config = entry.config;
      if (!config) continue;
      const type = config[0];
      const props = config[1] || {};

      if (hasLink) {
        const link = linkMap[input.link];
        if (link) {
          const [srcId, srcOut] = resolveSource(link.srcNode, link.srcOut);
          if (mode0Nodes.has(srcId)) {
            p.inputs[name] = [srcId, srcOut];
          }
        }
        if (isWidgetType(type)) {
          widgetIdx++;
          if (props.control_after_generate) widgetIdx++;
        }
      } else if (isWidgetType(type)) {
        if (widgetIdx < vals.length) {
          p.inputs[name] = vals[widgetIdx];
        }
        widgetIdx++;
        if (props.control_after_generate) widgetIdx++;
      }
    }
  }
  return prompt;
}

export function describeInput(inputName, value, definition) {
  const declaredType = definition?.[0];
  const options = Array.isArray(declaredType) ? declaredType.slice(0, 100) : undefined;
  const constraints = definition?.[1] || {};

  return {
    name: inputName,
    type: options ? 'select' : String(declaredType || typeof value).toLowerCase(),
    value,
    options,
    min: constraints.min,
    max: constraints.max,
    step: constraints.step,
  };
}

export { getInputDefinition };
