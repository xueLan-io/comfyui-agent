import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../contexts/SessionContext.jsx';
import { useComfyUI } from '../contexts/ComfyUIContext.jsx';
import AppearanceSettings from './AppearanceSettings.jsx';
import ResearchSettings from './ResearchSettings.jsx';
import NotificationSettings from './NotificationSettings.jsx';
import PromptPersonalitySettings from './PromptPersonalitySettings.jsx';
import MemorySettings from './MemorySettings.jsx';
import Icon from './Icon.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';
import { TEMPLATES, EMPTY_PROVIDER } from '../provider-templates.js';
import ProviderPickerModal from './ProviderPickerModal.jsx';

const EMPTY_SKILL = { id: '', name: '', description: '', keywords: '', promptMode: 'raw', enabled: true };

function ProviderForm({ value, onChange, onSave, onTest, testState, saveState }) {
  const { t } = useI18n();
  const headerRows = Object.entries(value.headers || {});
  const validId = /^[a-z0-9_-]+$/.test(value.id || '');
  const template = TEMPLATES[value.id] ? value.id : '';
  const update = patch => onChange({ ...value, ...patch });
  const isBusy = saveState.status === 'saving' || testState.status === 'testing';

  function updateModel(index, patch) {
    update({ models: value.models.map((model, i) => i === index ? { ...model, ...patch } : model) });
  }

  function updateHeader(index, key, headerValue) {
    const rows = [...headerRows];
    rows[index] = [key, headerValue];
    update({ headers: Object.fromEntries(rows.filter(([name]) => name)) });
  }

  return <div className="provider-form">
    <div className="provider-intro span-2">
       <div><span className="provider-kicker">{t('providerIntro')}</span><h3>{t('addProvider')}</h3></div>
       <p>{t('providerIntroDescription')}</p>
    </div>
    <div className="template-note">
        <strong>{template === 'lmstudio' ? t('providerLocalOpenai') : value.type === 'ollama' ? t('providerOllama') : t('providerOpenaiCompatible')}</strong>
        <span>{template === 'lmstudio' ? t('providerLocalOpenaiHint') : value.type === 'ollama' ? t('providerOllamaHint') : t('providerOpenaiHint')}</span>
      </div>
    <div className="settings-field"><label>{t('id')}</label><input value={value.id} onChange={event => update({ id: event.target.value })} placeholder="provider_id" />{value.id && !validId && <small className="field-error">Only a-z, 0-9, _, and - are supported</small>}</div>
    <div className="settings-field"><label>{t('displayName')}</label><input value={value.name} onChange={event => update({ name: event.target.value })} /></div>
    <div className="settings-field span-2"><label>{t('apiAddress')}</label><input value={value.baseUrl} onChange={event => update({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></div>
    <div className="settings-field span-2"><label>{t('apiKey')}</label><input type="password" value={value.apiKey || ''} onChange={event => update({ apiKey: event.target.value, apiKeyError: '' })} placeholder={value.hasApiKey ? t('apiKeySaved') : value.type === 'ollama' || template === 'lmstudio' ? t('localNoApiKey') : 'sk-...'} />{value.apiKeyError && <small className="field-error">{t('apiKeyDecryptFailed')}</small>}</div>

    <div className="settings-subsection span-2">
      <div className="settings-subsection-title"><span>{t('modelsTitle')}</span><button className="btn btn-icon" onClick={() => update({ models: [...value.models, { id: '', name: '' }] })} title={t('addModel')}><Icon name="plus" /></button></div>
       {value.models.map((model, index) => <div className="settings-row" key={index}>
        <input value={model.id} onChange={event => updateModel(index, { id: event.target.value })} placeholder={t('modelIdPlaceholder')} />
        <input value={model.name} onChange={event => updateModel(index, { name: event.target.value })} placeholder={t('displayNamePlaceholder')} />
        <select value={model.kind || 'chat'} onChange={event => updateModel(index, { kind: event.target.value })} aria-label={t('modelCapability')}>
          <option value="chat">{t('chatCapability')}</option>
          <option value="image">{t('imageCapability')}</option>
        </select>
        {model.kind === 'image' && <select value={model.runtime || 'cloud'} onChange={event => updateModel(index, { runtime: event.target.value })} aria-label={t('runtimeLocation')}>
          <option value="cloud">{t('cloud')}</option>
          <option value="local">{t('local')}</option>
        </select>}
        <button className="btn btn-icon" onClick={() => update({ models: value.models.filter((_, i) => i !== index) })} disabled={value.models.length === 1} title={t('deleteModel')}><Icon name="trash" size={14} /></button>
      </div>)}
    </div>

    <div className="settings-subsection span-2">
      <div className="settings-subsection-title"><span>{t('headers')}</span><button className="btn btn-icon" onClick={() => update({ headers: { ...value.headers, [`X-Header-${headerRows.length + 1}`]: '' } })} title={t('addHeader')}><Icon name="plus" /></button></div>
      {headerRows.length === 0 && <div className="settings-muted">{t('noHeaders')}</div>}
      {headerRows.map(([key, headerValue], index) => <div className="settings-row" key={`${key}-${index}`}>
         <input value={key} onChange={event => updateHeader(index, event.target.value, headerValue)} placeholder={t('headerPlaceholder')} />
         <input value={headerValue} onChange={event => updateHeader(index, key, event.target.value)} placeholder={t('valuePlaceholder')} />
        <button className="btn btn-icon" onClick={() => update({ headers: Object.fromEntries(headerRows.filter((_, i) => i !== index)) })} title={t('deleteHeader')}><Icon name="trash" size={14} /></button>
      </div>)}
    </div>

    <div className="provider-actions span-2">
      <div className="provider-action-buttons">
        <button className="btn" onClick={onTest} disabled={!validId || isBusy}>{testState.status === 'testing' ? t('testing') : t('testConnection')}</button>
        <button className="btn btn-primary" onClick={onSave} disabled={!validId || !value.name || !value.models.some(model => model.id) || isBusy}>{saveState.status === 'saving' ? t('saving') : t('saveProvider')}</button>
      </div>
      <div className="provider-statuses">
        {saveState.message && <span className={`provider-status ${saveState.status}`}><Icon name={saveState.status === 'ok' ? 'check' : saveState.status === 'error' ? 'circleAlert' : 'refresh'} size={13} />{saveState.message}</span>}
        {testState.message && <span className={`provider-status ${testState.status}`}>{testState.message}</span>}
      </div>
    </div>
  </div>;
}

function ModelManagement({ llm, activeProvider, onStrategy, onChatProvider, onChatModel, onImageProvider, onImageModel, onEditProvider, onToggleModel }) {
  const { t } = useI18n();
  const models = llm.providers.flatMap(provider => (provider.models || []).map(model => ({ provider, model })));
  return <div className="model-management">
    <section className="model-selection-section">
      <div className="settings-section-heading"><div><h3>{t('modelSelection')}</h3><p>{t('modelSelectionDescription')}</p></div><Icon name="spark" size={16} /></div>
      <div className="model-strategy-control">
        <div><strong>{t('modelStrategy')}</strong><small>{llm.active.providerId ? `${t('current')}: ${activeProvider?.name || llm.active.providerId}` : t('noModelSelected')}</small></div>
        <div role="group" aria-label={t('modelStrategy')}>
          {[{ id: 'auto', label: t('auto') }, { id: 'local', label: t('local') }, { id: 'cloud', label: t('cloud') }].map(item => <button key={item.id} className={llm.active.strategy === item.id ? 'active' : ''} onClick={() => onStrategy(item.id)}>{item.label}</button>)}
        </div>
      </div>
      <div className="settings-grid model-current-grid">
         <label className="settings-field"><span>{t('chatProvider')}</span><select value={llm.active.providerId || ''} onChange={event => onChatProvider(event.target.value)}>
          <option value="">{t('noModelSelected')}</option>
          {llm.providers.filter(item => item.models?.some(model => model.kind !== 'image' && model.enabled !== false)).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
         <label className="settings-field"><span>{t('chatModel')}</span><select value={llm.active.modelId || ''} onChange={event => onChatModel(event.target.value)}>
           <option value="">{t('noModelSelected')}</option>
           {(activeProvider?.models || []).filter(model => model.kind !== 'image' && model.enabled !== false).map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
         </select></label>
         <label className="settings-field"><span>{t('imageProvider')}</span><select value={llm.imageProviderId || ''} onChange={event => onImageProvider(event.target.value)}>
          <option value="">{t('disabled')}</option>
          {llm.providers.filter(item => item.models?.some(model => model.kind === 'image' && model.enabled !== false)).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label className="settings-field span-2"><span>{t('imageModel')}</span><select value={llm.imageModelId || ''} onChange={event => onImageModel(event.target.value)}>
          <option value="">{t('selectImageModel')}</option>
          {llm.providers.find(item => item.id === llm.imageProviderId)?.models?.filter(model => model.kind === 'image' && model.enabled !== false).map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
        </select></label>
      </div>
    </section>
    <section className="model-catalog-section">
      <div className="settings-section-heading"><div><h3>{t('modelCatalog')}</h3><p>{t('modelCatalogDescription')}</p></div><span className="catalog-count">{models.length} {t('modelCount')}</span></div>
      {models.length === 0 ? <div className="settings-empty-state">{t('noModelsConfigured')}</div> : <div className="model-catalog" role="table">
        <div className="model-catalog-header" role="row"><span>{t('modelId')}</span><span>{t('displayName')}</span><span>{t('provider')}</span><span>{t('modelCapability')}</span><span>{t('runtimeLocation')}</span><span>{t('enabled')}</span><span>{t('actions')}</span></div>
        {models.map(({ provider, model }) => <div className={`model-catalog-row${model.enabled === false ? ' disabled' : ''}`} role="row" key={`${provider.id}:${model.id}`}>
           <code>{model.id || t('notConfigured')}</code><span>{model.name || model.id || t('notConfigured')}</span><span>{provider.name}</span><span>{model.kind === 'image' ? t('imageCapability') : t('chatCapability')}</span><span>{model.kind === 'image' ? (model.runtime === 'local' ? t('local') : t('cloud')) : '-'}</span><label className="settings-toggle compact"><input type="checkbox" checked={model.enabled !== false} onChange={event => onToggleModel(provider.id, model.id, event.target.checked)} aria-label={t('enabled')} /></label><button className="btn btn-small" onClick={() => onEditProvider(provider)}>{t('editProvider')}</button>
        </div>)}
      </div>}
    </section>
  </div>;
}
export default function SettingsPanel({ onClose }) {
  const { t } = useI18n();
  const session = useSession();
  const { comfyState, refreshWorkflows } = useComfyUI();
  const [tab, setTab] = useState(() => window.localStorage.getItem('comfyui-agent.settings-tab') || 'appearance');
  const [llm, setLLM] = useState({ providers: [], active: {} });
  const [editing, setEditing] = useState(EMPTY_PROVIDER);
  const [skills, setSkills] = useState({ system: {}, custom: [] });
  const [custom, setCustom] = useState(EMPTY_SKILL);
  const [testState, setTestState] = useState({ status: '', message: '' });
  const [saveState, setSaveState] = useState({ status: '', message: '' });
  const [budgets, setBudgets] = useState({ positiveTokens: '', negativeTokens: '' });
  const [budgetState, setBudgetState] = useState({ status: '', message: '' });
  const [comfyBaseUrl, setComfyBaseUrl] = useState(comfyState.baseUrl || 'http://127.0.0.1:8188');
  const [comfyStateMsg, setComfyStateMsg] = useState({ status: '', text: '' });
  const [comfyBusy, setComfyBusy] = useState(false);
  const [mcp, setMcp] = useState({ enabled: false, host: '127.0.0.1', port: 3333, token: '', modules: { web: true, files: true, comfyui: true, skills: true } });
  const [mcpStatus, setMcpStatus] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const [update, setUpdate] = useState({ status: 'idle', progress: 0, version: '', error: '', manifest: null });

  useEffect(() => {
    window.localStorage.setItem('comfyui-agent.settings-tab', tab);
  }, [tab]);

  useEffect(() => {
    const handleKeyDown = event => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    setComfyBaseUrl(comfyState.baseUrl || 'http://127.0.0.1:8188');
  }, [comfyState.baseUrl]);

  useEffect(() => {
    window.electronAPI.llmProviders().then(data => {
      setLLM(data);
      setEditing(data.providers[0] || EMPTY_PROVIDER);
    }).catch(error => setSaveState({ status: 'error', message: error.message || t('providerLoadFailed') }));
    window.electronAPI.skillsList().then(setSkills).catch(error => setSaveState({ status: 'error', message: error.message || t('skillsLoadFailed') }));
    window.electronAPI.mcpSettings().then(value => setMcp({ ...value, token: '' })).catch(() => setMcpStatus(t('mcpLoadFailed')));
    setBudgets({
      positiveTokens: session.project?.budgets?.positiveTokens ?? '',
      negativeTokens: session.project?.budgets?.negativeTokens ?? '',
    });
  }, []);

  useEffect(() => {
    window.electronAPI.appVersion().then(setAppVersion).catch(() => {});
    window.electronAPI.updateState().then(setUpdate).catch(() => {});
    return window.electronAPI.onUpdateProgress?.(setUpdate);
  }, []);

  async function checkUpdate() {
    setUpdate(current => ({ ...current, status: 'checking', error: '' }));
    try { setUpdate(await window.electronAPI.updateCheck()); } catch (error) { setUpdate(current => ({ ...current, status: 'error', error: error.message || t('settingsCheckFailed') })); }
  }

  async function downloadUpdate() {
    try { setUpdate(await window.electronAPI.updateDownload(update.manifest)); } catch (error) { setUpdate(current => ({ ...current, status: 'error', error: error.message || t('settingsDownloadFailed') })); }
  }

  async function installUpdate() {
    try { setUpdate(await window.electronAPI.updateInstall()); } catch (error) { setUpdate(current => ({ ...current, status: 'error', error: error.message || t('settingsInstallFailed') })); }
  }

  useEffect(() => {
    setBudgets({
      positiveTokens: session.project?.budgets?.positiveTokens ?? '',
      negativeTokens: session.project?.budgets?.negativeTokens ?? '',
    });
  }, [session.project?.budgets]);

  const activeProvider = useMemo(() => llm.providers.find(item => item.id === llm.active.providerId), [llm]);

  async function saveProvider() {
    setSaveState({ status: 'saving', message: t('saving') });
    try {
      const payload = editing.hasApiKey && !editing.apiKey
        ? Object.fromEntries(Object.entries(editing).filter(([key]) => key !== 'apiKey'))
        : editing;
      const updated = await window.electronAPI.llmSaveProvider(payload);
      setLLM(updated);
      setEditing(updated.providers.find(item => item.id === editing.id) || editing);
      setSaveState({ status: 'ok', message: t('saved') });
      window.dispatchEvent(new Event('llm-config-changed'));
      return updated;
    } catch (error) {
      setSaveState({ status: 'error', message: error.message || t('saveFailed') });
      throw error;
    }
  }
  async function deleteProvider(id) {
    if (!window.confirm(t('providerDeleteConfirm'))) return;
    const updated = await window.electronAPI.llmDeleteProvider(id);
    setLLM(updated);
    setEditing(updated.providers[0]);
    window.dispatchEvent(new Event('llm-config-changed'));
  }

  async function disconnectProvider(id) {
    const provider = llm.providers.find(item => item.id === id);
    if (!provider) return;
    const template = TEMPLATES[id];
    if (!window.confirm(template ? t('disconnectTemplateConfirm') : t('disconnectCustomConfirm'))) return;
    const updated = await window.electronAPI.llmDisconnectProvider(id, template ? { ...template } : null);
    setLLM(updated);
    setEditing(updated.providers.find(item => item.id === id) || updated.providers[0] || EMPTY_PROVIDER);
    window.dispatchEvent(new Event('llm-config-changed'));
  }

  async function toggleModel(providerId, modelId, enabled) {
    const updated = await window.electronAPI.llmToggleModel(providerId, modelId, enabled);
    setLLM(updated);
    window.dispatchEvent(new Event('llm-config-changed'));
  }

  async function createFromTemplate(template, { name, apiKey }) {
    const updated = await window.electronAPI.llmSaveProvider({ ...EMPTY_PROVIDER, ...template, name, apiKey: apiKey || '', headers: {} });
    setLLM(updated);
    setEditing(updated.providers.find(item => item.id === template.id) || EMPTY_PROVIDER);
    setSaveState({ status: 'ok', message: t('saved') });
    setPickerOpen(false);
    setTestState({ status: '', message: '' });
    window.dispatchEvent(new Event('llm-config-changed'));
  }

  function pickCustom() {
    setEditing({ ...EMPTY_PROVIDER, models: [{ id: '', name: '', kind: 'chat' }] });
    setTestState({ status: '', message: '' });
    setSaveState({ status: '', message: '' });
    setPickerOpen(false);
  }

  async function selectStrategy(strategy) {
    const updated = await window.electronAPI.llmSelect({ strategy });
    setLLM(updated);
    window.dispatchEvent(new Event('llm-config-changed'));
  }

  async function toggleMediaPolicy(allowMediaToCloud) {
    const updated = await window.electronAPI.llmMediaPolicy(allowMediaToCloud);
    setLLM(updated);
    window.dispatchEvent(new Event('llm-config-changed'));
  }

  async function testProvider() {
    setTestState({ status: 'testing', message: t('connecting') });
    try {
      // 测试编辑框中的当前配置，不保存；与保存走同一份配置。
      const result = await window.electronAPI.llmTest(editing, editing.models.find(model => model.id)?.id);
      setTestState({ status: 'ok', message: result.message || t('connectionSucceeded') });
    } catch (error) {
      setTestState({ status: 'error', message: error.message || t('connectionFailed') });
    }
  }
  async function toggleSkill(id, enabled, isCustom, isExternal = false) {
    await window.electronAPI.skillSetEnabled(id, enabled, isCustom, isExternal);
    setSkills(await window.electronAPI.skillsList());
  }

  async function addCustom() {
    const skill = { ...custom, keywords: custom.keywords.split(/[,，\n]/).map(item => item.trim()).filter(Boolean) };
    setSkills(await window.electronAPI.skillAddCustom(skill));
    setCustom(EMPTY_SKILL);
  }

  async function saveBudgets() {
    setBudgetState({ status: 'saving', message: '' });
    try {
      const nextBudgets = {};
      if (budgets.positiveTokens !== '') {
        const value = Number(budgets.positiveTokens);
        if (!Number.isInteger(value) || value <= 0) throw new Error(t('positiveBudgetInteger'));
        nextBudgets.positiveTokens = value;
      }
      if (budgets.negativeTokens !== '') {
        const value = Number(budgets.negativeTokens);
        if (!Number.isInteger(value) || value <= 0) throw new Error(t('negativeBudgetInteger'));
        nextBudgets.negativeTokens = value;
      }
      const state = await window.electronAPI.projectUpdateState({ budgets: Object.keys(nextBudgets).length > 0 ? nextBudgets : null });
      session.applyState(state);
      setBudgetState({ status: 'ok', message: t('saved') });
    } catch (error) {
      setBudgetState({ status: 'error', message: error.message || t('saveFailed') });
    }
  }

  async function saveComfyBaseUrl() {
    setComfyBusy(true);
    setComfyStateMsg({ status: '', text: '' });
    try {
      const state = await window.electronAPI.comfyUISetBaseUrl(comfyBaseUrl);
      setComfyStateMsg({ status: state.status === 'ready' ? 'ok' : 'warn', text: state.message || '' });
    } catch (error) {
      setComfyStateMsg({ status: 'error', text: error.message });
    } finally {
      setComfyBusy(false);
    }
  }

  async function selectComfyRoot() {
    setComfyBusy(true);
    setComfyStateMsg({ status: '', text: '' });
    try {
      const state = await window.electronAPI.comfyUISelectRoot();
      if (state.portableRoot) {
        await refreshWorkflows();
        setComfyStateMsg({ status: 'ok', text: t('selectedDirectory') });
      }
    } catch (error) {
      setComfyStateMsg({ status: 'error', text: error.message });
    } finally {
      setComfyBusy(false);
    }
  }

  async function resetComfy() {
    setComfyBusy(true);
    setComfyStateMsg({ status: '', text: '' });
    try {
      const state = await window.electronAPI.comfyUIReset();
      await refreshWorkflows();
      setComfyStateMsg({ status: 'warn', text: state.message || t('resetAutoDetected') });
    } finally {
      setComfyBusy(false);
    }
  }

  return <div className="modal-overlay" onClick={onClose}>
    <section className="settings-panel" onClick={event => event.stopPropagation()} aria-label={t('settings')}>
      <div className="modal-header"><div><h2>{t('settings')}</h2><p className="settings-header-note">{t('settingsDescription')}</p></div><button className="btn btn-icon" onClick={onClose} title={t('close')}><Icon name="close" /></button></div>
      <div className="settings-body">
         <div className="settings-tabs" role="tablist" aria-label={t('settings')}>
           {[
             { key: 'look', label: t('tabGroupLook'), tabs: [['appearance', t('appearance'), t('appearanceNote'), 'spark']] },
             { key: 'models', label: t('tabGroupModels'), tabs: [
               ['models', t('models'), `${llm.providers.reduce((total, provider) => total + (provider.models?.length || 0), 0)} ${t('modelCount')}`, 'grid'],
               ['providers', t('providers'), `${llm.providers.length} ${t('providerCount')}`, 'library'],
             ] },
             { key: 'features', label: t('tabGroupFeatures'), tabs: [
               ['skills', t('skills'), t('skillsNote'), 'list'],
               ['generation', t('generation'), t('generationNote'), 'sliders'],
               ['personality', t('promptPersonality'), t('promptPersonalityNote'), 'message'],
               ['memory', t('memorySettings'), t('memorySettingsNote'), 'star'],
               ['notifications', t('notificationSettings'), t('notificationsNote'), 'circleAlert'],
             ] },
             { key: 'system', label: t('tabGroupSystem'), tabs: [
               ['comfyui', t('connection'), comfyState.status === 'ready' ? t('connected') : t('offline'), 'workflow'],
               ['mcp', t('mcp'), mcp.enabled ? `${Object.values(mcp.modules || {}).filter(Boolean).length} ${t('mcpModuleCount')}` : t('disabledStatus'), 'send'],
               ['updates', t('settingsUpdates'), appVersion ? t('settingsCurrentVersion', { version: appVersion }) : t('settingsVersionInfo'), 'refresh'],
             ] },
           ].map(group => <div className="settings-nav-group" key={group.key}>
             <div className="settings-nav-group-title">{group.label}</div>
             {group.tabs.map(([id, label, note, icon]) => (
              <button key={id} className={`settings-tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)} role="tab" aria-selected={tab === id} title={note}>
                 <Icon name={icon} size={14} />
                 <span className="settings-tab-label"><strong>{label}</strong><small>{note}</small></span>
              </button>
            ))}
          </div>)}
      </div>
      <div className="settings-content">
         {tab === 'appearance' ? <AppearanceSettings /> : tab === 'models' ? <ModelManagement llm={llm} activeProvider={activeProvider} onStrategy={async patch => { const updated = await window.electronAPI.llmSelect(typeof patch === 'string' ? { strategy: patch } : patch); setLLM(updated); window.dispatchEvent(new Event('llm-config-changed')); }} onChatProvider={async providerId => { const updated = await window.electronAPI.llmSelect({ providerId }); setLLM(updated); window.dispatchEvent(new Event('llm-config-changed')); }} onChatModel={async modelId => { const updated = await window.electronAPI.llmSelect({ modelId }); setLLM(updated); window.dispatchEvent(new Event('llm-config-changed')); }} onImageProvider={async imageProviderId => { const updated = await window.electronAPI.llmSelect({ imageProviderId }); setLLM(updated); }} onImageModel={async imageModelId => { const updated = await window.electronAPI.llmSelect({ imageModelId }); setLLM(updated); }} onEditProvider={provider => { setEditing(provider); setTab('providers'); setTestState({ status: '', message: '' }); setSaveState({ status: '', message: '' }); }} onToggleModel={toggleModel} /> : tab === 'providers' ? <div className="provider-management">
            <div className="provider-management-heading"><div><h3>{t('providerCatalog')}</h3><p>{t('providerCatalogDescription')}</p></div><span className="catalog-count">{llm.providers.length} {t('providerCount')}</span></div>
            <aside className="provider-list">
            {llm.providers.map(provider => <div key={provider.id} className={`provider-card${editing.id === provider.id ? ' active' : ''}`}>
               <button onClick={() => { setEditing(provider); setTestState({ status: '', message: '' }); setSaveState({ status: '', message: '' }); }}><strong>{provider.name}</strong><span>{provider.models?.filter(model => model.enabled !== false).length || 0}/{provider.models?.length || 0} {t('modelCount')}{activeProvider?.id === provider.id ? ` · ${t('current')}` : ''}</span></button>
               <button className="provider-disconnect" onClick={() => disconnectProvider(provider.id)} title={t('disconnect')}><Icon name="minus" size={14} /></button>
               {llm.providers.length > 1 && <button className="provider-delete" onClick={() => deleteProvider(provider.id)} title={t('delete')}><Icon name="trash" size={14} /></button>}
            </div>)}
              <button className="sidebar-command" onClick={() => setPickerOpen(true)}><Icon name="plus" size={14} /> {t('newProvider')}</button>
          </aside>
          <ProviderForm value={editing} onChange={next => { setEditing(next); setSaveState({ status: '', message: '' }); }} onSave={saveProvider} onTest={testProvider} testState={testState} saveState={saveState} />
          </div> : tab === 'generation' || tab === 'notifications' || tab === 'personality' || tab === 'memory' || tab === 'comfyui' || tab === 'mcp' || tab === 'updates' ? null : <div className="skills-settings">
            <section><h3>{t('systemSkills')}</h3>{(skills.registry || []).filter(skill => !skill.custom && !skill.external).map(skill => <label className="skill-item" key={skill.id}><span><strong>{skill.name || skill.id} <small>/{skill.id}</small></strong><small>{skill.description || t('builtinSkill')}</small></span><input type="checkbox" checked={skill.enabled !== false} onChange={event => toggleSkill(skill.id, event.target.checked, false)} /></label>)}</section>
            <section><h3>{t('customSkills')}</h3>{skills.custom.map(skill => <div className="skill-item" key={skill.id}><span><strong>{skill.name}</strong><small>{skill.description || skill.keywords?.join(', ')}</small></span><input type="checkbox" checked={skill.enabled !== false} onChange={event => toggleSkill(skill.id, event.target.checked, true)} /><button className="btn btn-icon" onClick={async () => setSkills(await window.electronAPI.skillDeleteCustom(skill.id))} title={t('delete')}><Icon name="trash" size={14} /></button></div>)}</section>
            <section><div className="settings-section-heading"><div><h3>{t('externalSkill')}</h3><p>{t('externalSkillDescription')}</p></div><button className="btn" onClick={async () => setSkills(await window.electronAPI.skillImportExternal())}>{t('importJson')}</button></div>{(skills.external || []).map(skill => <div className="skill-item" key={skill.id}><span><strong>{skill.name} <small>v{skill.version || '1.0'}</small></strong><small>{skill.description} · {skill.source}</small></span><input type="checkbox" checked={skill.enabled !== false} onChange={event => toggleSkill(skill.id, event.target.checked, true, true)} /><button className="btn btn-icon" onClick={async () => setSkills(await window.electronAPI.skillDeleteExternal(skill.id))} title={t('delete')}><Icon name="trash" size={14} /></button></div>)}</section>
           <section className="custom-skill-form"><h3>{t('addCustomSkill')}</h3>
             <div className="settings-grid"><div className="settings-field"><label>{t('customId')}</label><input value={custom.id} onChange={event => setCustom({ ...custom, id: event.target.value })} /></div><div className="settings-field"><label>{t('customName')}</label><input value={custom.name} onChange={event => setCustom({ ...custom, name: event.target.value })} /></div><div className="settings-field span-2"><label>{t('customDescription')}</label><input value={custom.description} onChange={event => setCustom({ ...custom, description: event.target.value })} /></div><div className="settings-field"><label>{t('customKeywords')}</label><input value={custom.keywords} onChange={event => setCustom({ ...custom, keywords: event.target.value })} /></div><div className="settings-field"><label>{t('promptMode')}</label><select value={custom.promptMode} onChange={event => setCustom({ ...custom, promptMode: event.target.value })}><option value="raw">{t('rawPromptMode')}</option><option value="cinematic">{t('cinematicPromptMode')}</option><option value="anime">{t('animePromptMode')}</option><option value="photorealistic">{t('photoPromptMode')}</option><option value="concept">{t('conceptPromptMode')}</option></select></div></div>
             <button className="btn btn-primary" onClick={addCustom} disabled={!/^[a-z0-9_-]+$/.test(custom.id) || !custom.name || !custom.keywords.trim()}>{t('addSkill')}</button>
          </section>
        </div>}
        {tab === 'generation' && <div className="generation-settings">
          <ResearchSettings />
          <section>
              <div className="settings-section-heading"><div><h3>{t('promptBudget')}</h3><p>{t('promptBudgetDescription')}</p></div><Icon name="sliders" size={16} /></div>
             <p className="settings-muted">{t('saveInOriginalModeHint')}</p>
            <div className="settings-grid">
              <div className="settings-field">
                 <label>{t('positiveBudget')}</label>
                 <input type="number" min="1" value={budgets.positiveTokens} onChange={event => setBudgets(current => ({ ...current, positiveTokens: event.target.value }))} placeholder={t('noLimit')} />
              </div>
              <div className="settings-field">
                 <label>{t('negativeBudget')}</label>
                 <input type="number" min="1" value={budgets.negativeTokens} onChange={event => setBudgets(current => ({ ...current, negativeTokens: event.target.value }))} placeholder={t('noLimit')} />
              </div>
            </div>
            <div className="settings-actions">
               <button className="btn btn-primary" onClick={saveBudgets} disabled={budgetState.status === 'saving'}>{budgetState.status === 'saving' ? t('saving') : t('saveBudget')}</button>
              {budgetState.message && <span className={budgetState.status}>{budgetState.message}</span>}
            </div>
          </section>
        </div>}
        {tab === 'notifications' && <div className="generation-settings"><NotificationSettings /></div>}
        {tab === 'personality' && <div className="generation-settings"><PromptPersonalitySettings /></div>}
        {tab === 'memory' && <div className="generation-settings"><MemorySettings /></div>}
        {tab === 'comfyui' && <div className="comfyui-settings">
          <section>
             <div className="settings-section-heading"><div><h3>{t('comfyConnectionTitle')}</h3><p>{t('comfyConnectionDescription')}</p></div><Icon name="workflow" size={16} /></div>
             <p className="settings-muted">{t('comfyRootHint')}</p>
            <div className="settings-field">
               <label>{t('currentDirectory')}</label>
               <code className="comfyui-settings-root">{comfyState.portableRoot || t('autoDetected')}</code>
            </div>
            <div className="settings-actions">
               <button className="btn" onClick={selectComfyRoot} disabled={comfyBusy}>{t('chooseComfyDirectory')}</button>
               <button className="btn" onClick={resetComfy} disabled={comfyBusy}>{t('resetAutoDetect')}</button>
            </div>
          </section>
          <section>
             <div className="settings-section-heading"><div><h3>{t('connectionAddress')}</h3><p>{t('connectionAddressDescription')}</p></div><Icon name="workflow" size={16} /></div>
             <p className="settings-muted">{t('comfyRunningHint')}</p>
            <div className="settings-grid">
              <div className="settings-field span-2">
                 <label>{t('comfyAddressLabel')}</label>
                <input value={comfyBaseUrl} onChange={event => setComfyBaseUrl(event.target.value)} placeholder="http://127.0.0.1:8188" disabled={comfyBusy} />
              </div>
            </div>
            <div className="settings-actions">
               <button className="btn btn-primary" onClick={saveComfyBaseUrl} disabled={comfyBusy}>{t('saveAndConnect')}</button>
              {comfyStateMsg.text && <span className={`provider-status ${comfyStateMsg.status}`}>{comfyStateMsg.text}</span>}
            </div>
          </section>
        </div>}
         {tab === 'updates' && <div className="comfyui-settings">
           <section>
             <div className="settings-section-heading"><div><h3>{t('settingsUpdates')}</h3><p>{t('settingsUpdatesNote')}</p></div><Icon name="refresh" size={16} /></div>
              <div className="update-summary"><span>{t('settingsCurrentVersionLabel')}</span><code>v{appVersion || t('settingsUnknown')}</code>{update.version && update.status !== 'latest' && <><span>{t('settingsAvailableVersion')}</span><code>v{update.version}</code></>}</div>
             {update.manifest?.releaseNotesUrl && <p className="settings-muted"><a href={update.manifest.releaseNotesUrl} target="_blank" rel="noreferrer">{t('settingsReleaseNotes')}</a></p>}
             {update.status === 'downloading' && <progress className="update-progress" max="100" value={update.progress} />}
             {update.error && <p className="provider-status error">{update.error}</p>}
             {update.status === 'latest' && <p className="provider-status ok">{t('settingsUpToDate')}</p>}
             {update.status === 'full-required' && <p className="provider-status warn">{t('settingsFullRequired')}</p>}
             <div className="settings-actions">
               <button className="btn" onClick={checkUpdate} disabled={['checking', 'downloading', 'installing'].includes(update.status)}>{update.status === 'checking' ? t('settingsChecking') : t('settingsCheckUpdate')}</button>
               {update.status === 'available' && <button className="btn btn-primary" onClick={downloadUpdate}>{t('settingsDownloadUpdate')}</button>}
               {update.status === 'ready' && <button className="btn btn-primary" onClick={installUpdate}>{t('settingsInstallUpdate')}</button>}
             </div>
           </section>
         </div>}
         {tab === 'mcp' && <div className="comfyui-settings">
          <section>
             <div className="settings-section-heading"><div><h3>{t('mcpServiceTitle')}</h3><p>{t('mcpDescription')}</p></div><Icon name="settings" size={16} /></div>
<p className="settings-muted">{t('mcpSafetyHint')}</p>
              <label className="settings-toggle"><span><strong>{t('enableEmbeddedMcp')}</strong><small>{t('mcpDefaultHost')}</small></span><input type="checkbox" checked={mcp.enabled} onChange={event => setMcp(current => ({ ...current, enabled: event.target.checked }))} /></label>
              <div className="mcp-modules">
                <strong>{t('mcpModuleTitle')}</strong><small>{t('mcpModuleDescription')}</small>
                {[['web', t('mcpModuleWeb'), t('mcpModuleWebDesc')], ['files', t('mcpModuleFiles'), t('mcpModuleFilesDesc')], ['comfyui', t('mcpModuleComfyui'), t('mcpModuleComfyuiDesc')], ['skills', t('mcpModuleSkills'), t('mcpModuleSkillsDesc')]].map(([key, label, description]) => <label className="settings-toggle" key={key}><span><strong>{label}</strong><small>{description}</small></span><input type="checkbox" checked={mcp.modules?.[key] !== false} onChange={event => setMcp(current => ({ ...current, modules: { ...current.modules, [key]: event.target.checked } }))} /></label>)}
              </div>
              <div className="settings-grid">
               <label className="settings-field"><span>{t('listenAddress')}</span><input value={mcp.host} onChange={event => setMcp(current => ({ ...current, host: event.target.value }))} placeholder="127.0.0.1" /></label>
               <label className="settings-field"><span>{t('port')}</span><input type="number" min="1" max="65535" value={mcp.port} onChange={event => setMcp(current => ({ ...current, port: event.target.value }))} /></label>
               <label className="settings-field span-2"><span>{t('accessToken')}</span><input type="password" value={mcp.token} onChange={event => setMcp(current => ({ ...current, token: event.target.value }))} placeholder={mcp.hasToken ? t('tokenSetKeep') : t('lanTokenRequired')} /></label>
            </div>
             <div className="settings-actions"><button className="btn btn-primary" onClick={async () => { try { const payload = mcp.hasToken && !mcp.token ? { ...mcp, token: undefined } : mcp; const saved = await window.electronAPI.mcpSaveSettings(payload); setMcp(current => ({ ...current, ...saved, token: '' })); setMcpStatus(t('mcpSaved')); } catch (error) { setMcpStatus(error.message || t('saveFailed')); } }}>{t('saveMcpSettings')}</button>{mcpStatus && <span className="settings-save-state">{mcpStatus}</span>}</div>
          </section>
        </div>}
      </div>
      </div>
    </section>
    {pickerOpen && <ProviderPickerModal onPick={createFromTemplate} onCustom={pickCustom} onClose={() => setPickerOpen(false)} />}
  </div>;
}
