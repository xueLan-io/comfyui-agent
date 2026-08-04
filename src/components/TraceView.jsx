import Icon from './Icon.jsx';

export default function TraceView({ trace, onClose }) {
  if (!trace) return null;
  const planSteps = trace.plan?.steps || (trace.steps?.some(step => step.status || step.attempt) ? [] : trace.steps || []);
  const executionSteps = trace.plan ? trace.steps || [] : (trace.steps || []).filter(step => step.status || step.attempt);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <section className="trace-panel" onClick={event => event.stopPropagation()} aria-label="任务追踪">
        <div className="modal-header">
          <h3>任务追踪</h3>
          <button className="btn btn-icon" onClick={onClose} title="关闭"><Icon name="close" /></button>
        </div>
        <div className="trace-body">
          {trace.taskId && (
            <div className="trace-section">
              <div className="trace-label">任务 ID</div>
              <code className="trace-value">{trace.taskId}</code>
            </div>
          )}
          {trace.traceId && (
            <div className="trace-section">
              <div className="trace-label">Trace ID</div>
              <code className="trace-value">{trace.traceId}</code>
            </div>
          )}
          {trace.error && (
            <div className="prompt-preview-warning">
              失败：{typeof trace.error === 'string' ? trace.error : trace.error.message || JSON.stringify(trace.error)}
            </div>
          )}
          {planSteps.length > 0 && (
            <div className="trace-section">
              <div className="trace-label">执行计划 ({planSteps.length} 步)</div>
              <ol className="trace-steps">
                {planSteps.map((step, index) => (
                  <li key={index} className="trace-step">
                    <span className="trace-step-tool">{step.tool || ''}</span>
                    <span className="trace-step-desc">{step.description || ''}</span>
                    {step.input && <code className="trace-step-input">{JSON.stringify(step.input, null, 2)}</code>}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {executionSteps.length > 0 && (
            <div className="trace-section">
              <div className="trace-label">执行步骤 ({executionSteps.length} 次尝试)</div>
              <ol className="trace-steps">
                {executionSteps.map((step, index) => (
                  <li key={`${step.stepId}-${step.attempt}-${index}`} className={`trace-step trace-step-${step.status || 'unknown'}`}>
                    <span className="trace-step-tool">{step.tool || ''} · {step.status || ''} · 尝试 {step.attempt || 1}</span>
                    <span className="trace-step-desc">{step.description || step.stepId || ''}</span>
                    {step.error && <pre className="trace-raw">{typeof step.error === 'string' ? step.error : JSON.stringify(step.error, null, 2)}</pre>}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {trace.retries?.length > 0 && (
            <div className="trace-section">
              <div className="trace-label">重试 ({trace.retries.length})</div>
              <pre className="trace-raw">{JSON.stringify(trace.retries, null, 2)}</pre>
            </div>
          )}
          {trace.replans?.length > 0 && (
            <div className="trace-section">
              <div className="trace-label">重新规划 ({trace.replans.length})</div>
              <pre className="trace-raw">{JSON.stringify(trace.replans, null, 2)}</pre>
            </div>
          )}
          {trace.rawInput && (
            <div className="trace-section">
              <div className="trace-label">原始输入</div>
              <pre className="trace-raw">{typeof trace.rawInput === 'string' ? trace.rawInput : JSON.stringify(trace.rawInput, null, 2)}</pre>
            </div>
          )}
          {trace.interpretedPrompt && (
            <div className="trace-section">
              <div className="trace-label">模型理解的画面提示词</div>
              <pre className="trace-raw">{trace.interpretedPrompt}</pre>
            </div>
          )}
          {trace.promptResult && (
            <div className="trace-section">
              <div className="trace-label">最终提示词注入结果</div>
              <pre className="trace-raw">{JSON.stringify(trace.promptResult, null, 2)}</pre>
            </div>
          )}
          {trace.rawResult && (
            <div className="trace-section">
              <div className="trace-label">执行结果</div>
              <pre className="trace-raw">{typeof trace.rawResult === 'string' ? trace.rawResult : JSON.stringify(trace.rawResult, null, 2)}</pre>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
