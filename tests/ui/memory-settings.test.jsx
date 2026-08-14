import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { I18nProvider } from '../../src/i18n/I18nContext.jsx';
import { SessionProvider } from '../../src/contexts/SessionContext.jsx';
import MemorySettings from '../../src/components/MemorySettings.jsx';

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

describe('MemorySettings', () => {
  it('mounts inside the real providers and shows the loaded memory', async () => {
    const { container, root } = mount();
    await act(async () => {
      root.render(
        <I18nProvider>
          <SessionProvider>
            <MemorySettings />
          </SessionProvider>
        </I18nProvider>,
      );
    });
    expect(container.textContent).toContain('长期记忆');
    expect(container.textContent).toContain('冷色系');
    expect(container.textContent).toContain('Alice');
  });

  it('clears project memory through the bridge after confirmation', async () => {
    const clear = vi.fn(async () => null);
    window.electronAPI.memoryClear = clear;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container, root } = mount();
    await act(async () => {
      root.render(
        <I18nProvider>
          <SessionProvider>
            <MemorySettings />
          </SessionProvider>
        </I18nProvider>,
      );
    });
    const button = [...container.querySelectorAll('button')].find(node => node.textContent.includes('清空本项目记忆'));
    expect(button).toBeTruthy();
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(confirm).toHaveBeenCalled();
    expect(clear).toHaveBeenCalledWith('project-a');
  });
});
