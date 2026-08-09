const GITHUB_ISSUE_URL = 'https://github.com/xueLan-io/comfyui-agent/issues/new';

function clean(value, max = 4000) {
  return String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

export function redactFeedbackText(value, max = 4000) {
  return clean(value)
    .replace(/([?&](?:api[_-]?key|token|authorization|password|secret)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(Basic\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|authorization|token|secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/([A-Za-z]:\\Users\\)[^\\]+/gi, '$1[USER]')
    .replace(/(\/(?:Users|home)\/)[^/]+/gi, '$1[USER]')
    .slice(0, max);
}

export function buildFeedbackReport({ error = '', details = '', version = '', platform = '', status = '', taskId = '', requestId = '', traceId = '', phase = '', workflow = '', source = '', comfyUrl = '', connected = false, hasReferenceMedia = false, errorCode = '' } = {}) {
  return {
    title: `[Bug] ${redactFeedbackText(error).replace(/\r?\n/g, ' ').slice(0, 100) || '运行错误'}`,
    body: [
      '## 问题描述',
      redactFeedbackText(details) || redactFeedbackText(error) || '请补充问题描述。',
      '',
      '## 错误信息',
      '```text',
      redactFeedbackText(error) || '未提供',
      '```',
      '',
      '## 运行环境',
      `- ComfyMuse: ${redactFeedbackText(version, 100) || '未知'}`,
      `- 平台: ${clean(platform, 100) || '未知'}`,
      `- 状态: ${clean(status, 100) || '未知'}`,
      `- 阶段: ${clean(phase, 100) || '未知'}`,
      `- Workflow: ${redactFeedbackText(workflow, 160) || '未知'}`,
      `- 来源: ${clean(source, 100) || '未知'}`,
      `- ComfyUI: ${redactFeedbackText(comfyUrl, 180) || '未提供'} (${connected ? '已连接' : '未连接'})`,
      `- 参考素材/Mask: ${hasReferenceMedia ? '有' : '无'}`,
      `- Task ID: ${clean(taskId, 120) || '未提供'}`,
      `- Request ID: ${clean(requestId, 120) || '未提供'}`,
      `- Trace ID: ${clean(traceId, 120) || '未提供'}`,
      `- 错误码: ${clean(errorCode, 120) || '未提供'}`,
      '',
      '> 提交前请检查内容，不要包含 API Key、密码或其他敏感信息。',
    ].join('\n'),
  };
}

export function buildGitHubIssueUrl(report, labels = []) {
  const url = new URL(GITHUB_ISSUE_URL);
  url.searchParams.set('title', clean(report?.title, 180) || '[Bug] 运行错误');
  url.searchParams.set('body', clean(report?.body, 6000));
  if (labels.length) url.searchParams.set('labels', labels.map(label => clean(label, 40)).filter(Boolean).join(','));
  return url.toString();
}

export { GITHUB_ISSUE_URL };
