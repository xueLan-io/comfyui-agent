import { useEffect, useState } from 'react';
import { applyUIPreferences, DEFAULT_UI_PREFERENCES, normalizeUIPreferences } from '../ui-preferences.mjs';
import Icon from './Icon.jsx';

const ACCENTS = [
  { value: '#339CFF', label: '天蓝' },
  { value: '#5B8DEF', label: '靛蓝' },
  { value: '#57B7A4', label: '青绿' },
  { value: '#D0D0D0', label: '中性灰' },
];

export default function AppearanceSettings() {
  const [preferences, setPreferences] = useState(DEFAULT_UI_PREFERENCES);
  const [status, setStatus] = useState('');

  useEffect(() => {
    window.electronAPI.uiPreferences().then(value => {
      const next = normalizeUIPreferences(value);
      setPreferences(next);
      applyUIPreferences(next);
    }).catch(() => {});
  }, []);

  function update(patch) {
    const next = normalizeUIPreferences({ ...preferences, ...patch });
    setPreferences(next);
    applyUIPreferences(next);
    setStatus('');
  }

  async function save() {
    try {
      const saved = await window.electronAPI.uiSavePreferences(preferences);
      setPreferences(normalizeUIPreferences(saved));
      setStatus('已保存');
    } catch {
      setStatus('保存失败');
    }
  }

  return (
    <div className="appearance-settings">
      <section>
        <div className="settings-section-heading"><div><h3>主题</h3><p>控制界面的明暗和强调色。</p></div><Icon name="spark" size={16} /></div>
        <div className="appearance-theme-options">
          {[['system', '系统'], ['light', '浅色'], ['dark', '深色']].map(([value, label]) => (
            <button key={value} className={`appearance-theme-option${preferences.theme === value ? ' active' : ''}`} onClick={() => update({ theme: value })} aria-pressed={preferences.theme === value}><span className={`theme-preview theme-preview-${value}`} /><strong>{label}</strong></button>
          ))}
        </div>
        <div className="settings-grid appearance-grid">
          <div className="settings-field"><label>强调色</label><div className="accent-options">{ACCENTS.map(item => <button key={item.value} className={`accent-swatch${preferences.accent === item.value ? ' active' : ''}`} style={{ background: item.value }} onClick={() => update({ accent: item.value })} title={item.label} aria-label={item.label} />)}</div></div>
          <label className="settings-toggle"><span><strong>半透明侧边栏</strong><small>让侧边区域与内容保持层次。</small></span><input type="checkbox" checked={preferences.sidebarTranslucent} onChange={event => update({ sidebarTranslucent: event.target.checked })} /></label>
        </div>
        <label className="settings-range"><span><strong>对比度</strong><output>{preferences.contrast}</output></span><input type="range" min="0" max="100" value={preferences.contrast} onChange={event => update({ contrast: Number(event.target.value) })} /></label>
      </section>

      <section>
        <div className="settings-section-heading"><div><h3>偏好设置</h3><p>调整交互反馈和文字密度。</p></div><Icon name="settings" size={16} /></div>
        <label className="settings-toggle"><span><strong>使用指针光标</strong><small>悬停在可点击元素时显示指针。</small></span><input type="checkbox" checked={preferences.pointerCursor} onChange={event => update({ pointerCursor: event.target.checked })} /></label>
        <label className="settings-toggle"><span><strong>减少动态效果</strong><small>减少过渡、闪烁和移动效果。</small></span><input type="checkbox" checked={preferences.reducedMotion} onChange={event => update({ reducedMotion: event.target.checked })} /></label>
        <div className="settings-grid appearance-grid">
          <label className="settings-field"><span>UI 字号</span><div className="settings-number"><input type="number" min="12" max="18" value={preferences.uiFontSize} onChange={event => update({ uiFontSize: event.target.value })} /><small>px</small></div></label>
          <label className="settings-field"><span>代码字号</span><div className="settings-number"><input type="number" min="10" max="18" value={preferences.codeFontSize} onChange={event => update({ codeFontSize: event.target.value })} /><small>px</small></div></label>
        </div>
        <label className="settings-toggle"><span><strong>差异标记</strong><small>为代码和差异视图保留颜色与 +/- 标记。</small></span><input type="checkbox" checked={preferences.diffMarkers} onChange={event => update({ diffMarkers: event.target.checked })} /></label>
      </section>

      <div className="settings-actions"><button className="btn btn-primary" onClick={() => void save()}><Icon name="check" size={13} /> 保存设置</button>{status && <span className="settings-save-state">{status}</span>}</div>
    </div>
  );
}
