// Conversation archive & compaction subsystem, extracted from agent.mjs.
//
// These functions operate on the agent (runtime) and its collaborators: the
// LLM provider, conversation/session stores, optional long-term memory, and
// token estimation. They are behavior-preserving moves: the Agent methods that
// used to contain this logic now delegate here.

import { estimateTokens } from '../optimizer/prompt-guard.mjs';

const COMPACT_SYSTEM_PROMPT = '将对话压缩成 JSON。只保留明确事实、用户约束、已确认决定、已完成事项和未解决事项。不要推测，不要改变数字、文件路径或用户意图。JSON 格式必须是：{"objective":"","decisions":[],"constraints":[],"completed":[],"openItems":[],"facts":[]}。数组只放字符串。';

export function contextArchiveOf(agent) {
  const archive = agent.sessionManager.getSessionState?.()?.contextArchive;
  return archive && Array.isArray(archive.segments) ? archive : { version: 1, segments: [], archivedMessageIds: [] };
}

export function archivePrompt(agent, messages = []) {
  return messages.map(message => {
    const role = message.role === 'agent' ? 'assistant' : message.role;
    return `${role}: ${String(message.content || '').slice(0, 4000)}`;
  }).join('\n');
}

export async function compactConversationSegment(agent, messages, mode = 'cloud', signal) {
  if (!messages.length) return null;
  const fallback = {
    objective: '',
    decisions: [],
    constraints: [],
    completed: [],
    openItems: [],
    facts: [],
  };
  try {
    const result = await agent.llm.chat({
      messages: [
        { role: 'system', content: COMPACT_SYSTEM_PROMPT },
        { role: 'user', content: archivePrompt(agent, messages) },
      ],
      maxTokens: mode === 'local' ? 512 : 700,
      prefer: mode,
      allowPolicyOverride: false,
      signal,
    });
    const text = String(result?.content || '').replace(/^```(?:json|JSON)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(text);
    return {
      ...fallback,
      ...parsed,
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.filter(Boolean).slice(0, 12) : [],
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints.filter(Boolean).slice(0, 12) : [],
      completed: Array.isArray(parsed.completed) ? parsed.completed.filter(Boolean).slice(0, 12) : [],
      openItems: Array.isArray(parsed.openItems) ? parsed.openItems.filter(Boolean).slice(0, 12) : [],
      facts: Array.isArray(parsed.facts) ? parsed.facts.filter(Boolean).slice(0, 16) : [],
    };
  } catch {
    const lines = messages.map(message => String(message.content || '').trim()).filter(Boolean);
    return { ...fallback, facts: lines.slice(-8).map(line => line.slice(0, 280)) };
  }
}

export async function prepareConversationArchive(agent, { recentCount, mode, inputBudget, currentMessages, signal }) {
  const archive = contextArchiveOf(agent);
  const archivedIds = new Set(archive.archivedMessageIds || []);
  const candidate = agent.conversation.getArchiveCandidate(recentCount, 100)
    .filter(message => !archivedIds.has(message.messageId || `${message.ts}:${message.role}`))
    .slice(0, 12);
  const currentTokens = currentMessages.reduce((total, message) => total + estimateTokens(String(message.content || '')), 0);
  if (candidate.length < 4 || currentTokens <= inputBudget) return archive;
  const ids = candidate.map(message => message.messageId || `${message.ts}:${message.role}`);
  if (ids.every(id => archive.archivedMessageIds.includes(id))) return archive;
  const summary = await compactConversationSegment(agent, candidate, mode, signal);
  if (!summary) return archive;
  const segment = {
    id: `segment_${Date.now()}`,
    sourceMessageIds: ids,
    createdAt: Date.now(),
    modelMode: mode,
    tokenEstimate: estimateTokens(JSON.stringify(summary)),
    summary,
  };
  const next = {
    version: 1,
    segments: [...archive.segments, segment].slice(-12),
    archivedMessageIds: [...new Set([...archive.archivedMessageIds, ...ids])].slice(-200),
  };
  agent.sessionManager.setSessionState?.({ contextArchive: next });
  // Best-effort distillation into cross-session memory: the compacted summary
  // feeds the project profile and a deduped memory segment. Failures must not
  // affect the conversation archive itself.
  if (agent.memory?.captureSession) {
    try {
      await agent.memory.captureSession(agent.sessionManager.activeProjectId || agent.projectId, {
        summary: segment.summary,
        sourceTurnId: agent._traceId || agent._requestId || '',
        workflowName: agent.project.get('workflow') || '',
      });
    } catch {
      // memory capture is best-effort
    }
  }
  return next;
}

// 回复完成后空闲期预压缩会话：把下一次回答前的一次完整 LLM 压缩调用
// 提前到用户阅读回复的间隙执行。新消息到达时由 handleTurn 取消，不抢锁。
export async function prefetchContextArchive(agent) {
  if (agent._running || !agent.llm?.isConfigured) return;
  agent._archivePrefetchSignal?.abort('superseded');
  const controller = new AbortController();
  agent._archivePrefetchSignal = controller;
  try {
    const profile = agent.llm.getContextProfile?.() || { mode: 'cloud', maxRecentTurns: 20, maxInputTokens: 32768 };
    const messages = agent.conversation.getMessages?.({ limit: 100 }) || [];
    await prepareConversationArchive(agent, {
      recentCount: profile.maxRecentTurns || 20,
      mode: profile.mode,
      inputBudget: profile.maxInputTokens,
      currentMessages: messages,
      signal: controller.signal,
    });
  } catch {
    // 预取失败（模型不可用、已取消）静默，不影响主流程
  }
}

export async function compactConversation(agent, { recentCount = 8, mode = 'cloud' } = {}) {
  const messages = agent.conversation.toJSON();
  const archive = await prepareConversationArchive(agent, {
    recentCount: Math.max(2, Number(recentCount) || 8),
    mode,
    inputBudget: 0,
    currentMessages: messages,
  });
  return { archived: archive.segments?.length || 0, archive };
}

// Recall cross-session memory for system-prompt injection. Returns '' when
// no memory is configured, the project has nothing stored, or recall fails.
export async function memoryContext(agent, query = '') {
  if (!agent.memory?.recall) return '';
  try {
    return await agent.memory.recall(agent.sessionManager.activeProjectId || agent.projectId, {
      query: String(query || '').slice(0, 200),
    });
  } catch {
    return '';
  }
}

export function archiveMessage(agent, archive) {
  if (!archive?.segments?.length) return null;
  const summaries = archive.segments.map((segment, index) => ({
    segment: index + 1,
    ...segment.summary,
  }));
  return {
    role: 'system',
    content: `归档上下文（只把其中明确事实当作历史记录，不要把推测当成事实）：\n${JSON.stringify(summaries)}`,
  };
}
