import { useEffect, useState } from 'react';
import { useComfyUI } from '../contexts/ComfyUIContext.jsx';
import Icon from './Icon.jsx';

const DOWNLOAD_KINDS = [
  { id: 'nvidia', label: 'NVIDIA 显卡版', description: '适合大部分独立显卡用户' },
  { id: 'amd', label: 'AMD 显卡版', description: 'A 卡用户，需启用 HIP' },
  { id: 'cpu', label: '纯 CPU 版', description: '无独显时应急，速度较慢' },
];

export default function ComfyUISetup({ onClose }) {
  const { comfyState, connected, refreshWorkflows } = useComfyUI();
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
        setMessage({ status: 'ok', text: '已指定目录，正在启动...' });
        await window.electronAPI.comfyUIStart();
        await refreshWorkflows();
      } else {
        setMessage({ status: '', text: '未选择目录' });
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
    setDownload({ phase: 'download', percent: 0, message: '准备下载...' });
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
      <section className="settings-panel comfy-setup" onClick={event => event.stopPropagation()} aria-label="ComfyUI 连接设置">
        <div className="modal-header">
          <h2>ComfyUI 连接设置</h2>
          <button className="btn btn-icon" onClick={onClose} disabled={busy || downloading} title="关闭"><Icon name="close" /></button>
        </div>
        <div className="settings-content">
          <div className={`comfy-setup-status ${comfyState.status}`}>
            <span className="connection-dot" />
            <span>{comfyState.message || comfyState.status}</span>
            {comfyState.portableRoot && <code className="comfy-setup-root">{comfyState.portableRoot}</code>}
          </div>
          {connected && <p className="settings-muted">ComfyUI 已就绪，可直接开始使用。也可以随时修改下方连接方式。</p>}

          <div className="comfy-setup-options">
            <div className="comfy-setup-option">
              <span className="comfy-setup-option-icon"><Icon name="folder" size={18} /></span>
              <div className="comfy-setup-option-body">
                <strong>使用本机已有的 ComfyUI</strong>
                <p>选择已解压的 ComfyUI portable 根目录（包含 python_embeded 和 ComfyUI 文件夹），本程序会代为启动。</p>
                <button className="btn" onClick={pickFolder} disabled={busy !== ''}>{busy === 'folder' ? '选择中...' : '选择目录'}</button>
              </div>
            </div>

            <div className="comfy-setup-option">
              <span className="comfy-setup-option-icon"><Icon name="workflow" size={18} /></span>
              <div className="comfy-setup-option-body">
                <strong>连接已运行的 ComfyUI</strong>
                <p>ComfyUI 已在别处启动（本机或局域网其他机器）时填写地址。</p>
                <div className="settings-row comfy-setup-url">
                  <input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="http://127.0.0.1:8188" disabled={busy !== ''} />
                  <button className="btn" onClick={connectUrl} disabled={busy !== ''}>{busy === 'connect' ? '连接中...' : '连接'}</button>
                </div>
              </div>
            </div>

            <div className="comfy-setup-option">
              <span className="comfy-setup-option-icon"><Icon name="refresh" size={18} /></span>
              <div className="comfy-setup-option-body">
                <strong>下载 ComfyUI portable</strong>
                <p>从官方源下载便携版并自动安装，不含模型权重（约 1~2 GB，需联网）。</p>
                <div className="settings-row comfy-setup-url">
                  <select value={downloadKind} onChange={event => setDownloadKind(event.target.value)} disabled={busy !== ''}>
                    {DOWNLOAD_KINDS.map(kind => <option key={kind.id} value={kind.id}>{kind.label} · {kind.description}</option>)}
                  </select>
                  <button className="btn btn-primary" onClick={startDownload} disabled={busy !== '' || downloading}>{busy === 'download' ? '下载中...' : '下载并安装'}</button>
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
            <button className="btn" onClick={onClose} disabled={busy !== '' || downloading}>{connected ? '完成' : '稍后再说'}</button>
          </div>
        </div>
      </section>
    </div>
  );
}
