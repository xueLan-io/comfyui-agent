import { describe, it, expect, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import Icon from '../../src/components/Icon.jsx';

function mount(node) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Icon', () => {
  it('renders an svg for a known name', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<Icon name="spark" />); });
    const svg = container.querySelector('svg.icon-spark');
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('honors size and className props', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<Icon name="close" size={24} className="extra" />); });
    const svg = container.querySelector('svg.icon-close');
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('width')).toBe('24');
    expect(svg.classList.contains('extra')).toBe(true);
  });

  it('falls back to spark for unknown names without crashing', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<Icon name="not-a-real-icon" />); });
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
