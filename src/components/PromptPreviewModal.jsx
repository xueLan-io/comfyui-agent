import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';

function constraintEntries(constraints) {
  return Object.entries(constraints || {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
}

const APPEARANCE_FIELDS = [
  ['hair', 'Hair'],
  ['eyes', 'Eyes'],
  ['outfit', 'Outfit'],
  ['accessories', 'Accessories'],
  ['silhouette', 'Silhouette'],
];

const TRUST_LABELS = { official: 'official', verified: 'verified', community: 'community', unknown: 'unknown' };

export default function PromptPreviewModal({ preview, onConfirm, onCancel }) {
  const { t } = useI18n();
  const isDirect = preview?.source === 'direct';
  const isUpscale = preview?.operation === 'upscale' || preview?.workflowOperation === 'upscale' || preview?.intent === 'upscale';
  const sourceLabel = isDirect ? t('ppSourceDirect') : t('ppSourceAi');
  const constraints = constraintEntries(preview?.constraints);
  const [positive, setPositive] = useState(preview?.positive || '');
  const [negative, setNegative] = useState(preview?.negative || '');
  const [facts, setFacts] = useState(preview?.research?.facts || {});
  useEffect(() => {
    setPositive(preview?.positive || '');
    setNegative(preview?.negative || '');
    setFacts(preview?.research?.facts || {});
  }, [preview]);
  if (!preview) return null;
  if (preview.action === 'generation_suggestion') {
    return (
      <div className="modal-overlay prompt-preview-overlay">
        <section className="prompt-preview-panel" onClick={event => event.stopPropagation()} aria-label="准备生成确认">
          <header className="modal-header prompt-preview-header">
            <div>
              <h2>检测到图片生成请求</h2>
              <p>将使用当前工作流整理提示词，随后再确认实际提交内容。</p>
            </div>
            <button className="btn btn-icon" onClick={onCancel} title={t('close')}><Icon name="close" /></button>
          </header>
          <div className="prompt-preview-body">
            <section className="prompt-preview-section">
              <h3>{t('request')}</h3>
              <p className="prompt-preview-text">{preview.request}</p>
            </section>
          </div>
          <footer className="settings-footer prompt-preview-footer">
            <span className="settings-footer-spacer" />
            <button className="btn" onClick={onCancel}>{t('cancel')}</button>
            <button className="btn btn-primary" onClick={() => onConfirm({ action: 'prepare_generation' })}>准备生成</button>
          </footer>
        </section>
      </div>
    );
  }
  if (preview.action === 'ai_failed') {
    return (
      <div className="modal-overlay prompt-preview-overlay">
        <section className="prompt-preview-panel" onClick={event => event.stopPropagation()} aria-label={t('ppAiFailed')}>
          <header className="modal-header prompt-preview-header">
            <div>
              <h2>{t('ppAiFailed')}</h2>
              <p>{t('ppAiFailedSub')}</p>
            </div>
            <button className="btn btn-icon" onClick={onCancel} title={t('close')}><Icon name="close" /></button>
          </header>
          <div className="prompt-preview-body">
            <div className="prompt-preview-warning">{preview.error || t('ppAiFailedBody')}</div>
            <section className="prompt-preview-section">
              <h3>{t('ppOriginalRequest')}</h3>
              <p className="prompt-preview-text">{preview.originalRequest}</p>
            </section>
          </div>
          <footer className="settings-footer prompt-preview-footer">
            <span>{t('ppAiFailedNote')}</span>
            <span className="settings-footer-spacer" />
            <button className="btn" onClick={onCancel}>{t('cancel')}</button>
            {preview.code === 'CLOUD_POLICY_BLOCKED' && <button className="btn btn-primary" onClick={() => onConfirm({ action: 'force_cloud' })}>{t('ppForceCloud')}</button>}
            <button className="btn" onClick={() => onConfirm({ action: 'direct_original' })}>{t('ppDirectOriginal')}</button>
            <button className="btn" onClick={() => onConfirm({ action: 'retry_ai' })}>{t('ppRetryAi')}</button>
          </footer>
        </section>
      </div>
    );
  }

  return (
    <div className="modal-overlay prompt-preview-overlay">
      <section className="prompt-preview-panel" onClick={event => event.stopPropagation()} aria-label={t('ppExecuteConfirm')}>
        <header className="modal-header prompt-preview-header">
          <div>
            <h2>{t('ppExecuteConfirm')}</h2>
            <p>{preview.model} · {preview.format}</p>
            <p className="prompt-preview-assistant-note">{isDirect ? t('ppDirectNote') : t('ppAgentNote')}</p>
          </div>
          <button className="btn btn-icon" onClick={onCancel} title={t('close')}><Icon name="close" /></button>
        </header>

        <div className="prompt-preview-body">
          <div className="prompt-preview-source">{t('ppSourceLabel', { label: sourceLabel })}{isDirect && t('ppSourceOrigin', { origin: preview.origin || t('ppDirectInput') })}</div>

          {preview.confirmation?.actions?.length > 0 && (
            <section className="prompt-preview-section">
              <h3>{t('ppActionsTitle')}</h3>
              <div className="prompt-target-list">
                {preview.confirmation.actions.map(action => (
                  <span key={action.type}>
                    <strong>{action.label}</strong>
                    {action.detail && ` · ${action.detail}`}
                  </span>
                ))}
              </div>
            </section>
          )}
          {preview.error && <div className="prompt-preview-warning">{t('ppEnhancerFallback', { error: preview.error })}</div>}

          {isDirect && preview.checks?.length > 0 && (
            <section className="prompt-preview-section">
              <h3>{t('ppWorkflowCheck')}</h3>
              <ul className="prompt-issue-list">
                {preview.checks.map((check, index) => (
                  <li key={`${check.type}-${index}`} className={`prompt-issue prompt-issue-${check.level || 'medium'}`}>{check.message}</li>
                ))}
              </ul>
            </section>
          )}

          {preview.interpretedPrompt && (
            <section className="prompt-preview-section">
              <h3>{t('ppInterpreted')}</h3>
              <p className="prompt-preview-text">{preview.interpretedPrompt}</p>
            </section>
          )}

          {preview.research && (
            <section className="prompt-preview-section prompt-research-section">
              <div className="prompt-research-heading"><h3>{t('ppResearchTitle')}</h3><span className={`research-status research-status-${preview.research.status}`}>{preview.research.status}</span></div>
              {preview.research.message && <div className="prompt-preview-warning">{preview.research.message}</div>}
              {preview.research.sources?.length > 0 && <div className="prompt-research-sources">
                {preview.research.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer"><span>{source.title || source.url}</span><small>{TRUST_LABELS[source.trustLevel] || 'unknown'}</small></a>)}
              </div>}
              <div className="prompt-research-facts">
                {APPEARANCE_FIELDS.map(([field, label]) => <div className="prompt-research-fact" key={field}>
                  <strong>{label}</strong>
                  {facts[field] ? <><span>{facts[field]}</span><button className="btn btn-icon" onClick={() => setFacts(current => ({ ...current, [field]: '' }))} title={`Remove ${label}`} aria-label={`Remove ${label}`}><Icon name="trash" size={13} /></button></> : <em>Not determined</em>}
                </div>)}
              </div>
              {preview.research.unknownFields?.length > 0 && <p className="prompt-preview-text">{t('ppUnknownFields', { fields: preview.research.unknownFields.join('、') })}</p>}
            </section>
          )}

          {(preview.positiveTruncated || preview.negativeTruncated) && (
            <div className="prompt-preview-warning">
              {preview.positiveTruncated && t('ppPositiveTruncated', { n: preview.droppedPositive?.length || 0 })}
              {preview.positiveTruncated && preview.negativeTruncated && '；'}
              {preview.negativeTruncated && t('ppNegativeTruncated', { n: preview.droppedNegative?.length || 0 })}
            </div>
          )}

          {preview.warnings?.length > 0 && (
            <div className="prompt-preview-warning">{preview.warnings.join('；')}</div>
          )}

          {preview.issues?.length > 0 && (
            <section className="prompt-preview-section">
              <h3>{t('ppIssuesTitle')}</h3>
              <ul className="prompt-issue-list">
                {preview.issues.map((issue, index) => (
                  <li key={`${issue.detail}-${index}`} className={`prompt-issue prompt-issue-${issue.severity || 'medium'}`}>{issue.detail}</li>
                ))}
              </ul>
            </section>
          )}

          {preview.tags?.length > 0 && (
            <section className="prompt-preview-section">
              <h3>{t('ppTagsTitle')}</h3>
              <div className="prompt-tag-list">{preview.tags.map((tag, index) => <span key={`${tag}-${index}`}>{tag}</span>)}</div>
            </section>
          )}

          <section className="prompt-preview-section">
            <label htmlFor="positive-prompt">{t('ppPositiveLabel')}</label>
            <textarea id="positive-prompt" className="prompt-preview-editor positive" value={positive} onChange={event => setPositive(event.target.value)} autoFocus />
          </section>

          <section className="prompt-preview-section">
            <label htmlFor="negative-prompt">{t('ppNegativeLabel')}</label>
            {preview.supportsNegative
              ? <textarea id="negative-prompt" className="prompt-preview-editor" value={negative} onChange={event => setNegative(event.target.value)} />
              : <p className="prompt-preview-text">{t('ppNoNegative')}</p>}
          </section>

          <section className="prompt-preview-section prompt-constraint-grid">
            <div>
              <h3>{t('ppCharacterConstraints')}</h3>
              <p className="prompt-preview-text">{constraints.filter(([key]) => /character|subject|person|identity|count|age|clothing/i.test(key)).map(([key, value]) => `${key}: ${String(value)}`).join('\n') || t('ppCharacterFallback')}</p>
            </div>
            <div>
              <h3>{t('ppCameraConstraints')}</h3>
              <p className="prompt-preview-text">{constraints.filter(([key]) => /camera|shot|composition|view|angle|lens/i.test(key)).map(([key, value]) => `${key}: ${String(value)}`).join('\n') || t('ppCameraFallback')}</p>
            </div>
          </section>

          <section className="prompt-preview-section">
            <h3>{t('ppTargetsTitle')}</h3>
            <div className="prompt-target-list">
              {(preview.targets || []).map((target, index) => (
                <span key={`${target.nodeId}-${target.input}-${index}`}>
                  <strong>{target.polarity === 'negative' ? t('ppPolarityNegative') : t('ppPolarityPositive')}</strong>
                  {t('ppNodeSlot', { nodeId: target.nodeId, input: target.input })}
                </span>
              ))}
              {preview.targets?.length === 0 && <span>{t('ppNoTargets')}</span>}
            </div>
          </section>
        </div>

        <footer className="settings-footer prompt-preview-footer">
          <span>{t('ppConfirmNote')}</span>
          <span className="settings-footer-spacer" />
          <button className="btn" onClick={onCancel}>{t('cancel')}</button>
          <button className="btn btn-primary" onClick={() => onConfirm({ positive, negative, ...(preview.research ? { appearanceFacts: { ...facts, evidence: (preview.research.evidence || []).filter(item => facts[item.field]) } } : {}) })} disabled={(preview.targets?.length === 0 && !isUpscale) || preview.workflow?.valid === false}>{t('ppConfirmGenerate')}</button>
        </footer>
      </section>
    </div>
  );
}
