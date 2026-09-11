#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { assertWeFlowCanaryTalkerIsolation } = require("../src/core/config");

const PROJECT_ROOT = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(PROJECT_ROOT, ".env") });
const DEFAULT_USER_STATE_DIR = path.join(os.homedir(), ".cyberboss");
require("dotenv").config({ path: path.join(DEFAULT_USER_STATE_DIR, ".env"), override: false });
const configuredBootstrapStateDir = normalizeText(process.env.CYBERBOSS_STATE_DIR);
if (configuredBootstrapStateDir && path.resolve(configuredBootstrapStateDir) !== path.resolve(DEFAULT_USER_STATE_DIR)) {
  require("dotenv").config({
    path: path.join(path.resolve(configuredBootstrapStateDir), ".env"),
    override: false,
  });
}

const STATE_VERSION = 1;
const DEFAULT_ROUTINE_INTERVAL_MS = 6 * 60 * 60_000;
const DEFAULT_ACCELERATED_INTERVAL_MS = 15 * 60_000;
const DEFAULT_FAILURE_RETRY_MS = 2 * 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_QUIET_WINDOW_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_BRIDGE_SEND_TIMEOUT_MS = 20_000;
const MAX_PROBE_TTL_MS = 120_000;
const MESSAGE_LIMIT = 200;
const MAX_HISTORY = 48;
const MAX_RUN_DIRECTORIES = 64;
const MAX_ATTEMPTS_PER_HOUR = 3;
const MAX_ATTEMPTS_PER_DAY = 4;
const MAX_URGENT_ATTEMPTS_PER_HOUR = 2;
const MAX_URGENT_ATTEMPTS_PER_DAY = 4;
const MAX_URGENT_DEMAND_HISTORY = 256;
const MIN_CANARY_DESKTOP_IDLE_SECONDS = 300;

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const config = readConfig(options);
  const result = await runScheduledCanary(config);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.healthy !== true) {
    process.exitCode = 1;
  }
}

async function runScheduledCanary(config, dependencies = {}) {
  assertWeFlowCanaryTalkerIsolation({
    weflowInboxChat: config.primaryTalker,
    weflowCanaryChat: config.talker,
  });
  config.targetFingerprint = normalizeText(config.targetFingerprint)
    || buildTargetFingerprint({ contact: config.contact, talker: config.talker });
  config.urgent = isUrgentCanaryReason(config.reason);
  config.urgentDemandFingerprint = config.urgent
    ? buildUrgentDemandFingerprint({
      targetFingerprint: config.targetFingerprint,
      reason: config.reason,
      demandKey: config.demandKey,
    })
    : "";
  const now = dependencies.now || (() => Date.now());
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const sleepImpl = dependencies.sleep || sleep;
  const nowMs = now();
  fs.mkdirSync(config.runsDir, { recursive: true });
  fs.mkdirSync(config.stateDir, { recursive: true });

  const releaseLock = acquireRunLock(config.lockFile, nowMs);
  if (!releaseLock) {
    const lockedSchedule = readSchedule(config.scheduleFile);
    if (normalizeText(lockedSchedule.targetFingerprint) !== config.targetFingerprint) {
      return {
        version: STATE_VERSION,
        healthy: null,
        action: "target_changed_pending",
        checkedAt: new Date(nowMs).toISOString(),
        lastRunId: "",
        lastSuccessAt: "",
        consecutiveFailures: 0,
        nextDueAt: new Date(nowMs).toISOString(),
        repairable: false,
        detail: "the active canary run belongs to a different target; wait for its bounded lock to release",
      };
    }
    return {
      version: STATE_VERSION,
      healthy: lockedSchedule.lastStatus === "healthy",
      action: "already_running",
      checkedAt: new Date(nowMs).toISOString(),
      lastRunId: lockedSchedule.lastRunId,
      lastSuccessAt: lockedSchedule.lastSuccessAt,
      consecutiveFailures: lockedSchedule.consecutiveFailures,
      nextDueAt: lockedSchedule.nextDueAt,
      repairable: lockedSchedule.lastRepairable !== false,
      detail: "another canary process owns the bounded run lock",
    };
  }

  try {
    const schedule = readSchedule(config.scheduleFile);
    bindScheduleToTarget(schedule, config.targetFingerprint);
    const active = readActiveRun(config, schedule, nowMs);
    if (active && config.urgent
      && normalizeText(active.manifest.urgentDemandFingerprint) !== config.urgentDemandFingerprint) {
      return {
        version: STATE_VERSION,
        healthy: null,
        action: "obligation_wait",
        attempted: false,
        checkedAt: new Date(nowMs).toISOString(),
        lastRunId: active.runId,
        lastSuccessAt: schedule.lastSuccessAt,
        consecutiveFailures: schedule.consecutiveFailures,
        nextDueAt: active.manifest.expiresAt,
        repairable: false,
        detail: "a different bounded canary obligation is active; this demand was not executed or credited",
      };
    }
    if (!active) {
      const decision = decideCanaryDue(schedule, {
        nowMs,
        force: config.force,
        repairVerification: config.reason === "repair_verification",
        explicitDemand: config.reason === "user_demand",
        demandKey: config.demandKey,
        urgentDemandFingerprint: config.urgentDemandFingerprint,
        routineIntervalMs: config.routineIntervalMs,
        acceleratedIntervalMs: config.acceleratedIntervalMs,
        failureRetryMs: config.failureRetryMs,
      });
      if (!decision.due) {
        const scheduleHealthy = resolveScheduleHealthy(schedule.lastStatus);
        const budgetWait = decision.reason.startsWith("budget_");
        const urgentBudgetWait = decision.reason.startsWith("urgent_budget_");
        const demandAlreadyHandled = decision.reason === "urgent_demand_duplicate";
        if (demandAlreadyHandled) {
          const replayed = replayHandledCanaryOutcome(config, schedule, {
            demandFingerprint: config.urgentDemandFingerprint,
            runId: decision.previousRunId,
            nowMs,
          });
          if (replayed) {
            return replayed;
          }
        }
        schedule.nextDueAt = new Date(decision.nextDueAtMs).toISOString();
        writeSchedule(config.scheduleFile, schedule);
        return {
          version: STATE_VERSION,
          healthy: scheduleHealthy,
          action: urgentBudgetWait
            ? "urgent_budget_wait"
            : demandAlreadyHandled
              ? "demand_already_handled"
              : budgetWait
                ? (scheduleHealthy === null ? "target_verification_budget_wait" : "budget_wait")
                : (schedule.lastStatus === "failed" ? "waiting_retry" : "not_due"),
          attempted: false,
          checkedAt: new Date(nowMs).toISOString(),
          lastRunId: schedule.lastRunId,
          lastSuccessAt: schedule.lastSuccessAt,
          consecutiveFailures: schedule.consecutiveFailures,
          nextDueAt: new Date(decision.nextDueAtMs).toISOString(),
          repairable: urgentBudgetWait || demandAlreadyHandled
            ? false
            : schedule.lastRepairable !== false,
          detail: decision.reason,
        };
      }
    }

    const run = active || createRun(config, schedule, { nowMs, now });
    let outcome;
    try {
      outcome = await executeRun(config, run, { fetchImpl, sleepImpl, now });
    } catch (error) {
      outcome = error?.code === "CANARY_DESKTOP_ACTIVE"
        ? buildDesktopBusyOutcome(run, error, now())
        : buildFailureOutcome(run, error, now());
    }
    finalizeRun(config, schedule, run, outcome, now());
    pruneRunDirectories(config.runsDir, MAX_RUN_DIRECTORIES);
    return outcome;
  } finally {
    releaseLock();
  }
}

function decideCanaryDue(schedule, {
  nowMs,
  force = false,
  repairVerification = false,
  explicitDemand = false,
  demandKey = "",
  urgentDemandFingerprint = "",
  routineIntervalMs = DEFAULT_ROUTINE_INTERVAL_MS,
  acceleratedIntervalMs = DEFAULT_ACCELERATED_INTERVAL_MS,
  failureRetryMs = DEFAULT_FAILURE_RETRY_MS,
} = {}) {
  const urgentDemand = repairVerification || explicitDemand;
  if (urgentDemand) {
    const fingerprint = normalizeText(urgentDemandFingerprint);
    if (!normalizeText(demandKey) || !/^[0-9a-f]{64}$/u.test(fingerprint)) {
      throw new Error("urgent canary demand key and fingerprint are required");
    }
    const previous = readUrgentAttempts(schedule.urgentAttempts)
      .find((attempt) => (
        attempt.demandFingerprint === fingerprint
        && attempt.state !== "released"
      ));
    if (previous) {
      return {
        due: false,
        nextDueAtMs: parseTimeMs(schedule.nextDueAt) || nowMs,
        reason: "urgent_demand_duplicate",
        previousRunId: previous.runId,
        previousState: previous.state,
      };
    }
    const urgentBudget = getUrgentCanaryAttemptGate(schedule.urgentAttempts, nowMs);
    if (!urgentBudget.allowed) {
      return {
        due: false,
        nextDueAtMs: urgentBudget.retryAtMs,
        reason: urgentBudget.reason,
      };
    }
    return {
      due: true,
      nextDueAtMs: nowMs,
      reason: repairVerification ? "repair_verification" : "user_demand",
    };
  }
  const budget = getCanaryAttemptGate(schedule.attempts, nowMs);
  if (!budget.allowed) {
    return {
      due: false,
      nextDueAtMs: budget.retryAtMs,
      reason: budget.reason,
    };
  }
  const lastAttemptMs = parseTimeMs(schedule.lastAttemptAt);
  const lastSuccessMs = parseTimeMs(schedule.lastSuccessAt);
  const normalizedDemand = normalizeText(demandKey);
  let dueAtMs;
  let reason;

  if (schedule.lastStatus === "failed") {
    dueAtMs = (lastAttemptMs || 0) + failureRetryMs;
    reason = "failure_retry";
  } else if (force) {
    const demandChanged = normalizedDemand && normalizedDemand !== normalizeText(schedule.lastDemandKey);
    dueAtMs = demandChanged ? 0 : (lastAttemptMs || 0) + acceleratedIntervalMs;
    reason = demandChanged ? "new_queue_demand" : "accelerated_interval";
  } else {
    dueAtMs = (lastSuccessMs || lastAttemptMs || 0) + routineIntervalMs;
    reason = "routine_interval";
  }

  return {
    due: dueAtMs <= nowMs,
    nextDueAtMs: Math.max(nowMs, dueAtMs),
    reason,
  };
}

function getUrgentCanaryAttemptGate(urgentAttempts, nowMs) {
  const parsed = readUrgentAttempts(urgentAttempts)
    .map((attempt) => parseTimeMs(attempt.at))
    .filter((value) => value > 0 && value <= nowMs + 10_000)
    .sort((left, right) => left - right);
  const daily = parsed.filter((value) => value > nowMs - 24 * 60 * 60_000);
  const hourly = daily.filter((value) => value > nowMs - 60 * 60_000);
  if (daily.length >= MAX_URGENT_ATTEMPTS_PER_DAY) {
    return {
      allowed: false,
      reason: "urgent_budget_daily",
      retryAtMs: daily[0] + 24 * 60 * 60_000,
    };
  }
  if (hourly.length >= MAX_URGENT_ATTEMPTS_PER_HOUR) {
    return {
      allowed: false,
      reason: "urgent_budget_hourly",
      retryAtMs: hourly[0] + 60 * 60_000,
    };
  }
  return { allowed: true, reason: "ready", retryAtMs: nowMs };
}

function getCanaryAttemptGate(attempts, nowMs) {
  const parsed = (Array.isArray(attempts) ? attempts : [])
    .map(parseTimeMs)
    .filter((value) => value > 0 && value <= nowMs + 10_000)
    .sort((left, right) => left - right);
  const daily = parsed.filter((value) => value > nowMs - 24 * 60 * 60_000);
  const hourly = daily.filter((value) => value > nowMs - 60 * 60_000);
  if (daily.length >= MAX_ATTEMPTS_PER_DAY) {
    return {
      allowed: false,
      reason: "budget_daily",
      retryAtMs: daily[0] + 24 * 60 * 60_000,
    };
  }
  if (hourly.length >= MAX_ATTEMPTS_PER_HOUR) {
    return {
      allowed: false,
      reason: "budget_hourly",
      retryAtMs: hourly[0] + 60 * 60_000,
    };
  }
  return { allowed: true, reason: "ready", retryAtMs: nowMs };
}

function createRun(config, schedule, { nowMs, now }) {
  const previousLastAttemptAt = normalizeText(schedule.lastAttemptAt);
  const previousLastDemandKey = normalizeText(schedule.lastDemandKey);
  const runId = crypto.randomUUID().toLowerCase();
  const nonce = crypto.randomBytes(12).toString("hex");
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + config.probeTimeoutMs).toISOString();
  const triggerText = `[Cyberboss心跳探针 trigger=${runId} nonce=${nonce}]`;
  const replyText = `[Cyberboss心跳正常 trigger=${runId}]`;
  const runDir = path.join(config.runsDir, runId);
  const manifest = {
    version: STATE_VERSION,
    runId,
    nonce,
    triggerText,
    replyText,
    createdAt,
    expiresAt,
    talker: config.talker,
    contact: config.contact,
    targetFingerprint: config.targetFingerprint,
    requestedAt: createdAt,
    reason: config.reason,
    urgentDemandFingerprint: config.urgentDemandFingerprint,
  };
  fs.mkdirSync(runDir, { recursive: false });
  atomicWriteJson(path.join(runDir, "manifest.json"), manifest);

  schedule.activeRunId = runId;
  schedule.lastRunId = runId;
  schedule.lastAttemptAt = createdAt;
  schedule.attempts = [
    ...(Array.isArray(schedule.attempts) ? schedule.attempts : [])
      .filter((value) => parseTimeMs(value) > nowMs - 24 * 60 * 60_000),
    createdAt,
  ];
  schedule.lastReason = config.reason;
  schedule.targetFingerprint = config.targetFingerprint;
  if (config.urgent) {
    schedule.urgentAttempts = [
      ...readUrgentAttempts(schedule.urgentAttempts),
      {
        at: createdAt,
        runId,
        reason: config.reason,
        demandFingerprint: config.urgentDemandFingerprint,
        state: "reserved",
      },
    ].slice(-MAX_URGENT_DEMAND_HISTORY);
  } else if (config.force) {
    schedule.lastDemandKey = config.demandKey;
  }
  writeSchedule(config.scheduleFile, schedule);
  return {
    runId,
    runDir,
    manifest,
    resumed: false,
    startedAtMs: now(),
    previousLastAttemptAt,
    previousLastDemandKey,
  };
}

function readActiveRun(config, schedule, nowMs) {
  const runId = normalizeRunId(schedule.activeRunId);
  if (!runId) {
    return null;
  }
  const runDir = path.join(config.runsDir, runId);
  const manifest = readJson(path.join(runDir, "manifest.json"));
  if (!validateManifest(manifest, {
    runId,
    talker: config.talker,
    contact: config.contact,
    targetFingerprint: config.targetFingerprint,
  })) {
    schedule.activeRunId = "";
    writeSchedule(config.scheduleFile, schedule);
    return null;
  }
  const expiresAtMs = parseTimeMs(manifest.expiresAt);
  if (!expiresAtMs || expiresAtMs <= nowMs) {
    const outcome = buildFailureOutcome(
      { runId, runDir, manifest, resumed: true, startedAtMs: nowMs },
      codedError("CANARY_EXPIRED", "the persisted canary run expired before completion"),
      nowMs,
    );
    finalizeRun(config, schedule, { runId, runDir, manifest }, outcome, nowMs);
    return null;
  }
  return { runId, runDir, manifest, resumed: true, startedAtMs: nowMs };
}

async function executeRun(config, run, { fetchImpl, sleepImpl, now }) {
  const { manifest, runDir } = run;
  const deadlineMs = parseTimeMs(manifest.expiresAt);
  const initialMessages = await fetchMessages(config, fetchImpl);
  let observed = inspectCanaryMessages(initialMessages, manifest);
  if (observed.trigger.length > 1 || observed.reply.length > 1) {
    throw codedError("CANARY_DUPLICATE", formatDuplicateDetail(observed));
  }

  let triggerLocalId = observed.trigger[0]?.localId || "";
  let bridgeVerified = Boolean(triggerLocalId);
  const dispatchStartedPath = path.join(runDir, "trigger-dispatch-started.json");
  const dispatchAlreadyStarted = Boolean(readJson(dispatchStartedPath));
  if (!triggerLocalId && !dispatchAlreadyStarted) {
    atomicWriteJson(dispatchStartedPath, {
      version: STATE_VERSION,
      runId: manifest.runId,
      startedAt: new Date(now()).toISOString(),
    });
    const payload = await requestJson(
      buildUrl(config.bridgeBaseUrl, "/api/send"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          contact: config.contact,
          talker: config.talker,
          text: manifest.triggerText,
          timeout: Math.max(1, Math.ceil(config.bridgeSendTimeoutMs / 1_000)),
          requireDesktopIdleSeconds: Math.max(
            MIN_CANARY_DESKTOP_IDLE_SECONDS,
            Number(config.desktopIdleSeconds) || MIN_CANARY_DESKTOP_IDLE_SECONDS,
          ),
          exactContact: true,
          expectedContact: config.contact,
          expectedTalker: config.talker,
        }),
      },
      {
        label: "watchdog canary trigger",
        timeoutMs: config.bridgeSendTimeoutMs + config.requestTimeoutMs,
        fetchImpl,
      },
    );
    if (payload?.dispatched !== true) {
      const error = codedError(
        "CANARY_TRIGGER_NOT_DISPATCHED",
        "UIA bridge did not dispatch the canary trigger",
      );
      error.certainPredispatch = true;
      throw error;
    }
    if (payload?.targetVerified !== true
      || normalizeText(payload?.selectedContact) !== config.contact
      || normalizeText(payload?.verifiedTalker) !== config.talker) {
      throw codedError("TARGET_NOT_CONFIRMED", "UIA bridge did not prove the exact canary contact and talker");
    }
    const returnedLocalId = optionalLocalId(payload?.localId);
    bridgeVerified = payload?.verified === true && Boolean(returnedLocalId);
    triggerLocalId = returnedLocalId || "";
  }

  let lastDetail = "waiting for the canary milestones";
  let quietStartedAtMs = 0;
  while (now() < deadlineMs) {
    const ingested = readJson(path.join(runDir, "ingested.json"));
    const replyDispatched = readJson(path.join(runDir, "reply-dispatched.json"));
    const replyObserved = readJson(path.join(runDir, "reply-observed.json"));
    const replyFailed = readJson(path.join(runDir, "reply-failed.json"));
    if (replyFailed?.version === STATE_VERSION
      && replyFailed?.runId === manifest.runId
      && normalizeText(replyFailed?.code) === "TARGET_NOT_CONFIRMED") {
      throw codedError(
        "TARGET_NOT_CONFIRMED",
        normalizeText(replyFailed?.error) || "exact canary reply target was not confirmed",
      );
    }
    const messages = await fetchMessages(config, fetchImpl);
    observed = inspectCanaryMessages(messages, manifest);

    if (observed.trigger.length > 1 || observed.reply.length > 1) {
      throw codedError("CANARY_DUPLICATE", formatDuplicateDetail(observed));
    }
    triggerLocalId = triggerLocalId || observed.trigger[0]?.localId || "";
    const replyLocalId = observed.reply[0]?.localId || "";
    const milestones = validateMilestones({
      manifest,
      ingested,
      replyDispatched,
      replyObserved,
      triggerLocalId,
      replyLocalId,
    });
    if (milestones.ok) {
      quietStartedAtMs = quietStartedAtMs || now();
      const quietElapsedMs = Math.max(0, now() - quietStartedAtMs);
      if (quietElapsedMs >= config.quietWindowMs) {
        const drain = inspectCursorDrain(config.cursorFile, {
          manifest,
          triggerLocalId: milestones.triggerLocalId,
          replyLocalId: milestones.replyLocalId,
          replyObserved,
        });
        if (drain.ok) {
          return {
            version: STATE_VERSION,
            healthy: true,
            action: "verified",
            checkedAt: new Date(now()).toISOString(),
            runId: manifest.runId,
            reason: config.reason,
            resumed: run.resumed,
            bridgeVerified,
            targetVerified: true,
            targetContact: manifest.contact,
            targetTalker: manifest.talker,
            targetFingerprint: manifest.targetFingerprint,
            triggerLocalId: milestones.triggerLocalId,
            replyLocalId: milestones.replyLocalId,
            quietWindowMs: config.quietWindowMs,
            cursorCommittedAt: drain.cursorCommittedAt,
            elapsedMs: Math.max(0, now() - run.startedAtMs),
            detail: "trigger and reply were unique, observed, quiet, and absent from the durable inbox queue",
          };
        }
        lastDetail = drain.detail;
      } else {
        lastDetail = `waiting for ${config.quietWindowMs - quietElapsedMs}ms quiet window`;
      }
    } else {
      quietStartedAtMs = 0;
      lastDetail = milestones.detail;
    }
    await sleepImpl(Math.min(config.pollIntervalMs, Math.max(0, deadlineMs - now())));
  }
  throw codedError("CANARY_TIMEOUT", `canary timed out: ${lastDetail}`);
}

function validateMilestones({
  manifest,
  ingested,
  replyDispatched,
  replyObserved,
  triggerLocalId,
  replyLocalId,
}) {
  const checks = [
    ["ingested", ingested],
    ["reply-dispatched", replyDispatched],
    ["reply-observed", replyObserved],
  ];
  for (const [name, receipt] of checks) {
    if (!receipt) {
      return { ok: false, detail: `${name} receipt is pending` };
    }
    if (receipt.version !== STATE_VERSION || receipt.runId !== manifest.runId) {
      return { ok: false, detail: `${name} receipt failed run binding validation` };
    }
  }

  const ingestedTriggerId = optionalLocalId(ingested.triggerLocalId ?? ingested.localId);
  const dispatchedReplyId = optionalLocalId(replyDispatched.replyLocalId ?? replyDispatched.localId);
  const observedReplyId = optionalLocalId(replyObserved.replyLocalId ?? replyObserved.localId);
  const resolvedTriggerId = optionalLocalId(triggerLocalId) || ingestedTriggerId;
  const resolvedReplyId = optionalLocalId(replyLocalId) || dispatchedReplyId || observedReplyId;
  if (!resolvedTriggerId || !ingestedTriggerId || resolvedTriggerId !== ingestedTriggerId) {
    return { ok: false, detail: "trigger localId is missing or inconsistent" };
  }
  if (!resolvedReplyId || !dispatchedReplyId || !observedReplyId
    || resolvedReplyId !== dispatchedReplyId || resolvedReplyId !== observedReplyId) {
    return { ok: false, detail: "reply localId is missing or inconsistent" };
  }
  if (BigInt(resolvedReplyId) <= BigInt(resolvedTriggerId)) {
    return { ok: false, detail: "reply localId did not follow the trigger localId" };
  }
  return { ok: true, triggerLocalId: resolvedTriggerId, replyLocalId: resolvedReplyId };
}

function inspectCanaryMessages(messages, manifest) {
  const unique = (text) => {
    const byId = new Map();
    for (const message of messages) {
      if (!isOutgoingMessage(message)
        || !isExpectedCanarySender(message, manifest.talker)
        || readMessageText(message) !== text) {
        continue;
      }
      const localId = optionalLocalId(readLocalId(message));
      if (localId) {
        byId.set(localId, { localId, message });
      }
    }
    return [...byId.values()].sort((left, right) => (
      BigInt(left.localId) < BigInt(right.localId) ? -1 : 1
    ));
  };
  return { trigger: unique(manifest.triggerText), reply: unique(manifest.replyText) };
}

function replayHandledCanaryOutcome(config, schedule, {
  demandFingerprint = "",
  runId = "",
  nowMs = Date.now(),
} = {}) {
  const fingerprint = normalizeText(demandFingerprint);
  const normalizedRunId = normalizeRunId(runId);
  const attempt = readUrgentAttempts(schedule.urgentAttempts)
    .find((entry) => (
      entry.demandFingerprint === fingerprint
      && entry.runId === normalizedRunId
      && ["handled", "completed"].includes(entry.state)
    ));
  if (!attempt) return null;

  let terminal = normalizeTerminalCanaryOutcome(attempt.result, normalizedRunId);
  if (!terminal) {
    const runDir = path.join(config.runsDir, normalizedRunId);
    const manifest = readJson(path.join(runDir, "manifest.json"));
    if (!validateManifest(manifest, {
      runId: normalizedRunId,
      talker: config.talker,
      contact: config.contact,
      targetFingerprint: config.targetFingerprint,
    }) || normalizeText(manifest.urgentDemandFingerprint) !== fingerprint) {
      return null;
    }
    terminal = normalizeTerminalCanaryOutcome(
      readJson(path.join(runDir, "summary.json")),
      normalizedRunId,
    );
  }
  if (!terminal) return null;

  return {
    ...terminal,
    attempted: false,
    replayed: true,
    replayedAt: new Date(nowMs).toISOString(),
    lastRunId: normalizedRunId,
    lastSuccessAt: normalizeText(schedule.lastSuccessAt),
    consecutiveFailures: Math.max(0, Math.min(100, Number(schedule.consecutiveFailures) || 0)),
    nextDueAt: normalizeText(schedule.nextDueAt),
  };
}

function normalizeTerminalCanaryOutcome(value, expectedRunId = "") {
  if (!isObject(value) || value.version !== STATE_VERSION) return null;
  const runId = normalizeRunId(value.runId);
  const expected = normalizeRunId(expectedRunId);
  if (!runId || (expected && runId !== expected)) return null;

  const action = normalizeText(value.action);
  if (action === "verified") {
    const triggerLocalId = optionalLocalId(value.triggerLocalId);
    const replyLocalId = optionalLocalId(value.replyLocalId);
    if (value.healthy !== true || !triggerLocalId || !replyLocalId
      || BigInt(replyLocalId) <= BigInt(triggerLocalId)) {
      return null;
    }
    return {
      ...value,
      version: STATE_VERSION,
      healthy: true,
      action,
      runId,
      triggerLocalId,
      replyLocalId,
    };
  }
  if (action === "failed" && value.healthy === false) {
    return {
      ...value,
      version: STATE_VERSION,
      healthy: false,
      action,
      runId,
      triggerLocalId: optionalLocalId(value.triggerLocalId),
      replyLocalId: optionalLocalId(value.replyLocalId),
    };
  }
  return null;
}

function finalizeRun(config, schedule, run, outcome, nowMs) {
  atomicWriteJson(path.join(run.runDir, "summary.json"), outcome);
  schedule.activeRunId = "";
  schedule.lastRunId = run.runId;
  const deferredBusy = outcome.action === "deferred_busy"
    && outcome.code === "CANARY_DESKTOP_ACTIVE";
  if (deferredBusy) {
    schedule.attempts = (Array.isArray(schedule.attempts) ? schedule.attempts : [])
      .filter((value) => normalizeText(value) !== normalizeText(run.manifest.createdAt));
    schedule.lastAttemptAt = normalizeText(run.previousLastAttemptAt)
      || normalizeText(schedule.attempts.at(-1));
    if (normalizeText(run.manifest?.urgentDemandFingerprint)) {
      schedule.urgentAttempts = readUrgentAttempts(schedule.urgentAttempts)
        .filter((attempt) => attempt.runId !== run.runId);
    } else if (config.force) {
      schedule.lastDemandKey = normalizeText(run.previousLastDemandKey);
    }
  } else {
    if (normalizeText(run.manifest?.urgentDemandFingerprint)) {
      schedule.urgentAttempts = readUrgentAttempts(schedule.urgentAttempts)
        .map((attempt) => attempt.runId === run.runId
          ? {
            ...attempt,
            state: outcome.certainPredispatch === true ? "released" : "handled",
            result: normalizeTerminalCanaryOutcome(outcome, run.runId),
          }
          : attempt);
    }
    schedule.lastAttemptAt = schedule.lastAttemptAt || run.manifest.createdAt;
    schedule.lastStatus = outcome.healthy === true ? "healthy" : "failed";
    schedule.lastError = outcome.healthy === true ? "" : normalizeText(outcome.error || outcome.detail).slice(0, 500);
    schedule.lastRepairable = outcome.repairable !== false;
    schedule.lastTriggerLocalId = normalizeText(outcome.triggerLocalId);
    schedule.lastReplyLocalId = normalizeText(outcome.replyLocalId);
    schedule.lastQuietWindowMs = Number.isFinite(Number(outcome.quietWindowMs))
      ? Math.max(0, Number(outcome.quietWindowMs))
      : 0;
    schedule.lastCursorCommittedAt = normalizeText(outcome.cursorCommittedAt);
  }
  schedule.lastAction = normalizeText(outcome.action);
  schedule.lastDetail = normalizeText(outcome.detail).slice(0, 500);
  if (deferredBusy) {
    schedule.nextDueAt = new Date(nowMs + config.failureRetryMs).toISOString();
  } else if (outcome.healthy === true) {
    schedule.lastSuccessAt = outcome.checkedAt || new Date(nowMs).toISOString();
    schedule.consecutiveFailures = 0;
    schedule.nextDueAt = new Date(nowMs + (
      config.force && !config.urgent
        ? config.acceleratedIntervalMs
        : config.routineIntervalMs
    )).toISOString();
  } else {
    schedule.lastFailureAt = outcome.checkedAt || new Date(nowMs).toISOString();
    schedule.consecutiveFailures = Math.min(100, Number(schedule.consecutiveFailures || 0) + 1);
    schedule.nextDueAt = new Date(nowMs + config.failureRetryMs).toISOString();
  }
  schedule.history = [
    ...(Array.isArray(schedule.history) ? schedule.history : []),
    {
      runId: run.runId,
      checkedAt: outcome.checkedAt,
      healthy: outcome.healthy === true,
      code: normalizeText(outcome.code),
      triggerLocalId: normalizeText(outcome.triggerLocalId),
      replyLocalId: normalizeText(outcome.replyLocalId),
    },
  ].slice(-MAX_HISTORY);
  writeSchedule(config.scheduleFile, schedule);
}

function buildFailureOutcome(run, error, nowMs) {
  const code = normalizeText(error?.code) || "CANARY_FAILED";
  const dispatchStarted = Boolean(readJson(path.join(run.runDir, "trigger-dispatch-started.json")));
  const certainPredispatch = error?.certainPredispatch === true || !dispatchStarted;
  return {
    version: STATE_VERSION,
    healthy: false,
    action: "failed",
    checkedAt: new Date(nowMs).toISOString(),
    runId: run.runId,
    code,
    certainPredispatch,
    ...(code === "TARGET_NOT_CONFIRMED" ? { repairable: false } : {}),
    error: error instanceof Error ? error.message : String(error || "unknown canary failure"),
    resumed: Boolean(run.resumed),
    elapsedMs: Math.max(0, nowMs - Number(run.startedAtMs || nowMs)),
  };
}

function buildDesktopBusyOutcome(run, error, nowMs) {
  return {
    version: STATE_VERSION,
    healthy: null,
    action: "deferred_busy",
    attempted: false,
    checkedAt: new Date(nowMs).toISOString(),
    runId: run.runId,
    code: "CANARY_DESKTOP_ACTIVE",
    error: "",
    resumed: Boolean(run.resumed),
    desktopIdleSeconds: Number.isFinite(Number(error?.desktopIdleSeconds))
      ? Math.max(0, Math.floor(Number(error.desktopIdleSeconds)))
      : null,
    elapsedMs: Math.max(0, nowMs - Number(run.startedAtMs || nowMs)),
    detail: error instanceof Error
      ? error.message
      : "desktop input became active before the canary could be dispatched",
  };
}

function readConfig(options = {}) {
  const stateDir = path.resolve(
    options.stateDir
      || normalizeText(process.env.CYBERBOSS_STATE_DIR)
      || path.join(os.homedir(), ".cyberboss"),
  );
  const probeTimeoutMs = boundedIntegerEnv(
    "CYBERBOSS_WATCHDOG_CANARY_TIMEOUT_MS",
    DEFAULT_PROBE_TIMEOUT_MS,
    10_000,
    MAX_PROBE_TTL_MS,
  );
  const talker = requiredEnv("CYBERBOSS_WEFLOW_CANARY_CHAT");
  const contact = requiredEnv("CYBERBOSS_WEFLOW_CANARY_DISPLAY_NAME");
  const primaryTalker = normalizeText(process.env.CYBERBOSS_WEFLOW_INBOX_CHAT);
  assertWeFlowCanaryTalkerIsolation({
    weflowInboxChat: primaryTalker,
    weflowCanaryChat: talker,
  });
  const targetFingerprint = buildTargetFingerprint({ contact, talker });
  return {
    stateDir,
    runsDir: path.join(stateDir, "e2e-probes"),
    scheduleFile: path.join(stateDir, "cyberboss-watchdog-canary.json"),
    lockFile: path.join(stateDir, "cyberboss-watchdog-canary.lock"),
    bridgeBaseUrl: normalizeBaseUrl(
      process.env.CYBERBOSS_WEFLOW_BRIDGE_BASE_URL || "http://127.0.0.1:8766",
      "CYBERBOSS_WEFLOW_BRIDGE_BASE_URL",
    ),
    weflowBaseUrl: normalizeBaseUrl(
      process.env.CYBERBOSS_WEFLOW_BASE_URL || "http://127.0.0.1:5031",
      "CYBERBOSS_WEFLOW_BASE_URL",
    ),
    token: requiredEnv("CYBERBOSS_WEFLOW_TOKEN"),
    primaryTalker,
    talker,
    contact,
    targetFingerprint,
    desktopIdleSeconds: normalizeCanaryDesktopIdleSeconds(boundedIntegerEnv(
      "CYBERBOSS_WATCHDOG_DESKTOP_IDLE_SECONDS",
      MIN_CANARY_DESKTOP_IDLE_SECONDS,
      0,
      24 * 60 * 60,
    )),
    probeTimeoutMs,
    routineIntervalMs: boundedIntegerEnv(
      "CYBERBOSS_WATCHDOG_CANARY_INTERVAL_MS",
      DEFAULT_ROUTINE_INTERVAL_MS,
      30 * 60_000,
      7 * 24 * 60 * 60_000,
    ),
    acceleratedIntervalMs: boundedIntegerEnv(
      "CYBERBOSS_WATCHDOG_CANARY_ACCELERATED_INTERVAL_MS",
      DEFAULT_ACCELERATED_INTERVAL_MS,
      2 * 60_000,
      24 * 60 * 60_000,
    ),
    failureRetryMs: boundedIntegerEnv(
      "CYBERBOSS_WATCHDOG_CANARY_FAILURE_RETRY_MS",
      DEFAULT_FAILURE_RETRY_MS,
      60_000,
      60 * 60_000,
    ),
    pollIntervalMs: boundedIntegerEnv(
      "CYBERBOSS_WATCHDOG_CANARY_POLL_INTERVAL_MS",
      DEFAULT_POLL_INTERVAL_MS,
      100,
      5_000,
    ),
    quietWindowMs: boundedIntegerEnv(
      "CYBERBOSS_WATCHDOG_CANARY_QUIET_WINDOW_MS",
      DEFAULT_QUIET_WINDOW_MS,
      3_000,
      8_000,
    ),
    requestTimeoutMs: boundedIntegerEnv(
      "CYBERBOSS_WATCHDOG_CANARY_REQUEST_TIMEOUT_MS",
      DEFAULT_REQUEST_TIMEOUT_MS,
      1_000,
      30_000,
    ),
    bridgeSendTimeoutMs: boundedIntegerEnv(
      "CYBERBOSS_WATCHDOG_CANARY_SEND_TIMEOUT_MS",
      DEFAULT_BRIDGE_SEND_TIMEOUT_MS,
      1_000,
      60_000,
    ),
    force: Boolean(options.force),
    reason: normalizeText(options.reason) || (options.force ? "queue" : "routine"),
    demandKey: normalizeText(options.demandKey),
    cursorFile: path.join(stateDir, "weflow-canary-inbox-cursor.json"),
  };
}

function inspectCursorDrain(cursorFile, {
  manifest,
  triggerLocalId,
  replyLocalId,
  replyObserved,
} = {}) {
  let parsed;
  let stat;
  try {
    const bytes = fs.readFileSync(cursorFile);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
    stat = fs.statSync(cursorFile);
  } catch (error) {
    return { ok: false, detail: `durable inbox cursor is unavailable: ${formatError(error)}` };
  }
  const expectedTalker = normalizeText(manifest?.talker);
  const cursorTalker = typeof parsed?.talker === "string" ? parsed.talker.trim() : "";
  const rawLastLocalId = typeof parsed?.lastLocalId === "string" ? parsed.lastLocalId.trim() : null;
  const seenIdentities = Array.isArray(parsed?.seenIdentities) ? parsed.seenIdentities : null;
  if (!isObject(parsed)
    || parsed.version !== STATE_VERSION
    || !expectedTalker
    || cursorTalker !== expectedTalker
    || rawLastLocalId === null
    || (rawLastLocalId && optionalLocalId(rawLastLocalId) !== rawLastLocalId)
    || !seenIdentities
    || !seenIdentities.every((value) => typeof value === "string" && value === value.trim() && Boolean(value))
    || typeof parsed.updatedAt !== "string"
    || typeof parsed.lastPolledAt !== "string") {
    return { ok: false, detail: "durable inbox cursor schema or talker does not match the dedicated canary source" };
  }
  const committedReplyLocalId = optionalLocalId(replyLocalId);
  const replyIdentity = committedReplyLocalId ? `local:${committedReplyLocalId}` : "";
  const cursorAdvancedThroughReply = Boolean(
    committedReplyLocalId
    && rawLastLocalId
    && BigInt(rawLastLocalId) >= BigInt(committedReplyLocalId),
  );
  if (!replyIdentity
    || (!seenIdentities.includes(replyIdentity) && !cursorAdvancedThroughReply)) {
    return { ok: false, detail: "durable inbox cursor has not committed the observed canary reply localId" };
  }
  const observedAtMs = parseTimeMs(
    replyObserved?.recordedAt ?? replyObserved?.replyObservedAt ?? replyObserved?.observedAt,
  );
  if (observedAtMs && stat.mtimeMs < observedAtMs) {
    return { ok: false, detail: "durable inbox cursor has not committed after reply observation" };
  }
  return { ok: true, cursorCommittedAt: new Date(stat.mtimeMs).toISOString() };
}

async function fetchMessages(config, fetchImpl) {
  const url = new URL("/api/v1/messages", `${config.weflowBaseUrl}/`);
  url.searchParams.set("talker", config.talker);
  url.searchParams.set("limit", String(MESSAGE_LIMIT));
  const payload = await requestJson(url, {
    headers: { Authorization: `Bearer ${config.token}` },
  }, {
    label: "WeFlow canary messages",
    timeoutMs: config.requestTimeoutMs,
    fetchImpl,
  });
  return extractMessages(payload);
}

async function requestJson(url, init = {}, {
  label = "request",
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw codedError("CANARY_REQUEST_TIMEOUT", `${label} timed out after ${timeoutMs}ms`);
    }
    throw codedError("CANARY_REQUEST_FAILED", `${label} failed: ${formatError(error)}`);
  } finally {
    clearTimeout(timer);
  }
  let payload = null;
  try { payload = await response.json(); } catch {}
  if (!response.ok) {
    const error = codedError(
      normalizeText(payload?.code) || "CANARY_HTTP_ERROR",
      `${label} failed: ${payload?.error || `HTTP ${response.status}`}`,
    );
    if (Number.isFinite(Number(payload?.desktopIdleSeconds))) {
      error.desktopIdleSeconds = Math.max(0, Math.floor(Number(payload.desktopIdleSeconds)));
    }
    if (payload?.dispatched === false) {
      error.certainPredispatch = true;
    }
    throw error;
  }
  if (!payload || typeof payload !== "object") {
    throw codedError("CANARY_INVALID_JSON", `${label} returned invalid JSON`);
  }
  return payload;
}

function validateManifest(manifest, { runId, talker, contact = "", targetFingerprint = "" }) {
  if (!manifest || manifest.version !== STATE_VERSION || manifest.runId !== runId) {
    return false;
  }
  if (!/^[0-9a-f]{24}$/.test(String(manifest.nonce || ""))
    || manifest.talker !== talker
    || (contact && manifest.contact !== contact)
    || !manifest.contact
    || !/^[0-9a-f]{64}$/.test(String(manifest.targetFingerprint || ""))
    || manifest.targetFingerprint !== buildTargetFingerprint({
      contact: manifest.contact,
      talker: manifest.talker,
    })
    || (targetFingerprint && manifest.targetFingerprint !== targetFingerprint)) {
    return false;
  }
  const reason = normalizeText(manifest.reason);
  const urgent = isUrgentCanaryReason(reason);
  const urgentDemandFingerprint = normalizeText(manifest.urgentDemandFingerprint);
  if (!reason
    || (urgent && !/^[0-9a-f]{64}$/u.test(urgentDemandFingerprint))
    || (!urgent && urgentDemandFingerprint)) {
    return false;
  }
  const requestedAtMs = parseTimeMs(manifest.requestedAt);
  const createdAtMs = parseTimeMs(manifest.createdAt);
  const expiresAtMs = parseTimeMs(manifest.expiresAt);
  return Boolean(
    requestedAtMs
    && requestedAtMs === createdAtMs
    && createdAtMs
    && expiresAtMs > createdAtMs
    && expiresAtMs - createdAtMs <= MAX_PROBE_TTL_MS
    && manifest.triggerText === `[Cyberboss心跳探针 trigger=${runId} nonce=${manifest.nonce}]`
    && manifest.replyText === `[Cyberboss心跳正常 trigger=${runId}]`
  );
}

function readSchedule(filePath) {
  const parsed = readJson(filePath);
  if (!parsed || parsed.version !== STATE_VERSION) {
    return emptySchedule();
  }
  return {
    ...emptySchedule(),
    ...parsed,
    version: STATE_VERSION,
    activeRunId: normalizeRunId(parsed.activeRunId),
    lastRunId: normalizeRunId(parsed.lastRunId),
    consecutiveFailures: Math.max(0, Math.min(100, Number(parsed.consecutiveFailures) || 0)),
    history: Array.isArray(parsed.history) ? parsed.history.slice(-MAX_HISTORY) : [],
    attempts: Array.isArray(parsed.attempts)
      ? parsed.attempts.filter((value) => parseTimeMs(value) > 0).slice(-MAX_HISTORY)
      : [],
    urgentAttempts: readUrgentAttempts(parsed.urgentAttempts),
  };
}

function bindScheduleToTarget(schedule, targetFingerprint) {
  const expected = normalizeText(targetFingerprint);
  if (!expected) {
    throw new Error("canary target fingerprint is required");
  }
  if (normalizeText(schedule.targetFingerprint) === expected) {
    return false;
  }
  schedule.targetFingerprint = expected;
  schedule.activeRunId = "";
  schedule.lastRunId = "";
  schedule.lastAttemptAt = "";
  schedule.lastSuccessAt = "";
  schedule.lastFailureAt = "";
  schedule.lastStatus = "never";
  schedule.lastError = "";
  schedule.lastAction = "target_changed";
  schedule.lastDetail = "canary target changed; a fresh exact-target verification is required";
  schedule.lastReason = "target_changed";
  schedule.lastTriggerLocalId = "";
  schedule.lastReplyLocalId = "";
  schedule.lastQuietWindowMs = 0;
  schedule.lastCursorCommittedAt = "";
  schedule.lastDemandKey = "";
  schedule.nextDueAt = "";
  schedule.consecutiveFailures = 0;
  schedule.lastRepairable = true;
  // Keep global attempts/history so changing a target cannot bypass probe budgets.
  return true;
}

function writeSchedule(filePath, schedule) {
  schedule.version = STATE_VERSION;
  atomicWriteJson(filePath, schedule);
}

function emptySchedule() {
  return {
    version: STATE_VERSION,
    targetFingerprint: "",
    activeRunId: "",
    lastRunId: "",
    lastAttemptAt: "",
    lastSuccessAt: "",
    lastFailureAt: "",
    lastStatus: "never",
    lastError: "",
    lastRepairable: true,
    lastAction: "",
    lastDetail: "",
    lastTriggerLocalId: "",
    lastReplyLocalId: "",
    lastQuietWindowMs: 0,
    lastCursorCommittedAt: "",
    lastReason: "",
    lastDemandKey: "",
    nextDueAt: "",
    consecutiveFailures: 0,
    history: [],
    attempts: [],
    urgentAttempts: [],
  };
}

function acquireRunLock(lockFile, nowMs) {
  const staleAfterMs = MAX_PROBE_TTL_MS + 60_000;
  const ownerToken = crypto.randomBytes(16).toString("hex");
  try {
    const descriptor = fs.openSync(lockFile, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify({
      pid: process.pid,
      ownerToken,
      createdAt: new Date(nowMs).toISOString(),
    })}\n`);
    fs.closeSync(descriptor);
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
    let stat = null;
    try { stat = fs.statSync(lockFile); } catch {}
    if (!stat || nowMs - stat.mtimeMs <= staleAfterMs) {
      return null;
    }
    try { fs.unlinkSync(lockFile); } catch { return null; }
    return acquireRunLock(lockFile, nowMs);
  }
  return () => {
    try {
      const current = readJson(lockFile);
      if (current?.ownerToken === ownerToken) {
        fs.unlinkSync(lockFile);
      }
    } catch {}
  };
}

function pruneRunDirectories(runsDir, maxDirectories) {
  let entries;
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && normalizeRunId(entry.name))
      .map((entry) => ({ name: entry.name, path: path.join(runsDir, entry.name) }))
      .map((entry) => ({ ...entry, mtimeMs: fs.statSync(entry.path).mtimeMs }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
  } catch {
    return;
  }
  for (const entry of entries.slice(maxDirectories)) {
    try { fs.rmSync(entry.path, { recursive: true, force: false }); } catch {}
  }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
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

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function extractMessages(payload) {
  if (Array.isArray(payload)) {
    return payload.filter(isObject);
  }
  for (const key of ["messages", "data", "items"]) {
    const candidate = payload?.[key];
    if (Array.isArray(candidate)) {
      return candidate.filter(isObject);
    }
    if (isObject(candidate)) {
      for (const nestedKey of ["messages", "items", "list"]) {
        if (Array.isArray(candidate[nestedKey])) {
          return candidate[nestedKey].filter(isObject);
        }
      }
    }
  }
  throw codedError("CANARY_MESSAGES_INVALID", "WeFlow messages response did not contain a list");
}

function isOutgoingMessage(message) {
  const isSend = message?.isSend ?? message?.is_send;
  return isSend === true || isSend === 1 || isSend === "1"
    || normalizeText(message?.direction).toLowerCase() === "outgoing";
}

function readMessageText(message) {
  for (const key of ["parsedContent", "content", "text"]) {
    if (typeof message?.[key] === "string" && message[key].trim()) {
      return message[key].trim();
    }
  }
  return "";
}

function isExpectedCanarySender(message, talker) {
  const expected = normalizeText(talker);
  const sender = normalizeText(message?.senderUsername ?? message?.sender_username);
  return Boolean(expected && sender === expected);
}

function readLocalId(message) {
  for (const key of ["localId", "local_id", "id", "msgId", "msg_id"]) {
    const value = optionalLocalId(message?.[key]);
    if (value) {
      return value;
    }
  }
  return "";
}

function optionalLocalId(value) {
  const text = normalizeText(value);
  return /^\d+$/.test(text) && BigInt(text) > 0n ? BigInt(text).toString() : "";
}

function formatDuplicateDetail(observed) {
  return `duplicate canary messages: triggers=${observed.trigger.length}, replies=${observed.reply.length}`;
}

function parseArguments(argv) {
  const options = { force: false, reason: "", demandKey: "", stateDir: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--force") {
      options.force = true;
    } else if (["--reason", "--demand-key", "--state-dir"].includes(value)) {
      const next = argv[index + 1];
      if (typeof next !== "string") {
        throw new Error(`${value} requires a value`);
      }
      index += 1;
      if (value === "--reason") options.reason = next;
      if (value === "--demand-key") options.demandKey = next;
      if (value === "--state-dir") options.stateDir = next;
    } else {
      throw new Error(`unknown argument: ${value}`);
    }
  }
  return options;
}

function requiredEnv(name) {
  const value = normalizeText(process.env[name]);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function boundedIntegerEnv(name, fallback, minimum, maximum) {
  const raw = normalizeText(process.env[name]);
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function normalizeCanaryDesktopIdleSeconds(value) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error("desktop idle requirement must be a non-negative integer");
  }
  return Math.max(MIN_CANARY_DESKTOP_IDLE_SECONDS, numeric);
}

function normalizeBaseUrl(value, name) {
  let parsed;
  try { parsed = new URL(normalizeText(value)); } catch { throw new Error(`${name} must be a valid URL`); }
  if (!["http:", "https:"].includes(parsed.protocol) || !isLoopbackHost(parsed.hostname)) {
    throw new Error(`${name} must use HTTP on a loopback host`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function isLoopbackHost(hostname) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(normalizeText(hostname).toLowerCase());
}

function buildUrl(baseUrl, pathname) {
  return new URL(pathname, `${baseUrl}/`);
}

function normalizeRunId(value) {
  const text = normalizeText(value).toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)
    ? text
    : "";
}

function buildTargetFingerprint({ contact, talker } = {}) {
  const normalizedContact = normalizeText(contact);
  const normalizedTalker = normalizeText(talker);
  if (!normalizedContact || !normalizedTalker) {
    throw new Error("canary contact and talker are required");
  }
  return crypto.createHash("sha256")
    .update(`${normalizedContact}\n${normalizedTalker}`, "utf8")
    .digest("hex");
}

function isUrgentCanaryReason(reason) {
  return ["repair_verification", "user_demand"].includes(normalizeText(reason));
}

function buildUrgentDemandFingerprint({ targetFingerprint, reason, demandKey } = {}) {
  const normalizedTarget = normalizeText(targetFingerprint);
  const normalizedReason = normalizeText(reason);
  const normalizedDemand = normalizeText(demandKey);
  if (!/^[0-9a-f]{64}$/u.test(normalizedTarget)
    || !isUrgentCanaryReason(normalizedReason)
    || !normalizedDemand) {
    throw new Error("urgent canary target, reason, and demand key are required");
  }
  if (normalizedDemand.length > 512) {
    throw new Error("urgent canary demand key must not exceed 512 characters");
  }
  return crypto.createHash("sha256")
    .update(`${normalizedTarget}\n${normalizedReason}\n${normalizedDemand}`, "utf8")
    .digest("hex");
}

function readUrgentAttempts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isObject)
    .map((attempt) => ({
      at: normalizeText(attempt.at),
      runId: normalizeRunId(attempt.runId),
      reason: normalizeText(attempt.reason),
      demandFingerprint: normalizeText(attempt.demandFingerprint).toLowerCase(),
      state: ["reserved", "handled", "completed", "released"].includes(normalizeText(attempt.state))
        ? normalizeText(attempt.state)
        : "handled",
      result: normalizeTerminalCanaryOutcome(attempt.result, attempt.runId),
    }))
    .filter((attempt) => (
      parseTimeMs(attempt.at) > 0
      && Boolean(attempt.runId)
      && isUrgentCanaryReason(attempt.reason)
      && /^[0-9a-f]{64}$/u.test(attempt.demandFingerprint)
    ))
    .slice(-MAX_URGENT_DEMAND_HISTORY);
}

function resolveScheduleHealthy(lastStatus) {
  const normalized = normalizeText(lastStatus);
  if (normalized === "healthy") return true;
  if (normalized === "failed") return false;
  return null;
}

function parseTimeMs(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeText(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({
      version: STATE_VERSION,
      healthy: false,
      action: "error",
      checkedAt: new Date().toISOString(),
      code: normalizeText(error?.code) || "CANARY_RUNNER_ERROR",
      ...(error?.repairable === false ? { repairable: false } : {}),
      error: formatError(error),
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  MAX_PROBE_TTL_MS,
  acquireRunLock,
  atomicWriteJson,
  bindScheduleToTarget,
  buildTargetFingerprint,
  buildUrgentDemandFingerprint,
  decideCanaryDue,
  emptySchedule,
  getCanaryAttemptGate,
  getUrgentCanaryAttemptGate,
  inspectCanaryMessages,
  inspectCursorDrain,
  normalizeCanaryDesktopIdleSeconds,
  resolveScheduleHealthy,
  readSchedule,
  runScheduledCanary,
  validateManifest,
  validateMilestones,
};
