import ImageAsset from './ImageAsset.jsx';
import Icon from './Icon.jsx';
import { outputGalleryClass } from './image-layout.mjs';
import GenerationProgress from './GenerationProgress.jsx';
import GenerationActions from './GenerationActions.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';
import { generationRecordView } from '../runtime/runtime-status.mjs';

function progressValue(record) {
  const value = Number(record.progressPercent ?? record.progressNodePercent);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
}

function renderAspectRatio(record) {
  const settings = record.parameters || record.settings || {};
  const width = Number(settings.width);
  const height = Number(settings.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '1 / 1';
  const ratio = Math.max(0.55, Math.min(1.8, width / height));
  return `${ratio} / 1`;
}

function RenderingPlaceholder({ record }) {
  const percent = progressValue(record);
  const label = record.status === 'preparing'
    ? '准备渲染'
    : record.status === 'queued'
      ? '等待渲染'
      : record.progressMessage || '正在渲染';
  return <div className="generation-rendering-placeholder" style={{ '--generation-aspect-ratio': renderAspectRatio(record) }} role="status" aria-live="polite">
    <div className="generation-rendering-frame" aria-hidden="true">
      <span className="generation-rendering-orb" />
    </div>
    <div className="generation-rendering-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={percent ?? undefined}>
      <span className="generation-rendering-progress-track" style={percent !== null ? { width: `${percent}%` } : undefined} />
    </div>
    <div className="generation-rendering-meta">
      <span>{label}</span>
      <strong>{percent === null ? '...' : `${percent}%`}</strong>
    </div>
  </div>;
}

export default function GenerationRecordCard({ record, onOpenImage, onError, onRegenerate, onEdit, onAdjust }) {
  const { t } = useI18n();
  const media = record.media || [];
  const runtime = generationRecordView(record);
  const terminal = runtime.terminal;
  const failed = runtime.phase === 'failed';
  const pending = !terminal && !runtime.recoverable && media.length === 0;
  const hasOutput = media.length > 0 && ['completed', 'recovery'].includes(runtime.phase);
  return <section className={`generation-record generation-record-${record.status || 'preparing'}${pending ? ' generation-record-pending' : ''}`} data-turn-id={record.turnId}>
    {hasOutput ? <>
      <div className={`image-grid chat-output-grid ${outputGalleryClass(media.length)}`}>{media.map((image, index) => <article key={`${image.assetId || image.filename || image.name || index}`} className="image-item"><ImageAsset image={image} onOpen={preview => onOpenImage?.({ ...preview, images: media, index })} onError={onError} /><div className="image-item-info"><span title={image.filename}>{image.filename || image.name || ''}</span><b>{String(index + 1).padStart(2, '0')}</b></div></article>)}</div>
      {runtime.recoverable && <div className="generation-record-warning" role="status"><Icon name="circleAlert" size={14} />{record.error?.message || '结果已生成，但归档未完成'}</div>}
      <details className="generation-details">
        <summary>提示词与参数</summary>
        <div className="output-prompt"><span>{t('positiveLabel')}</span><code>{record.prompt || ''}</code>{record.negative && <><span>{t('negativeLabel')}</span><code>{record.negative}</code></>}</div>
        <div className="generation-record-parameters"><span>{t('parameters')}</span><pre>{JSON.stringify(record.parameters || {}, null, 2)}</pre></div>
      </details>
    </> : pending ? <RenderingPlaceholder record={record} /> : <div className={`generation-record-placeholder${terminal ? ' terminal' : ''}`}>
        {(failed || record.status === 'cancelled') && <Icon name="circleAlert" size={22} />}
        <GenerationProgress status={failed ? 'failed' : record.status} percent={record.progressPercent} nodePercent={record.progressNodePercent} message={record.progressMessage || record.error?.message} stage={record.progressStage} />
      </div>}
    {hasOutput && <GenerationActions record={record} onRegenerate={onRegenerate} onEdit={onEdit} onAdjust={onAdjust} />}
  </section>;
}
