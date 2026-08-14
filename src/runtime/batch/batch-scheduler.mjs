// Batch creation pipeline: expand seed/parameter matrices into a job queue,
// execute with bounded concurrency, and track per-job lifecycle with pause,
// cancel, single-job retry and restart recovery.
//
// The scheduler is deliberately independent of the Agent/Direct services: job
// execution is injected via runJob(job, { signal, onProgress }), so it can be
// unit-tested with fakes and wired to the governed direct-generation path in
// the Electron worker.

import { randomUUID } from 'node:crypto';

const DEFAULT_LIMITS = {
  maxJobs: 100,
  maxConcurrency: 2,
  maxBatches: 20,
  jobDelayMs: 250,
};

export const JOB_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted'];
export const BATCH_STATUSES = ['created', 'running', 'paused', 'completed', 'cancelled', 'interrupted'];

export function randomSeed() {
  return Math.floor(Math.random() * 2 ** 31);
}

// Expand a batch request into individual jobs: seeds × parameter combos.
// - seeds: explicit seed list; seedCount: generate that many random seeds.
// - combos: parameter variations applied on top of the base settings.
// Each job carries its own seed/settings so it can be executed independently.
export function expandBatchJobs(input = {}) {
  const positive = String(input.positive || '');
  const negative = String(input.negative || '');
  if (!positive) throw Object.assign(new Error('Batch requires a positive prompt'), { code: 'BATCH_REQUIRES_PROMPT' });
  const baseSettings = { ...(input.settings || {}) };
  const seeds = Array.isArray(input.seeds)
    ? input.seeds.map(Number).filter(Number.isFinite)
    : Number(input.seedCount) > 0
      ? Array.from({ length: Math.min(Number(input.seedCount) || 1, 200) }, () => randomSeed())
      : [];
  const combos = Array.isArray(input.combos) ? input.combos.filter(combo => combo && typeof combo === 'object') : [];
  const seedValues = seeds.length > 0 ? seeds : [undefined];
  const comboValues = combos.length > 0 ? combos : [{}];
  const jobs = [];
  for (const combo of comboValues) {
    for (const seed of seedValues) {
      jobs.push({
        index: jobs.length,
        status: 'pending',
        positive,
        negative,
        workflowName: String(input.workflowName || ''),
        workflowDir: String(input.workflowDir || ''),
        settings: { ...baseSettings, ...(combo.settings || {}), ...(seed !== undefined ? { seed } : {}) },
        nodeOverrides: { ...(input.nodeOverrides || {}), ...(combo.nodeOverrides || {}) },
        outputNodeIds: input.outputNodeIds || null,
        media: input.media || {},
        seed: seed === undefined ? undefined : seed,
        comboIndex: comboValues.indexOf(combo),
        createdAt: 0,
      });
    }
  }
  return jobs;
}

function jobPayload(job) {
  return {
    positive: job.positive,
    negative: job.negative,
    workflowName: job.workflowName,
    workflowDir: job.workflowDir,
    settings: job.settings,
    nodeOverrides: job.nodeOverrides,
    outputNodeIds: job.outputNodeIds,
    media: job.media,
  };
}

function progressOf(jobs) {
  const counts = { total: jobs.length, completed: 0, failed: 0, cancelled: 0, running: 0, pending: 0 };
  for (const job of jobs) counts[job.status] = (counts[job.status] || 0) + 1;
  counts.done = counts.completed + counts.failed + counts.cancelled;
  return counts;
}

export class BatchScheduler {
  constructor({ store = null, runJob, limits = {}, clock = () => Date.now(), emit = () => {} } = {}) {
    if (typeof runJob !== 'function') throw new Error('BatchScheduler requires a runJob executor');
    this.store = store;
    this.runJob = runJob;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.clock = clock;
    this.emit = emit;
    this.data = { version: 1, batches: {} };
    this._controllers = new Map();
    this._loaded = false;
  }

  async init() {
    if (this._loaded) return this;
    this._loaded = true;
    if (!this.store) return this;
    try {
      const stored = await this.store.get('data');
      if (stored && stored.version === 1 && stored.batches) {
        this.data = stored;
        // Restart recovery: in-flight work is re-queued as interrupted.
        for (const batch of Object.values(this.data.batches)) {
          if (batch.status === 'running') batch.status = 'interrupted';
          for (const job of batch.jobs || []) {
            if (job.status === 'running') job.status = 'interrupted';
          }
        }
      }
    } catch {
      // unreadable store: start fresh
    }
    return this;
  }

  async _persist() {
    if (!this.store) return;
    await this.store.set('data', this.data);
    await this.store.save();
  }

  _batch(batchId) {
    const batch = this.data.batches[batchId];
    if (!batch) throw Object.assign(new Error(`Batch not found: ${batchId}`), { code: 'BATCH_NOT_FOUND' });
    return batch;
  }

  async createBatch(input = {}) {
    const jobs = expandBatchJobs(input);
    if (jobs.length > this.limits.maxJobs) {
      throw Object.assign(new Error(`Batch exceeds job limit: ${jobs.length} > ${this.limits.maxJobs}`), { code: 'BATCH_LIMIT_EXCEEDED' });
    }
    const now = this.clock();
    for (const job of jobs) {
      job.createdAt = now;
      job.id = `job_${now}_${job.index}`;
    }
    const batch = {
      id: `batch_${now}_${randomUUID().slice(0, 8)}`,
      title: String(input.title || '').trim() || `${input.workflowName || 'batch'} · ${jobs.length} 张`,
      projectId: String(input.projectId || ''),
      sessionId: String(input.sessionId || ''),
      workflowName: String(input.workflowName || ''),
      status: 'created',
      createdAt: now,
      updatedAt: now,
      jobs,
      progress: progressOf(jobs),
    };
    const entries = Object.keys(this.data.batches);
    if (entries.length >= this.limits.maxBatches) {
      // evict the oldest terminal batch to stay within the cap
      const oldest = entries
        .map(id => ({ id, updatedAt: this.data.batches[id].updatedAt }))
        .filter(item => ['completed', 'cancelled', 'interrupted'].includes(this.data.batches[item.id].status))
        .sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (oldest) delete this.data.batches[oldest.id];
    }
    this.data.batches[batch.id] = batch;
    await this._persist();
    return this.publicBatch(batch.id);
  }

  async start(batchId) {
    const batch = this._batch(batchId);
    if (batch.status === 'running') return this.publicBatch(batchId);
    if (this._controllers.has(batchId)) return this.publicBatch(batchId);
    const controller = new AbortController();
    this._controllers.set(batchId, controller);
    batch.status = 'running';
    batch.updatedAt = this.clock();
    await this._persist();
    // Re-queue interrupted and pending jobs in index order.
    const queue = batch.jobs
      .filter(job => job.status === 'pending' || job.status === 'interrupted')
      .map(job => { job.status = 'pending'; return job; });
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, this.limits.maxConcurrency) }, async () => {
      while (cursor < queue.length && !controller.signal.aborted && !batch._pauseRequested) {
        const job = queue[cursor++];
        if (job.status !== 'pending') continue;
        await this._runJob(batch, job, controller.signal);
      }
    });
    try {
      await Promise.all(workers);
    } catch {
      // worker errors are contained per-job; runJob failures mark jobs failed
    } finally {
      this._controllers.delete(batchId);
      if (batch._pauseRequested) {
        batch._pauseRequested = false;
        batch.status = 'paused';
        batch.updatedAt = this.clock();
      } else if (controller.signal.aborted) {
        batch.status = 'cancelled';
        batch.updatedAt = this.clock();
      } else {
        // A run is "completed" once every job reached a terminal state; the
        // progress counters carry partial failure/cancellation details.
        batch.status = batch.jobs.every(job => ['completed', 'failed', 'cancelled'].includes(job.status))
          ? 'completed'
          : 'interrupted';
      }
      batch.progress = progressOf(batch.jobs);
      await this._persist();
      this.emit('batch:status', { batchId, status: batch.status, progress: batch.progress });
    }
    return this.publicBatch(batchId);
  }

  async _runJob(batch, job, signal) {
    job.status = 'running';
    job.startedAt = this.clock();
    batch.updatedAt = this.clock();
    batch.progress = progressOf(batch.jobs);
    await this._persist();
    this.emit('batch:job-status', { batchId: batch.id, index: job.index, status: 'running' });
    try {
      const result = await this.runJob(jobPayload(job), {
        signal,
        batchId: batch.id,
        jobIndex: job.index,
        projectId: batch.projectId,
        sessionId: batch.sessionId,
        workflowName: batch.workflowName,
        onProgress: (percent, detail) => {
          job.progress = { percent, detail };
          this.emit('batch:job-progress', { batchId: batch.id, index: job.index, percent, detail });
        },
      });
      if (signal.aborted) throw Object.assign(new Error('Batch job cancelled'), { code: 'BATCH_CANCELLED' });
      job.status = 'completed';
      job.completedAt = this.clock();
      job.result = summarizeResult(result);
      job.score = Number.isFinite(result?.score) ? result.score : undefined;
      this.emit('batch:job-status', { batchId: batch.id, index: job.index, status: 'completed', result: job.result });
    } catch (error) {
      job.status = signal.aborted || error?.code === 'BATCH_CANCELLED' ? 'cancelled' : 'failed';
      job.finishedAt = this.clock();
      job.error = String(error?.message || error);
      job.errorCode = error?.code || '';
      this.emit('batch:job-status', { batchId: batch.id, index: job.index, status: job.status, error: job.error });
    } finally {
      if (this.limits.jobDelayMs > 0 && !signal.aborted) {
        await new Promise(resolve => setTimeout(resolve, this.limits.jobDelayMs));
      }
      batch.progress = progressOf(batch.jobs);
      await this._persist();
    }
  }

  async pause(batchId) {
    const batch = this._batch(batchId);
    if (batch.status !== 'running') return this.publicBatch(batchId);
    batch._pauseRequested = true;
    // The running job finishes; pending jobs stop being picked up.
    await this._persist();
    return this.publicBatch(batchId);
  }

  async resume(batchId) {
    const batch = this._batch(batchId);
    if (batch.status === 'paused' || batch.status === 'interrupted') return this.start(batchId);
    return this.publicBatch(batchId);
  }

  async cancel(batchId) {
    const batch = this._batch(batchId);
    const controller = this._controllers.get(batchId);
    if (controller) controller.abort();
    for (const job of batch.jobs) {
      if (job.status === 'pending' || job.status === 'interrupted') job.status = 'cancelled';
    }
    batch.status = 'cancelled';
    batch.updatedAt = this.clock();
    batch.progress = progressOf(batch.jobs);
    await this._persist();
    this.emit('batch:status', { batchId, status: 'cancelled', progress: batch.progress });
    return this.publicBatch(batchId);
  }

  async retryJob(batchId, jobId) {
    const batch = this._batch(batchId);
    const job = batch.jobs.find(item => item.id === jobId);
    if (!job) throw Object.assign(new Error(`Batch job not found: ${jobId}`), { code: 'BATCH_JOB_NOT_FOUND' });
    if (job.status !== 'failed' && job.status !== 'cancelled') return this.publicBatch(batchId);
    job.status = 'pending';
    delete job.error;
    delete job.errorCode;
    delete job.result;
    delete job.score;
    batch.status = batch.status === 'cancelled' ? 'created' : batch.status;
    batch.updatedAt = this.clock();
    batch.progress = progressOf(batch.jobs);
    await this._persist();
    // Restart the run (idempotent: start() is a no-op while already running).
    if (batch.status !== 'running' && !this._controllers.has(batchId)) {
      void this.start(batchId);
    }
    return this.publicBatch(batchId);
  }

  // Record an external curation score (0-100) for a completed job; used by the
  // batch panel for Top-K recommendations. Returns false when the job is not
  // completed or the score is not numeric.
  async scoreJob(batchId, index, score) {
    const batch = this._batch(batchId);
    const job = batch.jobs.find(item => item.index === Number(index));
    const numeric = Number(score);
    if (!job || job.status !== 'completed' || !Number.isFinite(numeric)) return false;
    job.score = Math.max(0, Math.min(100, Math.round(numeric)));
    batch.updatedAt = this.clock();
    await this._persist();
    this.emit('batch:job-status', { batchId, index: job.index, status: 'completed', score: job.score });
    return true;
  }

  publicBatch(batchId) {
    const batch = this._batch(batchId);
    return {
      id: batch.id,
      title: batch.title,
      projectId: batch.projectId,
      sessionId: batch.sessionId,
      workflowName: batch.workflowName,
      status: batch.status,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
      progress: batch.progress,
      jobs: batch.jobs.map(job => ({
        index: job.index,
        id: job.id,
        status: job.status,
        seed: job.seed,
        settings: job.settings,
        nodeOverrides: job.nodeOverrides,
        error: job.error,
        errorCode: job.errorCode,
        score: job.score,
        result: job.result,
        progress: job.progress,
      })),
    };
  }

  listBatches({ projectId = '', limit = 20 } = {}) {
    return Object.values(this.data.batches)
      .filter(batch => !projectId || batch.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, Number(limit) || 20))
      .map(batch => this.publicBatch(batch.id));
  }
}

function summarizeResult(result) {
  if (!result || typeof result !== 'object') return undefined;
  const images = Array.isArray(result.images) ? result.images.map(item => ({
    path: item.path || item.filename || '',
    name: item.name || item.filename || '',
    url: item.url || '',
  })) : [];
  const videos = Array.isArray(result.videos) ? result.videos.map(item => ({ path: item.path || item.filename || '', name: item.name || item.filename || '', url: item.url || '' })) : [];
  const summary = { images, videos };
  if (typeof result.promptId === 'string') summary.promptId = result.promptId;
  if (typeof result.durationMs === 'number') summary.durationMs = result.durationMs;
  return summary;
}
