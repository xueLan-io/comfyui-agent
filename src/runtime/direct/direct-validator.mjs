import { buildPreflightReport, preflightIssue } from '../preflight-contract.mjs';

function addCheck(checks, type, level, message) {
  checks.push({ type, level, message });
}

function nodeTypes(workflow) {
  return new Set((workflow?.editableNodes || []).map(node => String(node.type || '').toLowerCase()));
}

export function validateDirectRequest(request, workflow) {
  const checks = [];
  const profile = workflow?.promptProfile || {};
  const types = nodeTypes(workflow);
  const promptTargetCount = (profile.promptLists || []).reduce((count, target) => count + (target.inputs?.length || 0), 0)
    || (profile.positiveTargets || []).length;

  if (!request.positive.trim()) addCheck(checks, 'positive_prompt', 'error', 'Positive prompt cannot be empty');
  if (promptTargetCount === 0) addCheck(checks, 'positive_prompt', 'error', 'Current workflow has no usable positive prompt input');
  if (workflow?.modelReady === false) {
    const missing = (workflow.missingModels || []).map(item => item.value).filter(Boolean).join(', ');
    addCheck(checks, 'models', 'error', `Workflow model files are missing${missing ? `: ${missing}` : ''}`);
  }

  if (request.negative.trim() && profile.supportsNegative === false) {
    addCheck(checks, 'negative_prompt', 'error', '当前工作流不支持负向提示词，请清空后继续；原文不会被自动修改');
  }

  const media = request.media || {};
  const modes = new Set(workflow?.capabilities?.modes || []);
  if ((media.images || []).length > 0 && ![...types].some(type => /loadimage/.test(type)) && !modes.has('img2video')) {
    addCheck(checks, 'reference_media', 'warning', 'Reference images were provided, but the workflow has no image loader');
  }
  if ((media.masks || []).length > 0 && ![...types].some(type => /loadimagemask|loadimage/.test(type))) {
    addCheck(checks, 'reference_media', 'warning', 'Reference masks were provided, but the workflow has no image loader');
  }
  if ((media.videos || []).length > 0 && ![...types].some(type => /video/.test(type)) && !modes.has('video2video')) {
    addCheck(checks, 'reference_media', 'warning', 'Reference videos were provided, but the workflow has no video loader');
  }
  if ((profile.promptLists || []).length > 0 || (profile.positiveTargets || []).length > 1) {
    addCheck(checks, 'prompt_routing', 'warning', 'The workflow has multiple prompt targets; review which nodes will receive the original text');
  }

  const report = buildPreflightReport({
    issues: [
      ...(workflow?.preflight?.issues || []),
      ...checks.map(check => preflightIssue({ code: check.type === 'models' ? 'model_missing' : check.type, severity: check.level === 'error' ? 'error' : 'warning', message: check.message })),
    ],
    modelRequirements: workflow?.modelRequirements || workflow?.missingModels || [],
    capabilities: workflow?.capabilities || null,
    modelType: workflow?.modelType || 'generic',
    adapterAvailable: workflow?.preflight?.adapterAvailable ?? true,
    adaptationOnly: workflow?.preflight?.adaptationOnly === true,
    adapterCapabilities: workflow?.preflight?.adapterCapabilities || null,
    runtime: workflow?.preflight?.runtime || null,
    resourceEstimate: workflow?.preflight?.resourceEstimate || null,
  });
  return { ...report, checks };
}
