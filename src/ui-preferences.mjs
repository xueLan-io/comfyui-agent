import { UI_THEME_IDS, getThemeDefaultAccent, resolveThemeMode } from './themes.mjs';

export { UI_THEME_IDS } from './themes.mjs';

export const DEFAULT_UI_PREFERENCES = {
  language: 'zh-CN',
  theme: 'system',
  accent: '',
  sidebarTranslucent: false,
  contrast: 60,
  pointerCursor: true,
  reducedMotion: false,
  uiFontSize: 14,
  codeFontSize: 12,
  diffMarkers: true,
  startComfyOnLaunch: true,
  notifyOnComplete: true,
  notifyOnFail: true,
  soundOnComplete: true,
  soundStyle: 'chime',
  soundVolume: 60,
};

export const SOUND_STYLE_IDS = ['none', 'chime', 'soft', 'ding', 'bell', 'pop', 'beep', 'success'];

export function normalizeUIPreferences(value = {}) {
  const next = { ...DEFAULT_UI_PREFERENCES, ...value };
  return {
    ...next,
    language: ['zh-CN', 'en-US'].includes(next.language) ? next.language : DEFAULT_UI_PREFERENCES.language,
    theme: UI_THEME_IDS.includes(next.theme) ? next.theme : DEFAULT_UI_PREFERENCES.theme,
    accent: next.accent === '' || /^#[0-9a-f]{6}$/i.test(next.accent) ? next.accent : DEFAULT_UI_PREFERENCES.accent,
    contrast: Math.min(100, Math.max(0, Number.isFinite(Number(next.contrast)) ? Number(next.contrast) : DEFAULT_UI_PREFERENCES.contrast)),
    uiFontSize: Math.min(18, Math.max(12, Number(next.uiFontSize) || DEFAULT_UI_PREFERENCES.uiFontSize)),
    codeFontSize: Math.min(18, Math.max(10, Number(next.codeFontSize) || DEFAULT_UI_PREFERENCES.codeFontSize)),
    sidebarTranslucent: Boolean(next.sidebarTranslucent),
    pointerCursor: Boolean(next.pointerCursor),
    reducedMotion: Boolean(next.reducedMotion),
    diffMarkers: Boolean(next.diffMarkers),
    startComfyOnLaunch: Boolean(next.startComfyOnLaunch),
    notifyOnComplete: Boolean(next.notifyOnComplete),
    notifyOnFail: Boolean(next.notifyOnFail),
    soundOnComplete: Boolean(next.soundOnComplete),
    soundStyle: SOUND_STYLE_IDS.includes(next.soundStyle) ? next.soundStyle : DEFAULT_UI_PREFERENCES.soundStyle,
    soundVolume: Math.min(100, Math.max(0, Number(next.soundVolume) || DEFAULT_UI_PREFERENCES.soundVolume)),
  };
}

function accentLuminance(hex) {
  const value = hex.replace('#', '');
  const channel = index => {
    const raw = parseInt(value.slice(index * 2, index * 2 + 2), 16) / 255;
    return raw <= 0.04045 ? raw / 12.92 : Math.pow((raw + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

export function applyUIPreferences(value = {}) {
  const preferences = normalizeUIPreferences(value);
  const root = document.documentElement;
  const mode = resolveThemeMode(preferences.theme);
  const accent = preferences.accent || getThemeDefaultAccent(preferences.theme);
  const hoverMix = mode === 'light' ? '#000000' : '#ffffff';
  const onAccent = accentLuminance(accent) > 0.62 ? '#07121e' : '#ffffff';

  root.dataset.theme = preferences.theme;
  root.dataset.sidebarTranslucent = preferences.sidebarTranslucent ? 'true' : 'false';
  root.dataset.pointerCursor = preferences.pointerCursor ? 'true' : 'false';
  root.dataset.reducedMotion = preferences.reducedMotion ? 'true' : 'false';
  root.dataset.diffMarkers = preferences.diffMarkers ? 'true' : 'false';
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-hover', `color-mix(in srgb, ${accent} 84%, ${hoverMix})`);
  root.style.setProperty('--accent-bg', `color-mix(in srgb, ${accent} 12%, transparent)`);
  root.style.setProperty('--accent-border', `color-mix(in srgb, ${accent} 36%, transparent)`);
  root.style.setProperty('--text-on-accent', onAccent);
  root.style.setProperty('--ui-scale', (preferences.uiFontSize / 14).toFixed(2));
  root.style.setProperty('--ui-code-size', `${preferences.codeFontSize}px`);
  root.style.setProperty('--ui-contrast-factor', (0.9 + preferences.contrast / 600).toFixed(3));
  return preferences;
}
