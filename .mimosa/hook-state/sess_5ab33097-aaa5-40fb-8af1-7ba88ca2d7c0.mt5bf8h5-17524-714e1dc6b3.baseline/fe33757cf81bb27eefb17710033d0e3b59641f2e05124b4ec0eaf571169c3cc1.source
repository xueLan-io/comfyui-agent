import { useState } from 'react';
import { useI18n } from '../i18n/I18nContext.jsx';
import { useBatchQueue } from '../contexts/BatchQueueContext.jsx';
import Icon from './Icon.jsx';

const SEED_MODES = [
  { id: 'random', label: 'queueSeedRandom' },
  { id: 'fixed', label: 'queueSeedFixed' },
  { id: 'list', label: 'queueSeedList' },
  { id: 'step', label: 'queueSeedStep' },
];

function sourceLabel(t, kind, label) {
  if (label) return label;
  if (kind === 'preset') return t('queueSourcePreset');
  if (kind === 'result') return t('queueSourceResult');
  return t('queueSourcePlan');
}

function SeedStrategyEditor({ strategy = {}, onChange, t }) {
  const mode = strategy.mode || 'random';
  const seeds = useBatchQueue().seedPreview(strategy);

  function set(patch) {
    onChange({ ...strategy, ...patch });
  }

  return (
    <div className="queue-seed-editor">
      <div className="queue-seed-modes" role="tablist" aria-label={t('queueSeedStrategy')}>
        {SEED_MODES.map(item => (
          <button key={item.id} type="button" className={`queue-seed-mode${mode === item.id ? ' active' : ''}`} onClick={() => set({ mode: item.id })} role="tab" aria-selected={mode === item.id}>
            {t(item.label)}
          </button>
        ))}
      </div>
      <div className="queue-seed-fields">
        {mode === 'random' && (
          <label className="queue-seed-field">
            <span>{t('queueSeedCount')}</span>
            <input type="number" min="1" max="200" value={strategy.count ?? 4} onChange={event => set({ count: Math.max(1, Number(event.target.value) || 1) })} />
          </label>
        )}
        {mode === 'fixed' && (
          <label className="queue-seed-field">
            <span>{t('queueSeedValue')}</span>
            <input type="number" value={strategy.value ?? ''} placeholder={String(strategy.value == null ? '' : strategy.value)} onChange={event => set({ value: event.target.value === '' ? undefined : Number(event.target.value) })} />
          </label>
        )}
        {mode === 'list' && (
          <label className="queue-seed-field queue-seed-field-wide">
            <span>{t('queueSeedValues')}</span>
            <input value={(strategy.values || []).join(', ')} onChange={event => set({ values: event.target.value.split(/[,，\s]+/).map(Number).filter(Number.isFinite) })} />
          </label>
        )}
        {mode === 'step' && (
          <>
            <label className="queue-seed-field">
              <span>{t('queueSeedStart')}</span>
              <input type="number" value={strategy.start ?? ''} placeholder="随机" onChange={event => set({ start: event.target.value === '' ? undefined : Number(event.target.value) })} />
            </label>
            <label className="queue-seed-field">
              <span>{t('queueSeedStepValue')}</span>
              <input type="number" value={strategy.step ?? 1} onChange={event => set({ step: Number(event.target.value) || 1 })} />
            </label>
            <label className="queue-seed-field">
              <span>{t('queueSeedCount')}</span>
              <input type="number" min="1" max="200" value={strategy.count ?? 4} onChange={event => set({ count: Math.max(1, Number(event.target.value) || 1) })} />
            </label>
          </>
        )}
      </div>
      <div className="queue-seed-preview">{t('queueSeedPreview', { n: seeds.length })}：{seeds.map(seed => <code key={seed}>{seed}</code>)}</div>
    </div>
  );
}

function DraftItem({ item, index, total, onRemove, onMove, onUpdate, t }) {
  const [expanded, setExpanded] = useState(false);
  const plan = item.plan || {};
  const strategy = item.seedStrategy || { mode: 'random', count: 4 };
  const seeds = useBatchQueue().seedPreview(strategy);
  return (
    <article className="queue-draft-item">
      <header className="queue-draft-head">
        <span className="queue-draft-index">{String(index + 1).padStart(2, '0')}</span>
        <div className="queue-draft-summary">
          <strong className="queue-draft-title" title={plan.positive}>{plan.positive}</strong>
          <span className="queue-draft-meta">
            {sourceLabel(t, item.sourceKind, item.sourceLabel)}
            {item.hasReference && <span className="queue-reference-badge"><Icon name="paperclip" size={10} />{t('queueReferenceBadge')}</span>}
            <span>· {seeds.length} {t('queueJobs')}</span>
          </span>
        </div>
        <div className="queue-draft-actions">
          <button className="btn btn-icon" onClick={() => onMove(item.id, -1)} disabled={index === 0} title={t('queueMoveUp')}><Icon name="chevronUp" size={13} /></button>
          <button className="btn btn-icon" onClick={() => onMove(item.id, 1)} disabled={index === total - 1} title={t('queueMoveDown')}><Icon name="chevronDown" size={13} /></button>
          <button className="btn btn-icon" onClick={() => setExpanded(value => !value)} title={t('queueSeedStrategy')}><Icon name="sliders" size={13} /></button>
          <button className="btn btn-icon btn-danger" onClick={() => onRemove(item.id)} title={t('queueRemove')}><Icon name="trash" size={13} /></button>
        </div>
      </header>
      {expanded && <SeedStrategyEditor strategy={strategy} onChange={patch => onUpdate(item.id, { seedStrategy: patch })} t={t} />}
    </article>
  );
}

function ActiveBatch({ batch, onPause, onResume, onCancel, onRetryJob, t }) {
  const total = batch.progress?.total || 0;
  const done = batch.progress?.done || 0;
  const percent = total ? Math.round(done * 100 / total) : 0;
  const canResume = ['created', 'paused', 'interrupted'].includes(batch.status);
  const failedJobs = (batch.jobs || []).filter(job => job.status === 'failed');
  return (
    <article className="queue-batch queue-batch-active">
      <header className="queue-batch-head">
        <div className="queue-batch-title">
          <strong>{batch.code || batch.title}</strong>
          <span className={`batch-status batch-status-${batch.status}`}>{t(`batchStatus_${batch.status}`)}</span>
        </div>
        <div className="queue-batch-actions">
          {batch.status === 'running'
            ? <button className="btn btn-icon" onClick={() => onPause(batch.id)} title={t('batchPause')}><Icon name="minus" size={13} /></button>
            : canResume && <button className="btn btn-icon" onClick={() => onResume(batch.id)} title={t('batchResume')}><Icon name="play" size={13} /></button>}
          {batch.status !== 'completed' && batch.status !== 'cancelled' && <button className="btn btn-icon btn-danger" onClick={() => onCancel(batch.id)} title={t('batchCancel')}><Icon name="stop" size={13} /></button>}
        </div>
      </header>
      <div className="batch-progress">
        <div className="generation-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={percent}>
          <span style={{ width: `${percent}%` }} />
        </div>
        <span className="batch-progress-label">{t('queueJobs', { done, total })} · ✓{batch.progress?.completed || 0} ✗{batch.progress?.failed || 0}</span>
      </div>
      {failedJobs.length > 0 && (
        <div className="queue-batch-failed">
          <span>{t('queueFailedJobs', { count: failedJobs.length })}</span>
          {failedJobs.map(job => (
            <button key={job.id} className="btn btn-small" onClick={() => onRetryJob(batch.id, job.id)} title={t('batchRetry')}><Icon name="refresh" size={12} />{t('batchRetry')} #{job.index + 1}</button>
          ))}
        </div>
      )}
    </article>
  );
}

export default function QueueTab() {
  const { t } = useI18n();
  const queue = useBatchQueue();
  const {
    queueItems, activeBatches, completedBatches, badge,
    removeQueueItem, moveQueueItem, updateQueueItem, clearQueue, startQueue,
    pauseBatch, resumeBatch, cancelBatch, retryJob,
  } = queue;
  const [starting, setStarting] = useState(false);

  async function handleStart() {
    setStarting(true);
    try { await startQueue(); } finally { setStarting(false); }
  }

  const hasDraft = queueItems.length > 0;

  return (
    <section className="workspace-section queue-tab">
      <div className="workspace-section-heading">
        <div>
          <span className="section-kicker">04</span>
          <div>
            <h3>{t('queueTitle')}</h3>
            <p>{t('queueAddHint')}</p>
          </div>
        </div>
        {badge > 0 && <span className="params-change-badge">{badge}</span>}
      </div>
      <p className="preview-note"><span className="preview-badge">{t('previewBadge')}</span>{t('previewNote')}</p>

      {!hasDraft && activeBatches.length === 0 && completedBatches.length === 0 && (
        <div className="queue-empty">
          <Icon name="grid" size={20} />
          <strong>{t('queueEmpty')}</strong>
          <p>{t('queueEmptyHint')}</p>
        </div>
      )}

      {hasDraft && (
        <div className="queue-draft">
          <div className="queue-draft-heading">
            <span>{t('queueDraft')} · {queueItems.length}</span>
            <button className="btn btn-small" onClick={() => { if (window.confirm(t('queueClearConfirm', { count: queueItems.length }))) clearQueue(); }}>{t('queueClear')}</button>
          </div>
          {queueItems.map((item, index) => (
            <DraftItem key={item.id} item={item} index={index} total={queueItems.length} onRemove={removeQueueItem} onMove={moveQueueItem} onUpdate={updateQueueItem} t={t} />
          ))}
          <button className="btn btn-primary queue-start" onClick={() => void handleStart()} disabled={starting}>
            <Icon name="play" size={14} /> {starting ? t('processing') : t('queueStart')}
          </button>
        </div>
      )}

      {activeBatches.length > 0 && (
        <div className="queue-section">
          <h4 className="queue-section-title">{t('queueRunning')}</h4>
          {activeBatches.map(batch => (
            <ActiveBatch key={batch.id} batch={batch} onPause={pauseBatch} onResume={resumeBatch} onCancel={cancelBatch} onRetryJob={retryJob} t={t} />
          ))}
        </div>
      )}

      {completedBatches.length > 0 && (
        <div className="queue-section">
          <h4 className="queue-section-title">{t('queueCompleted')}</h4>
          {completedBatches.map(batch => (
            <div className="queue-batch queue-batch-done" key={batch.id}>
              <div className="queue-batch-title">
                <strong>{batch.code || batch.title}</strong>
                <span className={`batch-status batch-status-completed`}>{t('batchStatus_completed')}</span>
              </div>
              <span className="queue-batch-done-note">✓{batch.progress?.completed || 0}/{batch.progress?.total || 0} · {t('queueViewResult')}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
