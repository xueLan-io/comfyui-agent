const STATUS_GROUPS = Object.freeze({
  idle: new Set(['', 'idle']),
  preparing: new Set(['created', 'classifying', 'planning', 'preparing']),
  awaiting_input: new Set(['clarifying', 'waiting']),
  preview: new Set(['awaiting_confirmation', 'prepared', 'preview']),
  queued: new Set(['queued']),
  running: new Set(['executing', 'observing', 'running', 'retrying', 'replanning', 'archiving', 'generating', 'processing']),
  stopping: new Set(['stopping', 'cancel_requested']),
  completed: new Set(['complete', 'completed']),
  cancelled: new Set(['cancelled']),
  recovery: new Set(['submit_unknown', 'timed_out', 'observe_timeout', 'archive_failed', 'abandoned']),
  failed: new Set(['failed', 'error']),
});

const PHASE_META = Object.freeze({
  idle: { label: '', tone: 'neutral', busy: false, terminal: false, recoverable: false },
  preparing: { label: '正在准备', tone: 'info', busy: true, terminal: false, recoverable: false },
  awaiting_input: { label: '等待补充信息', tone: 'warning', busy: false, terminal: false, recoverable: false },
  preview: { label: '等待确认', tone: 'warning', busy: true, terminal: false, recoverable: false },
  queued: { label: '等待执行', tone: 'info', busy: true, terminal: false, recoverable: false },
  running: { label: '正在执行', tone: 'info', busy: true, terminal: false, recoverable: false },
  stopping: { label: '正在停止', tone: 'warning', busy: true, terminal: false, recoverable: false },
  completed: { label: '已完成', tone: 'success', busy: false, terminal: true, recoverable: false },
  cancelled: { label: '已取消', tone: 'neutral', busy: false, terminal: true, recoverable: false },
  recovery: { label: '需要恢复', tone: 'warning', busy: false, terminal: false, recoverable: true },
  failed: { label: '执行失败', tone: 'danger', busy: false, terminal: true, recoverable: false },
});

export function runtimePhaseForStatus(status = '', fallbackPhase = 'idle') {
  const normalized = String(status || '').toLowerCase();
  for (const [phase, statuses] of Object.entries(STATUS_GROUPS)) {
    if (statuses.has(normalized)) return phase;
  }
  return PHASE_META[fallbackPhase] ? fallbackPhase : 'idle';
}

export function normalizeRuntimeStatus(status = '') {
  const phase = runtimePhaseForStatus(status);
  if (phase === 'awaiting_input') return 'waiting';
  if (phase === 'preview') return 'preview';
  if (phase === 'completed') return 'completed';
  if (phase === 'failed') return 'error';
  if (phase === 'running') return 'running';
  return status || 'idle';
}

export function buildRuntimeView({ status = '', rawStatus = '', generationPhase = 'idle', message = '', progress = null, source = '', requestId = '', turnId = '', taskId = '' } = {}) {
  const backendStatus = rawStatus || status || generationPhase || 'idle';
  const backendPhase = runtimePhaseForStatus(backendStatus, generationPhase);
  const phase = backendPhase === 'idle' && PHASE_META[generationPhase] ? generationPhase : backendPhase;
  const meta = PHASE_META[phase] || PHASE_META.idle;
  return {
    phase,
    rawStatus: backendStatus,
    status: normalizeRuntimeStatus(backendStatus),
    stage: progress?.stage || '',
    source,
    message: message || progress?.message || meta.label,
    progress,
    requestId,
    turnId,
    taskId,
    ...meta,
  };
}

export function generationRecordView(record = {}) {
  return buildRuntimeView({
    status: record.status || 'preparing',
    rawStatus: record.progressStage || record.status || 'preparing',
    message: record.progressMessage || record.error?.message || '',
    progress: {
      stage: record.progressStage || '',
      percent: record.progressPercent,
      nodePercent: record.progressNodePercent,
    },
    source: record.source || '',
    requestId: record.requestId || '',
    turnId: record.turnId || '',
    taskId: record.taskId || '',
  });
}

export { PHASE_META, STATUS_GROUPS };
