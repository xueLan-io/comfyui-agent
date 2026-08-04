import Icon from './Icon.jsx';

const TOOL_MARKS = {
  comfyui: 'workflow',
  prompt_enhance: 'spark',
  filesystem: 'folder',
  evaluator: 'check',
  planning: 'sliders',
};

export default function ExecutionGraph({ steps }) {
  if (!steps?.length) return <div className="graph-empty">等待执行计划</div>;

  return (
    <div className="exec-graph">
      {steps.map((step, index) => (
        <div key={step._key || index} className={`exec-graph-node ${step.status || ''}`}>
          <div className="exec-graph-node-inner">
            <div className={`exec-graph-mark ${step.status || ''}`}><Icon name={TOOL_MARKS[step.tool] || 'sliders'} size={13} /></div>
            <div className="exec-graph-info">
              <div className="exec-graph-label">{step.description || step.tool || ''}</div>
              <div className="exec-graph-tool">{step.status || step.tool || ''}</div>
            </div>
            {step.duration_ms != null && <span className="exec-graph-time">{Math.round(step.duration_ms / 1000)}s</span>}
          </div>
          {index < steps.length - 1 && <div className="exec-graph-connector" />}
        </div>
      ))}
    </div>
  );
}
