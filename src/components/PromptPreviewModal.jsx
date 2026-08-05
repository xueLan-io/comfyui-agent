import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';

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
  const isDirect = preview?.source === 'direct';
  const sourceLabel = isDirect ? '直接生成 · 原文执行' : 'AI 生成 · Agent 规划';
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
  if (preview.action === 'ai_failed') {
    return (
      <div className="modal-overlay prompt-preview-overlay">
        <section className="prompt-preview-panel" onClick={event => event.stopPropagation()} aria-label="AI 生成失败">
          <header className="modal-header prompt-preview-header">
            <div>
              <h2>AI 生成失败</h2>
              <p>大模型没有完成理解或规划</p>
            </div>
            <button className="btn btn-icon" onClick={onCancel} title="关闭"><Icon name="close" /></button>
          </header>
          <div className="prompt-preview-body">
            <div className="prompt-preview-warning">{preview.error || 'AI 生成未完成'}</div>
            <section className="prompt-preview-section">
              <h3>原始请求</h3>
              <p className="prompt-preview-text">{preview.originalRequest}</p>
            </section>
          </div>
          <footer className="settings-footer prompt-preview-footer">
            <span>请选择下一步，系统不会自动切换生成链。</span>
            <span className="settings-footer-spacer" />
            <button className="btn" onClick={onCancel}>取消</button>
            {preview.code === 'CLOUD_POLICY_BLOCKED' && <button className="btn btn-primary" onClick={() => onConfirm({ action: 'force_cloud' })}>仍然发送到云端</button>}
            <button className="btn" onClick={() => onConfirm({ action: 'direct_original' })}>按原文直接生成</button>
            <button className="btn" onClick={() => onConfirm({ action: 'retry_ai' })}>重试 AI</button>
          </footer>
        </section>
      </div>
    );
  }

  return (
    <div className="modal-overlay prompt-preview-overlay">
      <section className="prompt-preview-panel" onClick={event => event.stopPropagation()} aria-label="执行确认">
        <header className="modal-header prompt-preview-header">
          <div>
            <h2>执行确认</h2>
            <p>{preview.model} · {preview.format}</p>
            <p className="prompt-preview-assistant-note">{isDirect ? '这是直接生成，提示词不会自动改写。请检查原文和工作流后确认。' : 'Agent 已完成规划，请检查提示词和修改目标后确认。'}</p>
          </div>
          <button className="btn btn-icon" onClick={onCancel} title="关闭"><Icon name="close" /></button>
        </header>

        <div className="prompt-preview-body">
          <div className="prompt-preview-source">生成方式：{sourceLabel}{isDirect && ` · 来源：${preview.origin || '直接输入'}`}</div>

          {preview.confirmation?.actions?.length > 0 && (
            <section className="prompt-preview-section">
              <h3>本次操作</h3>
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
          {preview.error && <div className="prompt-preview-warning">增强器返回异常，当前预览已回退为原始提示词：{preview.error}</div>}

          {isDirect && preview.checks?.length > 0 && (
            <section className="prompt-preview-section">
              <h3>工作流检查</h3>
              <ul className="prompt-issue-list">
                {preview.checks.map((check, index) => (
                  <li key={`${check.type}-${index}`} className={`prompt-issue prompt-issue-${check.level || 'medium'}`}>{check.message}</li>
                ))}
              </ul>
            </section>
          )}

          {preview.interpretedPrompt && (
            <section className="prompt-preview-section">
              <h3>模型理解的画面</h3>
              <p className="prompt-preview-text">{preview.interpretedPrompt}</p>
            </section>
          )}

          {preview.research && (
            <section className="prompt-preview-section prompt-research-section">
              <div className="prompt-research-heading"><h3>角色资料查询</h3><span className={`research-status research-status-${preview.research.status}`}>{preview.research.status}</span></div>
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
              {preview.research.unknownFields?.length > 0 && <p className="prompt-preview-text">未确定：{preview.research.unknownFields.join('、')}</p>}
            </section>
          )}

          {(preview.positiveTruncated || preview.negativeTruncated) && (
            <div className="prompt-preview-warning">
              {preview.positiveTruncated && `正向提示词超出预算，已压缩并丢弃 ${preview.droppedPositive?.length || 0} 项`}
              {preview.positiveTruncated && preview.negativeTruncated && '；'}
              {preview.negativeTruncated && `负向提示词超出预算，已压缩并丢弃 ${preview.droppedNegative?.length || 0} 项`}
            </div>
          )}

          {preview.warnings?.length > 0 && (
            <div className="prompt-preview-warning">{preview.warnings.join('；')}</div>
          )}

          {preview.issues?.length > 0 && (
            <section className="prompt-preview-section">
              <h3>检查发现问题</h3>
              <ul className="prompt-issue-list">
                {preview.issues.map((issue, index) => (
                  <li key={`${issue.detail}-${index}`} className={`prompt-issue prompt-issue-${issue.severity || 'medium'}`}>{issue.detail}</li>
                ))}
              </ul>
            </section>
          )}

          {preview.tags?.length > 0 && (
            <section className="prompt-preview-section">
              <h3>识别到的标签</h3>
              <div className="prompt-tag-list">{preview.tags.map((tag, index) => <span key={`${tag}-${index}`}>{tag}</span>)}</div>
            </section>
          )}

          <section className="prompt-preview-section">
            <label htmlFor="positive-prompt">正向提示词</label>
            <textarea id="positive-prompt" className="prompt-preview-editor positive" value={positive} onChange={event => setPositive(event.target.value)} autoFocus />
          </section>

          <section className="prompt-preview-section">
            <label htmlFor="negative-prompt">负向提示词</label>
            {preview.supportsNegative
              ? <textarea id="negative-prompt" className="prompt-preview-editor" value={negative} onChange={event => setNegative(event.target.value)} />
              : <p className="prompt-preview-text">当前模型不使用普通负向提示词</p>}
          </section>

          <section className="prompt-preview-section prompt-constraint-grid">
            <div>
              <h3>人物约束</h3>
              <p className="prompt-preview-text">{constraints.filter(([key]) => /character|subject|person|identity|count|age|clothing/i.test(key)).map(([key, value]) => `${key}: ${String(value)}`).join('\n') || '按用户原始描述保持人物身份、人数、年龄和服装'}</p>
            </div>
            <div>
              <h3>镜头约束</h3>
              <p className="prompt-preview-text">{constraints.filter(([key]) => /camera|shot|composition|view|angle|lens/i.test(key)).map(([key, value]) => `${key}: ${String(value)}`).join('\n') || '按用户原始描述保持镜头与构图'}</p>
            </div>
          </section>

          <section className="prompt-preview-section">
            <h3>将修改的节点和槽位</h3>
            <div className="prompt-target-list">
              {(preview.targets || []).map((target, index) => (
                <span key={`${target.nodeId}-${target.input}-${index}`}>
                  <strong>{target.polarity === 'negative' ? '负向' : '正向'}</strong>
                  节点 {target.nodeId} · {target.input}
                </span>
              ))}
              {preview.targets?.length === 0 && <span>当前执行图没有可写提示词目标</span>}
            </div>
          </section>
        </div>

        <footer className="settings-footer prompt-preview-footer">
          <span>确认后仅执行卡片中列出的操作，不会重新规划。</span>
          <span className="settings-footer-spacer" />
          <button className="btn" onClick={onCancel}>取消</button>
          <button className="btn btn-primary" onClick={() => onConfirm({ positive, negative, ...(preview.research ? { appearanceFacts: { ...facts, evidence: (preview.research.evidence || []).filter(item => facts[item.field]) } } : {}) })} disabled={preview.targets?.length === 0 || !positive.trim() || preview.workflow?.valid === false}>确认并生成</button>
        </footer>
      </section>
    </div>
  );
}
