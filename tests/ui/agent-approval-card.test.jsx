import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import AgentApprovalCard from '../../src/components/AgentApprovalCard.jsx';

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

// The card subscribes on mount; tests push events through this sink.
let approvalSink = null;

function stubBridge({ respond } = {}) {
  window.electronAPI = {
    agentOnApproval: (cb) => {
      approvalSink = cb;
      return () => { approvalSink = null; };
    },
    agentRespondApproval: respond || vi.fn(async () => true),
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  delete window.electronAPI;
  approvalSink = null;
});

describe('AgentApprovalCard (v2 kernel confirmation protocol)', () => {
  it('renders nothing when no approval has arrived or no bridge exists', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<AgentApprovalCard />); });
    expect(container.textContent).toBe('');

    // No electronAPI (legacy worker path / tests): must not crash either.
    delete window.electronAPI;
    const { container: c2, root: r2 } = mount();
    await act(async () => { r2.render(<AgentApprovalCard />); });
    expect(c2.textContent).toBe('');
  });

  it('shows the pending action and detail, and answers the card', async () => {
    const respond = vi.fn(async () => true);
    stubBridge({ respond });
    const { container, root } = mount();
    await act(async () => { root.render(<AgentApprovalCard />); });

    await act(async () => {
      approvalSink({ id: 'appr_1', action: 'generate_image', detail: '工作流：默认\n正向：一只狐狸' });
    });
    expect(container.textContent).toContain('generate_image');
    expect(container.textContent).toContain('一只狐狸');
    expect(container.textContent).toContain('允许');

    await act(async () => {
      container.querySelector('button').click();
    });
    expect(respond).toHaveBeenCalledWith({ id: 'appr_1', approved: true, reason: '' });
    // Answered cards disappear until the next confirmation.
    expect(container.textContent).toBe('');
  });

  it('sends approved:false with a reason on decline', async () => {
    const respond = vi.fn(async () => true);
    stubBridge({ respond });
    const { container, root } = mount();
    await act(async () => { root.render(<AgentApprovalCard />); });
    await act(async () => {
      approvalSink({ id: 'appr_2', action: 'reroll', detail: 'x' });
    });
    const buttons = container.querySelectorAll('button');
    await act(async () => { buttons[1].click(); });
    expect(respond).toHaveBeenCalledWith({ id: 'appr_2', approved: false, reason: 'Declined in chat.' });
  });
});
