const fs = require("fs");

const { renderInstructionTemplate } = require("./instructions-template");

const DEFAULT_SYSTEM_ACTION_INSTRUCTIONS = [
  "SYSTEM ACTION MODE: internal trigger, not user chat.",
  "Use available tools when timeline, diary, reminder, or whereabouts work is useful for this trigger.",
  "After any tool calls, return exactly one JSON object:",
  '{"action":"silent"}',
  '{"action":"send_message","message":"<one short natural WeChat message>"}',
  "During daytime (08:30-00:30 Asia/Shanghai), return `send_message` with one short natural message. Use `silent` only during quiet hours, while a user turn is running, or just after a successfully delivered check-in.",
  "No markdown fences, reasoning, or text outside the JSON object.",
].join("\n");

class SystemMessageDispatcher {
  constructor({ queueStore, config, accountId }) {
    this.queueStore = queueStore;
    this.config = config;
    this.accountId = accountId;
  }

  hasPending() {
    return this.queueStore.hasPendingForAccount(this.accountId);
  }

  drainPending() {
    return this.queueStore.drainForAccount(this.accountId);
  }

  requeue(message) {
    return this.queueStore.enqueue(message);
  }

  resolveWorkspaceRoot(message) {
    return normalizeText(message?.workspaceRoot) || normalizeText(this.config.workspaceRoot);
  }

  buildPreparedMessage(message, contextToken = "") {
    return {
      provider: "system",
      workspaceId: this.config.workspaceId,
      accountId: this.accountId,
      chatId: message.senderId,
      threadKey: `system:${message.senderId}`,
      senderId: message.senderId,
      messageId: message.id,
      text: buildSystemInboundText(
        message?.text,
        message?.createdAt,
        loadSystemActionInstructions(this.config),
      ),
      attachments: [],
      command: "message",
      contextToken,
      receivedAt: normalizeIsoTime(message?.createdAt) || new Date().toISOString(),
      workspaceRoot: this.resolveWorkspaceRoot(message),
    };
  }
}

function buildSystemInboundText(text, createdAt = "", instructions = DEFAULT_SYSTEM_ACTION_INSTRUCTIONS) {
  const body = normalizeText(text);
  const localTime = formatSystemLocalTime(createdAt);
  const stableInstructions = normalizeText(instructions) || DEFAULT_SYSTEM_ACTION_INSTRUCTIONS;
  const sections = [stableInstructions];
  if (body) {
    sections.push("", "Trigger:", body);
  }
  if (localTime) {
    sections.push("", `Event time: [${localTime}]`);
  }
  return sections.join("\n").trim();
}

const instructionCache = new Map();

function loadSystemActionInstructions(config = {}) {
  const filePath = normalizeText(config?.systemActionInstructionsFile);
  if (!filePath) {
    return DEFAULT_SYSTEM_ACTION_INSTRUCTIONS;
  }
  try {
    const stat = fs.statSync(filePath);
    const cacheKey = `${filePath}:${stat.mtimeMs}`;
    const cached = instructionCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const rendered = renderInstructionTemplate(fs.readFileSync(filePath, "utf8"), config).trim();
    const result = rendered || DEFAULT_SYSTEM_ACTION_INSTRUCTIONS;
    instructionCache.set(cacheKey, result);
    return result;
  } catch {
    return DEFAULT_SYSTEM_ACTION_INSTRUCTIONS;
  }
}

function formatSystemLocalTime(value) {
  const normalized = normalizeIsoTime(value);
  if (!normalized) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(normalized)).replace(/\//g, "-");
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Date(parsed).toISOString();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  DEFAULT_SYSTEM_ACTION_INSTRUCTIONS,
  SystemMessageDispatcher,
  buildSystemInboundText,
  loadSystemActionInstructions,
};
