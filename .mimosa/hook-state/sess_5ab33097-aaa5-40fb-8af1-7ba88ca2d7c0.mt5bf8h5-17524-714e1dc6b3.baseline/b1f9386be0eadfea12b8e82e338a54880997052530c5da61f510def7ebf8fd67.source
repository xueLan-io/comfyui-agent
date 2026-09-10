function percentValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : null;
}

export default function GenerationProgress({ status, percent, nodePercent, overallPercent, message, stage, compact = false }) {
  const overall = percentValue(overallPercent ?? percent);
  const node = percentValue(nodePercent);
  const value = overall ?? node;
  const label = {
    preparing: '准备中', classifying: '分析请求', planning: '生成计划', queued: '等待执行',
    running: '执行中', executing: '执行中', observing: '等待 ComfyUI', retrying: '重试中',
    replanning: '重新规划', archiving: '正在归档', stopping: '正在停止', completed: '生成完成',
    cancelled: '已取消', failed: '生成失败', error: '生成失败', archive_failed: '结果已生成，归档失败',
    submit_unknown: '提交状态未知', timed_out: '任务超时，等待恢复', abandoned: '任务已中断',
  }[status] || message || stage || '正在生成';
  const indeterminate = value === null && !['completed', 'cancelled', 'failed', 'error'].includes(status);
  return (
    <div className={`generation-progress generation-progress-${status || 'generating'}${compact ? ' compact' : ''}`} role="status" aria-live="polite">
      <div className="generation-progress-meta"><span>{label}</span>{value !== null && <strong>{value}%</strong>}</div>
      <div className="generation-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={value ?? undefined}>
        <span className={indeterminate ? 'indeterminate' : ''} style={value !== null ? { width: `${value}%` } : undefined} />
      </div>
    </div>
  );
}
