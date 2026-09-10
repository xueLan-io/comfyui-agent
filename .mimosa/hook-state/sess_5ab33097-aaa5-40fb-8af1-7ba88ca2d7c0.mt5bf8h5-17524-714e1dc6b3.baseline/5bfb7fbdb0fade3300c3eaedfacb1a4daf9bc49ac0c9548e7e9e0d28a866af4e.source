import { describe, it, expect, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { I18nProvider } from '../../src/i18n/I18nContext.jsx';
import { SessionProvider } from '../../src/contexts/SessionContext.jsx';
import PromptPersonalitySettings from '../../src/components/PromptPersonalitySettings.jsx';

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('PromptPersonalitySettings', () => {
  it('mounts inside the real providers without crashing', async () => {
    const { container, root } = mount();
    await act(async () => {
      root.render(
        <I18nProvider>
          <SessionProvider>
            <PromptPersonalitySettings />
          </SessionProvider>
        </I18nProvider>,
      );
    });
    expect(container.textContent).toContain('自定义');
  });

  it('renders scope toggle and strategy controls', async () => {
    const { container, root } = mount();
    await act(async () => {
      root.render(
        <I18nProvider>
          <SessionProvider>
            <PromptPersonalitySettings />
          </SessionProvider>
        </I18nProvider>,
      );
    });
    const inputs = container.querySelectorAll('input[type="checkbox"]');
    expect(inputs.length).toBeGreaterThanOrEqual(1);
    const selects = container.querySelectorAll('select');
    expect(selects.length).toBeGreaterThanOrEqual(1);
  });
});
