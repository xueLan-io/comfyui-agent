const COMMON_SETTINGS = {
  seed: { inputs: ['seed', 'noise_seed'], node: /sampler/i },
  steps: { inputs: ['steps'], node: /sampler/i },
  cfg: { inputs: ['cfg'], node: /sampler|guider/i },
  sampler: { inputs: ['sampler_name', 'sampler'], node: /sampler/i },
  scheduler: { inputs: ['scheduler'], node: /sampler|scheduler/i },
  denoise: { inputs: ['denoise'], node: /sampler/i },
  width: { inputs: ['width'], node: /latent|resolution|size/i },
  height: { inputs: ['height'], node: /latent|resolution|size/i },
  batch: { inputs: ['amount', 'batch_size'], node: /batch|latent/i },
  frames: { inputs: ['frames', 'frame_count', 'video_length', 'length'], node: /video|wan|animatediff|latent/i },
  fps: { inputs: ['fps', 'frame_rate', 'framerate'], node: /video|vhs|combine/i },
};

function isLink(value) {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1]);
}

function coerceValue(current, next) {
  if (typeof current === 'number') {
    const number = Number(next);
    return Number.isFinite(number) ? number : undefined;
  }
  if (typeof current === 'boolean') {
    if (next === true || next === 'true' || next === 1 || next === '1') return true;
    if (next === false || next === 'false' || next === 0 || next === '0') return false;
    return undefined;
  }
  if (typeof current === 'string') return String(next);
  return undefined;
}

function evaluateLinkedValue(prompt, value, visited = new Set()) {
  if (!isLink(value)) return value;
  const [nodeId] = value;
  if (visited.has(nodeId)) return undefined;
  visited.add(nodeId);
  const node = prompt[nodeId];
  if (!node) return undefined;

  const scalar = Object.values(node.inputs || {}).find(input => !isLink(input) && ['string', 'number', 'boolean'].includes(typeof input));
  if (scalar !== undefined) return scalar;
  const linked = Object.values(node.inputs || {}).find(isLink);
  return linked ? evaluateLinkedValue(prompt, linked, visited) : undefined;
}

function resolveControlTarget(prompt, value, setting, inputName, visited = new Set()) {
  if (!isLink(value)) return null;
  const [nodeId] = value;
  if (visited.has(nodeId)) return null;
  visited.add(nodeId);
  const node = prompt[nodeId];
  if (!node) return null;

  if ((setting === 'width' || setting === 'height') && /resolution/i.test(node.class_type || '')) {
    const targetInput = setting === 'width' ? 'custom_width' : 'custom_height';
    if (Object.prototype.hasOwnProperty.call(node.inputs || {}, targetInput)) {
      return { nodeId, inputName: targetInput, beforeSet: () => {
        if (Object.prototype.hasOwnProperty.call(node.inputs, 'use_custom_resolution')) {
          node.inputs.use_custom_resolution = true;
        }
      } };
    }
  }

  for (const candidate of [inputName, setting, 'value']) {
    if (Object.prototype.hasOwnProperty.call(node.inputs || {}, candidate) && !isLink(node.inputs[candidate])) {
      return { nodeId, inputName: candidate };
    }
  }

  if (/conditionalbranch/i.test(node.class_type || '')) {
    const condition = Boolean(evaluateLinkedValue(prompt, node.inputs?.cond));
    const selected = condition ? node.inputs?.tt_value : node.inputs?.ff_value;
    return resolveControlTarget(prompt, selected, setting, inputName, visited);
  }

  const scalarInputs = Object.entries(node.inputs || {}).filter(([, input]) => !isLink(input) && ['string', 'number', 'boolean'].includes(typeof input));
  if (scalarInputs.length === 1) return { nodeId, inputName: scalarInputs[0][0] };

  const linkedInputs = Object.values(node.inputs || {}).filter(isLink);
  if (linkedInputs.length === 1) return resolveControlTarget(prompt, linkedInputs[0], setting, inputName, visited);
  return null;
}

function setOverride(prompt, nodeId, inputName, value, source, applied, ignored) {
  const node = prompt[String(nodeId)];
  if (!node || !Object.prototype.hasOwnProperty.call(node.inputs || {}, inputName)) {
    ignored.push({ nodeId: String(nodeId), input: inputName, reason: 'input_not_found', source });
    return;
  }

  const current = node.inputs[inputName];
  if (isLink(current)) {
    ignored.push({ nodeId: String(nodeId), input: inputName, reason: 'linked_input', source });
    return;
  }

  const next = coerceValue(current, value);
  if (next === undefined) {
    ignored.push({ nodeId: String(nodeId), input: inputName, reason: 'invalid_value', source });
    return;
  }

  node.inputs[inputName] = next;
  applied.push({ nodeId: String(nodeId), input: inputName, value: next, source });
}

export function applyWorkflowOverrides(prompt, settings = {}, nodeOverrides = {}) {
  const applied = [];
  const ignored = [];
  const semanticTargets = new Set();

  for (const [setting, definition] of Object.entries(COMMON_SETTINGS)) {
    const value = settings?.[setting];
    if (value === undefined || value === null || value === '') continue;

    let candidates = Object.entries(prompt).filter(([, node]) => definition.node.test(node.class_type || ''));
    if (setting === 'batch') {
      const explicitBatchNodes = candidates.filter(([, node]) => /repeatlatentbatch|batch/i.test(node.class_type || ''));
      if (explicitBatchNodes.length > 0) candidates = explicitBatchNodes;
    }

    for (const [nodeId, node] of candidates) {
      for (const inputName of definition.inputs) {
        if (Object.prototype.hasOwnProperty.call(node.inputs || {}, inputName)) {
          const current = node.inputs[inputName];
          const target = isLink(current)
            ? resolveControlTarget(prompt, current, setting, inputName)
            : { nodeId, inputName };
          if (!target) {
            ignored.push({ nodeId, input: inputName, reason: 'control_source_not_found', source: `setting:${setting}` });
            continue;
          }
          const key = `${target.nodeId}:${target.inputName}:${setting}`;
          if (semanticTargets.has(key)) continue;
          semanticTargets.add(key);
          target.beforeSet?.();
          setOverride(prompt, target.nodeId, target.inputName, value, `setting:${setting}`, applied, ignored);
        }
      }
    }
  }

  for (const [nodeId, inputs] of Object.entries(nodeOverrides || {})) {
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) continue;
    for (const [inputName, value] of Object.entries(inputs)) {
      setOverride(prompt, nodeId, inputName, value, 'node', applied, ignored);
    }
  }

  return { applied, ignored };
}

export function extractCommonSettings(prompt) {
  const result = {};
  for (const [setting, definition] of Object.entries(COMMON_SETTINGS)) {
    for (const node of Object.values(prompt)) {
      if (!definition.node.test(node.class_type || '')) continue;
      const inputName = definition.inputs.find(name => Object.prototype.hasOwnProperty.call(node.inputs || {}, name));
      const value = inputName ? node.inputs[inputName] : undefined;
      if (value !== undefined) {
        if (isLink(value) && (setting === 'width' || setting === 'height')) {
          const source = prompt[value[0]];
          if (/resolution/i.test(source?.class_type || '') && source.inputs?.use_custom_resolution === false) {
            const match = String(source.inputs.resolution || '').match(/(\d+)\s*[x×]\s*(\d+)/i);
            if (match) {
              result[setting] = Number(match[setting === 'width' ? 1 : 2]);
              break;
            }
          }
        }
        const target = isLink(value) ? resolveControlTarget(prompt, value, setting, inputName) : null;
        const resolved = target ? prompt[target.nodeId]?.inputs?.[target.inputName] : value;
        if (resolved === undefined || isLink(resolved)) continue;
        const numeric = typeof resolved === 'string' && resolved.trim() !== '' && Number.isFinite(Number(resolved))
          ? Number(resolved)
          : resolved;
        result[setting] = numeric;
        break;
      }
    }
  }
  return result;
}

export function isEditableValue(value) {
  return !isLink(value) && ['string', 'number', 'boolean'].includes(typeof value);
}

export function injectExecutionPrompts(prompt, compiledPrompt = {}, promptProfile = {}) {
  const source = Array.isArray(compiledPrompt) ? { positivePrompts: compiledPrompt } : compiledPrompt || {};
  const values = (source.positivePrompts || [source.positive || source.enhanced || ''])
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const applied = [];

  for (const target of promptProfile.promptLists || []) {
    const nodeId = String(target.nodeId);
    const node = prompt[nodeId];
    if (!node || node.class_type !== 'easy promptList') continue;
    const inputNames = (target.inputs || [])
      .filter(name => Object.prototype.hasOwnProperty.call(node.inputs || {}, name))
      .sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1]));
    for (let index = 0; index < inputNames.length; index++) {
      const inputName = inputNames[index];
      node.inputs[inputName] = values[index] || '';
       applied.push({ nodeId, input: inputName, value: node.inputs[inputName], polarity: 'positive', source: 'prompt_positive' });
    }
  }

  if ((promptProfile.promptLists || []).length === 0 && values[0]) {
    for (const target of promptProfile.positiveTargets || []) {
      const nodeId = String(target.nodeId);
      const node = prompt[nodeId];
      if (!node || isLink(node.inputs?.[target.input]) || typeof node.inputs?.[target.input] !== 'string') continue;
      node.inputs[target.input] = values[0];
       applied.push({ nodeId, input: target.input, value: values[0], polarity: 'positive', source: 'prompt_positive' });
    }
  }

  const negative = String(source.negative || '').trim();
  if (promptProfile.supportsNegative && negative) {
    for (const target of promptProfile.negativeTargets || []) {
      const nodeId = String(target.nodeId);
      const node = prompt[nodeId];
      if (!node || isLink(node.inputs?.[target.input]) || typeof node.inputs?.[target.input] !== 'string') continue;
      node.inputs[target.input] = negative;
       applied.push({ nodeId, input: target.input, value: negative, polarity: 'negative', source: 'prompt_negative' });
    }
  }

  return applied;
}

export function selectExecutionOutputs(prompt, selectedOutputIds, knownOutputIds = []) {
  if (!Array.isArray(selectedOutputIds) || selectedOutputIds.length === 0) return [];
  const selected = new Set(selectedOutputIds.map(String));
  const removed = [];
  for (const nodeId of knownOutputIds.map(String)) {
    if (!selected.has(nodeId) && prompt[nodeId]) {
      delete prompt[nodeId];
      removed.push(nodeId);
    }
  }
  return removed;
}

const DECORATIVE_OUTPUT = /reel|collage|contact.?sheet|grid|polaroid|comparison|compare|composit/i;

function linkedImageSource(prompt, node) {
  for (const inputName of ['images', 'image']) {
    const value = node?.inputs?.[inputName];
    if (isLink(value)) return prompt[value[0]];
  }
  return null;
}

export function selectPreferredExecutionOutputs(prompt, knownOutputIds = []) {
  const candidates = knownOutputIds
    .map(String)
    .filter(nodeId => prompt[nodeId])
    .map((nodeId, index) => {
      const node = prompt[nodeId];
      const source = linkedImageSource(prompt, node);
      const sourceType = source?.class_type || '';
      let score = -index;
      if (/saveimage/i.test(node.class_type || '')) score += 20;
      if (/vaedecode/i.test(sourceType)) score += 100;
      if (DECORATIVE_OUTPUT.test(sourceType)) score -= 100;
      return { nodeId, score };
    })
    .sort((a, b) => b.score - a.score);

  return candidates[0] ? [candidates[0].nodeId] : [];
}

function mediaRefString(ref) {
  return ref?.subfolder ? `${ref.subfolder}/${ref.name}` : ref?.name;
}

function findUnlinkedInput(node, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(node.inputs || {}, name)) {
      const value = node.inputs[name];
      if (typeof value === 'string') return { inputName: name, current: value };
    }
  }
  return null;
}

function linkedSource(prompt, value) {
  return isLink(value) ? prompt[String(value[0])] : null;
}

function injectH3Reference(prompt, refs, kind, applied, ignored) {
  const slots = Object.entries(prompt)
    .filter(([, node]) => /minimaxh3referencetovideo/i.test(node.class_type || ''))
    .flatMap(([nodeId, node]) => Object.entries(node.inputs || {})
      .filter(([name]) => kind === 'images' ? /^ref_images\./i.test(name) : /^ref_videos\./i.test(name))
      .map(([input, value]) => ({ nodeId, node, input, value })));

  if (slots.length === 0) return;
  for (const [index, ref] of refs.entries()) {
    const slot = slots[index];
    const value = kind === 'videos' ? `input/${mediaRefString(ref)}` : mediaRefString(ref);
    if (!slot) {
      ignored.push({ kind, reason: 'no_h3_reference_slot' });
      continue;
    }
    const source = linkedSource(prompt, slot.value);
    if (source) {
      const hit = findUnlinkedInput(source, kind === 'images' ? ['image', 'images'] : ['video', 'video_path', 'video_file', 'file']);
      if (hit) {
        source.inputs[hit.inputName] = value;
        applied.push({ nodeId: slot.nodeId, input: slot.input, value, source: kind });
        continue;
      }
    } else if (typeof slot.value === 'string' || slot.value === undefined) {
      prompt[slot.nodeId].inputs[slot.input] = value;
      applied.push({ nodeId: slot.nodeId, input: slot.input, value, source: kind });
      continue;
    }
    ignored.push({ nodeId: slot.nodeId, input: slot.input, kind, reason: 'h3_reference_not_patchable' });
  }
}

export function injectInputMedia(prompt, media = {}) {
  const applied = [];
  const ignored = [];
  const usedNodeIds = new Set();

  injectH3Reference(prompt, media.images || [], 'images', applied, ignored);
  injectH3Reference(prompt, media.videos || [], 'videos', applied, ignored);

  const loadImageNodes = Object.entries(prompt).filter(([, node]) => node.class_type === 'LoadImage');
  const loadMaskNodes = Object.entries(prompt).filter(([, node]) => node.class_type === 'LoadImageMask');
  const videoNodes = Object.entries(prompt).filter(([, node]) => /video/i.test(node.class_type || '') && !/minimaxh3referencetovideo/i.test(node.class_type || ''));

  let imageIdx = 0;
  for (const ref of (media.images || []).slice(applied.filter(item => item.source === 'images').length)) {
    const entry = loadImageNodes[imageIdx];
    if (!entry) {
      ignored.push({ kind: 'images', reason: 'no_load_image_node' });
      break;
    }
    const [nodeId, node] = entry;
    const hit = findUnlinkedInput(node, ['image']);
    if (!hit) {
      ignored.push({ nodeId, kind: 'images', reason: 'no_unlinked_image_input' });
      imageIdx++;
      continue;
    }
    node.inputs[hit.inputName] = mediaRefString(ref);
    usedNodeIds.add(nodeId);
    applied.push({ nodeId, input: hit.inputName, value: mediaRefString(ref), source: 'images' });
    imageIdx++;
  }

  let maskIdx = 0;
  for (const ref of media.masks || []) {
    const maskEntry = loadMaskNodes[maskIdx];
    const fallbackEntry = loadImageNodes.find(([nodeId]) => !usedNodeIds.has(nodeId));
    const entry = maskEntry || fallbackEntry;
    if (!entry) {
      ignored.push({ kind: 'masks', reason: 'no_load_mask_node' });
      break;
    }
    const [nodeId, node] = entry;
    const hit = findUnlinkedInput(node, ['image']);
    if (!hit) {
      ignored.push({ nodeId, kind: 'masks', reason: 'no_unlinked_image_input' });
      if (maskEntry) maskIdx++;
      continue;
    }
    node.inputs[hit.inputName] = mediaRefString(ref);
    usedNodeIds.add(nodeId);
    applied.push({ nodeId, input: hit.inputName, value: mediaRefString(ref), source: 'masks' });
    if (maskEntry) maskIdx++;
  }

  let videoIdx = 0;
  for (const ref of (media.videos || []).slice(applied.filter(item => item.source === 'videos').length)) {
    const entry = videoNodes[videoIdx];
    if (!entry) {
      ignored.push({ kind: 'videos', reason: 'no_video_loader_node' });
      break;
    }
    const [nodeId, node] = entry;
    const hit = findUnlinkedInput(node, ['video', 'video_path', 'video_file']);
    if (!hit) {
      ignored.push({ nodeId, kind: 'videos', reason: 'no_video_path_input' });
      videoIdx++;
      continue;
    }
    node.inputs[hit.inputName] = `input/${mediaRefString(ref)}`;
    applied.push({ nodeId, input: hit.inputName, value: node.inputs[hit.inputName], source: 'videos' });
    videoIdx++;
  }

  return { applied, ignored };
}

export function referenceMediaInjected(uploaded, mediaReport) {
  const total = Number(uploaded?.total) || 0;
  const applied = Array.isArray(mediaReport?.applied) ? mediaReport.applied.length : 0;
  return total === 0 || applied > 0;
}

export function capReferenceImageResolution(prompt, objectInfo, largestSize = 1024) {
  const scalerType = objectInfo?.ImageScaleToMaxDimension
    ? 'ImageScaleToMaxDimension'
    : objectInfo?.ImageScaleToTotalPixels
      ? 'ImageScaleToTotalPixels'
      : '';
  if (!scalerType) return { applied: 0 };

  const usedIds = new Set(Object.keys(prompt));
  let nextId = Math.max(0, ...Object.keys(prompt).map(id => Number(id)).filter(Number.isFinite)) + 1;
  let applied = 0;
  for (const node of Object.values(prompt)) {
    if (node.class_type !== 'VAEEncode' || !isLink(node.inputs?.pixels)) continue;
    const source = prompt[node.inputs.pixels[0]];
    if (source?.class_type !== 'LoadImage') continue;

    while (usedIds.has(String(nextId))) nextId++;
    const scaleId = String(nextId++);
    prompt[scaleId] = {
      class_type: scalerType,
      inputs: scalerType === 'ImageScaleToMaxDimension'
        ? { image: node.inputs.pixels, upscale_method: 'lanczos', largest_size: largestSize }
        : { image: node.inputs.pixels, upscale_method: 'lanczos', megapixels: 1.0, resolution_steps: 8 },
    };
    node.inputs.pixels = [scaleId, 0];
    usedIds.add(scaleId);
    applied++;
  }
  return { applied, scalerType, largestSize };
}
