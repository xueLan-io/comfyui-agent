import { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n/I18nContext.jsx';

export default function ModelSelector({ mode = 'chat' }) {
  const { t } = useI18n();
  const efforts = [{ id: 'low', label: t('low') }, { id: 'medium', label: t('medium') }, { id: 'high', label: t('high') }];
  const [config, setConfig] = useState({ providers: [], active: {} });
  const load = useCallback(() => window.electronAPI.llmProviders().then(setConfig), []);

  useEffect(() => {
    load();
    window.addEventListener('llm-config-changed', load);
    return () => window.removeEventListener('llm-config-changed', load);
  }, [load]);

  const chatProviders = useMemo(() => config.providers.filter(item => item.models?.some(model => model.kind !== 'image')), [config.providers]);
  const provider = useMemo(() => chatProviders.find(item => item.id === config.active.providerId) || chatProviders[0], [chatProviders, config.active.providerId]);
  const imageProviders = useMemo(() => config.providers.filter(item => item.models?.some(model => model.kind === 'image')), [config.providers]);
  const imageProvider = useMemo(() => imageProviders.find(item => item.id === config.imageProviderId) || imageProviders[0], [imageProviders, config.imageProviderId]);

  async function select(patch) {
    if (mode === 'image') {
      const next = { imageProviderId: patch.imageProviderId !== undefined ? patch.imageProviderId : config.imageProviderId, imageModelId: patch.imageModelId !== undefined ? patch.imageModelId : config.imageModelId };
      if (patch.imageProviderId !== undefined) {
        const selected = imageProviders.find(item => item.id === patch.imageProviderId);
        next.imageModelId = selected?.models?.find(model => model.kind === 'image')?.id || '';
      }
      const updated = await window.electronAPI.llmSelect(next);
      setConfig(updated);
      return;
    }
    const next = { ...config.active, ...patch };
    if (patch.providerId) {
      const selected = chatProviders.find(item => item.id === patch.providerId);
      next.modelId = selected?.models?.find(model => model.kind !== 'image')?.id || '';
    }
    const updated = await window.electronAPI.llmSelect(next);
    setConfig(updated);
  }

  if (mode === 'image') {
    if (!imageProvider) return <span className="settings-muted">{t('notConfiguredImageModel')}</span>;
    return (
      <div className="model-selector">
       <select aria-label={t('imageProviderLabel')} value={imageProvider.id} onChange={event => select({ imageProviderId: event.target.value })}>
          {imageProviders.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
       <select aria-label={t('modelLabel')} value={(imageProvider.models || []).some(model => model.id === config.imageModelId && model.kind === 'image') ? config.imageModelId : ''} onChange={event => select({ imageModelId: event.target.value })}>
          {(imageProvider.models || []).filter(model => model.kind === 'image').map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
        </select>
      </div>
    );
  }
  if (!provider) return null;
  return (
    <div className="model-selector">
      <select aria-label={t('providerIntro')} value={provider.id} onChange={event => select({ providerId: event.target.value })}>
        {chatProviders.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
       <select aria-label={t('modelLabel')} value={(provider.models || []).some(model => model.id === config.active.modelId && model.kind !== 'image') ? config.active.modelId : ''} onChange={event => select({ modelId: event.target.value })}>
        {(provider.models || []).filter(model => model.kind !== 'image').map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
      </select>
      {provider.type !== 'ollama' && <div className="effort-control" role="group" aria-label={t('reasoningEffort')}>
        {efforts.map(item => <button key={item.id} className={config.active.reasoningEffort === item.id ? 'active' : ''} onClick={() => select({ reasoningEffort: item.id })}>{item.label}</button>)}
      </div>}
    </div>
  );
}
