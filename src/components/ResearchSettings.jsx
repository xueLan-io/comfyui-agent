import { useEffect, useState } from 'react';
import { useSession } from '../contexts/SessionContext.jsx';
import { DEFAULT_RESEARCH_SETTINGS, normalizeResearchSettings } from '../agent/research/settings.mjs';
import { useI18n } from '../i18n/I18nContext.jsx';

const DOMAIN_FIELDS = [
  ['allowedDomains', 'Allowed domains'],
  ['officialDomains', 'Official domains'],
  ['verifiedDomains', 'Verified domains'],
  ['communityDomains', 'Community domains'],
];

export default function ResearchSettings() {
  const session = useSession();
  const { t } = useI18n();
  const [settings, setSettings] = useState(DEFAULT_RESEARCH_SETTINGS);
  const [baiduApiKey, setBaiduApiKey] = useState('');
  const [searchApiKey, setSearchApiKey] = useState('');
  const [keyErrors, setKeyErrors] = useState({ baidu: '', searchApi: '' });
  const [status, setStatus] = useState('');

  useEffect(() => {
    setSettings(normalizeResearchSettings(session.project?.researchSettings));
    window.electronAPI.researchSettings().then(value => {
      setBaiduApiKey(value?.hasBaiduApiKey ? '********' : '');
      setSearchApiKey(value?.hasSearchApiKey ? '********' : '');
      setKeyErrors({ baidu: value?.baiduApiKeyError || '', searchApi: value?.searchApiKeyError || '' });
    }).catch(() => setStatus('Research settings failed to load'));
  }, [session.project?.researchSettings]);

  function update(patch) { setSettings(current => normalizeResearchSettings({ ...current, ...patch })); setStatus(''); }

  async function save() {
    try {
      await window.electronAPI.researchSaveSettings({
        baiduApiKey: baiduApiKey === '********' ? undefined : baiduApiKey,
        searchApiKey: searchApiKey === '********' ? undefined : searchApiKey,
      });
      session.applyState(await window.electronAPI.projectUpdateState({ researchSettings: normalizeResearchSettings(settings) }));
      setStatus(t('saved'));
    } catch (error) { setStatus(error.message || t('saveFailed')); }
  }

  const domainLabels = { allowedDomains: 'Allowed domains', officialDomains: 'Official domains', verifiedDomains: 'Verified domains', communityDomains: 'Community domains' };
  return <section>
    <div className="settings-section-heading"><div><h3>{t('research')}</h3><p>{t('researchDescription')}</p></div></div>
    <label className="settings-toggle"><span><strong>{t('allowNetwork')}</strong><small>{t('allowNetworkDescription')}</small></span><input type="checkbox" checked={settings.allowNetwork} onChange={event => update({ allowNetwork: event.target.checked })} /></label>
    <div className="settings-grid">
      <label className="settings-field"><span>{t('maxResults')}</span><input type="number" min="1" max="10" value={settings.maxResults} onChange={event => update({ maxResults: event.target.value })} /></label>
      <label className="settings-field"><span>{t('maxOpenPages')}</span><input type="number" min="0" max="10" value={settings.maxOpenPages} onChange={event => update({ maxOpenPages: event.target.value })} /></label>
      <label className="settings-field"><span>{t('timeout')}</span><input type="number" min="1000" max="30000" step="1000" value={settings.timeoutMs} onChange={event => update({ timeoutMs: event.target.value })} /></label>
      <label className="settings-field"><span>{t('cacheTtl')}</span><input type="number" min="0" max="86400000" step="10000" value={settings.cacheTtlMs} onChange={event => update({ cacheTtlMs: event.target.value })} /></label>
    </div>
    <div className="settings-grid">
      <label className="settings-field span-2"><span>{t('searchProviders')}</span><input value={settings.providers.join(', ')} onChange={event => update({ providers: event.target.value })} placeholder="bing, duckduckgo, baidu" /></label>
      <label className="settings-field span-2"><span>{t('proxy')}</span><input value={settings.proxyUrl} onChange={event => update({ proxyUrl: event.target.value })} placeholder="http://127.0.0.1:7897" /></label>
      <label className="settings-field span-2"><span>{t('baiduKey')}</span><input type="password" value={baiduApiKey} onChange={event => setBaiduApiKey(event.target.value)} placeholder="Optional" /></label>
      {keyErrors.baidu && <small className="settings-muted span-2 settings-error">{keyErrors.baidu}</small>}
    </div>
    <div className="settings-grid">
      <label className="settings-field span-2"><span>{t('searchApi')}</span>
        <select value={settings.searchApi} onChange={event => update({ searchApi: event.target.value })}>
          <option value="">{t('searchApiNone')}</option>
          <option value="tavily">{t('searchApiTavily')}</option>
          <option value="searxng">{t('searchApiSearxng')}</option>
        </select>
      </label>
      {settings.searchApi === 'tavily' && <label className="settings-field span-2"><span>{t('searchApiKey')}</span><input type="password" value={searchApiKey} onChange={event => setSearchApiKey(event.target.value)} placeholder="tvly-..." /></label>}
      {keyErrors.searchApi && settings.searchApi === 'tavily' && <small className="settings-muted span-2 settings-error">{keyErrors.searchApi}</small>}
      {settings.searchApi === 'tavily' && <small className="settings-muted span-2">{t('searchApiKeyDescription')}</small>}
      {settings.searchApi === 'searxng' && <label className="settings-field span-2"><span>{t('searchApiBaseUrl')}</span><input value={settings.searchApiBaseUrl} onChange={event => update({ searchApiBaseUrl: event.target.value })} placeholder="http://127.0.0.1:8888" /></label>}
      {settings.searchApi === 'searxng' && <small className="settings-muted span-2">{t('searchApiBaseUrlDescription')}</small>}
    </div>
    <div className="settings-grid">{DOMAIN_FIELDS.map(([field]) => <label className="settings-field span-2" key={field}><span>{languageLabel(domainLabels[field], t)}</span><input value={settings[field].join(', ')} onChange={event => update({ [field]: event.target.value })} placeholder="example.com, game.example" /></label>)}</div>
    <div className="settings-actions"><button className="btn btn-primary" onClick={() => void save()}>{t('saveResearch')}</button>{status && <span className="settings-save-state">{status}</span>}</div>
  </section>;
}

function languageLabel(english, t) {
  if (t('language') === '语言') return { 'Allowed domains': '允许域名', 'Official domains': '官方域名', 'Verified domains': '已验证域名', 'Community domains': '社区域名' }[english];
  return english;
}
