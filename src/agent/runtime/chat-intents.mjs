// Chat-side intent heuristics shared by the Agent runtime.
//
// Extracted from agent.mjs so the confirm/query/identity heuristics can be
// unit-tested in isolation and reused without pulling in the whole Agent.

export const TURN_CONFIRM = /^(?:confirm|yes|run|go|确认|确定|执行|开始)(?:执行|生成)?[.。!！]?$/i;

export const LOCAL_QUERY = /(参数|节点|工作流|队列|显存|设备|模型列表|采样器|调度器|step|seed|cfg|denoise|功能|命令|usage)/i;

export const CHAT_CONTEXT_HINTS = /(当前|实际|参数|提示词|prompt|工作流|节点|队列|显存|设备|模型|采样器|调度器|seed|cfg|steps?|denoise)/i;

export const IDENTITY_QUERY = /(你是谁|你是啥|你是哪位|你叫什么|你是什么|你是干什么的|你是干嘛的|你是什么模型|你用的?什么模型|你是什么ai|你有什么能力|你会什么|你能做什么|who are you|what are you|what model|what can you do)/i;

export function isConfirmTurn(text) {
  return TURN_CONFIRM.test(text);
}

export function messageAttachments(media = {}) {
  // 默认参数只兜 undefined；前端聊天请求会显式传 media: null。
  const source = media && typeof media === 'object' ? media : {};
  return [
    ...(source.images || []).map(item => ({ name: item?.name || item?.path?.split(/[\\/]/).pop() || '', kind: 'image' })),
    ...(source.videos || []).map(item => ({ name: item?.name || item?.path?.split(/[\\/]/).pop() || '', kind: 'video' })),
  ].filter(item => item.name);
}

export function needsWorkflowChatContext(message, intent) {
  return ['query', 'prompt_edit', 'refine'].includes(intent) || CHAT_CONTEXT_HINTS.test(message);
}

export function wantsWebResearch(message, intent) {
  if (['query', 'workflow_query', 'runtime_query', 'prompt_edit', 'cancel'].includes(intent)) return false;
  const text = String(message || '').trim();
  if (!text) return false;
  if (/https?:\/\//i.test(text)) return true;
  if (LOCAL_QUERY.test(text)) return false;
  return /(搜索|搜一下|搜下|查一下|查查|查资料|查详情|上网|网上|网查|官方资料|设定资料|背景资料|百科|资料库|look\s*up|search|research|who is|what is)/i.test(text);
}
