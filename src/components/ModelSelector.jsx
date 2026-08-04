import { useCallback, useEffect, useMemo, useState } from 'react';

const EFFORTS = [{ id: 'low', label: '低' }, { id: 'medium', label: '中' }, { id: 'high', label: '高' }];

export default function ModelSelector() {
  const [config, setConfig] = useState({ providers: [], active: {} });
  const load = useCallback(() => window.electronAPI.llmProviders().then(setConfig), []);

  useEffect(() => {
    load();
    window.addEventListener('llm-config-changed', load);
    return () => window.removeEventListener('llm-config-changed', load);
  }, [load]);

  const provider = useMemo(() => config.providers.find(item => item.id === config.active.providerId) || config.providers[0], [config]);

  async function select(patch) {
    const next = { ...config.active, ...patch };
    if (patch.providerId) {
      const selected = config.providers.find(item => item.id === patch.providerId);
      next.modelId = selected?.models?.[0]?.id || '';
    }
    const updated = await window.electronAPI.llmSelect(next);
    setConfig(updated);
  }

  if (!provider) return null;
  return (
    <div className="model-selector">
      <select aria-label="模型提供商" value={provider.id} onChange={event => select({ providerId: event.target.value })}>
        {config.providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <select aria-label="模型" value={config.active.modelId || ''} onChange={event => select({ modelId: event.target.value })}>
        {(provider.models || []).map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
      </select>
      {provider.type !== 'ollama' && <div className="effort-control" role="group" aria-label="推理强度">
        {EFFORTS.map(item => <button key={item.id} className={config.active.reasoningEffort === item.id ? 'active' : ''} onClick={() => select({ reasoningEffort: item.id })}>{item.label}</button>)}
      </div>}
    </div>
  );
}
