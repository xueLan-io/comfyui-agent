import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { I18nProvider } from '../../src/i18n/I18nContext.jsx';
import PluginSettings from '../../src/components/PluginSettings.jsx';

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('PluginSettings', () => {
  it('mounts and lists loaded plugins with capabilities', async () => {
    const { container, root } = mount();
    await act(async () => {
      root.render(
        <I18nProvider>
          <PluginSettings />
        </I18nProvider>,
      );
    });
    expect(container.textContent).toContain('Hello');
    expect(container.textContent).toContain('tools');
    expect(container.textContent).toContain('已签名');
    expect(container.textContent).toContain('bad');
  });

  it('toggles a plugin through the bridge', async () => {
    const enable = vi.fn(async () => ({}));
    window.electronAPI.pluginsEnable = enable;
    const { container, root } = mount();
    await act(async () => {
      root.render(
        <I18nProvider>
          <PluginSettings />
        </I18nProvider>,
      );
    });
    const checkbox = container.querySelector('input[type="checkbox"]');
    await act(async () => { checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(enable).toHaveBeenCalledWith('hello', false);
  });
});
