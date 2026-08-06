import { useEffect, useState } from 'react';
import { loadCollectedPromptItems } from './prompt-library-collected.mjs';

export function usePresetTagTranslations() {
  const [translations, setTranslations] = useState(() => new Map());
  useEffect(() => {
    let live = true;
    void loadCollectedPromptItems().then(items => {
      if (live) setTranslations(new Map(items.filter(item => item.kind === 'tag' && item.translation).map(item => [item.prompt, item.translation])));
    }).catch(() => {});
    return () => { live = false; };
  }, []);
  return translations;
}

export function presetTagNodes(tags, translations, language = 'zh-CN') {
  return tags?.length ? tags.map((rawTag, index) => {
    const tag = String(rawTag || '').trim();
    const translation = translations.get(tag) || '';
    const primary = language === 'en-US' ? tag : (translation || tag);
    const secondary = language === 'en-US' ? translation : tag;
    return <span key={`${tag}-${index}`}><strong>{primary}</strong>{secondary && secondary !== primary && <small>{secondary}</small>}</span>;
  }) : null;
}
