import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import AgentStageStrip from '../../src/components/AgentStageStrip.jsx';

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, root: createRoot(container) };
}

afterEach(() => { document.body.innerHTML = ''; });

describe('AgentStageStrip', () => {
  it('marks completed, current, and pending stages', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<AgentStageStrip status="observing" />); });
    const items = [...container.querySelectorAll('li')];
    expect(items).toHaveLength(5);
    expect(items.map(item => item.className)).toEqual(['done', 'done', 'done', 'current', 'pending']);
  });

  it('marks completion as the current terminal stage', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<AgentStageStrip status="completed" />); });
    expect([...container.querySelectorAll('li')].map(item => item.className)).toEqual(['done', 'done', 'done', 'done', 'current']);
  });

  it('does not render non-execution statuses', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<AgentStageStrip status="awaiting_confirmation" />); });
    expect(container.innerHTML).toBe('');
  });
});
