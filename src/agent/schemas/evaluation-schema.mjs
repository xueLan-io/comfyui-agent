const CheckNames = ['technical', 'constraint', 'prompt_alignment', 'creative_quality', 'style_match', 'composition'];

const EvaluationSchema = {
  type: 'object',
  required: ['passed', 'technical', 'constraint', 'creative', 'checks', 'summary'],
  properties: {
    passed: { type: 'boolean' },
    needsRetry: { type: 'boolean' },
    technical: { type: 'string', enum: ['passed', 'failed'] },
    constraint: { type: 'string', enum: ['passed', 'failed', 'unknown'] },
    creative: { type: 'string', enum: ['not_evaluated', 'passed', 'failed'] },
    scores: {
      type: 'object',
      properties: {
        technical: { type: 'number', minimum: 0, maximum: 1 },
        alignment: { type: ['number', 'null'], minimum: 0, maximum: 1 },
        creative: { type: ['number', 'null'], minimum: 0, maximum: 1 },
        overall: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
    checks: { type: 'array' },
    issues: { type: 'array' },
    recommendation: { type: 'object' },
    summary: { type: 'string' },
    imageCount: { type: 'number' },
  },
};

const DEFAULT_EVALUATION = {
  passed: true,
  needsRetry: false,
  technical: 'passed',
  constraint: 'unknown',
  creative: 'not_evaluated',
  scores: { technical: 1, alignment: null, creative: null, overall: 1 },
  checks: [],
  issues: [],
  recommendation: { action: 'accept', modification: '', confidence: 1 },
  summary: 'No evaluation performed',
  imageCount: 0,
};

function checkStatus(check, fallback = 'unknown') {
  if (check?.status) return check.status;
  if (typeof check?.passed === 'boolean') return check.passed ? 'passed' : 'failed';
  return fallback;
}

function evaluateTechnical(result) {
  if (!result || result.error) {
    return { status: 'failed', passed: false, score: 0, detail: result?.error || 'No result' };
  }

  const images = Array.isArray(result.images) ? result.images : [];
  const failures = [];
  if (result.timedOut === true || result.executionStatus === 'timeout') failures.push('ComfyUI generation timeout');
  const executionStatus = result.executionStatus || result.status || '';
  if (executionStatus && !['success', 'completed'].includes(executionStatus)) {
    failures.push(`ComfyUI execution status: ${executionStatus}`);
  }
  const nodeErrors = result.nodeErrors || result.executionErrors || [];
  if (Array.isArray(nodeErrors) && nodeErrors.length > 0) failures.push('Node execution error');
  if (images.length === 0) failures.push('No images in output');

  const targetIds = new Set((result.outputNodeIds || []).map(String));
  const imageNodeIds = new Set((result.imageNodeIds || []).map(String));
  if (targetIds.size > 0 && ![...targetIds].some(id => imageNodeIds.has(id))) {
    failures.push('Selected output node did not produce an image');
  }

  const expectedBatch = Number(result.expectedBatch ?? result.batch);
  if (Number.isInteger(expectedBatch) && expectedBatch > 0 && images.length !== expectedBatch) {
    failures.push(`Expected ${expectedBatch} image(s), received ${images.length}`);
  }

  const imageChecks = result.imageChecks || result.outputFiles || [];
  for (const check of imageChecks) {
    if (check.exists === false) failures.push(`Output file not found: ${check.filename || 'image'}`);
    if (check.readable === false) failures.push(`Output file cannot be read: ${check.filename || 'image'}`);
    if (check.validFormat === false) failures.push(`Invalid image format: ${check.filename || 'image'}`);
  }

  const passed = failures.length === 0;
  return {
    status: passed ? 'passed' : 'failed',
    passed,
    score: passed ? 1 : 0,
    detail: passed ? `${images.length} image(s) passed technical checks` : failures.join('; '),
    checks: {
      comfyui: result.executionStatus || result.status || 'unknown',
      outputFiles: imageChecks,
      imageCount: images.length,
      expectedBatch: Number.isInteger(expectedBatch) ? expectedBatch : null,
      outputNodeIds: [...targetIds],
      imageNodeIds: [...imageNodeIds],
      nodeErrors,
    },
  };
}

function buildEvaluation({ technical, constraint, alignment, creative, issues, recommendation }) {
  const technicalStatus = checkStatus(technical, 'failed');
  const constraintCheck = constraint || alignment || { status: 'unknown', detail: 'Constraint evaluation was not available' };
  const constraintStatus = checkStatus(constraintCheck);
  const creativeStatus = creative?.status || (typeof creative?.passed === 'boolean' ? (creative.passed ? 'passed' : 'failed') : 'not_evaluated');
  const scores = {
    technical: technical?.score ?? (technicalStatus === 'passed' ? 1 : 0),
    alignment: constraintStatus === 'passed' ? 1 : constraintStatus === 'failed' ? 0 : null,
    creative: typeof creative?.score === 'number' ? creative.score : null,
  };
  scores.overall = +(scores.technical * 0.7 + (scores.alignment ?? scores.technical) * 0.3).toFixed(3);

  const checks = [
    { name: 'technical', passed: technicalStatus === 'passed', score: scores.technical, detail: technical?.detail || '' },
    { name: 'constraint', passed: constraintStatus === 'passed' ? true : constraintStatus === 'failed' ? false : null, score: scores.alignment, detail: constraintCheck.detail || '' },
    { name: 'creative_quality', passed: creativeStatus === 'passed' ? true : creativeStatus === 'failed' ? false : null, score: scores.creative, detail: creative?.detail || 'Creative quality was not evaluated' },
  ];
  const allIssues = issues || [];
  const passed = technicalStatus === 'passed' && constraintStatus !== 'failed' && creativeStatus !== 'failed';
  const needsRetry = !passed && (recommendation?.action === 'retry' || recommendation?.action === 'rewrite_prompt');

  return {
    passed,
    needsRetry,
    technical: technicalStatus,
    constraint: constraintStatus,
    creative: creativeStatus,
    scores,
    checks,
    issues: allIssues,
    recommendation: recommendation || { action: passed ? 'accept' : 'retry', modification: '', confidence: 0.8 },
    summary: passed ? 'Technical checks passed; creative quality was not evaluated' : `${checks.filter(check => check.passed === false).length} check(s) failed`,
    imageCount: technical?.checks?.imageCount || 0,
  };
}

export { EvaluationSchema, CheckNames, DEFAULT_EVALUATION, evaluateTechnical, buildEvaluation };
