import ImageAsset from './ImageAsset.jsx';
import Icon from './Icon.jsx';
import { outputGalleryClass } from './image-layout.mjs';
import { useI18n } from '../i18n/I18nContext.jsx';
import { useBatchQueue } from '../contexts/BatchQueueContext.jsx';

function durationLabel(ms, t) {
  if (!ms || ms <= 0) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

// Re-queue a completed batch as variants: group jobs by their source plan, and
// enqueue one item per distinct plan with a fresh random seed strategy.
function groupByPlan(batch) {
  const groups = new Map();
  for (const job of batch.jobs || []) {
    const key = `${job.sourceLabel || ''}::${job.positive || ''}`;
    if (!groups.has(key)) {
      groups.set(key, {
        positive: job.positive || '',
        negative: job.negative || '',
        workflowName: batch.workflowName || '',
        settings: job.settings || {},
        nodeOverrides: job.nodeOverrides || {},
        media: job.media || {},
        sourceKind: job.sourceKind || 'result',
        sourceLabel: job.sourceLabel || batch.code || batch.title,
      });
    }
  }
  return [...groups.values()];
}

export default function BatchResultCard({ batch, onOpenImage }) {
  const { t } = useI18n();
  const queue = useBatchQueue();
  const jobs = batch.jobs || [];
  const completedJobs = jobs.filter(job => job.status === 'completed' && job.result?.images?.length > 0);
  const failedJobs = jobs.filter(job => job.status === 'failed');
  const images = completedJobs.flatMap(job => (job.result.images || []).map(image => ({
    ...image,
    seed: job.seed,
    sourceLabel: job.sourceLabel || '',
  })));
  const okCount = completedJobs.length;
  const total = batch.progress?.total || jobs.length;
  const duration = durationLabel((batch.updatedAt || 0) - (batch.createdAt || 0), t);

  function requeue() {
    const plans = groupByPlan(batch);
    for (const plan of plans) {
      queue.addToQueue(plan, { sourceKind: plan.sourceKind, sourceLabel: plan.sourceLabel, seedStrategy: { mode: 'random', count: 4 } });
    }
  }

  return (
    <section className="batch-result-card" data-batch-id={batch.id}>
      <header className="batch-result-head">
        <div className="batch-result-title">
          <Icon name="grid" size={14} />
          <strong>{batch.code || batch.title}</strong>
          <span className="batch-status batch-status-completed">{t('batchStatus_completed')}</span>
        </div>
        <span className="batch-result-summary">
          {t('batchResultSummary', { ok: okCount, total, failed: failedJobs.length })}{duration ? ` · ${duration}` : ''}
        </span>
      </header>

      {images.length > 0 && (
        <div className={`image-grid chat-output-grid ${outputGalleryClass(images.length)}`}>
          {images.map((image, index) => (
            <article key={`${image.filename || image.path || index}-${index}`} className="image-item">
              <ImageAsset image={image} compact onOpen={preview => onOpenImage?.({ ...preview, images, index })} />
              <div className="image-item-info"><span title={image.filename}>{image.filename || image.name || ''}</span><b>#{image.seed ?? index + 1}</b></div>
            </article>
          ))}
        </div>
      )}

      {failedJobs.length > 0 && (
        <div className="batch-result-failed">
          <span className="batch-result-failed-label"><Icon name="circleAlert" size={13} />{t('batchResultFailed', { count: failedJobs.length })}</span>
          {failedJobs.map(job => (
            <button key={job.id} className="btn btn-small" onClick={() => queue.retryJob(batch.id, job.id)} title={job.error || t('batchRetry')}>
              <Icon name="refresh" size={12} />{t('batchRetry')} #{job.index + 1}{job.seed != null ? ` · ${job.seed}` : ''}
            </button>
          ))}
        </div>
      )}

      <div className="batch-result-actions">
        <button className="btn btn-primary" onClick={requeue}><Icon name="queueAdd" size={13} />{t('batchResultJoinQueue')}</button>
        <span className="batch-result-source">{t('queueSourceLabel')}：{jobs[0]?.sourceLabel || t('queueSourceResult')}</span>
      </div>
    </section>
  );
}
