import { useEffect, useState } from 'react';

/**
 * Confirmation card for the v2 kernel's approval protocol (agent-v2-design P5).
 *
 * Self-contained on purpose: it subscribes directly to the `agent:approval`
 * worker event and answers over `agent:approval-response`, without touching
 * AgentContext's generation state machine. When the v2 kernel is off, no
 * `agent:approval` events arrive and this renders nothing.
 *
 * Styling is inline rather than a new cascade file — src/styles import order is
 * load-bearing (scripts/lint-theme.mjs) and this card is intentionally isolated.
 */
export default function AgentApprovalCard() {
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api?.agentOnApproval) return undefined;
    return api.agentOnApproval((data) => {
      setPending(data && data.id ? data : null);
      setBusy(false);
    });
  }, []);

  if (!pending) return null;

  const respond = async (approved) => {
    setBusy(true);
    try {
      await window.electronAPI.agentRespondApproval({
        id: pending.id,
        approved,
        reason: approved ? '' : 'Declined in chat.',
      });
    } catch {
      // The worker also denies pending approvals on stop; a failed response
      // must not wedge the card — drop it either way.
    } finally {
      setPending(null);
      setBusy(false);
    }
  };

  const card = {
    position: 'fixed',
    right: 24,
    bottom: 96,
    zIndex: 1200,
    width: 380,
    maxWidth: 'calc(100vw - 48px)',
    background: 'var(--bg-elevated, #1b2632)',
    color: 'var(--text-primary, #f1f6fb)',
    border: '1px solid var(--accent, #66b7ff)',
    borderRadius: 'var(--radius-lg, 12px)',
    boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
    padding: 14,
    fontSize: 13,
    lineHeight: 1.5,
  };
  const detail = {
    margin: '8px 0 12px',
    padding: 10,
    maxHeight: 180,
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    background: 'var(--bg-surface, #151d27)',
    borderRadius: 'var(--radius-sm, 6px)',
    fontFamily: '"Cascadia Code", Consolas, monospace',
    fontSize: 12,
    color: 'var(--text-secondary, #b7c5d3)',
  };
  const button = (primary) => ({
    flex: 1,
    padding: '7px 0',
    borderRadius: 'var(--radius-sm, 6px)',
    border: primary ? 'none' : '1px solid var(--border, #2a3644)',
    background: primary ? 'var(--accent, #66b7ff)' : 'transparent',
    color: primary ? '#0a0f15' : 'var(--text-primary, #f1f6fb)',
    fontWeight: 600,
    cursor: busy ? 'wait' : 'pointer',
  });

  return (
    <div className="agent-approval-card" style={card} role="dialog" aria-label={`操作确认：${pending.action}`}>
      <div style={{ fontWeight: 700 }}>
        需要确认 · <span style={{ color: 'var(--accent, #66b7ff)' }}>{pending.action}</span>
      </div>
      <div style={detail}>{pending.detail || '(无详情)'}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" style={button(true)} disabled={busy} onClick={() => respond(true)}>允许</button>
        <button type="button" style={button(false)} disabled={busy} onClick={() => respond(false)}>拒绝</button>
      </div>
    </div>
  );
}
