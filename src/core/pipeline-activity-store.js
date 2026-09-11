const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ACTIVITY_VERSION = 1;
const DEFAULT_REFRESH_INTERVAL_MS = 10_000;

class PipelineActivityStore {
  constructor({
    filePath,
    snapshotProvider = () => ({}),
    now = () => Date.now(),
    refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
    logger = console,
  } = {}) {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new Error("pipeline activity filePath is required");
    }
    this.filePath = path.resolve(filePath);
    this.snapshotProvider = typeof snapshotProvider === "function" ? snapshotProvider : () => ({});
    this.now = typeof now === "function" ? now : () => Date.now();
    this.refreshIntervalMs = normalizePositiveInteger(refreshIntervalMs, DEFAULT_REFRESH_INTERVAL_MS);
    this.logger = logger || console;
    this.instanceId = crypto.randomUUID();
    this.startedAt = new Date(normalizeNowMs(this.now())).toISOString();
    this.lastUserInboundAt = readPreviousLastUserInboundAt(this.filePath);
    this.lastTurnCompletedAt = "";
    this.timer = null;
  }

  start() {
    if (this.timer) {
      return;
    }
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.refreshIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.refresh();
  }

  markUserInbound(at = this.now()) {
    this.lastUserInboundAt = new Date(normalizeNowMs(at)).toISOString();
    return this.refresh();
  }

  markTurnCompleted(at = this.now()) {
    this.lastTurnCompletedAt = new Date(normalizeNowMs(at)).toISOString();
    return this.refresh();
  }

  refresh() {
    try {
      const dynamic = normalizeDynamicSnapshot(this.snapshotProvider());
      const payload = {
        version: ACTIVITY_VERSION,
        pid: process.pid,
        instanceId: this.instanceId,
        startedAt: this.startedAt,
        updatedAt: new Date(normalizeNowMs(this.now())).toISOString(),
        lastUserInboundAt: this.lastUserInboundAt,
        lastTurnCompletedAt: this.lastTurnCompletedAt,
        activeTurnCount: dynamic.activeTurnCount,
        turnGateCount: dynamic.turnGateCount,
        activeDeliveryCount: dynamic.activeDeliveryCount,
        pendingInboundCount: dynamic.pendingInboundCount,
      };
      atomicWriteJson(this.filePath, payload);
      return payload;
    } catch (error) {
      this.logger.warn?.(`[cyberboss] pipeline activity snapshot failed: ${formatError(error)}`);
      return null;
    }
  }
}

function normalizeDynamicSnapshot(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    activeTurnCount: normalizeCount(source.activeTurnCount),
    turnGateCount: normalizeCount(source.turnGateCount),
    activeDeliveryCount: normalizeCount(source.activeDeliveryCount),
    pendingInboundCount: normalizeCount(source.pendingInboundCount),
  };
}

function readPreviousLastUserInboundAt(filePath) {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return normalizeIsoTime(parsed?.lastUserInboundAt);
  } catch {
    return "";
  }
}

function atomicWriteJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(5).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, filePath);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // A successful rename removes the temporary path.
    }
  }
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function normalizeNowMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function normalizeIsoTime(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

module.exports = {
  ACTIVITY_VERSION,
  DEFAULT_REFRESH_INTERVAL_MS,
  PipelineActivityStore,
};
