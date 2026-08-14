import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { I18nProvider } from '../../src/i18n/I18nContext.jsx';
import { SessionProvider } from '../../src/contexts/SessionContext.jsx';
import BatchWorkspacePage from '../../src/components/BatchWorkspacePage.jsx';

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

describe('BatchWorkspacePage', () => {
  it('mounts and shows the batch list with jobs', async () => {
    const { container, root } = mount();
    await act(async () => {
      root.render(
        <I18nProvider>
          <SessionProvider>
            <BatchWorkspacePage onBack={() => {}} />
          </SessionProvider>
        </I18nProvider>,
      );
    });
    expect(container.textContent).toContain('批量创作');
    expect(container.textContent).toContain('夜晚车站系列');
    expect(container.textContent).toContain('95');
    expect(container.querySelectorAll('.batch-card').length).toBe(1);
  });

  it('creates and starts a batch from the form', async () => {
    const create = vi.fn(async () => ({ id: 'batch_new', jobs: [] }));
    const start = vi.fn(async () => ({}));
    window.electronAPI.batchCreate = create;
    window.electronAPI.batchStart = start;
    const { container, root } = mount();
    await act(async () => {
      root.render(
        <I18nProvider>
          <SessionProvider>
            <BatchWorkspacePage onBack={() => {}} />
          </SessionProvider>
        </I18nProvider>,
      );
    });
    const button = [...container.querySelectorAll('button')].find(node => node.textContent.includes('创建并开始'));
    expect(button).toBeTruthy();
    // create is disabled until workflow + positive are set; fill them with the
    // native setter so React's controlled components observe the change
    const setValue = (el, value) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const workflow = container.querySelector('select');
    const positive = container.querySelector('textarea');
    await act(async () => {
      setValue(workflow, 'anima.json');
      setValue(positive, 'a night station, anime style');
    });
    const enabled = [...container.querySelectorAll('button')].find(node => node.textContent.includes('创建并开始'));
    await act(async () => { enabled.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(create).toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith('batch_new');
  });
});
