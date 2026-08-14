// Session/project management subsystem, extracted from agent.mjs.
// Functions operate on the agent (runtime) and are behavior-preserving moves:
// the Agent methods delegate here one line each.

import { initSession } from '../events/agent-events.mjs';

export async function useSession(agent, projectId, sessionId) {
  if (projectId === agent.sessionManager.activeProjectId && sessionId === agent.sessionManager.activeSessionId) {
    return agent.sessionManager.getState();
  }
  agent._assertSessionSwitchAllowed();
  const state = await agent.sessionManager.activate(projectId, sessionId);
  agent._resetRuntimeState();
  agent._preparedRuns.clear();
  initSession(state.activeProjectId, state.activeSessionId);
  return state;
}

export async function createProject(agent, input) {
  agent._assertSessionSwitchAllowed();
  await agent.sessionManager.createProject(input);
  agent._resetRuntimeState();
  agent._preparedRuns.clear();
  initSession(agent.sessionManager.activeProjectId, agent.sessionManager.activeSessionId);
  return agent.sessionManager.getState();
}

export async function createSession(agent, title, projectId, { activate = true } = {}) {
  if (activate) agent._assertSessionSwitchAllowed();
  await agent.sessionManager.createSession(title, projectId, { activate });
  if (activate) {
    agent._resetRuntimeState();
    agent._preparedRuns.clear();
    initSession(agent.sessionManager.activeProjectId, agent.sessionManager.activeSessionId);
  }
  return agent.sessionManager.getState();
}

export async function suggestSessionTitle(agent, message) {
  const text = String(message || '').trim().slice(0, 200);
  if (!text) return { title: '新会话' };
  // Session titles must not compete with a user-visible chat request for the
  // same model connection. A stable local title is sufficient metadata.
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return { title: cleaned.slice(0, 12) || '新会话' };
}

export async function deleteProject(agent, projectId) {
  const active = projectId === agent.sessionManager.activeProjectId;
  if (active) agent._assertSessionSwitchAllowed();
  const state = await agent.sessionManager.deleteProject(projectId);
  if (active) {
    agent._resetRuntimeState();
    agent._preparedRuns.clear();
    initSession(state.activeProjectId, state.activeSessionId);
  }
  return state;
}

export async function deleteSession(agent, sessionId, projectId = agent.sessionManager.activeProjectId) {
  const active = projectId === agent.sessionManager.activeProjectId && sessionId === agent.sessionManager.activeSessionId;
  if (active) agent._assertSessionSwitchAllowed();
  const state = await agent.sessionManager.deleteSession(sessionId, projectId);
  if (active) {
    agent._resetRuntimeState();
    agent._preparedRuns.clear();
    initSession(state.activeProjectId, state.activeSessionId);
  }
  return state;
}
