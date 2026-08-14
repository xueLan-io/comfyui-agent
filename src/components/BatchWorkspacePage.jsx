import { useEffect, useRef, useState } from 'react';
import { useSession } from '../contexts/SessionContext.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';
import Icon from './Icon.jsx';

const ACTIVE_STATUSES = new Set(['created', 'running', 'paused', 'interrupted']);

function parseSeeds(text) {
  return String(text || '')
    .split(/[,，\s]+/)
    .map(value => Number(value))
    .filter(Number.isFinite)
    .slice(0, 50);
}

function parseCombos(text) {
  const value = String(text || '').trim();
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error('参数组合必须是 JSON 数组');
  return parsed;
}

// Batch creation workspace: define a seed/parameter matrix and monitor the
// batch pipeline (progress, pause/cancel, single-job retry, curation Top-K).
export default function BatchWorkspacePage({ onBack }) {
  const { t } = useI18n();
  const session = useSession();
  const projectId = session.activeProjectId || '';
  const [batches, setBatches] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  const [form, setForm] = useState({ title: '', workflowName: '', positive: '', negative: '', seedCount: '4', seeds: '', combos: '' });
  const [status, setStatus] = useState('');
  const [curating, setCurating] = useState('');
  const refreshTimerRef = useRef(null);

  async function loadBatches() {
    try {
      setBatches(await window.electronAPI.batchList(projectId, 20));
    } catch (error) {
      setStatus(error.message || t('batchLoadFailed'));
    }
  }

  useEffect(() => {
    if (!projectId) return;
    void loadBatches();
    void window.electronAPI.listWorkflows().then(list => setWorkflows(Array.isArray(list) ? list : [])).catch(() => {});
    const unsubscribe = window.electronAPI.onBatchEvent?.(payload => {
      if (payload?.type === 'batch:job-status' || payload?.type === 'batch:status') void loadBatches();
    });
    const poll = () => {
      const active = batches.some(batch => ACTIVE_STATUSES.has(batch.status));
      if (active) void loadBatches();
    };
    refreshTimerRef.current = setInterval(poll, 2000);
    return () => {
      unsubscribe?.();
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    };
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function createBatch() {
    const workflowName = form.workflowName.trim();
    const positive = form.positive.trim();
    if (!workflowName || !positive) {
      setStatus(t('batchCreateHint'));
      return;
    }
    try {
      const seeds = parseSeeds(form.seeds);
      const input = {
        title: form.title.trim(),
        workflowName,
        positive,
        negative: form.negative.trim(),
        seedCount: seeds.length === 0 ? Math.max(1, Number(form.seedCount) || 1) : 0,
        seeds,
        combos: parseCombos(form.combos),
      };
      const batch = await window.electronAPI.batchCreate(input);
      setStatus(`${t('batchCreated')} · ${batch.jobs.length} ${t('batchJobs')}`);
      setForm(previous => ({ ...previous, title: '', positive: '', negative: '', seeds: '', combos: '' }));
      await window.electronAPI.batchStart(batch.id);
      await loadBatches();
    } catch (error) {
      setStatus(error.message || t('batchCreateFailed'));
    }
  }

  async function runAction(action, ...args) {
    try {
      await window.electronAPI[action](...args);
      await loadBatches();
    } catch (error) {
      setStatus(error.message || t('operationFailed'));
    }
  }

  async function curate(batchId) {
    if (curating) return;
    setCurating(batchId);
    try {
      const outcome = await window.electronAPI.batchCurate(batchId, 12);
      setStatus(`${t('batchCurated')}：${outcome.scored} · ${t('batchTop')} ${outcome.top.map(item => `#${item.index + 1} (${item.score})`).join('、')}`);
      await loadBatches();
    } catch (error) {
      setStatus(error.message || t('batchCurateFailed'));
    } finally {
      setCurating('');
    }
  }

  const totalJobs = batches.reduce((sum, batch) => sum + batch.progress.total, 0);
  const activeCount = batches.filter(batch => ACTIVE_STATUSES.has(batch.status)).length;

  return (
    <div className="batch-workspace page-view">
      <header className="page-header">
        <button className="btn btn-icon" onClick={onBack} title={t('backToChat')}><Icon name="chevronLeft" /></button>
        <h2>{t('batchWorkspace')}</h2>
        <span className="batch-summary">{batches.length} {t('batchBatches')} · {totalJobs} {t('batchJobs')}{activeCount > 0 ? ` · ${t('batchRunning')} ${activeCount}` : ''}</span>
      </header>
      {status && <p className="settings-status">{status}</p>}

      <section className="batch-create">
        <h3>{t('batchCreateTitle')}</h3>
        <div className="settings-grid">
          <div className="settings-field"><label>{t('batchTitle')}</label><input value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} placeholder={t('batchTitlePlaceholder')} /></div>
          <div className="settings-field">
            <label>{t('workflow')} *</label>
            <select value={form.workflowName} onChange={event => setForm({ ...form, workflowName: event.target.value })}>
              <option value="">{t('chooseWorkflow')}</option>
              {workflows.map(workflow => <option key={workflow.name || workflow} value={workflow.name || workflow}>{(workflow.name || workflow).replace(/\.json$/i, '')}</option>)}
            </select>
          </div>
          <div className="settings-field span-2"><label>{t('batchPositive')} *</label><textarea value={form.positive} onChange={event => setForm({ ...form, positive: event.target.value })} rows={2} placeholder={t('batchPositivePlaceholder')} /></div>
          <div className="settings-field span-2"><label>{t('batchNegative')}</label><textarea value={form.negative} onChange={event => setForm({ ...form, negative: event.target.value })} rows={1} placeholder={t('batchNegativePlaceholder')} /></div>
          <div className="settings-field"><label>{t('batchSeedCount')}</label><input type="number" min="1" max="100" value={form.seedCount} onChange={event => setForm({ ...form, seedCount: event.target.value })} /></div>
          <div className="settings-field"><label>{t('batchSeeds')}</label><input value={form.seeds} onChange={event => setForm({ ...form, seeds: event.target.value })} placeholder="42, 1337, 2026" /></div>
          <div className="settings-field span-2"><label>{t('batchCombos')}</label><textarea value={form.combos} onChange={event => setForm({ ...form, combos: event.target.value })} rows={1} placeholder='[{"settings":{"steps":30}},{"settings":{"cfg":7}}]' /></div>
        </div>
        <button className="btn btn-primary" onClick={() => void createBatch()} disabled={!form.workflowName.trim() || !form.positive.trim()}>
          <Icon name="play" size={14} /> {t('batchCreateAndStart')}
        </button>
      </section>

      <section className="batch-list">
        {batches.length === 0 && <p className="batch-empty">{t('batchEmpty')}</p>}
        {batches.map(batch => (
          <article className="batch-card" key={batch.id}>
            <header className="batch-card-head">
              <div>
                <strong>{batch.title}</strong>
                <span className={`batch-status batch-status-${batch.status}`}>{t(`batchStatus_${batch.status}`)}</span>
              </div>
              <div className="batch-actions">
                {batch.status === 'created' || batch.status === 'paused' || batch.status === 'interrupted'
                  ? <button className="btn" onClick={() => void runAction('batchResume', batch.id)} title={t('batchResume')}><Icon name="play" size={14} /></button>
                  : batch.status === 'running' && <button className="btn" onClick={() => void runAction('batchPause', batch.id)} title={t('batchPause')}><Icon name="minus" size={14} /></button>}
                {(batch.status === 'created' || batch.status === 'paused' || batch.status === 'interrupted' || batch.status === 'running')
                  && <button className="btn" onClick={() => void runAction('batchCancel', batch.id)} title={t('batchCancel')}><Icon name="stop" size={14} /></button>}
                {batch.status === 'completed' && batch.progress.completed > 0
                  && <button className="btn" onClick={() => void curate(batch.id)} disabled={Boolean(curating)} title={t('batchCurate')}><Icon name="star" size={14} /> {t('batchCurate')}</button>}
              </div>
            </header>
            <div className="batch-progress">
              <div className="generation-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={batch.progress.total ? Math.round(batch.progress.done * 100 / batch.progress.total) : 0}>
                <span style={{ width: `${batch.progress.total ? Math.round(batch.progress.done * 100 / batch.progress.total) : 0}%` }} />
              </div>
              <span className="batch-progress-label">{batch.progress.done}/{batch.progress.total} · ✓{batch.progress.completed} ✗{batch.progress.failed} ⊘{batch.progress.cancelled}</span>
            </div>
            <table className="batch-jobs">
              <thead><tr><th>#</th><th>{t('batchSeed')}</th><th>{t('batchStatusShort')}</th><th>{t('batchScore')}</th><th>{t('batchActions')}</th></tr></thead>
              <tbody>
                {batch.jobs.map(job => (
                  <tr key={job.id || job.index} className={`batch-job-${job.status}`}>
                    <td>{job.index + 1}</td>
                    <td>{job.seed ?? '—'}</td>
                    <td>{job.status === 'failed' ? `${t(`batchJobStatus_${job.status}`)}${job.error ? `：${String(job.error).slice(0, 60)}` : ''}` : t(`batchJobStatus_${job.status}`)}</td>
                    <td>{job.score ?? '—'}</td>
                    <td>
                      {(job.status === 'failed' || job.status === 'cancelled')
                        && <button className="btn btn-icon" onClick={() => void runAction('batchRetryJob', batch.id, job.id)} title={t('batchRetry')}><Icon name="refresh" size={14} /></button>}
                      {job.result?.images?.length > 0 && job.result.images[0].path
                        && <button className="btn btn-icon" onClick={() => void window.electronAPI.comfyUIShowImage?.(job.result.images[0])} title={t('batchShowImage')}><Icon name="images" size={14} /></button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>
        ))}
      </section>
    </div>
  );
}
