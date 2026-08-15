// Unified user-turn orchestration extracted from Agent.
// P0-5 slice 9: handleTurn() delegates each phase (begin/session/confirm/
// intent-routing/dispatch/timing-close) to turn-ops.mjs; calls remain on the
// Agent instance so overrides and lifecycle behavior persist.
import { beginTurn, switchTurnSession, confirmTurn, routeTurnIntent, dispatchTurnDecision, endTurnTiming } from './turn-ops.mjs';
import { timingOutcome } from './prepare-ops.mjs';

export async function handleTurn(agent, input = {}) {
  const opened = beginTurn(agent, input);
  if (!opened) return { turnId: agent._newTurnId(), action: 'reply', response: '' };
  const turnState = { outcome: 'completed' };
  try {
    const { modeHint, options } = await switchTurnSession(agent, input, opened);
    const sessionState = agent.sessionManager.getSessionState?.() || {};
    const confirmed = await confirmTurn(agent, { input, text: opened.text, turnId: opened.turnId, sessionState, modeHint });
    if (confirmed) return confirmed;
    const decision = await routeTurnIntent(agent, { input, text: opened.text, options, modeHint, turnId: opened.turnId, timingMeta: opened.timingMeta });
    return await dispatchTurnDecision(agent, { text: opened.text, options, decision, turnId: opened.turnId, modeHint, turnState });
  } catch (error) {
    turnState.outcome = timingOutcome(error);
    throw error;
  } finally {
    endTurnTiming(agent, { timingMeta: opened.timingMeta, turnStart: opened.turnStart, outcome: turnState.outcome });
  }
}
