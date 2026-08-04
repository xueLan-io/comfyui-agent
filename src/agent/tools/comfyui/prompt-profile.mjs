function activeNodes(workflow) {
  return (workflow.nodes || []).filter(node => node.mode === 0);
}

function inputSource(node, inputName, links) {
  const input = (node.inputs || []).find(item => item.name === inputName);
  const link = links.get(input?.link);
  return link ? { nodeId: String(link[1]), output: link[2] } : null;
}

function collectUpstream(source, nodes, links) {
  const visited = new Set();

  function visit(nodeId) {
    nodeId = String(nodeId);
    if (visited.has(nodeId) || !nodes.has(nodeId)) return;
    visited.add(nodeId);
    for (const input of nodes.get(nodeId).inputs || []) {
      const link = links.get(input.link);
      if (link) visit(link[1]);
    }
  }

  if (source) visit(source.nodeId);
  return visited;
}

function detectFamily(workflow, fallback = 'generic') {
  const signature = activeNodes(workflow)
    .flatMap(node => [node.type, node.title, ...(node.widgets_values || [])])
    .filter(value => typeof value === 'string')
    .join(' ')
    .toLowerCase();

  if (/miaomiao|anima(?!tediff)/.test(signature)) return 'anima';
  if (/\bflux\b/.test(signature)) return 'flux';
  if (/\bwan(?:2|\s|_|-|\.)/.test(signature)) return 'wan';
  if (/animatediff/.test(signature)) return 'animatediff';
  if (/sdxl|stable.?diffusion.?xl/.test(signature)) return 'sdxl';
  return fallback;
}

function textTargets(nodeIds, nodes) {
  return [...nodeIds]
    .map(nodeId => nodes.get(nodeId))
    .filter(node => /textencode/i.test(node?.type || '') && (node.inputs || []).some(input => input.name === 'text'))
    .map(node => ({ nodeId: String(node.id), input: 'text', type: node.type }));
}

function promptLists(nodeIds, nodes) {
  return [...nodeIds]
    .map(nodeId => nodes.get(nodeId))
    .filter(node => node?.type === 'easy promptList')
    .map(node => ({
      nodeId: String(node.id),
      inputs: (node.inputs || []).map(input => input.name).filter(name => /^prompt_\d+$/.test(name)),
    }));
}

function currentText(targets, nodes) {
  for (const target of targets) {
    const value = nodes.get(target.nodeId)?.widgets_values?.[0];
    if (typeof value === 'string') return value;
  }
  return '';
}

export function buildPromptProfile(workflow, modelType = 'generic') {
  const nodes = new Map(activeNodes(workflow).map(node => [String(node.id), node]));
  const links = new Map((workflow.links || []).map(link => [link[0], link]));
  const samplers = [...nodes.values()].filter(node => /ksampler/i.test(node.type || ''));
  const positiveNodes = new Set();
  const negativeNodes = new Set();

  for (const sampler of samplers) {
    for (const nodeId of collectUpstream(inputSource(sampler, 'positive', links), nodes, links)) positiveNodes.add(nodeId);
    for (const nodeId of collectUpstream(inputSource(sampler, 'negative', links), nodes, links)) negativeNodes.add(nodeId);
  }

  const family = detectFamily(workflow, modelType);
  const positiveTargets = textTargets(positiveNodes, nodes);
  const negativeTargets = textTargets(negativeNodes, nodes);
  const hasZeroedNegative = [...negativeNodes].some(nodeId => /conditioningzeroout/i.test(nodes.get(nodeId)?.type || ''));
  const supportsNegative = family !== 'flux' && !hasZeroedNegative;

  return {
    family,
    format: family === 'anima' || family === 'sdxl' ? 'tag_narrative' : 'narrative',
    positiveTargets,
    negativeTargets: supportsNegative ? negativeTargets : [],
    promptLists: promptLists(positiveNodes, nodes),
    supportsNegative,
    currentPositive: currentText(positiveTargets, nodes),
    currentNegative: supportsNegative ? currentText(negativeTargets, nodes) : '',
  };
}

export function promptProfileLabel(profile) {
  const labels = {
    anima: 'Anima/Miaomiao',
    flux: 'Flux.1',
    sdxl: 'SDXL',
    wan: 'Wan 2.2',
    animatediff: 'AnimateDiff',
  };
  return labels[profile?.family] || profile?.family || 'Generic';
}
