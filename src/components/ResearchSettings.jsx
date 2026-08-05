import { useEffect, useState } from 'react';
import { useSession } from '../contexts/SessionContext.jsx';
import { DEFAULT_RESEARCH_SETTINGS, normalizeResearchSettings } from '../agent/research/settings.mjs';

const DOMAIN_FIELDS = [
  ['allowedDomains', 'Allowed domains'],
  ['officialDomains', 'Official domains'],
  ['verifiedDomains', 'Verified domains'],
  ['communityDomains', 'Community domains'],
];

export default function ResearchSettings() {
  const session = useSession();
  const [settings, setSettings] = useState(DEFAULT_RESEARCH_SETTINGS);
  const [baiduApiKey, setBaiduApiKey] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    setSettings(normalizeResearchSettings(session.project?.researchSettings));
    window.electronAPI.researchSettings().then(value => setBaiduApiKey(value?.baiduApiKey || '')).catch(() => {});
  }, [session.project?.researchSettings]);

  function update(patch) {
    setSettings(current => normalizeResearchSettings({ ...current, ...patch }));
    setStatus('');
  }

  async function save() {
    try {
      await window.electronAPI.researchSaveSettings({ baiduApiKey });
      const state = await window.electronAPI.projectUpdateState({ researchSettings: normalizeResearchSettings(settings) });
      session.applyState(state);
      setStatus('Saved');
    } catch (error) {
      setStatus(error.message || 'Save failed');
    }
  }

  return <section>
    <div className="settings-section-heading"><div><h3>角色资料研究</h3><p>为角色生成补充公开资料，结果会经过来源和域名策略筛选。</p></div></div>
    <label className="settings-toggle"><span><strong>允许联网研究</strong><small>关闭后不会访问网络，并会在生成结果中明确标注未执行研究。</small></span><input type="checkbox" checked={settings.allowNetwork} onChange={event => update({ allowNetwork: event.target.checked })} /></label>
    <div className="settings-grid">
      <label className="settings-field"><span>最多结果数</span><input type="number" min="1" max="10" value={settings.maxResults} onChange={event => update({ maxResults: event.target.value })} /></label>
      <label className="settings-field"><span>最多打开页面数</span><input type="number" min="0" max="10" value={settings.maxOpenPages} onChange={event => update({ maxOpenPages: event.target.value })} /></label>
      <label className="settings-field"><span>请求超时（毫秒）</span><input type="number" min="1000" max="30000" step="1000" value={settings.timeoutMs} onChange={event => update({ timeoutMs: event.target.value })} /></label>
      <label className="settings-field"><span>缓存时长（毫秒）</span><input type="number" min="0" max="86400000" step="10000" value={settings.cacheTtlMs} onChange={event => update({ cacheTtlMs: event.target.value })} /></label>
    </div>
    <div className="settings-grid">
      <label className="settings-field span-2"><span>搜索提供商</span><input value={settings.providers.join(', ')} onChange={event => update({ providers: event.target.value })} placeholder="bing, duckduckgo, baidu" /></label>
      <label className="settings-field span-2"><span>HTTP 代理</span><input value={settings.proxyUrl} onChange={event => update({ proxyUrl: event.target.value })} placeholder="http://127.0.0.1:7897（留空使用系统代理）" /></label>
      <label className="settings-field span-2"><span>百度 AI Search API Key</span><input type="password" value={baiduApiKey} onChange={event => setBaiduApiKey(event.target.value)} placeholder="可选；优先使用百度 AI Search，再回退到网页搜索" /></label>
    </div>
    <div className="settings-grid">
      {DOMAIN_FIELDS.map(([field]) => <label className="settings-field span-2" key={field}><span>{{ allowedDomains: '允许域名', officialDomains: '官方域名', verifiedDomains: '已验证域名', communityDomains: '社区域名' }[field]}</span><input value={settings[field].join(', ')} onChange={event => update({ [field]: event.target.value })} placeholder="example.com, game.example" /></label>)}
    </div>
    <div className="settings-actions"><button className="btn btn-primary" onClick={() => void save()}>保存研究设置</button>{status && <span className="settings-save-state">{status}</span>}</div>
  </section>;
}
