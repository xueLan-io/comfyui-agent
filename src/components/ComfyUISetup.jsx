import { useEffect, useState } from 'react';
import { useComfyUI } from '../contexts/ComfyUIContext.jsx';
import Icon from './Icon.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';

export default function ComfyUISetup({ onClose }) {
  const { t } = useI18n();
  const { comfyState, connected, refreshWorkflows } = useComfyUI();
  const DOWNLOAD_KINDS = [
    { id: 'nvidia', label: t('setupNvidiaLabel'), description: t('setupNvidiaDesc') },
    { id: 'amd', label: t('setupAmdLabel'), description: t('setupAmdDesc') },
    { id: 'cpu', label: t('setupCpuLabel'), description: t('setupCpuDesc') },
  ];
  const [baseUrl, setBaseUrl] = useState(comfyState.baseUrl || 'http://127.0.0.1:8188');
  const [downloadKind, setDownloadKind] = useState('nvidia');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState({ status: '', text: '' });
  const [download, setDownload] = useState(null);

  useEffect(() => {
    return window.electronAPI.onComfyUIDownloadProgress?.(setDownload) || undefined;
  }, []);

  async function pickFolder() {
    setBusy('folder');
    setMessage({ status: '', text: '' });
    try {
      const state = await window.electronAPI.comfyUISelectRoot();
      if (state.portableRoot) {
        setMessage({ status: 'ok', text: t('setupStarting') });
        await window.electronAPI.comfyUIStart();
        await refreshWorkflows();
      } else {
        setMessage({ status: '', text: t('setupNoFolder') });
      }
    } catch (error) {
      setMessage({ status: 'error', text: error.message });
    } finally {
      setBusy('');
    }
  }

  async function connectUrl() {
    setBusy('connect');
    setMessage({ status: '', text: '' });
    try {
      const state = await window.electronAPI.comfyUISetBaseUrl(baseUrl);
      setMessage({ status: state.status === 'ready' ? 'ok' : 'warn', text: state.message });
    } catch (error) {
      setMessage({ status: 'error', text: error.message });
    } finally {
      setBusy('');
    }
  }

  async function startDownload() {
    setBusy('download');
    setMessage({ status: '', text: '' });
    setDownload({ phase: 'download', percent: 0, message: t('setupPreparingDownload') });
    try {
      const state = await window.electronAPI.comfyUIDownloadPortable(downloadKind);
      if (state?.cancelled) return;
      await refreshWorkflows();
      setMessage({ status: state?.status === 'ready' ? 'ok' : 'warn', text: state?.message || '' });
    } catch (error) {
      setDownload(current => current ? { ...current, phase: 'error', message: error.message } : null);
    } finally {
      setBusy('');
    }
  }

  const downloading = download && download.phase !== 'done' && download.phase !== 'error';
  const showProgress = download && download.message;

  return (
    <div className="modal-overlay" onClick={() => !busy && !downloading && onClose()}>
      <section className="settings-panel comfy-setup" onClick={event => event.stopPropagation()} aria-label={t('setupAria')}>
        <div className="modal-header">
          <h2>{t('setupTitle')}</h2>
          <button className="btn btn-icon" onClick={onClose} disabled={busy || downloading} title={t('close')}><Icon name="close" /></button>
        </div>
        <div className="settings-content">
          <div className={`comfy-setup-status ${comfyState.status}`}>
            <span className="connection-dot" />
            <span>{comfyState.message || comfyState.status}</span>
            {comfyState.portableRoot && <code className="comfy-setup-root">{comfyState.portableRoot}</code>}
          </div>
          {connected && <p className="settings-muted">{t('setupReadyNote')}</p>}

          <div className="comfy-setup-options">
            <div className="comfy-setup-option">
              <span className="comfy-setup-option-icon"><Icon name="folder" size={18} /></span>
              <div className="comfy-setup-option-body">
                <strong>{t('setupUseLocalTitle')}</strong>
                <p>{t('setupUseLocalDesc')}</p>
                <button className="btn" onClick={pickFolder} disabled={busy !== ''}>{busy === 'folder' ? t('setupSelecting') : t('setupSelectFolder')}</button>
              </div>
            </div>

            <div className="comfy-setup-option">
              <span className="comfy-setup-option-icon"><Icon name="workflow" size={18} /></span>
              <div className="comfy-setup-option-body">
                <strong>{t('setupConnectTitle')}</strong>
                <p>{t('setupConnectDesc')}</p>
                <div className="settings-row comfy-setup-url">
                  <input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="http://127.0.0.1:8188" disabled={busy !== ''} />
                  <button className="btn" onClick={connectUrl} disabled={busy !== ''}>{busy === 'connect' ? t('setupConnecting') : t('setupConnect')}</button>
                </div>
              </div>
            </div>

            <div className="comfy-setup-option">
              <span className="comfy-setup-option-icon"><Icon name="refresh" size={18} /></span>
              <div className="comfy-setup-option-body">
                <strong>{t('setupDownloadTitle')}</strong>
                <p>{t('setupDownloadDesc')}</p>
                <div className="settings-row comfy-setup-url">
                  <select value={downloadKind} onChange={event => setDownloadKind(event.target.value)} disabled={busy !== ''}>
                    {DOWNLOAD_KINDS.map(kind => <option key={kind.id} value={kind.id}>{kind.label} · {kind.description}</option>)}
                  </select>
                  <button className="btn btn-primary" onClick={startDownload} disabled={busy !== '' || downloading}>{busy === 'download' ? t('setupDownloading') : t('setupDownloadInstall')}</button>
                </div>
                {showProgress && <div className="comfy-setup-download">
                  {download.phase === 'download' && download.percent >= 0 && (
                    <div className="comfy-setup-progress"><div className="comfy-setup-progress-fill" style={{ width: `${download.percent}%` }} /></div>
                  )}
                  <p className={`comfy-setup-download-message ${download.phase === 'error' ? 'field-error' : ''}`}>{download.message}</p>
                </div>}
              </div>
            </div>
          </div>

          {message.text && <p className={`provider-status ${message.status || 'info'}`}>{message.text}</p>}
          <div className="settings-actions comfy-setup-actions">
            <button className="btn" onClick={onClose} disabled={busy !== '' || downloading}>{connected ? t('setupDone') : t('setupLater')}</button>
          </div>
        </div>
      </section>
    </div>
  );
}
