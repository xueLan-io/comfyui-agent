import { describe, it, expect, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import GenerationProgress from '../../src/components/GenerationProgress.jsx';

function mount(node) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('GenerationProgress', () => {
  it('renders a determinate progressbar for a running task', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<GenerationProgress status="running" percent={42} />); });
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar).not.toBeNull();
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(container.querySelector('.generation-progress-running')).not.toBeNull();
  });

  it('clamps out-of-range percentages', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<GenerationProgress status="running" percent={250} />); });
    expect(container.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')).toBe('100');
  });

  it('renders a completed state without a progressbar value', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<GenerationProgress status="completed" />); });
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar).not.toBeNull();
    expect(bar.hasAttribute('aria-valuenow')).toBe(false);
  });
});
