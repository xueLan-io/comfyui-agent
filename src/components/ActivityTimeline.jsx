import Icon from './Icon.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';

const STATUS_ICONS = {
  running: 'play',
  completed: 'check',
  error: 'circleAlert',
  warning: 'circleAlert',
  skipped: 'minus',
  planning: 'spark',
  rejected: 'circleAlert',
  overridden: 'check',
  cancelled: 'minus',
  queued: 'clock',
  preparing: 'spark',
  observing: 'play',
  retrying: 'refresh',
  replanning: 'spark',
  stopping: 'stop',
  archive_failed: 'circleAlert',
  abandoned: 'circleAlert',
};

function statusLabel(status, t) {
  const labels = {
    running: t('statusRunning'),
    completed: t('statusCompleted'),
    error: t('statusError'),
    failed: t('statusError'),
    warning: t('statusWarning'),
    rejected: t('reviewRejected'),
    overridden: t('reviewOverridden'),
    cancelled: t('reviewCancelled'),
    planning: t('statusPlanning'),
    queued: '等待执行', preparing: '准备中', observing: '观察结果', retrying: '重试中', replanning: '重新规划', stopping: '正在停止', archive_failed: '归档失败', abandoned: '任务中断',
  };
  return labels[status] || status;
}

function toolLabel(tool, t) {
  const labels = {
    comfyui: 'ComfyUI',
    prompt_enhance: t('toolPromptEnhance'),
    filesystem: t('toolFilesystem'),
    web: 'Web research',
    evaluator: t('toolEvaluator'),
    planning: t('toolPlanning'),
  };
  return labels[tool] || tool || '';
}

export default function ActivityTimeline({ events }) {
  const { t } = useI18n();
  if (!events?.length) return <div className="timeline-empty">{t('timelineEmpty')}</div>;

  return (
    <div className="timeline">
      {events.map((event, index) => (
        <div key={index} className={`timeline-item ${event.status || ''}`}>
          <div className="timeline-icon"><Icon name={STATUS_ICONS[event.status] || 'spark'} size={13} /></div>
          <div className="timeline-content">
            <div className="timeline-label">{event.description || event.stage || event.tool || ''}</div>
            <div className="timeline-meta">
              {event.tool && <span className="timeline-tag">{toolLabel(event.tool, t)}</span>}
              {event.status && <span className={`timeline-status ${event.status}`}>{statusLabel(event.status, t)}</span>}
              {event.duration_ms != null && <span className="timeline-duration">{(event.duration_ms / 1000).toFixed(1)}s</span>}
              {event.time && <span className="timeline-time">{event.time}</span>}
            </div>
            {(event.type === 'policy' || event.error || event.code || event.reason || event.stepId || event.taskId || event.traceId) && (
              <div className={`timeline-details ${event.type === 'policy' ? 'timeline-policy-details' : ['error', 'failed', 'warning'].includes(event.status) ? 'timeline-error-details' : ''}`}>
                {event.type === 'policy' && <span><b>{t('reviewResult')}：</b>{event.status === 'rejected' ? t('reviewRejected') : event.status === 'overridden' ? t('reviewOverridden') : t('reviewCancelled')}</span>}
                {event.reason && <span><b>{t('reviewReason')}：</b>{event.reason}</span>}
                {event.categories?.length > 0 && <span><b>{t('reviewCategories')}：</b>{event.categories.join('、')}</span>}
                {event.type === 'policy' && event.sentToCloud !== undefined && <span><b>{t('cloudDelivery')}：</b>{event.sentToCloud ? t('sentToCloud') : t('notSentToCloud')}</span>}
                {event.error && <span><b>{t('errorDetails')}：</b>{typeof event.error === 'string' ? event.error : event.error.message || JSON.stringify(event.error)}</span>}
                {event.code && <span><b>{t('errorCode')}：</b><code>{event.code}</code></span>}
                {event.stepId && ['error', 'failed', 'warning'].includes(event.status) && <span><b>{t('failedStep')}：</b><code>{event.stepId}</code></span>}
                {event.taskId && <span><b>{t('taskId')}：</b><code>{event.taskId}</code></span>}
                {event.traceId && <span><b>{t('timelineTraceId')}</b><code>{event.traceId}</code></span>}
              </div>
            )}
            {event.result?.sources?.length > 0 && (
              <div className="timeline-sources">
                {event.result.sources.map(source => (
                  <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title || source.url}{source.trustLevel ? ` · ${source.trustLevel}` : ''}</a>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
