export const DEFAULT_UI_PREFERENCES = {
  language: 'zh-CN',
  theme: 'system',
  accent: '#339CFF',
  sidebarTranslucent: false,
  contrast: 60,
  pointerCursor: true,
  reducedMotion: false,
  uiFontSize: 14,
  codeFontSize: 12,
  diffMarkers: true,
};

export function normalizeUIPreferences(value = {}) {
  const next = { ...DEFAULT_UI_PREFERENCES, ...value };
  return {
    ...next,
    language: ['zh-CN', 'en-US'].includes(next.language) ? next.language : DEFAULT_UI_PREFERENCES.language,
    theme: ['system', 'light', 'dark'].includes(next.theme) ? next.theme : DEFAULT_UI_PREFERENCES.theme,
    accent: /^#[0-9a-f]{6}$/i.test(next.accent) ? next.accent : DEFAULT_UI_PREFERENCES.accent,
    contrast: Math.min(100, Math.max(0, Number.isFinite(Number(next.contrast)) ? Number(next.contrast) : DEFAULT_UI_PREFERENCES.contrast)),
    uiFontSize: Math.min(18, Math.max(12, Number(next.uiFontSize) || DEFAULT_UI_PREFERENCES.uiFontSize)),
    codeFontSize: Math.min(18, Math.max(10, Number(next.codeFontSize) || DEFAULT_UI_PREFERENCES.codeFontSize)),
    sidebarTranslucent: Boolean(next.sidebarTranslucent),
    pointerCursor: Boolean(next.pointerCursor),
    reducedMotion: Boolean(next.reducedMotion),
    diffMarkers: Boolean(next.diffMarkers),
  };
}

export function applyUIPreferences(value = {}) {
  const preferences = normalizeUIPreferences(value);
  const root = document.documentElement;
  root.dataset.theme = preferences.theme;
  root.dataset.sidebarTranslucent = preferences.sidebarTranslucent ? 'true' : 'false';
  root.dataset.pointerCursor = preferences.pointerCursor ? 'true' : 'false';
  root.dataset.reducedMotion = preferences.reducedMotion ? 'true' : 'false';
  root.dataset.diffMarkers = preferences.diffMarkers ? 'true' : 'false';
  root.style.setProperty('--accent', preferences.accent);
  root.style.setProperty('--accent-hover', preferences.accent);
  root.style.setProperty('--accent-bg', `color-mix(in srgb, ${preferences.accent} 12%, transparent)`);
  root.style.setProperty('--accent-border', `color-mix(in srgb, ${preferences.accent} 36%, transparent)`);
  root.style.setProperty('--ui-scale', (preferences.uiFontSize / 14).toFixed(2));
  root.style.setProperty('--ui-code-size', `${preferences.codeFontSize}px`);
  root.style.setProperty('--ui-contrast-factor', (0.9 + preferences.contrast / 600).toFixed(3));
  return preferences;
}
