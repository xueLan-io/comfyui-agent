const STAGES = Object.freeze([
  { id: 'classifying', label: '分类' },
  { id: 'planning', label: '规划' },
  { id: 'executing', label: '执行' },
  { id: 'observing', label: '观察' },
  { id: 'completed', label: '完成' },
]);

const STATUS_INDEX = Object.freeze({
  classifying: 0,
  planning: 1,
  replanning: 1,
  executing: 2,
  retrying: 2,
  observing: 3,
  completed: 4,
});

export function agentStageState(status = '') {
  const index = STATUS_INDEX[String(status || '').toLowerCase()];
  if (index === undefined) return null;
  return { index, stages: STAGES };
}

export { STAGES };
