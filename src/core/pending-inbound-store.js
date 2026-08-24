const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const STORE_VERSION = 5;
const DEFAULT_MAX_MESSAGES = 2_000;
const DEFAULT_COMPLETED_RETENTION_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_COMPLETED = 4_000;
const DISPATCH_RETRY_BASE_MS = 15_000;
const DISPATCH_RETRY_MAX_MS = 15 * 60_000;
const ACKNOWLEDGEMENT_STATUSES = new Set(["", "sending", "sent", "failed"]);

class PendingInboundStore {
  constructor({
    filePath,
    maxMessages = DEFAULT_MAX_MESSAGES,
    completedRetentionMs = DEFAULT_COMPLETED_RETENTION_MS,
    maxCompleted = DEFAULT_MAX_COMPLETED,
    now = () => Date.now(),
  } = {}) {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new Error("pending inbound filePath is required");
    }
    this.filePath = path.resolve(filePath);
    this.maxMessages = normalizePositiveInteger(maxMessages, DEFAULT_MAX_MESSAGES);
    this.completedRetentionMs = normalizePositiveInteger(completedRetentionMs, DEFAULT_COMPLETED_RETENTION_MS);
    this.maxCompleted = normalizePositiveInteger(maxCompleted, DEFAULT_MAX_COMPLETED);
    this.now = typeof now === "function" ? now : () => Date.now();
    this.state = emptyState();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      this.state = emptyState();
      return this.state;
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      this.recoverCorruptFile();
      this.state = emptyState();
      this.save();
      return this.state;
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.scopes)) {
      this.recoverCorruptFile();
      this.state = emptyState();
      this.save();
      return this.state;
    }
    const scopes = parsed.scopes.map(normalizeScope).filter(Boolean).sort(compareScopes);
    const sharedScopes = (Array.isArray(parsed.sharedScopes) ? parsed.sharedScopes : [])
      .map(normalizeSharedScope)
      .filter(Boolean)
      .sort(compareScopes);
    const completed = pruneCompleted(
      (Array.isArray(parsed.completed) ? parsed.completed : []).map(normalizeCompleted).filter(Boolean),
      {
        nowMs: this.currentTimeMs(),
        retentionMs: this.completedRetentionMs,
        maxCompleted: this.maxCompleted,
      }
    );
    this.state = { version: STORE_VERSION, scopes, sharedScopes, completed };
    if (parsed.version !== STORE_VERSION
      || scopes.length !== parsed.scopes.length
      || !Array.isArray(parsed.sharedScopes)
      || sharedScopes.length !== (Array.isArray(parsed.sharedScopes) ? parsed.sharedScopes.length : 0)
      || completed.length !== (Array.isArray(parsed.completed) ? parsed.completed.length : 0)) {
      this.save();
    }
    return this.state;
  }

  save() {
    this.state.completed = pruneCompleted(this.state.completed, {
      nowMs: this.currentTimeMs(),
      retentionMs: this.completedRetentionMs,
      maxCompleted: this.maxCompleted,
    });
    atomicWriteJson(this.filePath, this.state);
  }

  snapshotMap() {
    this.load();
    return new Map(this.state.scopes.map((scope) => [scope.scopeKey, cloneScope(scope)]));
  }

  snapshotSharedMap() {
    this.load();
    return new Map(this.state.sharedScopes.map((scope) => [scope.scopeKey, cloneScope(scope)]));
  }

  getScope(scopeKey) {
    this.load();
    const normalizedScopeKey = normalizeText(scopeKey);
    const scope = this.state.scopes.find((item) => item.scopeKey === normalizedScopeKey);
    return scope ? cloneScope(scope) : null;
  }

  isCompleted(scopeKey, pendingId) {
    this.load();
    const normalizedScopeKey = normalizeText(scopeKey);
    const normalizedPendingId = normalizeText(pendingId);
    return Boolean(normalizedScopeKey && normalizedPendingId && this.state.completed.some((item) => (
      item.scopeKey === normalizedScopeKey && item.pendingId === normalizedPendingId
    )));
  }

  enqueue({ bindingKey, workspaceRoot, message } = {}) {
    this.load();
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    const normalizedMessage = normalizeMessage(message, { scopeKey, nowMs: this.currentTimeMs() });
    if (!scopeKey || !normalizedMessage) {
      throw new Error("invalid pending inbound message");
    }
    let scope = this.state.scopes.find((item) => item.scopeKey === scopeKey);
    if (!scope) {
      scope = {
        scopeKey,
        bindingKey: normalizeText(bindingKey),
        workspaceRoot: normalizeText(workspaceRoot),
        messages: [],
        dispatchAttemptCount: 0,
        nextDispatchAt: "",
        lastDispatchError: "",
      };
      this.state.scopes.push(scope);
    }
    const existing = scope.messages.find((item) => item.pendingId === normalizedMessage.pendingId);
    if (existing) {
      return { added: false, scopeKey, message: cloneMessage(existing), draft: cloneScope(scope) };
    }
    const sharedHandoffScopeKey = normalizeText(message?.sharedHandoffScopeKey);
    const replacesSharedContent = Boolean(
      sharedHandoffScopeKey
      && this.state.sharedScopes.some((item) => item.scopeKey === sharedHandoffScopeKey)
    );
    if (countMessages(this.state.scopes) + countMessages(this.state.sharedScopes) >= this.maxMessages
      && !replacesSharedContent) {
      throw new Error(`pending inbound queue limit reached (${this.maxMessages})`);
    }
    scope.messages.push(normalizedMessage);
    scope.messages.sort(compareMessages);
    this.state.scopes.sort(compareScopes);
    this.save();
    return { added: true, scopeKey, message: cloneMessage(normalizedMessage), draft: cloneScope(scope) };
  }

  enqueueSharedContent({ bindingKey, workspaceRoot, chatId, message, lastContentAtMs = 0 } = {}) {
    this.load();
    const scopeKey = buildSharedScopeKey(bindingKey, workspaceRoot, chatId);
    const normalizedMessage = normalizeMessage(message, { scopeKey, nowMs: this.currentTimeMs() });
    if (!scopeKey || !normalizedMessage) {
      throw new Error("invalid pending shared-content message");
    }
    let scope = this.state.sharedScopes.find((item) => item.scopeKey === scopeKey);
    if (!scope) {
      scope = {
        scopeKey,
        bindingKey: normalizeText(bindingKey),
        workspaceRoot: normalizeText(workspaceRoot),
        chatId: normalizeText(chatId),
        messages: [],
        lastContentAtMs: 0,
        activePromptId: "",
        promptAcknowledged: false,
      };
      this.state.sharedScopes.push(scope);
    }
    const existing = scope.messages.find((item) => item.pendingId === normalizedMessage.pendingId);
    if (existing) {
      return { added: false, scopeKey, message: cloneMessage(existing), draft: cloneScope(scope) };
    }
    if (countMessages(this.state.scopes) + countMessages(this.state.sharedScopes) >= this.maxMessages) {
      throw new Error(`pending inbound queue limit reached (${this.maxMessages})`);
    }
    scope.messages.push(normalizedMessage);
    scope.messages.sort(compareMessages);
    scope.lastContentAtMs = Math.max(
      normalizeTimeMs(scope.lastContentAtMs),
      normalizeTimeMs(lastContentAtMs)
        || Date.parse(normalizedMessage.receivedAt)
        || this.currentTimeMs()
    );
    this.state.sharedScopes.sort(compareScopes);
    this.save();
    return { added: true, scopeKey, message: cloneMessage(normalizedMessage), draft: cloneScope(scope) };
  }

  removeSharedScope(scopeKey) {
    this.load();
    const normalizedScopeKey = normalizeText(scopeKey);
    const next = this.state.sharedScopes.filter((item) => item.scopeKey !== normalizedScopeKey);
    if (next.length === this.state.sharedScopes.length) {
      return false;
    }
    this.state.sharedScopes = next;
    this.save();
    return true;
  }

  commitSharedContent(scopeKey, consumedIds, {
    remainingMessages = [],
    activePromptId = "",
    promptAcknowledged = false,
    completeSourcePendingId = "",
  } = {}) {
    this.load();
    const normalizedScopeKey = normalizeText(scopeKey);
    const index = this.state.sharedScopes.findIndex((item) => item.scopeKey === normalizedScopeKey);
    const consumed = new Set(
      (Array.isArray(consumedIds) ? consumedIds : []).map(normalizeText).filter(Boolean)
    );
    if (index < 0 || !consumed.size) {
      return index >= 0 ? cloneScope(this.state.sharedScopes[index]) : null;
    }
    const scope = this.state.sharedScopes[index];
    const normalizedActivePromptId = normalizeText(activePromptId);
    const normalizedCompletedSource = normalizeText(completeSourcePendingId);
    if (normalizedCompletedSource) {
      const completedScopeKey = buildScopeKey(scope.bindingKey, scope.workspaceRoot);
      const completedAt = new Date(this.currentTimeMs()).toISOString();
      const existingCompleted = this.state.completed.find((item) => (
        item.scopeKey === completedScopeKey && item.pendingId === normalizedCompletedSource
      ));
      if (existingCompleted) {
        existingCompleted.completedAt = completedAt;
      } else {
        this.state.completed.push({
          scopeKey: completedScopeKey,
          pendingId: normalizedCompletedSource,
          completedAt,
        });
      }
      scope.activePromptId = "";
      scope.promptAcknowledged = false;
    } else if (normalizedActivePromptId) {
      scope.activePromptId = normalizedActivePromptId;
      scope.promptAcknowledged = Boolean(promptAcknowledged);
    }
    const retained = scope.messages.filter((message) => !consumed.has(message.pendingId));
    const retainedIds = new Set(retained.map((message) => message.pendingId));
    for (const raw of Array.isArray(remainingMessages) ? remainingMessages : []) {
      const replacement = normalizeMessage(raw, { scopeKey: normalizedScopeKey, nowMs: this.currentTimeMs() });
      if (!replacement || !consumed.has(replacement.pendingId) || retainedIds.has(replacement.pendingId)) {
        continue;
      }
      retained.push(replacement);
      retainedIds.add(replacement.pendingId);
    }
    if (!retained.length) {
      this.state.sharedScopes.splice(index, 1);
      this.save();
      return null;
    }
    scope.messages = retained.sort(compareMessages);
    scope.lastContentAtMs = Date.parse(scope.messages[scope.messages.length - 1].receivedAt);
    this.save();
    return cloneScope(scope);
  }

  claimAcknowledgement(scopeKey, pendingId) {
    this.load();
    const message = this.findMessage(scopeKey, pendingId);
    if (!message || message.acknowledgementStatus) {
      return false;
    }
    message.acknowledgementStatus = "sending";
    message.acknowledgementAt = new Date(this.currentTimeMs()).toISOString();
    this.save();
    return true;
  }

  completeAcknowledgement(scopeKey, pendingId, { success = false } = {}) {
    this.load();
    const message = this.findMessage(scopeKey, pendingId);
    if (!message) {
      return null;
    }
    message.acknowledgementStatus = success ? "sent" : "failed";
    message.acknowledgementAt = new Date(this.currentTimeMs()).toISOString();
    this.save();
    return cloneMessage(message);
  }

  commitDispatch(scopeKey, consumedIds, { remainingMessages = [] } = {}) {
    this.load();
    const normalizedScopeKey = normalizeText(scopeKey);
    const index = this.state.scopes.findIndex((item) => item.scopeKey === normalizedScopeKey);
    const consumed = new Set(
      (Array.isArray(consumedIds) ? consumedIds : []).map(normalizeText).filter(Boolean)
    );
    if (!consumed.size) {
      return index >= 0 ? cloneScope(this.state.scopes[index]) : null;
    }
    const completedAt = new Date(this.currentTimeMs()).toISOString();
    for (const pendingId of consumed) {
      const existing = this.state.completed.find((item) => (
        item.scopeKey === normalizedScopeKey && item.pendingId === pendingId
      ));
      if (existing) {
        existing.completedAt = completedAt;
      } else {
        this.state.completed.push({ scopeKey: normalizedScopeKey, pendingId, completedAt });
      }
    }
    if (index < 0) {
      this.save();
      return null;
    }
    const scope = this.state.scopes[index];
    const retained = scope.messages.filter((message) => !consumed.has(message.pendingId));
    const retainedIds = new Set(retained.map((message) => message.pendingId));
    for (const raw of Array.isArray(remainingMessages) ? remainingMessages : []) {
      const replacement = normalizeMessage(raw, { scopeKey: normalizedScopeKey, nowMs: this.currentTimeMs() });
      if (!replacement || !consumed.has(replacement.pendingId) || retainedIds.has(replacement.pendingId)) {
        continue;
      }
      retained.push(replacement);
      retainedIds.add(replacement.pendingId);
    }
    if (!retained.length) {
      this.state.scopes.splice(index, 1);
      this.save();
      return null;
    }
    scope.messages = retained.sort(compareMessages);
    scope.dispatchAttemptCount = 0;
    scope.nextDispatchAt = "";
    scope.lastDispatchError = "";
    this.save();
    return cloneScope(scope);
  }

  recordDispatchFailure(scopeKey, { error = "" } = {}) {
    this.load();
    const normalizedScopeKey = normalizeText(scopeKey);
    const scope = this.state.scopes.find((item) => item.scopeKey === normalizedScopeKey);
    if (!scope) {
      return null;
    }
    scope.dispatchAttemptCount = Math.min(16, normalizeNonNegativeInteger(scope.dispatchAttemptCount) + 1);
    const delayMs = Math.min(
      DISPATCH_RETRY_MAX_MS,
      DISPATCH_RETRY_BASE_MS * (2 ** Math.min(6, scope.dispatchAttemptCount - 1))
    );
    scope.nextDispatchAt = new Date(this.currentTimeMs() + delayMs).toISOString();
    scope.lastDispatchError = stringValue(error).slice(0, 500);
    this.save();
    return cloneScope(scope);
  }

  removeMessages(scopeKey, consumedIds, options = {}) {
    return this.commitDispatch(scopeKey, consumedIds, options);
  }

  removeScope(scopeKey) {
    this.load();
    const normalizedScopeKey = normalizeText(scopeKey);
    const next = this.state.scopes.filter((item) => item.scopeKey !== normalizedScopeKey);
    if (next.length === this.state.scopes.length) {
      return false;
    }
    this.state.scopes = next;
    this.save();
    return true;
  }

  findMessage(scopeKey, pendingId) {
    const normalizedScopeKey = normalizeText(scopeKey);
    const normalizedPendingId = normalizeText(pendingId);
    if (!normalizedScopeKey || !normalizedPendingId) {
      return null;
    }
    const scope = this.state.scopes.find((item) => item.scopeKey === normalizedScopeKey);
    return scope?.messages.find((item) => item.pendingId === normalizedPendingId) || null;
  }

  recoverCorruptFile() {
    const backupPath = `${this.filePath}.corrupt-${this.currentTimeMs()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
    try { fs.renameSync(this.filePath, backupPath); } catch {}
  }

  currentTimeMs() {
    const value = Number(this.now());
    return Number.isFinite(value) ? value : Date.now();
  }
}

function normalizeScope(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const bindingKey = normalizeText(raw.bindingKey);
  const workspaceRoot = normalizeText(raw.workspaceRoot);
  const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
  if (!scopeKey || (normalizeText(raw.scopeKey) && normalizeText(raw.scopeKey) !== scopeKey)) {
    return null;
  }
  const seen = new Set();
  const messages = (Array.isArray(raw.messages) ? raw.messages : [])
    .map((message) => normalizeMessage(message, { scopeKey }))
    .filter((message) => {
      if (!message || seen.has(message.pendingId)) {
        return false;
      }
      seen.add(message.pendingId);
      return true;
    })
    .sort(compareMessages);
  return messages.length ? {
    scopeKey,
    bindingKey,
    workspaceRoot,
    messages,
    dispatchAttemptCount: normalizeNonNegativeInteger(raw.dispatchAttemptCount),
    nextDispatchAt: normalizeIsoTime(raw.nextDispatchAt),
    lastDispatchError: stringValue(raw.lastDispatchError).slice(0, 500),
  } : null;
}

function normalizeSharedScope(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const bindingKey = normalizeText(raw.bindingKey);
  const workspaceRoot = normalizeText(raw.workspaceRoot);
  const chatId = normalizeText(raw.chatId);
  const scopeKey = buildSharedScopeKey(bindingKey, workspaceRoot, chatId);
  if (!scopeKey || (normalizeText(raw.scopeKey) && normalizeText(raw.scopeKey) !== scopeKey)) {
    return null;
  }
  const seen = new Set();
  const messages = (Array.isArray(raw.messages) ? raw.messages : [])
    .map((message) => normalizeMessage(message, { scopeKey }))
    .filter((message) => {
      if (!message || seen.has(message.pendingId)) {
        return false;
      }
      seen.add(message.pendingId);
      return true;
    })
    .sort(compareMessages);
  if (!messages.length) {
    return null;
  }
    return {
    scopeKey,
    bindingKey,
    workspaceRoot,
    chatId,
    messages,
    lastContentAtMs: normalizeTimeMs(raw.lastContentAtMs)
      || Date.parse(messages[messages.length - 1].receivedAt),
    activePromptId: normalizeText(raw.activePromptId),
    promptAcknowledged: raw.promptAcknowledged === true,
  };
}

function normalizeMessage(raw, { scopeKey = "", nowMs = Date.now() } = {}) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const workspaceId = normalizeText(raw.workspaceId);
  const accountId = normalizeText(raw.accountId);
  const senderId = normalizeText(raw.senderId);
  const messageId = normalizeText(raw.messageId);
  const provider = normalizeText(raw.provider);
  const text = stringValue(raw.text);
  const originalText = stringValue(raw.originalText);
  const receivedAt = normalizeIsoTime(raw.receivedAt) || new Date(nowMs).toISOString();
  const pendingId = normalizeText(raw.pendingId) || messageId || buildFallbackPendingId({
    scopeKey,
    senderId,
    provider,
    text,
    receivedAt,
  });
  const quotedContexts = cloneSerializableArray(raw.quotedContexts);
  const attachments = cloneSerializableArray(raw.attachments);
  const attachmentFailures = cloneSerializableArray(raw.attachmentFailures);
  if (!pendingId || !senderId || !provider || quotedContexts === null || attachments === null || attachmentFailures === null) {
    return null;
  }
  const acknowledgementStatus = normalizeText(raw.acknowledgementStatus);
  return {
    pendingId,
    workspaceId,
    accountId,
    senderId,
    chatId: normalizeText(raw.chatId),
    messageId,
    contextToken: normalizeText(raw.contextToken),
    provider,
    deliveryPolicy: normalizeText(raw.deliveryPolicy),
    originalText,
    text,
    quotedContexts,
    attachments,
    attachmentFailures,
    receivedAt,
    contentKind: normalizeText(raw.contentKind),
    contentTitle: normalizeText(raw.contentTitle),
    contentText: stringValue(raw.contentText),
    contentUrl: normalizeText(raw.contentUrl),
    sharedContent: Boolean(raw.sharedContent),
    explicitPrompt: Boolean(raw.explicitPrompt),
    sharedHandoffScopeKey: normalizeText(raw.sharedHandoffScopeKey),
    acknowledgementStatus: ACKNOWLEDGEMENT_STATUSES.has(acknowledgementStatus) ? acknowledgementStatus : "",
    acknowledgementAt: normalizeIsoTime(raw.acknowledgementAt),
  };
}

function buildFallbackPendingId({ scopeKey, senderId, provider, text, receivedAt }) {
  const material = JSON.stringify([scopeKey, senderId, provider, text, receivedAt]);
  return `sha256:${crypto.createHash("sha256").update(material, "utf8").digest("hex")}`;
}

function buildScopeKey(bindingKey, workspaceRoot) {
  const left = normalizeText(bindingKey);
  const right = normalizeText(workspaceRoot);
  return left && right ? `${left}::${right}` : "";
}

function buildSharedScopeKey(bindingKey, workspaceRoot, chatId) {
  const base = buildScopeKey(bindingKey, workspaceRoot);
  const normalizedChatId = normalizeText(chatId);
  return base && normalizedChatId ? `${base}::${normalizedChatId}` : "";
}

function compareScopes(left, right) {
  return left.scopeKey.localeCompare(right.scopeKey);
}

function compareMessages(left, right) {
  const timeDifference = Date.parse(left.receivedAt) - Date.parse(right.receivedAt);
  return timeDifference || left.pendingId.localeCompare(right.pendingId);
}

function normalizeCompleted(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const scopeKey = normalizeText(raw.scopeKey);
  const pendingId = normalizeText(raw.pendingId);
  const completedAt = normalizeIsoTime(raw.completedAt);
  return scopeKey && pendingId && completedAt ? { scopeKey, pendingId, completedAt } : null;
}

function pruneCompleted(items, { nowMs, retentionMs, maxCompleted }) {
  const cutoff = nowMs - retentionMs;
  const deduplicated = new Map();
  for (const item of items.map(normalizeCompleted).filter(Boolean)) {
    if (Date.parse(item.completedAt) < cutoff) {
      continue;
    }
    const key = `${item.scopeKey}\u0000${item.pendingId}`;
    const previous = deduplicated.get(key);
    if (!previous || Date.parse(previous.completedAt) < Date.parse(item.completedAt)) {
      deduplicated.set(key, item);
    }
  }
  const retained = [...deduplicated.values()].sort((left, right) => (
    Date.parse(left.completedAt) - Date.parse(right.completedAt)
    || left.scopeKey.localeCompare(right.scopeKey)
    || left.pendingId.localeCompare(right.pendingId)
  ));
  return retained.length > maxCompleted ? retained.slice(retained.length - maxCompleted) : retained;
}

function countMessages(scopes) {
  return scopes.reduce((total, scope) => total + scope.messages.length, 0);
}

function cloneSerializableArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function cloneMessage(message) {
  return JSON.parse(JSON.stringify(message));
}

function cloneScope(scope) {
  return JSON.parse(JSON.stringify(scope));
}

function normalizeIsoTime(value) {
  const text = normalizeText(value);
  const parsed = text ? Date.parse(text) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeNonNegativeInteger(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeTimeMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function emptyState() {
  return { version: STORE_VERSION, scopes: [], sharedScopes: [], completed: [] };
}

function atomicWriteJson(filePath, value) {
  const tempPath = `${filePath}.${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(tempPath, filePath);
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

module.exports = {
  DEFAULT_COMPLETED_RETENTION_MS,
  DEFAULT_MAX_MESSAGES,
  PendingInboundStore,
};
