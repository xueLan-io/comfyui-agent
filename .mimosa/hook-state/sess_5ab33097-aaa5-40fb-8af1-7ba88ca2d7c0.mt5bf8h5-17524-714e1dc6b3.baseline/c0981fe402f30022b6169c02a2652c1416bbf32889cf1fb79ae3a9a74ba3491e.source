import { agentStageState } from '../runtime/agent-stage.mjs';

export default function AgentStageStrip({ status }) {
  const state = agentStageState(status);
  if (!state) return null;
  return (
    <ol className="agent-stage-strip" aria-label="Agent 执行阶段">
      {state.stages.map((stage, index) => (
        <li key={stage.id} className={index < state.index ? 'done' : index === state.index ? 'current' : 'pending'}>
          <span aria-hidden="true" />{stage.label}
        </li>
      ))}
    </ol>
  );
}
