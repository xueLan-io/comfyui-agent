import Icon from './Icon.jsx';

const STATUS_ICONS = {
  running: 'play',
  completed: 'check',
  error: 'circleAlert',
  skipped: 'minus',
  planning: 'spark',
};

function toolLabel(tool) {
  const labels = {
    comfyui: 'ComfyUI',
    prompt_enhance: '提示词优化',
    filesystem: '文件系统',
    web: 'Web research',
    evaluator: '结果评估',
    planning: '任务规划',
  };
  return labels[tool] || tool || '';
}

export default function ActivityTimeline({ events }) {
  if (!events?.length) return <div className="timeline-empty">暂无活动记录</div>;

  return (
    <div className="timeline">
      {events.map((event, index) => (
        <div key={index} className={`timeline-item ${event.status || ''}`}>
          <div className="timeline-icon"><Icon name={STATUS_ICONS[event.status] || 'spark'} size={13} /></div>
          <div className="timeline-content">
            <div className="timeline-label">{event.description || event.stage || event.tool || ''}</div>
            <div className="timeline-meta">
              {event.tool && <span className="timeline-tag">{toolLabel(event.tool)}</span>}
              {event.status && <span className={`timeline-status ${event.status}`}>{event.status}</span>}
              {event.time && <span className="timeline-time">{event.time}</span>}
            </div>
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
