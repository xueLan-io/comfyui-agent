import { createContext, useContext, useEffect, useState } from 'react';
import { translations, uiTranslations, additionalTranslations } from './translations-data.mjs';

export const I18nContext = createContext(null);

export function I18nProvider({ children }) {
  const [language, setLanguageState] = useState(() => window.localStorage.getItem('comfyui-agent.language') || 'zh-CN');
  useEffect(() => { window.electronAPI?.uiPreferences?.().then(value => setLanguageState(value.language || 'zh-CN')).catch(() => {}); }, []);
  function setLanguage(value) { const next = ['zh-CN', 'en-US'].includes(value) ? value : 'zh-CN'; setLanguageState(next); window.localStorage.setItem('comfyui-agent.language', next); }
  function t(key, params = {}) {
    const template = uiTranslations[language]?.[key] || translations[language]?.[key] || additionalTranslations[language]?.[key] || additionalTranslations['zh-CN'][key] || uiTranslations['zh-CN'][key] || translations['zh-CN'][key] || key;
    return Object.entries(params).reduce((value, [name, replacement]) => value.replaceAll(`{${name}}`, String(replacement)), template);
  }
  return <I18nContext.Provider value={{ language, setLanguage, t }}>{children}</I18nContext.Provider>;
}

export function useI18n() { return useContext(I18nContext); }
