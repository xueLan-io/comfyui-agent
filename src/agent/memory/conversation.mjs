const DEFAULT_RECENT_MESSAGES = 8;

export function createSessionMemory(input = {}) {
  return {
    activeGoal: input.activeGoal || '',
    subject: input.subject || '',
    style: input.style || '',
    confirmedConstraints: input.confirmedConstraints || {},
    pendingIntent: input.pendingIntent || null,
    pendingQuestion: input.pendingQuestion || '',
    currentArtifactId: input.currentArtifactId || '',
    currentPromptVersion: Number(input.currentPromptVersion) || 0,
    generationHistory: Array.isArray(input.generationHistory) ? input.generationHistory : [],
    currentWorkflow: input.currentWorkflow || '',
    lastParameters: input.lastParameters || {},
    unresolvedItems: Array.isArray(input.unresolvedItems) ? input.unresolvedItems : [],
  };
}

export class SessionMemory {
  constructor(input = {}, onChange = null) {
    this.onChange = onChange;
    this.current = createSessionMemory(input);
  }

  update(patch = {}) {
    this.current = createSessionMemory({ ...this.current, ...patch });
    this.onChange?.();
    return this.current;
  }

  get(field) {
    return this.current[field];
  }

  toJSON() {
    return createSessionMemory(this.current);
  }
}

export class ConversationMemory {
  constructor(maxMessages = 100, onChange = null) {
    this.messages = [];
    this.maxMessages = maxMessages;
    this.onChange = onChange;
  }

  add(role, content, metadata = {}) {
    this.messages.push({ role, content, ...metadata, ts: Date.now() });
    if (this.messages.length > this.maxMessages) {
      this.messages.splice(0, this.messages.length - this.maxMessages);
    }
    this.onChange?.();
  }

  updateById(messageId, content, metadata = {}) {
    const index = this.messages.findIndex(message => message.messageId === messageId);
    if (index < 0) return false;
    this.messages[index] = { ...this.messages[index], ...metadata, content, ts: Date.now() };
    this.onChange?.();
    return true;
  }

  removeByTurnId(turnId) {
    if (!turnId) return 0;
    const previousLength = this.messages.length;
    this.messages = this.messages.filter(message => message.turnId !== turnId);
    const removed = previousLength - this.messages.length;
    if (removed > 0) this.onChange?.();
    return removed;
  }

  getMessages(options = {}) {
    const { since, limit } = options;
    let msgs = this.messages;
    if (since) msgs = msgs.filter(m => m.ts > since);
    if (limit) msgs = msgs.slice(-limit);
    return msgs;
  }

  getLLMMessages() {
    return this.messages.map(m => ({
      role: m.role === 'agent' ? 'assistant' : m.role,
      content: m.content,
    }));
  }

  getCompressedLLMMessages(options = {}) {
    const recentCount = options.recentCount || DEFAULT_RECENT_MESSAGES;
    return this.getLLMMessages().slice(-recentCount);
  }

  clear() {
    this.messages = [];
    this.onChange?.();
  }

  rewind(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.messages.length) return false;
    this.messages = this.messages.slice(0, index);
    this.onChange?.();
    return true;
  }

  loadFrom(messages) {
    this.messages = Array.isArray(messages) ? messages : [];
  }

  toJSON() {
    return this.messages;
  }

  get length() {
    return this.messages.length;
  }
}
