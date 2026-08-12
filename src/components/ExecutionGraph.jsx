import Icon from './Icon.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';

function statusIcon(status) {
  if (status === 'completed') return 'executionDone';
  if (['running', 'processing'].includes(status)) return 'executionActive';
  if (['failed', 'error', 'archive_failed', 'abandoned'].includes(status)) return 'executionError';
  return 'executionPending';
};

function clampPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function statusText(status, t) {
  return {
    running: t('graphRunning'),
    processing: t('graphRunning'),
    completed: t('graphCompleted'),
    failed: t('graphFailed'),
    error: t('graphFailed'),
    skipped: t('graphSkipped'),
    planning: t('graphPlanning'),
    queued: '等待执行', preparing: '准备中', observing: '观察结果', retrying: '重试中', replanning: '重新规划', stopping: '正在停止', archive_failed: '归档失败', abandoned: '任务中断',
  }[status] || t('graphWaiting');
}

export default function ExecutionGraph({ steps, progress }) {
  const { t } = useI18n();
  if (!steps?.length) return <div className="graph-empty">{t('graphEmpty')}</div>;

  const activeIndex = steps.reduce((current, step, index) => (
    ['running', 'processing'].includes(step.status) ? index : current
  ), -1);
  const progressPercent = clampPercent(progress?.overallPercent ?? progress?.percent);
  const activeProgress = clampPercent(progress?.nodePercent);

  return (
    <div className="exec-graph" aria-label={t('graphAria')}>
      {steps.map((step, index) => (
        <div key={step._key || index} className={`exec-graph-node ${step.status || ''} ${index === activeIndex ? 'is-active' : ''}`}>
          <div className="exec-graph-node-inner" data-state={step.status || 'pending'}>
            <div className={`exec-graph-mark ${step.status || 'pending'}`}><Icon name={statusIcon(step.status)} size={14} /></div>
            <div className="exec-graph-info">
              <div className="exec-graph-label">{step.description || step.tool || ''}</div>
              <div className="exec-graph-tool">{step.tool || 'Agent'} <span className="exec-graph-status">{statusText(step.status, t)}</span></div>
              {index === activeIndex && (
                <div className="exec-step-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={activeProgress ?? progressPercent ?? undefined}>
                  <div className="exec-step-progress-meta"><span>{progress?.message || progress?.node || t('graphExecuting')}</span>{activeProgress !== null && <b>{activeProgress}%</b>}</div>
                  <div className="generation-progress-track"><span className={activeProgress === null && progressPercent === null ? 'indeterminate' : ''} style={activeProgress !== null ? { width: `${Math.max(2, activeProgress)}%` } : progressPercent !== null ? { width: `${Math.max(2, progressPercent)}%` } : undefined} /></div>
                </div>
              )}
              {(step.error || step.reason || step.code) && <div className="exec-graph-error">{step.error || step.reason || step.code}</div>}
            </div>
            {step.duration_ms != null && <span className="exec-graph-time">{Math.round(step.duration_ms / 1000)}s</span>}
          </div>
          {index < steps.length - 1 && <div className="exec-graph-connector" />}
        </div>
      ))}
    </div>
  );
}
