class TurnGateStore {
  constructor() {
    this.scopeByThreadId = new Map();
    this.pendingScopeKeys = new Set();
  }

  begin(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey) {
      return "";
    }
    this.pendingScopeKeys.add(scopeKey);
    return scopeKey;
  }

  attachThread(scopeKey, threadId) {
    const normalizedScopeKey = normalizeText(scopeKey);
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedScopeKey || !normalizedThreadId || !this.pendingScopeKeys.has(normalizedScopeKey)) {
      return false;
    }
    this.scopeByThreadId.set(normalizedThreadId, normalizedScopeKey);
    return true;
  }

  releaseScope(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey) {
      return { released: false, scopeKey: "" };
    }
    const released = this.pendingScopeKeys.delete(scopeKey);
    for (const [threadId, mappedScopeKey] of this.scopeByThreadId.entries()) {
      if (mappedScopeKey === scopeKey) {
        this.scopeByThreadId.delete(threadId);
      }
    }
    return { released, scopeKey };
  }

  releaseThread(threadId) {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId) {
      return { released: false, scopeKey: "" };
    }
    const scopeKey = this.scopeByThreadId.get(normalizedThreadId) || "";
    let released = false;
    if (scopeKey) {
      released = this.pendingScopeKeys.delete(scopeKey);
      this.scopeByThreadId.delete(normalizedThreadId);
    }
    return { released, scopeKey };
  }

  isPending(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    return scopeKey ? this.pendingScopeKeys.has(scopeKey) : false;
  }
}

function buildTurnScopeKey(bindingKey, workspaceRoot) {
  const normalizedBindingKey = normalizeText(bindingKey);
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  if (!normalizedBindingKey || !normalizedWorkspaceRoot) {
    return "";
  }
  return `${normalizedBindingKey}::${normalizedWorkspaceRoot}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { TurnGateStore };
