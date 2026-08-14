import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { I18nProvider } from '../../src/i18n/I18nContext.jsx';
import { SessionProvider } from '../../src/contexts/SessionContext.jsx';
import { BatchQueueProvider } from '../../src/contexts/BatchQueueContext.jsx';
import QueueTab from '../../src/components/QueueTab.jsx';

// QueueTab replaced the deleted BatchWorkspacePage (f6e2b54): the batch studio
// is now a queue tab driven by BatchQueueContext over the main-process draft.
// These smoke tests cover the queue surface (empty state + completed batches).

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

describe('QueueTab', () => {
  it('mounts inside the real providers and shows the empty queue state', async () => {
    window.electronAPI.queueList = vi.fn(async () => []);
    window.electronAPI.batchList = vi.fn(async () => []);
    const { container, root } = mount();
    await act(async () => {
      root.render(
        <I18nProvider>
          <SessionProvider>
            <BatchQueueProvider>
              <QueueTab />
            </BatchQueueProvider>
          </SessionProvider>
        </I18nProvider>,
      );
    });
    expect(container.querySelector('.queue-empty')).toBeTruthy();
    expect(container.textContent).toContain('生成队列');
  });

  it('lists completed batches from the queue and shows per-batch progress', async () => {
    window.electronAPI.queueList = vi.fn(async () => []);
    window.electronAPI.batchList = vi.fn(async () => [
      {
        id: 'batch_1', title: '夜晚车站系列', projectId: 'project-a', workflowName: 'anima.json',
        status: 'completed', progress: { total: 2, done: 2, completed: 2, failed: 0, cancelled: 0 },
        jobs: [
          { index: 0, id: 'job_1', status: 'completed', seed: 42, score: 95, result: { images: [{ path: 'out_1.png', name: 'out_1.png' }] } },
          { index: 1, id: 'job_2', status: 'completed', seed: 1337, score: 60, result: { images: [{ path: 'out_2.png', name: 'out_2.png' }] } },
        ],
      },
    ]);
    const { container, root } = mount();
    await act(async () => {
      root.render(
        <I18nProvider>
          <SessionProvider>
            <BatchQueueProvider>
              <QueueTab />
            </BatchQueueProvider>
          </SessionProvider>
        </I18nProvider>,
      );
    });
    await act(async () => {});
    expect(container.querySelector('.queue-batch-done')).toBeTruthy();
    expect(container.textContent).toContain('夜晚车站系列');
    expect(container.textContent).toContain('2/2');
  });
});
