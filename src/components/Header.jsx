import { useEffect, useState } from 'react';
import { useComfyUI } from '../contexts/ComfyUIContext.jsx';
import { useAgent } from '../contexts/AgentContext.jsx';
import Icon from './Icon.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';

export default function Header({ onOpenSetup }) {
  const { t } = useI18n();
  const { connected, comfyState, handleStartComfyUI } = useComfyUI();
  const { trace, setShowTrace, runtimeView } = useAgent();
  const [maximized, setMaximized] = useState(false);
  const windowApi = window.electronAPI;
  const comfyStatusLabels = {
    checking: t('checkingComfy'), starting: t('startingComfy'), ready: t('comfyReady'), disconnected: t('comfyDisconnected'), stopped: t('comfyStopped'), error: t('comfyStartFailed'),
  };

  useEffect(() => {
    if (!windowApi?.windowIsMaximized) return undefined;
    windowApi.windowIsMaximized().then(setMaximized).catch(() => {});
    return undefined;
  }, [windowApi]);

  async function toggleMaximize() {
    if (!windowApi?.windowToggleMaximize) return;
    setMaximized(await windowApi.windowToggleMaximize());
  }

  return (
    <header className="header">
      <div className="header-brand"><span className="header-brand-mark">CM</span><span><strong>{t('appTitle')}</strong><small>{runtimeView.phase === 'idle' ? t('chatWorkspace') : runtimeView.label}</small></span></div>
      <div className="header-right">
        <div
          className={`connection-state ${connected ? 'connected' : comfyState.status}`}
          title={comfyState.message || comfyStatusLabels[comfyState.status]}
        >
          <span className="connection-dot" />
          <span>{comfyStatusLabels[comfyState.status] || comfyState.status}</span>
        </div>
        {(comfyState.status === 'error' || comfyState.status === 'stopped') && (
          <>
            <button className="btn connection-retry" onClick={handleStartComfyUI}>{t('retry')}</button>
            {!comfyState.portableRoot && <button className="btn" onClick={onOpenSetup}>{t('configure')}</button>}
          </>
        )}
        {trace && (
          <button className="btn btn-trace" onClick={() => setShowTrace(true)} title={t('taskTrace')}>
            {t('track')}
          </button>
        )}
        {windowApi && (
            <div className="window-controls" aria-label={t('windowControls')}>
            <button className="window-control" onClick={() => windowApi.windowMinimize()} title={t('minimize')} aria-label={t('minimize')}><Icon name="minimize" /></button>
            <button className="window-control" onClick={toggleMaximize} title={maximized ? t('restore') : t('maximize')} aria-label={maximized ? t('restore') : t('maximize')}><Icon name={maximized ? 'restore' : 'maximize'} /></button>
            <button className="window-control window-control-close" onClick={() => windowApi.windowClose()} title={t('close')} aria-label={t('close')}><Icon name="windowClose" /></button>
          </div>
        )}
      </div>
    </header>
  );
}
