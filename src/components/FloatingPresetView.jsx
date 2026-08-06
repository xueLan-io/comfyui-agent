import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { presetTagNodes, usePresetTagTranslations } from './PresetTags.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';

function Cover({ cover }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let live = true;
    setSrc('');
    if (cover) window.electronAPI.globalPresetImageData(cover).then(value => live && setSrc(value || '')).catch(() => {});
    return () => { live = false; };
  }, [cover]);
  return src ? <img src={src} alt="" draggable="false" onDragStart={event => event.preventDefault()} /> : <span className="floating-preset-placeholder">PRESET</span>;
}

function PresetDetailPages({ preset, tagTranslations, language, copied, copy, onAdjust, onGenerate, onReset, onHorizontalSwipe }) {
  const pagesRef = useRef(null);
  const gestureRef = useRef(null);

  function goPage(page) {
    pagesRef.current?.scrollTo({ top: page * pagesRef.current.clientHeight, behavior: 'smooth' });
  }
  function handlePointerDown(event) {
    if (event.button !== 0 || event.target.closest?.('button, input, textarea, select, pre, a')) return;
    gestureRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, axis: '', moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }
  function handlePointerMove(event) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - gesture.x;
    const deltaY = event.clientY - gesture.y;
    const totalX = event.clientX - gesture.startX;
    const totalY = event.clientY - gesture.startY;
    if (!gesture.axis && Math.max(Math.abs(totalX), Math.abs(totalY)) >= 6) {
      gesture.axis = Math.abs(totalX) >= Math.abs(totalY) ? 'x' : 'y';
    }
    if (!gesture.axis) return;
    gesture.moved = true;
    gesture.x = event.clientX;
    gesture.y = event.clientY;
    if (gesture.axis === 'x') onHorizontalSwipe?.(-deltaX);
    else pagesRef.current?.scrollBy({ top: -deltaY, behavior: 'auto' });
    event.preventDefault();
  }
  function handlePointerUp(event) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (gesture.axis === 'y' && gesture.moved && pagesRef.current) pagesRef.current.scrollTo({ top: Math.round(pagesRef.current.scrollTop / pagesRef.current.clientHeight) * pagesRef.current.clientHeight, behavior: 'smooth' });
  }

  return <div className="floating-preset-detail-pages" ref={pagesRef} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp}>
    <article className="floating-preset-detail-page floating-preset-overview-page">
      <div className="floating-preset-cover"><Cover cover={preset.cover} /></div>
      <div className="floating-preset-card-title"><span className="section-kicker">PRESET CARD</span><h2>{preset.title}</h2></div>
      <p className="floating-preset-description">{preset.description || '暂无描述'}</p>
       <div className="floating-preset-tags floating-preset-tags-large">{presetTagNodes(preset.tags, tagTranslations, language) || <span>未设置标签</span>}</div>
      <span className="floating-preset-swipe-hint">向上滑动查看提示词与参数</span>
      <div className="floating-preset-actions"><button type="button" className="btn btn-primary" onClick={() => onAdjust(preset)}>调整后生成</button><button type="button" className="btn" onClick={() => onGenerate(preset)}>立即生成</button></div>
    </article>
    <article className="floating-preset-detail-page floating-preset-prompt-page">
      <div className="floating-preset-info-heading"><span>DETAILS</span><button type="button" className="btn" onClick={() => goPage(0)}><Icon name="chevronDown" size={12} />返回封面</button></div>
         <div className="floating-preset-tags floating-preset-tags-large">{presetTagNodes(preset.tags, tagTranslations, language) || <span>未设置标签</span>}</div>
      <div className="floating-preset-copy-heading"><h3>正向提示词</h3><button type="button" className="btn btn-small" onClick={() => void copy(preset.positive, `${preset.id}-positive`)}>{copied === `${preset.id}-positive` ? '已复制' : '复制'}</button></div>
      <pre className="floating-preset-scroll-text">{preset.positive || '未设置'}</pre>
      <div className="floating-preset-copy-heading"><h3>负向提示词</h3><button type="button" className="btn btn-small" onClick={() => void copy(preset.negative, `${preset.id}-negative`)} disabled={!preset.negative}>{copied === `${preset.id}-negative` ? '已复制' : '复制'}</button></div>
      <pre className="floating-preset-scroll-text">{preset.negative || '未设置'}</pre>
      <button type="button" className="btn floating-preset-reset" onClick={() => onReset(preset)}>恢复此卡默认状态</button>
    </article>
  </div>;
}

export default function FloatingPresetView({ onBack, onAdjust, onGenerate, onReset }) {
  const { language } = useI18n();
  const [presets, setPresets] = useState([]);
  const [search, setSearch] = useState('');
  const [index, setIndex] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState('');
  const tagTranslations = usePresetTagTranslations();
  const pagesRef = useRef(null);
  const gestureRef = useRef(null);

  async function refresh() {
    setLoading(true);
    setError('');
    try { setPresets(await window.electronAPI.globalPresetsList()); } catch (requestError) { setError(requestError.message || '加载预设失败'); } finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  const visible = presets.filter(preset => `${preset.title} ${preset.description} ${preset.positive} ${preset.negative} ${(preset.tags || []).join(' ')}`.toLowerCase().includes(search.trim().toLowerCase()));
  useEffect(() => { setIndex(current => Math.min(current, Math.max(visible.length - 1, 0))); }, [search, visible.length]);
  useEffect(() => { if (visible.length && pagesRef.current) pagesRef.current.scrollTo({ left: index * pagesRef.current.clientWidth, behavior: 'auto' }); }, [index, visible.length]);

  function scrollToPreset(nextIndex) {
    const safeIndex = Math.max(0, Math.min(nextIndex, visible.length - 1));
    setIndex(safeIndex);
    pagesRef.current?.scrollTo({ left: safeIndex * pagesRef.current.clientWidth, behavior: 'smooth' });
  }
  async function copy(value, type) { if (!value) return; try { await navigator.clipboard.writeText(value); setCopied(type); window.setTimeout(() => setCopied(''), 1200); } catch {} }
  function handlePointerDown(event) {
    if (event.button !== 0 || event.target.closest?.('button, input, textarea, select, pre, a, .floating-preset-detail-pages')) return;
    gestureRef.current = { pointerId: event.pointerId, x: event.clientX, startX: event.clientX, y: event.clientY, startY: event.clientY, axis: '', moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }
  function handlePointerMove(event) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - gesture.x;
    const totalX = event.clientX - gesture.startX;
    const totalY = event.clientY - gesture.startY;
    if (!gesture.axis && Math.max(Math.abs(totalX), Math.abs(totalY)) >= 6) {
      gesture.axis = Math.abs(totalX) >= Math.abs(totalY) ? 'x' : 'y';
    }
    if (gesture.axis !== 'x') return;
    gesture.moved = true;
    gesture.x = event.clientX;
    pagesRef.current?.scrollBy({ left: -deltaX, behavior: 'auto' });
    event.preventDefault();
  }
  function handlePointerUp(event) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (gesture.axis === 'x' && gesture.moved && pagesRef.current) scrollToPreset(Math.round(pagesRef.current.scrollLeft / pagesRef.current.clientWidth));
  }
  function handleScroll() {
    if (!pagesRef.current?.clientWidth) return;
    const next = Math.round(pagesRef.current.scrollLeft / pagesRef.current.clientWidth);
    if (next !== index) setIndex(Math.max(0, Math.min(next, visible.length - 1)));
  }

  return <section className="floating-preset-view" aria-label="悬浮窗预设卡">
    <header className="quick-generate-header"><div><span className="section-kicker">PRESET CARDS</span><strong>预设卡</strong></div><div className="quick-generate-header-actions"><button type="button" className="quick-generate-main" onClick={onBack}><Icon name="chevronLeft" size={13} /><span>返回</span></button><button type="button" className="quick-generate-close" onClick={onBack}><Icon name="close" size={15} /></button></div></header>
    <label className="floating-preset-search"><Icon name="search" size={13} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索预设、提示词或标签" /></label>
    {error && <div className="floating-preset-error">{error}<button type="button" className="btn" onClick={() => void refresh()}>重试</button></div>}
    {loading ? <div className="floating-preset-empty">正在加载预设...</div> : !visible.length ? <div className="floating-preset-empty">还没有匹配的预设卡</div> : <>
      <div className="floating-preset-browser-heading"><span>{index + 1} / {visible.length} · 左右切换预设</span><div><button type="button" className="btn btn-icon" onClick={() => scrollToPreset(index - 1)} disabled={index === 0} aria-label="上一张预设"><Icon name="chevronLeft" size={13} /></button><button type="button" className="btn btn-icon" onClick={() => scrollToPreset(index + 1)} disabled={index === visible.length - 1} aria-label="下一张预设"><Icon name="chevronRight" size={13} /></button></div></div>
       <div className="floating-preset-pages" ref={pagesRef} onScroll={handleScroll} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp}>
           {visible.map(preset => <article className="floating-preset-page floating-preset-card-page" key={preset.id}><PresetDetailPages preset={preset} tagTranslations={tagTranslations} language={language} copied={copied} copy={copy} onAdjust={onAdjust} onGenerate={onGenerate} onReset={onReset} onHorizontalSwipe={delta => pagesRef.current?.scrollBy({ left: delta, behavior: 'auto' })} /></article>)}
      </div>
    </>}
  </section>;
}
