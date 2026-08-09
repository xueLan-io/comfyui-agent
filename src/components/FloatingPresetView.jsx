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

function PresetDetailPages({ preset, tagTranslations, language, copied, copy, onAdjust, onGenerate, onReset, onHorizontalSwipe, onHorizontalRelease }) {
  const { t } = useI18n();
  const pagesRef = useRef(null);
  const gestureRef = useRef(null);

  useEffect(() => () => { gestureRef.current = null; }, []);

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
    if (gesture.axis === 'x' && gesture.moved) onHorizontalRelease?.();
  }

  return <div className="floating-preset-detail-pages" ref={pagesRef} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp}>
    <article className="floating-preset-detail-page floating-preset-overview-page">
      <div className="floating-preset-cover"><Cover cover={preset.cover} /></div>
      <div className="floating-preset-card-title"><span className="section-kicker">PRESET CARD</span><h2>{preset.title}</h2></div>
      <p className="floating-preset-description">{preset.description || t('floatPresetNoDescription')}</p>
       <div className="floating-preset-tags floating-preset-tags-large">{presetTagNodes(preset.tags, tagTranslations, language) || <span>{t('floatPresetNoTags')}</span>}</div>
      <span className="floating-preset-swipe-hint">{t('floatPresetSwipeHint')}</span>
      <div className="floating-preset-actions"><button type="button" className="btn btn-primary" onClick={() => onAdjust(preset)}>{t('floatPresetAdjustGenerate')}</button><button type="button" className="btn" onClick={() => onGenerate(preset)}>{t('floatPresetGenerateNow')}</button></div>
    </article>
    <article className="floating-preset-detail-page floating-preset-prompt-page">
      <div className="floating-preset-info-heading"><span>DETAILS</span><button type="button" className="btn" onClick={() => goPage(0)}><Icon name="chevronDown" size={12} />{t('floatPresetBackToCover')}</button></div>
         <div className="floating-preset-tags floating-preset-tags-large">{presetTagNodes(preset.tags, tagTranslations, language) || <span>{t('floatPresetNoTags')}</span>}</div>
      <div className="floating-preset-copy-heading"><h3>{t('floatPresetPositive')}</h3><button type="button" className="btn btn-small" onClick={() => void copy(preset.positive, `${preset.id}-positive`)}>{copied === `${preset.id}-positive` ? t('floatCopied') : t('floatCopy')}</button></div>
      <pre className="floating-preset-scroll-text">{preset.positive || t('floatPresetNotSet')}</pre>
      <div className="floating-preset-copy-heading"><h3>{t('floatPresetNegative')}</h3><button type="button" className="btn btn-small" onClick={() => void copy(preset.negative, `${preset.id}-negative`)} disabled={!preset.negative}>{copied === `${preset.id}-negative` ? t('floatCopied') : t('floatCopy')}</button></div>
      <pre className="floating-preset-scroll-text">{preset.negative || t('floatPresetNotSet')}</pre>
      <button type="button" className="btn floating-preset-reset" onClick={() => onReset(preset)}>{t('floatPresetResetCard')}</button>
    </article>
  </div>;
}

export default function FloatingPresetView({ onBack, onAdjust, onGenerate, onReset }) {
  const { language, t } = useI18n();
  const [presets, setPresets] = useState([]);
  const [search, setSearch] = useState('');
  const [index, setIndex] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState('');
  const tagTranslations = usePresetTagTranslations();
  const pagesRef = useRef(null);
  const gestureRef = useRef(null);

  useEffect(() => () => { gestureRef.current = null; }, []);

  async function refresh() {
    setLoading(true);
    setError('');
    try { setPresets(await window.electronAPI.globalPresetsList()); } catch (requestError) { setError(requestError.message || t('floatPresetLoadFailed')); } finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    const refreshOnSave = () => void refresh();
    window.addEventListener('comfy-agent:preset-saved', refreshOnSave);
    return () => window.removeEventListener('comfy-agent:preset-saved', refreshOnSave);
  }, []);
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

  return <section className="floating-preset-view" aria-label={t('floatPresetViewAria')}>
    <header className="quick-generate-header"><div><span className="section-kicker">PRESET CARDS</span><strong>{t('floatPresetCards')}</strong></div><div className="quick-generate-header-actions"><button type="button" className="quick-generate-main" onClick={onBack}><Icon name="chevronLeft" size={13} /><span>{t('floatBack')}</span></button><button type="button" className="quick-generate-close" onClick={onBack}><Icon name="close" size={15} /></button></div></header>
    <label className="floating-preset-search"><Icon name="search" size={13} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder={t('floatPresetSearchPlaceholder')} /></label>
    {error && <div className="floating-preset-error">{error}<button type="button" className="btn" onClick={() => void refresh()}>{t('floatRetry')}</button></div>}
    {loading ? <div className="floating-preset-empty">{t('floatPresetLoading')}</div> : !visible.length ? <div className="floating-preset-empty">{t('floatPresetNoMatch')}</div> : <>
      <div className="floating-preset-browser-heading"><span>{t('floatPresetBrowserHint', { index: index + 1, total: visible.length })}</span><div><button type="button" className="btn btn-icon" onClick={() => scrollToPreset(index - 1)} disabled={index === 0} aria-label={t('floatPresetPrevious')}><Icon name="chevronLeft" size={13} /></button><button type="button" className="btn btn-icon" onClick={() => scrollToPreset(index + 1)} disabled={index === visible.length - 1} aria-label={t('floatPresetNext')}><Icon name="chevronRight" size={13} /></button></div></div>
       <div className="floating-preset-pages" ref={pagesRef} onScroll={handleScroll} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp}>
           {visible.map(preset => <article className="floating-preset-page floating-preset-card-page" key={preset.id}><PresetDetailPages preset={preset} tagTranslations={tagTranslations} language={language} copied={copied} copy={copy} onAdjust={onAdjust} onGenerate={onGenerate} onReset={onReset} onHorizontalSwipe={delta => pagesRef.current?.scrollBy({ left: delta, behavior: 'auto' })} onHorizontalRelease={() => { if (pagesRef.current) scrollToPreset(Math.round(pagesRef.current.scrollLeft / pagesRef.current.clientWidth)); }} /></article>)}
      </div>
    </>}
  </section>;
}
