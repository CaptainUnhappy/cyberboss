/**
 * Tracks which workspace scopes currently own an in-flight turn.
 *
 * A scope is opened by `begin()` before the runtime is asked to accept a turn and
 * is closed by `releaseThread()` (on the turn's terminal event) or
 * `releaseScope()` (on any failure path). `attachThread()` records which thread
 * the runtime handed back.
 *
 * The gate is also a health signal: callers treat "a scope is still pending" as
 * "the pipeline is busy", which makes a gate that is never released block
 * downstream recovery indefinitely. A gate opened but never attached to a thread
 * can only mean the handoff never completed, so this store timestamps every gate
 * and reports how long each has been pending, letting callers distinguish real
 * in-flight work from a leak instead of treating both as busy forever.
 */

const DEFAULT_STALE_GATE_MS = 30 * 60_000;

class TurnGateStore {
  constructor({ now = () => Date.now(), staleAfterMs = DEFAULT_STALE_GATE_MS } = {}) {
    this.scopeByThreadId = new Map();
    /** scopeKey -> { openedAtMs, attachedAtMs } */
    this.pendingScopeKeys = new Map();
    this.now = typeof now === "function" ? now : () => Date.now();
    this.staleAfterMs = Number.isFinite(Number(staleAfterMs)) && Number(staleAfterMs) > 0
      ? Number(staleAfterMs)
      : DEFAULT_STALE_GATE_MS;
  }

  begin(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey) {
      return "";
    }
    const openedAtMs = this.now();
    this.pendingScopeKeys.set(scopeKey, { openedAtMs, attachedAtMs: null });
    return scopeKey;
  }

  attachThread(scopeKey, threadId) {
    const normalizedScopeKey = normalizeText(scopeKey);
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedScopeKey || !normalizedThreadId || !this.pendingScopeKeys.has(normalizedScopeKey)) {
      return false;
    }
    this.scopeByThreadId.set(normalizedThreadId, normalizedScopeKey);
    const record = this.pendingScopeKeys.get(normalizedScopeKey);
    if (record) {
      record.attachedAtMs = this.now();
    }
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

  /**
   * Classify every pending gate. `live` gates are plausible in-flight turns;
   * `stale` gates have been pending longer than `staleAfterMs` without ever being
   * attached to a thread, so no terminal event can ever arrive to release them.
   */
  describePending() {
    const nowMs = this.now();
    const live = [];
    const stale = [];
    for (const [scopeKey, record] of this.pendingScopeKeys.entries()) {
      const openedAtMs = Number(record?.openedAtMs) || nowMs;
      const ageMs = Math.max(0, nowMs - openedAtMs);
      const entry = { scopeKey, ageMs, attached: record?.attachedAtMs != null };
      const unattached = record?.attachedAtMs == null;
      if (unattached && ageMs >= this.staleAfterMs) {
        stale.push(entry);
      } else {
        live.push(entry);
      }
    }
    return { live, stale, total: this.pendingScopeKeys.size };
  }

  /**
   * Release gates that can never be released by an event, and report what was
   * dropped so the caller can log it rather than leak silently.
   */
  releaseStaleGates() {
    const { stale } = this.describePending();
    const released = [];
    for (const entry of stale) {
      this.pendingScopeKeys.delete(entry.scopeKey);
      for (const [threadId, mappedScopeKey] of this.scopeByThreadId.entries()) {
        if (mappedScopeKey === entry.scopeKey) {
          this.scopeByThreadId.delete(threadId);
        }
      }
      released.push(entry);
    }
    return released;
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

module.exports = { TurnGateStore, buildTurnScopeKey, DEFAULT_STALE_GATE_MS };
