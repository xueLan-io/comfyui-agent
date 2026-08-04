import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../contexts/SessionContext.jsx';
import { useComfyUI } from '../contexts/ComfyUIContext.jsx';
import AppearanceSettings from './AppearanceSettings.jsx';
import ResearchSettings from './ResearchSettings.jsx';
import Icon from './Icon.jsx';

const TEMPLATES = {
  openai: { id: 'openai', name: 'OpenAI', type: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] },
  lmstudio: { id: 'lmstudio', name: 'LM Studio', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', models: [{ id: 'local-model', name: '本地模型（请替换 ID）' }] },
  ollama: { id: 'ollama', name: 'Ollama', type: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: [{ id: 'llama3.2', name: 'Llama 3.2' }] },
  deepseek: { id: 'deepseek', name: 'DeepSeek', type: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
  glm: { id: 'glm', name: 'GLM', type: 'openai-compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: [{ id: 'glm-4-plus', name: 'GLM-4 Plus' }] },
  moonshot: { id: 'moonshot', name: 'Moonshot', type: 'openai-compatible', baseUrl: 'https://api.moonshot.cn/v1', models: [{ id: 'moonshot-v1-8k', name: 'Moonshot 8K' }] },
  dashscope: { id: 'dashscope', name: 'DashScope', type: 'openai-compatible', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: [{ id: 'qwen-plus', name: 'Qwen Plus' }] },
};

const EMPTY_PROVIDER = { id: '', name: '', type: 'openai-compatible', baseUrl: '', apiKey: '', headers: {}, models: [{ id: '', name: '' }] };
const EMPTY_SKILL = { id: '', name: '', description: '', keywords: '', promptMode: 'raw', enabled: true };

function ProviderForm({ value, onChange, onSave, onTest, testState, saveState }) {
  const headerRows = Object.entries(value.headers || {});
  const validId = /^[a-z0-9_-]+$/.test(value.id || '');
  const template = TEMPLATES[value.id] ? value.id : '';
  const update = patch => onChange({ ...value, ...patch });
  const isBusy = saveState.status === 'saving' || testState.status === 'testing';

  function applyTemplate(id) {
    if (!id) return;
    onChange({ ...EMPTY_PROVIDER, ...TEMPLATES[id], apiKey: value.apiKey || '', headers: {} });
  }

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
      <div><span className="provider-kicker">模型连接</span><h3>添加一个模型提供商</h3></div>
      <p>先选择预设，再确认地址和模型 ID。保存后即可在聊天中使用。</p>
    </div>
    <div className="template-picker span-2">
      <div className="settings-field">
        <label>快速配置</label>
        <select value={template} onChange={event => applyTemplate(event.target.value)}>
          <option value="">选择提供商预设...</option>
          <optgroup label="本地模型">
            <option value="lmstudio">LM Studio · OpenAI 兼容</option>
            <option value="ollama">Ollama · 原生接口</option>
          </optgroup>
          <optgroup label="云端服务">
            {['openai', 'deepseek', 'glm', 'moonshot', 'dashscope'].map(id => <option key={id} value={id}>{TEMPLATES[id].name}</option>)}
          </optgroup>
        </select>
      </div>
      <div className="template-note">
        <strong>{template === 'lmstudio' ? 'LM Studio 使用 OpenAI 兼容接口' : value.type === 'ollama' ? 'Ollama 使用原生聊天接口' : 'OpenAI 兼容接口'}</strong>
        <span>{template === 'lmstudio' ? '地址通常是 http://127.0.0.1:1234/v1；模型 ID 需填写 LM Studio 当前加载的名称。' : value.type === 'ollama' ? '地址通常是 http://127.0.0.1:11434，不需要 API Key。' : '请求会发送到 /chat/completions，地址一般需要包含 /v1。'}</span>
      </div>
    </div>
    <div className="settings-field"><label>ID</label><input value={value.id} onChange={event => update({ id: event.target.value })} placeholder="provider_id" />{value.id && !validId && <small className="field-error">仅支持 a-z、0-9、_、-</small>}</div>
    <div className="settings-field"><label>显示名称</label><input value={value.name} onChange={event => update({ name: event.target.value })} /></div>
    <div className="settings-field span-2"><label>API 地址</label><input value={value.baseUrl} onChange={event => update({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></div>
    <div className="settings-field span-2"><label>API Key</label><input type="password" value={value.apiKey || ''} onChange={event => update({ apiKey: event.target.value, apiKeyError: '' })} placeholder={value.type === 'ollama' || template === 'lmstudio' ? '本地服务通常无需填写' : 'sk-...'} />{value.apiKeyError && <small className="field-error">已保存的 API Key 无法解密，请重新输入并保存。</small>}</div>

    <div className="settings-subsection span-2">
      <div className="settings-subsection-title"><span>模型</span><button className="btn btn-icon" onClick={() => update({ models: [...value.models, { id: '', name: '' }] })} title="添加模型"><Icon name="plus" /></button></div>
      {value.models.map((model, index) => <div className="settings-row" key={index}>
        <input value={model.id} onChange={event => updateModel(index, { id: event.target.value })} placeholder="模型 ID" />
        <input value={model.name} onChange={event => updateModel(index, { name: event.target.value })} placeholder="显示名称" />
        <button className="btn btn-icon" onClick={() => update({ models: value.models.filter((_, i) => i !== index) })} disabled={value.models.length === 1} title="删除模型"><Icon name="trash" size={14} /></button>
      </div>)}
    </div>

    <div className="settings-subsection span-2">
      <div className="settings-subsection-title"><span>请求头</span><button className="btn btn-icon" onClick={() => update({ headers: { ...value.headers, [`X-Header-${headerRows.length + 1}`]: '' } })} title="添加请求头"><Icon name="plus" /></button></div>
      {headerRows.length === 0 && <div className="settings-muted">未配置自定义请求头</div>}
      {headerRows.map(([key, headerValue], index) => <div className="settings-row" key={`${key}-${index}`}>
        <input value={key} onChange={event => updateHeader(index, event.target.value, headerValue)} placeholder="Header" />
        <input value={headerValue} onChange={event => updateHeader(index, key, event.target.value)} placeholder="Value" />
        <button className="btn btn-icon" onClick={() => update({ headers: Object.fromEntries(headerRows.filter((_, i) => i !== index)) })} title="删除请求头"><Icon name="trash" size={14} /></button>
      </div>)}
    </div>

    <div className="provider-actions span-2">
      <div className="provider-action-buttons">
        <button className="btn" onClick={onTest} disabled={!validId || isBusy}>{testState.status === 'testing' ? '测试中...' : '测试连接'}</button>
        <button className="btn btn-primary" onClick={onSave} disabled={!validId || !value.name || !value.models.some(model => model.id) || isBusy}>{saveState.status === 'saving' ? '保存中...' : '保存提供商'}</button>
      </div>
      <div className="provider-statuses">
        {saveState.message && <span className={`provider-status ${saveState.status}`}><Icon name={saveState.status === 'ok' ? 'check' : saveState.status === 'error' ? 'circleAlert' : 'refresh'} size={13} />{saveState.message}</span>}
        {testState.message && <span className={`provider-status ${testState.status}`}>{testState.message}</span>}
      </div>
    </div>
  </div>;
}
export default function SettingsPanel({ onClose }) {
  const session = useSession();
  const { comfyState, refreshWorkflows } = useComfyUI();
  const [tab, setTab] = useState('appearance');
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

  useEffect(() => {
    setComfyBaseUrl(comfyState.baseUrl || 'http://127.0.0.1:8188');
  }, [comfyState.baseUrl]);

  useEffect(() => {
    window.electronAPI.llmProviders().then(data => {
      setLLM(data);
      setEditing(data.providers[0] || EMPTY_PROVIDER);
    });
    window.electronAPI.skillsList().then(setSkills);
    setBudgets({
      positiveTokens: session.project?.budgets?.positiveTokens ?? '',
      negativeTokens: session.project?.budgets?.negativeTokens ?? '',
    });
  }, [session.project?.budgets]);

  const activeProvider = useMemo(() => llm.providers.find(item => item.id === llm.active.providerId), [llm]);

  async function saveProvider() {
    setSaveState({ status: 'saving', message: '保存中...' });
    try {
      const updated = await window.electronAPI.llmSaveProvider(editing);
      setLLM(updated);
      setEditing(updated.providers.find(item => item.id === editing.id) || editing);
      setSaveState({ status: 'ok', message: '已保存' });
      window.dispatchEvent(new Event('llm-config-changed'));
      return updated;
    } catch (error) {
      setSaveState({ status: 'error', message: error.message || '保存失败' });
      throw error;
    }
  }
  async function deleteProvider(id) {
    if (!window.confirm('删除这个提供商？')) return;
    const updated = await window.electronAPI.llmDeleteProvider(id);
    setLLM(updated);
    setEditing(updated.providers[0]);
    window.dispatchEvent(new Event('llm-config-changed'));
  }

  async function selectStrategy(strategy) {
    const updated = await window.electronAPI.llmSelect({ strategy });
    setLLM(updated);
    window.dispatchEvent(new Event('llm-config-changed'));
  }

  async function testProvider() {
    setTestState({ status: 'testing', message: '正在连接...' });
    try {
      await saveProvider();
      const result = await window.electronAPI.llmTest(editing.id, editing.models.find(model => model.id)?.id);
      setTestState({ status: 'ok', message: result.message || '连接成功' });
    } catch (error) {
      setTestState({ status: 'error', message: error.message || '连接失败' });
    }
  }
  async function toggleSkill(id, enabled, isCustom) {
    setSkills(await window.electronAPI.skillSetEnabled(id, enabled, isCustom));
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
        if (!Number.isInteger(value) || value <= 0) throw new Error('正向预算必须是正整数');
        nextBudgets.positiveTokens = value;
      }
      if (budgets.negativeTokens !== '') {
        const value = Number(budgets.negativeTokens);
        if (!Number.isInteger(value) || value <= 0) throw new Error('负向预算必须是正整数');
        nextBudgets.negativeTokens = value;
      }
      const state = await window.electronAPI.projectUpdateState({ budgets: Object.keys(nextBudgets).length > 0 ? nextBudgets : null });
      session.applyState(state);
      setBudgetState({ status: 'ok', message: '已保存' });
    } catch (error) {
      setBudgetState({ status: 'error', message: error.message || '保存失败' });
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
        setComfyStateMsg({ status: 'ok', text: '已指定目录' });
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
      setComfyStateMsg({ status: 'warn', text: state.message || '已重置为自动检测' });
    } finally {
      setComfyBusy(false);
    }
  }

  return <div className="modal-overlay" onClick={onClose}>
    <section className="settings-panel" onClick={event => event.stopPropagation()} aria-label="设置">
      <div className="modal-header"><h2>设置</h2><button className="btn btn-icon" onClick={onClose} title="关闭"><Icon name="close" /></button></div>
      <div className="settings-tabs">
        <button className={tab === 'appearance' ? 'active' : ''} onClick={() => setTab('appearance')}>外观</button>
        <button className={tab === 'models' ? 'active' : ''} onClick={() => setTab('models')}>模型</button>
        <button className={tab === 'skills' ? 'active' : ''} onClick={() => setTab('skills')}>技能</button>
        <button className={tab === 'generation' ? 'active' : ''} onClick={() => setTab('generation')}>生成</button>
        <button className={tab === 'comfyui' ? 'active' : ''} onClick={() => setTab('comfyui')}>连接</button>
      </div>
      <div className="settings-content">
        {tab === 'appearance' ? <AppearanceSettings /> : tab === 'models' ? <div className="models-settings">
          <div className="strategy-control">
            <span>模型策略</span>
            <div role="group" aria-label="模型策略">
              {[{ id: 'auto', label: '自动' }, { id: 'local', label: '本地' }, { id: 'cloud', label: '云端' }].map(item => (
                <button key={item.id} className={llm.active.strategy === item.id ? 'active' : ''} onClick={() => selectStrategy(item.id)} title={item.id === 'auto' ? '智能：使用当前选择的模型；所选模型不可用或未配置时才切换' : item.id === 'local' ? '固定使用本地模型' : '固定使用云端模型'}>{item.label}</button>
              ))}
            </div>
          </div>
          <aside className="provider-list">
            {llm.providers.map(provider => <div key={provider.id} className={`provider-card${editing.id === provider.id ? ' active' : ''}`}>
              <button onClick={() => { setEditing(provider); setTestState({ status: '', message: '' }); setSaveState({ status: '', message: '' }); }}><strong>{provider.name}</strong><span>{provider.models?.length || 0} 个模型{activeProvider?.id === provider.id ? ' · 当前' : ''}</span></button>
              {llm.providers.length > 1 && <button className="provider-delete" onClick={() => deleteProvider(provider.id)} title="删除"><Icon name="trash" size={14} /></button>}
            </div>)}
            <button className="sidebar-command" onClick={() => { setEditing({ ...EMPTY_PROVIDER, models: [{ id: '', name: '' }] }); setTestState({ status: '', message: '' }); setSaveState({ status: '', message: '' }); }}><Icon name="plus" size={14} /> 新建提供商</button>
          </aside>
          <ProviderForm value={editing} onChange={next => { setEditing(next); setSaveState({ status: '', message: '' }); }} onSave={saveProvider} onTest={testProvider} testState={testState} saveState={saveState} />
        </div> : tab === 'generation' || tab === 'comfyui' ? null : <div className="skills-settings">
          <section><h3>系统技能</h3>{Object.entries(skills.system).map(([id, enabled]) => <label className="skill-item" key={id}><span><strong>{id}</strong><small>内置技能</small></span><input type="checkbox" checked={enabled} onChange={event => toggleSkill(id, event.target.checked, false)} /></label>)}</section>
          <section><h3>自定义技能</h3>{skills.custom.map(skill => <div className="skill-item" key={skill.id}><span><strong>{skill.name}</strong><small>{skill.description || skill.keywords?.join('、')}</small></span><input type="checkbox" checked={skill.enabled !== false} onChange={event => toggleSkill(skill.id, event.target.checked, true)} /><button className="btn btn-icon" onClick={async () => setSkills(await window.electronAPI.skillDeleteCustom(skill.id))} title="删除"><Icon name="trash" size={14} /></button></div>)}</section>
          <section className="custom-skill-form"><h3>新增自定义技能</h3>
            <div className="settings-grid"><div className="settings-field"><label>ID</label><input value={custom.id} onChange={event => setCustom({ ...custom, id: event.target.value })} /></div><div className="settings-field"><label>名称</label><input value={custom.name} onChange={event => setCustom({ ...custom, name: event.target.value })} /></div><div className="settings-field span-2"><label>描述</label><input value={custom.description} onChange={event => setCustom({ ...custom, description: event.target.value })} /></div><div className="settings-field"><label>关键词（逗号分隔）</label><input value={custom.keywords} onChange={event => setCustom({ ...custom, keywords: event.target.value })} /></div><div className="settings-field"><label>提示词模式</label><select value={custom.promptMode} onChange={event => setCustom({ ...custom, promptMode: event.target.value })}><option value="raw">保留原文</option><option value="cinematic">电影质感</option><option value="anime">动漫风格</option><option value="photorealistic">写实摄影</option><option value="concept">概念设计</option></select></div></div>
            <button className="btn btn-primary" onClick={addCustom} disabled={!/^[a-z0-9_-]+$/.test(custom.id) || !custom.name || !custom.keywords.trim()}>添加技能</button>
          </section>
        </div>}
        {tab === 'generation' && <div className="generation-settings">
          <ResearchSettings />
          <section>
            <h3>提示词长度预算</h3>
            <p className="settings-muted">仅在提示词优化模式（非保留原文）下生效。超出预算时从尾部压缩，并丢弃整条标签词/整句叙述。留空表示不限制。</p>
            <div className="settings-grid">
              <div className="settings-field">
                <label>正向提示词预算（tokens）</label>
                <input type="number" min="1" value={budgets.positiveTokens} onChange={event => setBudgets(current => ({ ...current, positiveTokens: event.target.value }))} placeholder="留空不限制" />
              </div>
              <div className="settings-field">
                <label>负向提示词预算（tokens）</label>
                <input type="number" min="1" value={budgets.negativeTokens} onChange={event => setBudgets(current => ({ ...current, negativeTokens: event.target.value }))} placeholder="留空不限制" />
              </div>
            </div>
            <div className="settings-actions">
              <button className="btn btn-primary" onClick={saveBudgets} disabled={budgetState.status === 'saving'}>{budgetState.status === 'saving' ? '保存中...' : '保存预算'}</button>
              {budgetState.message && <span className={budgetState.status}>{budgetState.message}</span>}
            </div>
          </section>
        </div>}
        {tab === 'comfyui' && <div className="comfyui-settings">
          <section>
            <h3>ComfyUI 连接</h3>
            <p className="settings-muted">选择本机 ComfyUI portable 根目录（含 python_embeded 和 ComfyUI 文件夹）由本程序代为启动，或连接已在运行的实例。未指定目录时自动向上级目录探测。</p>
            <div className="settings-field">
              <label>当前目录</label>
              <code className="comfyui-settings-root">{comfyState.portableRoot || '未指定（自动探测）'}</code>
            </div>
            <div className="settings-actions">
              <button className="btn" onClick={selectComfyRoot} disabled={comfyBusy}>选择 ComfyUI 目录</button>
              <button className="btn" onClick={resetComfy} disabled={comfyBusy}>恢复自动探测</button>
            </div>
          </section>
          <section>
            <h3>连接地址</h3>
            <p className="settings-muted">ComfyUI 已在其他位置运行（本机其他端口或局域网其他机器）时，填写其地址。</p>
            <div className="settings-grid">
              <div className="settings-field span-2">
                <label>ComfyUI 地址</label>
                <input value={comfyBaseUrl} onChange={event => setComfyBaseUrl(event.target.value)} placeholder="http://127.0.0.1:8188" disabled={comfyBusy} />
              </div>
            </div>
            <div className="settings-actions">
              <button className="btn btn-primary" onClick={saveComfyBaseUrl} disabled={comfyBusy}>保存并连接</button>
              {comfyStateMsg.text && <span className={`provider-status ${comfyStateMsg.status}`}>{comfyStateMsg.text}</span>}
            </div>
          </section>
        </div>}
      </div>
    </section>
  </div>;
}
