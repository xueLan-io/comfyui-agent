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
    <h3>Character research</h3>
    <label className="settings-toggle"><span><strong>Allow online research</strong><small>When disabled, generation reports that online research was not performed.</small></span><input type="checkbox" checked={settings.allowNetwork} onChange={event => update({ allowNetwork: event.target.checked })} /></label>
    <div className="settings-grid">
      <label className="settings-field"><span>Max results</span><input type="number" min="1" max="10" value={settings.maxResults} onChange={event => update({ maxResults: event.target.value })} /></label>
      <label className="settings-field"><span>Max pages</span><input type="number" min="0" max="10" value={settings.maxOpenPages} onChange={event => update({ maxOpenPages: event.target.value })} /></label>
      <label className="settings-field"><span>Timeout (ms)</span><input type="number" min="1000" max="30000" step="1000" value={settings.timeoutMs} onChange={event => update({ timeoutMs: event.target.value })} /></label>
      <label className="settings-field"><span>Cache TTL (ms)</span><input type="number" min="0" max="86400000" step="10000" value={settings.cacheTtlMs} onChange={event => update({ cacheTtlMs: event.target.value })} /></label>
    </div>
    <div className="settings-grid">
      <label className="settings-field span-2"><span>Search providers</span><input value={settings.providers.join(', ')} onChange={event => update({ providers: event.target.value })} placeholder="bing, duckduckgo, baidu" /></label>
      <label className="settings-field span-2"><span>HTTP proxy</span><input value={settings.proxyUrl} onChange={event => update({ proxyUrl: event.target.value })} placeholder="http://127.0.0.1:7897 (empty = use system proxy)" /></label>
      <label className="settings-field span-2"><span>Baidu AI Search API key</span><input type="password" value={baiduApiKey} onChange={event => setBaiduApiKey(event.target.value)} placeholder="Optional; uses Baidu AI Search before web scraping" /></label>
    </div>
    <div className="settings-grid">
      {DOMAIN_FIELDS.map(([field, label]) => <label className="settings-field span-2" key={field}><span>{label}</span><input value={settings[field].join(', ')} onChange={event => update({ [field]: event.target.value })} placeholder="example.com, game.example" /></label>)}
    </div>
    <div className="settings-actions"><button className="btn btn-primary" onClick={() => void save()}>Save research settings</button>{status && <span className="settings-save-state">{status}</span>}</div>
  </section>;
}
