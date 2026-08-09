const AgentContextSchema = {
  type: 'object',
  properties: {
    userRequest: { type: 'string', description: 'The raw user message' },
    conversation: {
      type: 'array',
      items: { type: 'object', properties: { role: { type: 'string' }, content: { type: 'string' } } },
      description: 'Recent conversation history (last 10 messages)',
    },
    project: {
      type: 'object',
      properties: {
        currentCharacter: { type: 'string', description: 'Active character/concept name' },
        currentStyle: { type: 'string', description: 'Active style hint' },
        currentModel: { type: 'string', description: 'Active model name' },
        currentWorkflow: { type: 'string', description: 'Active workflow filename' },
        lastPrompt: { type: 'string', description: 'Last used prompt text' },
        promptMode: { type: 'string', description: 'Active prompt enhancement mode' },
        budgets: { type: 'object', description: 'Token budgets: { positiveTokens, negativeTokens }' },
        confirmedConstraints: { type: 'object', description: 'Constraints explicitly confirmed by the user' },
        commonParameters: { type: 'object', description: 'Project-level generation parameters' },
        savedPreferences: { type: 'object', description: 'Preferences explicitly saved by the user' },
        researchSettings: { type: 'object', description: 'Project-level online character research policy' },
      },
    },
    availableTools: {
      type: 'array',
      items: { type: 'string' },
      description: 'Tool names available to the planner',
    },
    availableWorkflows: {
      type: 'array',
      items: { type: 'string' },
      description: 'Workflow filenames available in the current directory',
    },
    workflowDir: { type: 'string', description: 'Current workflow directory path' },
    workflowManifest: { type: 'object', description: 'Active executable nodes and editable inputs in the selected workflow' },
    attachedMedia: {
      type: 'object',
      properties: {
        images: { type: 'array', items: { type: 'object' }, description: 'User-attached image files' },
        masks: { type: 'array', items: { type: 'object' }, description: 'User-attached mask files for inpainting' },
        videos: { type: 'array', items: { type: 'object' }, description: 'User-attached video files' },
      },
      description: 'Media files the user attached to this request',
    },
    previousArtifacts: {
      type: 'array',
      items: { type: 'object' },
      description: 'Artifacts from the current session (last 5)',
    },
    preferences: {
      type: 'object',
      description: 'User preference snapshot',
    },
  },
};

function buildAgentContext(userRequest, options = {}) {
  return {
    userRequest,
    conversation: options.conversation || [],
    project: {
      currentCharacter: options.project?.currentCharacter || '',
      currentStyle: options.project?.currentStyle || '',
      currentModel: options.project?.currentModel || '',
      currentWorkflow: options.project?.currentWorkflow || '',
      lastPrompt: options.project?.lastPrompt || '',
      promptMode: options.project?.promptMode || 'raw',
      budgets: options.project?.budgets || null,
      confirmedConstraints: options.project?.confirmedConstraints || {},
      commonParameters: options.project?.commonParameters || {},
      savedPreferences: options.project?.savedPreferences || {},
      researchSettings: options.project?.researchSettings || {},
    },
    availableTools: options.availableTools || Object.keys(options.tools || {}),
    availableWorkflows: options.availableWorkflows || [],
    workflowDir: options.workflowDir || '',
    workflowManifest: options.workflowManifest || null,
    previousArtifacts: options.previousArtifacts || [],
    preferences: options.preferences || {},
    attachedMedia: options.attachedMedia || null,
  };
}

function promptProfileSummary(profile) {
  const field = (name, value) => {
    if (typeof value === 'string') {
      const truncated = value.length > 120 ? `${value.slice(0, 120)}...` : value;
      return `${name}="${truncated}"`;
    }
    return `${name}=${value}`;
  };
  const parts = ['family', 'supportsNegative', 'currentPositive', 'currentNegative']
    .filter(name => profile[name] !== undefined)
    .map(name => field(name, profile[name]));
  const targets = [];
  for (const target of [...(profile.positiveTargets || []), ...(profile.negativeTargets || [])]) {
    targets.push(`${target.nodeId}(${target.input})`);
  }
  for (const list of profile.promptLists || []) {
    for (const input of list.inputs || []) targets.push(`${list.nodeId}(${input})`);
  }
  if (targets.length > 0) {
    const joined = targets.join(', ');
    parts.push(`targets: ${joined.length > 200 ? `${joined.slice(0, 200)}...` : joined}`);
  }
  return parts.join('; ');
}

function contextToPrompt(ctx) {
  let prompt = `User request: "${ctx.userRequest}"\n`;

  if (ctx.availableWorkflows?.length > 0) {
    prompt += `Available workflows:\n${ctx.availableWorkflows.map(w => `  - ${w}`).join('\n')}\n`;
  }

  if (ctx.workflowManifest) {
    const manifest = ctx.workflowManifest;
    prompt += `\nSelected workflow runtime controls:\n`;
    prompt += `- Active nodes: ${manifest.activeNodeCount || 0}\n`;
    prompt += `- Editable nodes: ${manifest.editableNodeCount || 0}\n`;
    prompt += `- Current common settings: ${JSON.stringify(manifest.commonSettings || {})}\n`;
    if (manifest.promptProfile) {
      prompt += `- Model type: ${manifest.modelType || manifest.promptProfile.family || 'generic'}\n`;
      prompt += `- Prompt profile: ${promptProfileSummary(manifest.promptProfile)}\n`;
    }
    if (manifest.capabilities) prompt += `- Workflow capabilities: ${JSON.stringify(manifest.capabilities)}\n`;
    if (manifest.workflowProfile) prompt += `- Workflow compatibility and defaults: ${JSON.stringify(manifest.workflowProfile)}\n`;
    if (manifest.modelRequirements?.length > 0) {
      prompt += `- Required local model files: ${manifest.modelRequirements.map(item => `${item.kind}/${item.value}${item.available === false ? ' (missing)' : ''}`).join(', ')}\n`;
    }
    const inputMedia = manifest.inputMedia || {};
    const mediaParts = [];
    if (inputMedia.images?.length > 0) mediaParts.push(`images: ${inputMedia.images.join(', ')}`);
    if (inputMedia.masks?.length > 0) mediaParts.push(`masks: ${inputMedia.masks.join(', ')}`);
    if (inputMedia.videos?.length > 0) mediaParts.push(`videos: ${inputMedia.videos.join(', ')}`);
    if (mediaParts.length > 0) prompt += `- Workflow input media: ${mediaParts.join('; ')}\n`;
    const allNodes = manifest.editableNodes || [];
    const nodes = allNodes.slice(0, 25);
    if (nodes.length > 0) {
      prompt += '- Editable node inputs (use only these exact node ids and input names):\n';
      for (const node of nodes) {
        const inputs = node.inputs.map(input => input.name);
        const names = inputs.length > 8 ? `${inputs.slice(0, 8).join(', ')}, ...` : inputs.join(', ');
        prompt += `  - ${node.id} ${node.type}${node.group ? ` [${node.group}]` : ''}: ${names}\n`;
      }
      if (allNodes.length > nodes.length) {
        prompt += `  ... and ${allNodes.length - nodes.length} more nodes\n`;
      }
    }
    if (manifest.outputNodes?.length > 0) {
      prompt += `- Output nodes: ${manifest.outputNodes.map(node => `${node.id} ${node.type}${node.group ? ` [${node.group}]` : ''}`).join('; ')}\n`;
    }
  }

  const p = ctx.project;
  if (p.currentStyle || p.currentModel || p.currentCharacter || p.lastPrompt) {
    prompt += `\nProject context:\n`;
    if (p.currentCharacter) prompt += `- Active character: ${p.currentCharacter}\n`;
    if (p.currentStyle) prompt += `- Style: ${p.currentStyle}\n`;
    if (p.currentModel) prompt += `- Model: ${p.currentModel}\n`;
    if (p.currentWorkflow) prompt += `- Workflow: ${p.currentWorkflow}\n`;
    if (p.lastPrompt) prompt += `- Last prompt: ${p.lastPrompt}\n`;
    if (p.promptMode) prompt += `- Enhancement mode: ${p.promptMode}\n`;
  }

  if (ctx.previousArtifacts?.length > 0) {
    prompt += `\nPrevious artifacts in this session: ${ctx.previousArtifacts.length}\n`;
  }

  const media = ctx.attachedMedia;
  if (media && (media.images?.length > 0 || media.masks?.length > 0 || media.videos?.length > 0)) {
    const filename = value => String(value || '').split(/[\\/]/).pop() || '';
    const names = (list) => list?.map(m => filename(typeof m === 'string' ? m : m.name || m.path || '')).join(', ') || '';
    const parts = [];
    if (media.images?.length > 0) parts.push(`${media.images.length} image(s): ${names(media.images)}`);
    if (media.masks?.length > 0) parts.push(`${media.masks.length} mask(s): ${names(media.masks)}`);
    if (media.videos?.length > 0) parts.push(`${media.videos.length} video(s): ${names(media.videos)}`);
    prompt += `\nUser attached media: ${parts.join('; ')}\n`;
  }

  return prompt;
}

export { AgentContextSchema, buildAgentContext, contextToPrompt };
