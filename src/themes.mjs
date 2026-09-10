// Single source of truth for the theme catalog.
// CSS token blocks live in styles/themes-core.css; atmosphere layers in
// styles/themes-atmosphere.css. This registry drives the settings gallery,
// default accents, and light/dark routing (mermaid, etc.).
export const UI_THEMES = [
  {
    id: 'system',
    labelKey: 'system',
    descriptionKey: 'themeSystemDescription',
    mode: 'system',
    defaultAccent: '#2670C2',
    defaultAccentDark: '#66B7FF',
  },
  {
    id: 'light',
    labelKey: 'light',
    descriptionKey: 'themeLightDescription',
    mode: 'light',
    defaultAccent: '#2670C2',
  },
  {
    id: 'dark',
    labelKey: 'dark',
    descriptionKey: 'themeDarkDescription',
    mode: 'dark',
    defaultAccent: '#66B7FF',
  },
  {
    id: 'paper',
    labelKey: 'themePaper',
    descriptionKey: 'themePaperDescription',
    mode: 'light',
    defaultAccent: '#4F6B9E',
  },
  {
    id: 'mist',
    labelKey: 'themeMist',
    descriptionKey: 'themeMistDescription',
    mode: 'light',
    defaultAccent: '#347E72',
  },
  {
    id: 'warm',
    labelKey: 'themeWarm',
    descriptionKey: 'themeWarmDescription',
    mode: 'light',
    defaultAccent: '#96601F',
  },
  {
    id: 'navy',
    labelKey: 'themeNavy',
    descriptionKey: 'themeNavyDescription',
    mode: 'dark',
    defaultAccent: '#4DA3FF',
  },
  {
    id: 'starry',
    labelKey: 'themeStarry',
    descriptionKey: 'themeStarryDescription',
    mode: 'dark',
    defaultAccent: '#66B7FF',
  },
];

export const UI_THEME_IDS = UI_THEMES.map(theme => theme.id);
export const UI_THEME_BY_ID = Object.fromEntries(UI_THEMES.map(theme => [theme.id, theme]));

export function getThemeDefaultAccent(themeId) {
  const theme = UI_THEME_BY_ID[themeId] || UI_THEME_BY_ID.system;
  if (theme.mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches
      ? theme.defaultAccent
      : theme.defaultAccentDark;
  }
  return theme.defaultAccent;
}

export function resolveThemeMode(themeId) {
  const theme = UI_THEME_BY_ID[themeId] || UI_THEME_BY_ID.system;
  if (theme.mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return theme.mode;
}

export function isThemeLight(themeId) {
  return resolveThemeMode(themeId) === 'light';
}
