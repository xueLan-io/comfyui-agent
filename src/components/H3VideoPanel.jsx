import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { H3_HARDWARE_CONTROLS } from './h3-video-controls.mjs';
import { useI18n } from '../i18n/I18nContext.jsx';

export default function H3VideoPanel({ onApply, onReadinessChange, workflowSelected = false }) {
  const { t } = useI18n();
  const [readiness, setReadiness] = useState({ loading: true, ready: false, message: t('h3CheckingNodes') });
  const [hardware, setHardware] = useState('amd');
  const controls = H3_HARDWARE_CONTROLS[hardware];

  useEffect(() => {
    let active = true;
    window.electronAPI.h3Readiness?.()
      .then(value => {
        const next = value || { ready: false, message: t('h3CantCheck') };
        if (active) { const settled = { ...next, loading: false }; setReadiness(settled); onReadinessChange?.(settled); }
      })
      .catch(error => {
        const next = { ready: false, message: error.message || t('h3CantCheck') };
        if (active) { const settled = { ...next, loading: false }; setReadiness(settled); onReadinessChange?.(settled); }
      });
    return () => { active = false; };
  }, [workflowSelected, t]);

  return (
    <section className="h3-video-panel">
      <div className="h3-video-heading"><div><span className="section-kicker">MINIMAX H3 VIDEO</span><strong>{controls.name}</strong></div><span className={`h3-ready ${readiness.ready ? 'ready' : 'blocked'}`}>{readiness.loading ? t('h3Checking') : readiness.ready ? t('h3Ready') : t('h3NotReady')}</span></div>
      <div className="h3-video-hardware"><button className={hardware === 'nvidia' ? 'active' : ''} onClick={() => setHardware('nvidia')}>NVIDIA</button><button className={hardware === 'amd' ? 'active' : ''} onClick={() => setHardware('amd')}>AMD</button></div>
      <div className="h3-video-specs"><span>{controls.settings.width} × {controls.settings.height}</span><span>{t('h3Duration', { frames: controls.settings.frames })}</span><span>{controls.settings.fps} fps</span><span>{controls.settings.steps} steps</span><span>CFG {controls.settings.cfg}</span></div>
      <p className="h3-video-note">{t('h3Note')}</p>
      {!workflowSelected && <div className="h3-video-blocked"><Icon name="circleAlert" size={14} /><span>{t('h3SelectWorkflowFirst')}</span></div>}
      {workflowSelected && !readiness.loading && !readiness.ready && <div className="h3-video-blocked"><Icon name="circleAlert" size={14} /><span>{readiness.message || t('h3NodeNotLoaded')}</span></div>}
      <div className="h3-video-actions"><button className="btn" onClick={() => onApply(controls)}><Icon name="sliders" size={14} />{t('h3Apply', { name: controls.name })}</button></div>
      <small>{t('h3ApplyNote')}</small>
    </section>
  );
}
