import { useEffect, useState } from 'react';
import { useComfyUI } from '../contexts/ComfyUIContext.jsx';
import { useAgent } from '../contexts/AgentContext.jsx';
import appIconUrl from '../assets/app-icon.svg';
import Icon from './Icon.jsx';

const COMFY_STATUS_LABELS = {
  checking: '正在检测 ComfyUI',
  starting: '正在启动 ComfyUI',
  ready: '已连接',
  disconnected: 'ComfyUI 连接已断开',
  stopped: 'ComfyUI 已停止',
  error: 'ComfyUI 启动失败',
};

export default function Header({ onOpenSetup }) {
  const { connected, comfyState, handleStartComfyUI } = useComfyUI();
  const { trace, setShowTrace } = useAgent();
  const [maximized, setMaximized] = useState(false);
  const windowApi = window.electronAPI;

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
      <div className="header-left">
        <div className="header-brand" aria-label="ComfyUI 智能创作台">
          <img className="header-logo" src={appIconUrl} alt="" />
          <span className="header-title">ComfyUI 智能创作台</span>
        </div>
      </div>

      <div className="header-right">
        <div
          className={`connection-state ${connected ? 'connected' : comfyState.status}`}
          title={comfyState.message || COMFY_STATUS_LABELS[comfyState.status]}
        >
          <span className="connection-dot" />
          <span>{COMFY_STATUS_LABELS[comfyState.status] || comfyState.status}</span>
        </div>
        {(comfyState.status === 'error' || comfyState.status === 'stopped') && (
          <>
            <button className="btn connection-retry" onClick={handleStartComfyUI}>重试</button>
            {!comfyState.portableRoot && <button className="btn" onClick={onOpenSetup}>配置</button>}
          </>
        )}
        {trace && (
          <button className="btn btn-trace" onClick={() => setShowTrace(true)} title="查看任务追踪">
            追踪
          </button>
        )}
        {windowApi && (
          <div className="window-controls" aria-label="窗口控制">
            <button className="window-control" onClick={() => windowApi.windowMinimize()} title="最小化" aria-label="最小化"><Icon name="minimize" /></button>
            <button className="window-control" onClick={toggleMaximize} title={maximized ? '还原' : '最大化'} aria-label={maximized ? '还原' : '最大化'}><Icon name={maximized ? 'restore' : 'maximize'} /></button>
            <button className="window-control window-control-close" onClick={() => windowApi.windowClose()} title="关闭" aria-label="关闭"><Icon name="windowClose" /></button>
          </div>
        )}
      </div>
    </header>
  );
}
