import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { H3_HARDWARE_CONTROLS } from './h3-video-controls.mjs';

export default function H3VideoPanel({ onApply, onReadinessChange, workflowSelected = false }) {
  const [readiness, setReadiness] = useState({ loading: true, ready: false, message: '正在检查 H3 节点...' });
  const [hardware, setHardware] = useState('amd');
  const controls = H3_HARDWARE_CONTROLS[hardware];

  useEffect(() => {
    let active = true;
    window.electronAPI.h3Readiness?.()
      .then(value => {
        const next = value || { ready: false, message: '无法检查 H3 节点' };
        if (active) { setReadiness(next); onReadinessChange?.(next); }
      })
      .catch(error => {
        const next = { ready: false, message: error.message || '无法检查 H3 节点' };
        if (active) { setReadiness(next); onReadinessChange?.(next); }
      });
    return () => { active = false; };
  }, []);

  return (
    <section className="h3-video-panel">
      <div className="h3-video-heading"><div><span className="section-kicker">MINIMAX H3 VIDEO</span><strong>{controls.name}</strong></div><span className={`h3-ready ${readiness.ready ? 'ready' : 'blocked'}`}>{readiness.loading ? '检查中' : readiness.ready ? '节点就绪' : '暂不可运行'}</span></div>
      <div className="h3-video-hardware"><button className={hardware === 'nvidia' ? 'active' : ''} onClick={() => setHardware('nvidia')}>NVIDIA</button><button className={hardware === 'amd' ? 'active' : ''} onClick={() => setHardware('amd')}>AMD</button></div>
      <div className="h3-video-specs"><span>{controls.settings.width} × {controls.settings.height}</span><span>5 秒 / {controls.settings.frames} 帧</span><span>{controls.settings.fps} fps</span><span>{controls.settings.steps} steps</span><span>CFG {controls.settings.cfg}</span></div>
      <p className="h3-video-note">两档都使用通用 MiniMax H3 工作流。先完成一次 5 秒测试，再单独提高分辨率或时长。</p>
      {!workflowSelected && <div className="h3-video-blocked"><Icon name="circleAlert" size={14} /><span>请先在下方工作流列表选择通用 MiniMax H3 工作流。</span></div>}
      {workflowSelected && !readiness.loading && !readiness.ready && <div className="h3-video-blocked"><Icon name="circleAlert" size={14} /><span>{readiness.message || 'H3 官方节点尚未加载。完成 ComfyUI 更新后重启服务。'}</span></div>}
      <div className="h3-video-actions"><button className="btn" onClick={() => onApply(controls)}><Icon name="sliders" size={14} />应用 {controls.name}</button></div>
      <small>参数会应用到当前选中的 H3 工作流，不修改工作流文件。高级节点参数请从主应用的工作流面板打开。参考图/视频当前请在主应用聊天区添加。</small>
    </section>
  );
}
