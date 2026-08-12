import { useEffect, useState } from 'react';
import { applyUIPreferences, DEFAULT_UI_PREFERENCES, normalizeUIPreferences } from '../ui-preferences.mjs';
import { useI18n } from '../i18n/I18nContext.jsx';
import Icon from './Icon.jsx';

const ACCENTS = [
  { value: '#339CFF', label: 'Sky' },
  { value: '#5B8DEF', label: 'Indigo' },
  { value: '#57B7A4', label: 'Teal' },
  { value: '#D0D0D0', label: 'Neutral' },
];

const PRIMARY_THEMES = ['system', 'light', 'dark'];
const EXTRA_THEMES = ['paper', 'mist', 'warm', 'navy', 'starry'];

export default function AppearanceSettings() {
  const { language, setLanguage, t } = useI18n();
  const [preferences, setPreferences] = useState(DEFAULT_UI_PREFERENCES);
  const [savedPreferences, setSavedPreferences] = useState(DEFAULT_UI_PREFERENCES);
  const [status, setStatus] = useState('');
  const dirty = JSON.stringify(preferences) !== JSON.stringify(savedPreferences);
  const extraTheme = EXTRA_THEMES.includes(preferences.theme) ? preferences.theme : '';

  useEffect(() => {
    window.electronAPI.uiPreferences().then(value => {
      const next = normalizeUIPreferences(value);
      setPreferences(next); setSavedPreferences(next); applyUIPreferences(next);
      if (next.language) setLanguage(next.language);
    }).catch(() => {});
  }, []);

  function update(patch) {
    const next = normalizeUIPreferences({ ...preferences, ...patch });
    setPreferences(next); applyUIPreferences(next); setStatus('');
  }

  async function updateLanguage(value) {
    setLanguage(value);
    const next = normalizeUIPreferences({ ...preferences, language: value });
    update({ language: value });
    try {
      const saved = await window.electronAPI.uiSavePreferences(next);
      setPreferences(normalizeUIPreferences(saved));
      setSavedPreferences(normalizeUIPreferences(saved));
    } catch { setStatus(t('saveFailed')); }
  }

  async function save() {
    try {
      const saved = await window.electronAPI.uiSavePreferences(preferences);
      const next = normalizeUIPreferences(saved);
      setPreferences(next); setSavedPreferences(next); setLanguage(next.language); setStatus(t('saved'));
    } catch { setStatus(t('saveFailed')); }
  }

  return <div className="appearance-settings">
    <section>
      <div className="settings-section-heading"><div><h3>{t('theme')}</h3><p>{t('themeDescription')}</p></div><Icon name="spark" size={16} /></div>
       <div className="appearance-theme-options">{PRIMARY_THEMES.map(value => <button key={value} className={`appearance-theme-option${preferences.theme === value ? ' active' : ''}`} onClick={() => update({ theme: value })} aria-pressed={preferences.theme === value}><span className={`theme-preview theme-preview-${value}`} /><strong>{t(value)}</strong></button>)}</div>
       <label className="settings-field appearance-extra-themes"><span>{t('moreThemes')}</span><select value={extraTheme} onChange={event => update({ theme: event.target.value || 'light' })} aria-label={t('moreThemes')}><option value="">{t('moreThemesPlaceholder')}</option>{EXTRA_THEMES.map(value => <option key={value} value={value}>{t(`theme${value[0].toUpperCase()}${value.slice(1)}`)}</option>)}</select><small>{t('moreThemesDescription')}</small></label>
      <div className="settings-grid appearance-grid">
        <div className="settings-field"><label>{t('accent')}</label><div className="accent-options">{ACCENTS.map(item => <button key={item.value} className={`accent-swatch${preferences.accent === item.value ? ' active' : ''}`} style={{ background: item.value }} onClick={() => update({ accent: item.value })} title={item.label} aria-label={item.label} />)}</div></div>
        <label className="settings-toggle"><span><strong>{t('sidebarTranslucent')}</strong><small>{t('sidebarTranslucentDescription')}</small></span><input type="checkbox" checked={preferences.sidebarTranslucent} onChange={event => update({ sidebarTranslucent: event.target.checked })} /></label>
      </div>
    </section>
    <section>
      <div className="settings-section-heading"><div><h3>{t('preferences')}</h3><p>{t('preferencesDescription')}</p></div><Icon name="settings" size={16} /></div>
      <label className="settings-toggle"><span><strong>{t('pointerCursor')}</strong><small>{t('pointerCursorDescription')}</small></span><input type="checkbox" checked={preferences.pointerCursor} onChange={event => update({ pointerCursor: event.target.checked })} /></label>
      <label className="settings-toggle"><span><strong>{t('reducedMotion')}</strong><small>{t('reducedMotionDescription')}</small></span><input type="checkbox" checked={preferences.reducedMotion} onChange={event => update({ reducedMotion: event.target.checked })} /></label>
      <div className="settings-grid appearance-grid">
        <label className="settings-field"><span>{t('uiFontSize')}</span><div className="settings-number"><input type="number" min="12" max="18" value={preferences.uiFontSize} onChange={event => update({ uiFontSize: event.target.value })} /><small>px</small></div></label>
        <label className="settings-field"><span>{t('codeFontSize')}</span><div className="settings-number"><input type="number" min="10" max="18" value={preferences.codeFontSize} onChange={event => update({ codeFontSize: event.target.value })} /><small>px</small></div></label>
      </div>
      <label className="settings-toggle"><span><strong>{t('diffMarkers')}</strong><small>{t('diffMarkersDescription')}</small></span><input type="checkbox" checked={preferences.diffMarkers} onChange={event => update({ diffMarkers: event.target.checked })} /></label>
    </section>
    <section className="settings-language-section"><div className="settings-section-heading"><div><h3>{t('language')}</h3></div></div><select value={language} onChange={event => updateLanguage(event.target.value)}><option value="zh-CN">{t('chinese')}</option><option value="en-US">{t('english')}</option></select></section>
    <div className="settings-actions"><button className="btn" onClick={() => { setPreferences(savedPreferences); applyUIPreferences(savedPreferences); setStatus(t('undo')); }} disabled={!dirty}>{t('undo')}</button><button className="btn btn-primary" onClick={() => void save()} disabled={!dirty}><Icon name="check" size={13} /> {t('save')}</button>{dirty && <span className="settings-save-state">{t('unsaved')}</span>}{status && <span className="settings-save-state">{status}</span>}</div>
  </div>;
}
