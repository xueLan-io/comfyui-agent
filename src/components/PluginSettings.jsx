import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/I18nContext.jsx';
import Icon from './Icon.jsx';

// Plugin management: list plugins loaded from the userData/plugins directory,
// toggle enable/disable (which starts/stops the plugin lifecycle and registers
// or removes its tools), and remove plugins from the runtime registry.
export default function PluginSettings() {
  const { t } = useI18n();
  const [state, setState] = useState({ plugins: [], errors: [] });
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState('');

  async function refresh() {
    try {
      setState(await window.electronAPI.pluginsList());
    } catch (error) {
      setStatus(error.message || t('pluginsLoadFailed'));
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function toggle(pluginId, enabled) {
    if (busy) return;
    setBusy(pluginId);
    try {
      await window.electronAPI.pluginsEnable(pluginId, enabled);
      setStatus(enabled ? t('pluginsEnabled') : t('pluginsDisabled'));
      await refresh();
    } catch (error) {
      setStatus(error.message || t('pluginsToggleFailed'));
    } finally {
      setBusy('');
    }
  }

  async function remove(pluginId) {
    if (!window.confirm(t('pluginsRemoveConfirm'))) return;
    try {
      await window.electronAPI.pluginsRemove(pluginId);
      setStatus(t('pluginsRemoved'));
      await refresh();
    } catch (error) {
      setStatus(error.message || t('pluginsRemoveFailed'));
    }
  }

  return (
    <div className="plugin-settings">
      <div className="settings-section-heading">
        <div><h3>{t('plugins')}</h3><p>{t('pluginsDescription')}</p></div>
      </div>
      {status && <p className="settings-status">{status}</p>}
      <p className="plugin-dir-hint">{t('pluginsDirHint')}</p>
      {state.plugins.length === 0 && state.errors.length === 0 && <p className="plugin-empty">{t('pluginsEmpty')}</p>}
      <div className="plugin-list">
        {state.plugins.map(plugin => (
          <div className="plugin-item" key={plugin.pluginId}>
            <div className="plugin-item-head">
              <span className="plugin-name"><strong>{plugin.name || plugin.pluginId}</strong> <small>v{plugin.version}</small></span>
              <span className={`plugin-badge${plugin.signed ? ' plugin-badge-signed' : ''}`}>
                {plugin.signed ? t('pluginsSigned') : t('pluginsUnsigned')}
              </span>
              <span className={`plugin-state plugin-state-${plugin.state}`}>{t(`pluginsState_${plugin.state}`)}</span>
              <div className="plugin-actions">
                <input type="checkbox" checked={plugin.enabled !== false} onChange={event => void toggle(plugin.pluginId, event.target.checked)} title={t('pluginsEnable')} />
                <button className="btn btn-icon" onClick={() => void remove(plugin.pluginId)} title={t('pluginsRemove')}><Icon name="trash" size={14} /></button>
              </div>
            </div>
            <div className="plugin-meta">
              <span className="plugin-id">/{plugin.pluginId}</span>
              <span className="plugin-caps">{(plugin.capabilities || []).join(', ')}</span>
              {busy === plugin.pluginId && <span className="plugin-busy">{t('pluginsBusy')}</span>}
            </div>
          </div>
        ))}
      </div>
      {state.errors.length > 0 && (
        <div className="plugin-errors">
          <h4>{t('pluginsLoadErrors')}</h4>
          {state.errors.map((entry, index) => <p key={`${entry.pluginId}-${index}`}><strong>{entry.pluginId}</strong>：{entry.error}</p>)}
        </div>
      )}
    </div>
  );
}
