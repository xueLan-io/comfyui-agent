import { useEffect, useState } from 'react';
import { DEFAULT_UI_PREFERENCES, normalizeUIPreferences, SOUND_STYLE_IDS } from '../ui-preferences.mjs';
import { playCompletionSound } from '../utils/sounds.mjs';
import { useI18n } from '../i18n/I18nContext.jsx';

export default function NotificationSettings() {
  const { t } = useI18n();
  const [preferences, setPreferences] = useState(DEFAULT_UI_PREFERENCES);
  const [status, setStatus] = useState('');

  useEffect(() => {
    window.electronAPI.uiPreferences().then(value => setPreferences(normalizeUIPreferences(value))).catch(() => setStatus(t('loadFailed')));
  }, [t]);

  async function update(patch) {
    const next = normalizeUIPreferences({ ...preferences, ...patch });
    setPreferences(next);
    setStatus('');
    try {
      await window.electronAPI.uiSavePreferences(next);
    } catch (error) {
      setStatus(error.message || t('saveFailed'));
    }
  }

  return <section>
    <div className="settings-section-heading"><div><h3>{t('notificationSettings')}</h3><p>{t('notificationSettingsDescription')}</p></div></div>
    <label className="settings-toggle"><span><strong>{t('notifyOnComplete')}</strong><small>{t('notifyOnCompleteDescription')}</small></span><input type="checkbox" checked={preferences.notifyOnComplete} onChange={event => void update({ notifyOnComplete: event.target.checked })} /></label>
    <label className="settings-toggle"><span><strong>{t('notifyOnFail')}</strong><small>{t('notifyOnFailDescription')}</small></span><input type="checkbox" checked={preferences.notifyOnFail} onChange={event => void update({ notifyOnFail: event.target.checked })} /></label>
    <label className="settings-field"><span>{t('soundOnComplete')}</span><select value={preferences.soundStyle} onChange={event => {
      const nextStyle = event.target.value;
      void update({ soundStyle: nextStyle, soundOnComplete: nextStyle !== 'none' });
      if (nextStyle !== 'none') playCompletionSound(nextStyle, preferences.soundVolume / 100);
    }}>
      {SOUND_STYLE_IDS.map(style => <option key={style} value={style}>{t(`soundStyle_${style}`)}</option>)}
    </select><small className="settings-muted">{t('soundOnCompleteDescription')}</small></label>
    <label className="settings-field"><span>{t('soundVolume')}</span>
      <input type="range" min="0" max="100" value={preferences.soundVolume} onChange={event => void update({ soundVolume: Number(event.target.value) })}
        onPointerUp={event => playCompletionSound(preferences.soundStyle, Number(event.target.value) / 100)}
        onKeyUp={event => playCompletionSound(preferences.soundStyle, Number(event.target.value) / 100)} />
      <small className="settings-muted">{t('soundVolumeDescription')}</small></label>
    {status && <span className="settings-save-state">{status}</span>}
  </section>;
}
