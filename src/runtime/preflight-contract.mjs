function issueKey(issue) {
  return [issue.code || issue.type || '', issue.nodeId || '', issue.input || '', issue.message || ''].join(':');
}

export function preflightIssue({ code = 'preflight_error', severity = 'error', message, ...details } = {}) {
  return { code, severity, message: String(message || code), ...details };
}

export function buildPreflightReport({ issues = [], modelRequirements = [], capabilities = null, modelType = 'generic', adapterAvailable = true, adaptationOnly = false, adapterCapabilities = null, runtime = null, resourceEstimate = null } = {}) {
  const missingModels = modelRequirements.filter(item => item?.available === false);
  const normalizedIssues = [...issues];
  if (missingModels.length > 0 && !normalizedIssues.some(issue => issue.code === 'model_missing')) {
    normalizedIssues.push(preflightIssue({ code: 'model_missing', severity: 'error', message: `Workflow model files are missing: ${missingModels.map(item => item.value).filter(Boolean).join(', ')}` }));
  }
  if (adaptationOnly && !normalizedIssues.some(issue => issue.code === 'adaptation_only')) {
    normalizedIssues.push(preflightIssue({ code: 'adaptation_only', severity: 'error', message: `${modelType} workflow is adaptation-only and cannot be executed locally` }));
  }
  const uniqueIssues = normalizedIssues.filter((issue, index, list) => list.findIndex(candidate => issueKey(candidate) === issueKey(issue)) === index);
  const errors = uniqueIssues.filter(issue => issue.severity === 'error');
  return { valid: errors.length === 0, issueCount: uniqueIssues.length, errorCount: errors.length, issues: uniqueIssues, missingModels, modelReady: missingModels.length === 0 && !adaptationOnly, capabilities, modelType, adapterAvailable, adaptationOnly, adapterCapabilities, runtime, resourceEstimate };
}

export function preflightError(report, message, failureType = '') {
  const resolvedFailureType = failureType || report.issues.find(issue => issue.severity === 'error')?.code || 'preflight_failed';
  const error = new Error(message || report.issues.find(issue => issue.severity === 'error')?.message || 'Workflow preflight failed');
  error.failureType = resolvedFailureType;
  error.retryable = false;
  error.preflight = report;
  return error;
}
