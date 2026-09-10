import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../contexts/SessionContext.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';
import { buildChatSystemPrompt, CHAT_SYSTEM_PROMPT_LIMIT, PLACEHOLDER_IDS } from '../agent/runtime/chat-prompt.mjs';

const EMPTY = { enabled: false, strategy: 'append', text: '' };

const PRESETS = [
  { id: 'engineer', zhLabel: '专业提示词工程师', enLabel: 'Expert prompt engineer', zh: '你是资深的 AI 绘画提示词工程师，深谙 ComfyUI 工作流、采样参数与各模型族的特性。回答专业、结构清晰，主动给出可执行的建议与备选方案，必要时提醒参数权衡。', en: 'You are a senior AI art prompt engineer who knows ComfyUI workflows, sampling parameters, and model families inside out. Answer professionally and clearly, offer actionable advice and alternatives, and point out parameter trade-offs when relevant.' },
  { id: 'concise', zhLabel: '极简高效', enLabel: 'Concise & efficient', zh: '回答务必简短直接，只说结论与必要理由；不使用列表和 Markdown，不重复用户已知的信息，不寒暄。', en: 'Keep answers short and direct: state the conclusion and the essential reason only. No lists, no Markdown, no repeating what the user already knows, no small talk.' },
  { id: 'writer', zhLabel: '创意写作助手', enLabel: 'Creative writer', zh: '你是富有想象力的创意写作助手，语言生动、富有画面感，善用比喻与细节描写，同时保持结构清晰、逻辑通顺。', en: 'You are an imaginative creative-writing assistant. Write vividly with strong imagery, metaphors, and sensory detail, while staying clear and well structured.' },
];

export default function PromptPersonalitySettings() {
  const session = useSession();
  const { t, language } = useI18n();
  const [globalConfig, setGlobalConfig] = useState(EMPTY);
  const [projectConfig, setProjectConfig] = useState(null);
  const [scope, setScope] = useState('global');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const textareaRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.promptSettings().then(value => {
      if (cancelled) return;
      setGlobalConfig({ enabled: Boolean(value.enabled), strategy: value.strategy === 'replace' ? 'replace' : 'append', text: String(value.text || '') });
      setStatus('');
    }).catch(() => { if (!cancelled) setStatus(t('personalityLoadFailed')); });
    return () => { cancelled = true; };
  }, [t]);

  useEffect(() => {
    const override = session.project?.customSystemPrompt;
    setProjectConfig(override && (override.enabled || String(override.text || '').trim())
      ? { enabled: Boolean(override.enabled), strategy: override.strategy === 'replace' ? 'replace' : 'append', text: String(override.text || '') }
      : null);
  }, [session.project?.customSystemPrompt]);

  const current = scope === 'project' && projectConfig ? projectConfig : globalConfig;
  const setCurrent = patch => {
    if (scope === 'project') setProjectConfig(prev => ({ ...(prev || EMPTY), ...patch }));
    else setGlobalConfig(prev => ({ ...prev, ...patch }));
    setStatus('');
  };

  const overLimit = current.text.length > CHAT_SYSTEM_PROMPT_LIMIT;
  const active = current.enabled && Boolean(current.text.trim());

  const previewText = useMemo(() => buildChatSystemPrompt({
    personality: { enabled: active, strategy: current.strategy, text: current.text },
    language,
    projectContext: t('personalityInjectedProject'),
    workflowContext: t('personalityInjectedWorkflow'),
    researchContext: t('personalityInjectedResearch'),
    runtimeContext: t('personalityInjectedRuntime'),
    visionSupported: true,
    visionImages: [{}],
  }), [active, current.strategy, current.text, language, t]);

  function insertPlaceholder(id) {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const label = `{${id}}`;
    const start = textarea.selectionStart ?? current.text.length;
    const end = textarea.selectionEnd ?? start;
    setCurrent({ text: current.text.slice(0, start) + label + current.text.slice(end) });
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + label.length, start + label.length);
    });
  }

  async function save() {
    if (overLimit) { setStatus(t('personalityTooLong')); return; }
    const value = { enabled: active, strategy: current.strategy, text: current.text.trim() };
    setSaving(true);
    try {
      if (scope === 'project') {
        session.applyState(await window.electronAPI.projectUpdateState({ customSystemPrompt: value }));
      } else {
        setGlobalConfig(await window.electronAPI.promptSaveSettings(value));
      }
      setStatus(t('personalitySaved'));
    } catch (error) {
      setStatus(error.message || t('personalitySaveFailed'));
    }
    setSaving(false);
  }

  async function restoreDefault() {
    if (!window.confirm(t('personalityRestoreConfirm'))) return;
    setSaving(true);
    try {
      if (scope === 'project') {
        session.applyState(await window.electronAPI.projectUpdateState({ customSystemPrompt: EMPTY }));
      } else {
        setGlobalConfig(await window.electronAPI.promptSaveSettings(EMPTY));
      }
      setStatus(t('personalitySaved'));
    } catch (error) {
      setStatus(error.message || t('personalitySaveFailed'));
    }
    setSaving(false);
  }

  return <section>
    <div className="settings-section-heading"><div><h3>{t('promptPersonality')}</h3><p>{t('promptPersonalityDescription')}</p></div></div>
    <label className="settings-toggle"><span><strong>{t('personalityEnable')}</strong><small>{t('personalityEnableDescription')}</small></span><input type="checkbox" checked={current.enabled} onChange={event => setCurrent({ enabled: event.target.checked })} /></label>
    {session.project && <div className="personality-scope" role="radiogroup" aria-label={t('personalityStrategy')}>
      <label className="scope-option"><input type="radio" name="personality-scope" checked={scope === 'global'} onChange={() => { setScope('global'); setStatus(''); }} /><span><strong>{t('personalityScopeGlobal')}</strong></span></label>
      <label className="scope-option"><input type="radio" name="personality-scope" checked={scope === 'project'} onChange={() => { setScope('project'); setStatus(''); }} /><span><strong>{t('personalityScopeProject')}</strong><small>{t('personalityScopeProjectDescription')}</small>{scope === 'project' && projectConfig && <em>{t('personalityProjectOverrideActive')}</em>}</span></label>
    </div>}
    <div className={`personality-body${current.enabled ? '' : ' disabled'}`}>
      <label className="settings-toggle"><span><strong>{t('personalityStrategyAppend')}</strong></span><input type="radio" name="personality-strategy" checked={current.strategy === 'append'} onChange={() => setCurrent({ strategy: 'append' })} /></label>
      <label className="settings-toggle"><span><strong>{t('personalityStrategyReplace')}</strong></span><input type="radio" name="personality-strategy" checked={current.strategy === 'replace'} onChange={() => setCurrent({ strategy: 'replace' })} /></label>
      {current.strategy === 'replace' && <p className="settings-muted personality-warning">{t('personalityReplaceWarning')}</p>}
      <div className="settings-grid">
        <div className="settings-field">
          <label>{t('personalityPresets')}</label>
          <select value="" onChange={event => { const preset = PRESETS.find(item => item.id === event.target.value); if (preset) setCurrent({ text: language === 'zh-CN' ? preset.zh : preset.en }); event.target.value = ''; }}>
            <option value="" disabled>{t('personalityPresetPlaceholder')}</option>
            {PRESETS.map(preset => <option key={preset.id} value={preset.id}>{language === 'zh-CN' ? preset.zhLabel : preset.enLabel}</option>)}
          </select>
        </div>
        <div className="settings-field">
          <label>{t('personalityPlaceholders')}</label>
          <div className="variable-chips">{PLACEHOLDER_IDS.map(id => <button key={id} type="button" className="variable-chip" onClick={() => insertPlaceholder(id)}>{`{${id}}`}</button>)}</div>
          <small className="settings-muted">{t('personalityPlaceholderHint')}</small>
        </div>
      </div>
      <div className="settings-field">
        <label>{t('personalityText')}</label>
        <textarea ref={textareaRef} className={`settings-textarea${overLimit ? ' over-limit' : ''}`} rows={10} value={current.text} onChange={event => setCurrent({ text: event.target.value })} placeholder={t('personalityTextPlaceholder')} />
        <span className={`settings-textarea-count${overLimit ? ' over-limit' : ''}`}>{t('personalityCount', { count: current.text.length })}</span>
      </div>
      <button type="button" className="btn personality-preview-toggle" onClick={() => setPreviewOpen(value => !value)}>{previewOpen ? t('personalityPreviewClose') : t('personalityPreviewOpen')}</button>
      {previewOpen && <pre className="prompt-preview-box">{previewText}</pre>}
      <p className="settings-muted personality-boundary-note">{t('personalityBoundaryNote')}</p>
    </div>
    <div className="settings-actions">
      <button className="btn btn-primary" onClick={() => void save()} disabled={saving || overLimit}>{saving ? t('saving') : t('personalitySave')}</button>
      <button className="btn" onClick={() => void restoreDefault()} disabled={saving}>{t('personalityRestoreDefault')}</button>
      {status && <span className="settings-save-state">{status}</span>}
    </div>
  </section>;
}
