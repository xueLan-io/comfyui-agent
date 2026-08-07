function busyError(active, preview) {
  const owner = active || preview;
  const error = new Error(owner?.phase === 'stopping'
    ? '当前生成任务正在收尾，请稍候'
    : '当前已有生成任务或待确认预览，请先完成或取消它');
  error.code = 'GENERATION_BUSY';
  error.taskId = owner?.taskId || '';
  error.source = owner?.source || '';
  return error;
}

function sameOwner(left, right) {
  return left?.projectId === right?.projectId
    && left?.sessionId === right?.sessionId
    && left?.projectDir === right?.projectDir
    && left?.workflowDir === right?.workflowDir;
}

export class ExecutionCoordinator {
  constructor() {
    this.active = null;
    this.preview = null;
  }

  get isBusy() {
    return Boolean(this.active || this.preview);
  }

  assertAvailable() {
    if (this.active || this.preview) throw busyError(this.active, this.preview);
  }

  registerPreview({ source, previewId, taskId = '', owner, entry = null, requestId = '' }) {
    if (!previewId) throw new Error('Generation preview is missing an id');
    if (entry && this.active !== entry) throw new Error('Generation execution has already settled');
    if (!entry && this.active) throw busyError(this.active, this.preview);
    if (this.preview) throw busyError(this.active, this.preview);
    this.preview = Object.freeze({ source, previewId, taskId, requestId, status: 'prepared', owner: Object.freeze({ ...owner }) });
    return this.preview;
  }

  getPreview(previewId = '') {
    return this.preview?.previewId === previewId ? this.preview : null;
  }

  discardPreview(previewId = '') {
    if (!this.preview || this.preview.previewId !== previewId) return false;
    this.preview = null;
    return true;
  }

  async execute({ source, taskId = '', owner, previewId = '', work, onResult, cancel, governance }) {
    if (this.active) throw busyError(this.active, this.preview);
    if (this.preview && !previewId) throw busyError(this.active, this.preview);
    if (previewId) {
      if (!this.preview || this.preview.previewId !== previewId || this.preview.source !== source) {
        const error = new Error('Generation preview expired; prepare it again');
        error.code = 'GENERATION_PREVIEW_EXPIRED';
        throw error;
      }
      if (!sameOwner(this.preview.owner, owner)) {
        const error = new Error('Generation preview belongs to a different session');
        error.code = 'GENERATION_OWNER_MISMATCH';
        throw error;
      }
      this.preview = { ...this.preview, status: 'consuming' };
    }

    const entry = {
      source,
      taskId,
      owner: Object.freeze({ ...owner }),
      phase: 'running',
      cancelRequested: false,
      cancel: cancel || null,
      promise: null,
    };
    this.active = entry;
    const workPromise = Promise.resolve().then(() => governance ? governance({ entry, work }) : work(entry));
    entry.promise = workPromise;
    try {
      const result = await workPromise;
      if (!entry.detached) await onResult?.(result, entry);
      if (previewId) this.preview = null;
      return result;
    } catch (error) {
      if (previewId && this.preview?.previewId === previewId) {
        this.preview = { ...this.preview, status: 'prepared' };
      }
      throw error;
    } finally {
      if (this.active === entry) this.active = null;
    }
  }

  async cancel({ source = '', taskId = '', cancel } = {}) {
    const entry = this.active;
    if (!entry) return { cancelled: false, reason: 'not_running' };
    if ((source && entry.source !== source) || (taskId && entry.taskId && entry.taskId !== taskId)) {
      return { cancelled: false, reason: 'task_not_current' };
    }
    if (entry.cancelPromise) return entry.cancelPromise;

    entry.phase = 'cancel_requested';
    entry.cancelRequested = true;
    entry.cancelPromise = (async () => {
      entry.phase = 'stopping';
      try {
        await (cancel || entry.cancel)?.();
      } catch (error) {
        entry.phase = 'running';
        entry.cancelPromise = null;
        throw error;
      }
      try {
        await Promise.race([
          entry.promise,
          new Promise(resolve => setTimeout(resolve, 5000)),
        ]);
      } catch (error) {
        if (!entry.cancelRequested) throw error;
      }
      entry.phase = 'cancelled';
      if (this.active === entry) {
        entry.detached = true;
        this.active = null;
      }
      return { cancelled: true, taskId: entry.taskId };
    })();
    return entry.cancelPromise;
  }
}
