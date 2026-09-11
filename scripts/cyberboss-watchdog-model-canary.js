#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { assertWeFlowCanaryTalkerIsolation } = require("../src/core/config");
const {
  MAX_MODEL_CANARY_TTL_MS,
  MODEL_CANARY_VERSION,
  createModelCanaryDesktopInputLeaseReceipt,
  createModelCanaryManifest,
  validateModelCanaryDesktopInputLeaseReceipt,
  validateModelCanaryManifest,
} = require("../src/integrations/weflow-model-canary");
const { hashWeFlowMessageContent } = require("../src/integrations/weflow-message-ledger-store");

const PROJECT_ROOT = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(PROJECT_ROOT, ".env") });
const DEFAULT_USER_STATE_DIR = path.join(os.homedir(), ".cyberboss");
require("dotenv").config({ path: path.join(DEFAULT_USER_STATE_DIR, ".env"), override: false });
const bootstrapStateDir = normalizeText(process.env.CYBERBOSS_STATE_DIR);
if (bootstrapStateDir && path.resolve(bootstrapStateDir) !== path.resolve(DEFAULT_USER_STATE_DIR)) {
  require("dotenv").config({ path: path.join(path.resolve(bootstrapStateDir), ".env"), override: false });
}

const STATE_VERSION = 1;
const MODE = "model_e2e";
const DEFAULT_ROUTINE_INTERVAL_MS = 24 * 60 * 60_000;
const MIN_ROUTINE_INTERVAL_MS = 24 * 60 * 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_QUIET_WINDOW_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_BRIDGE_SEND_TIMEOUT_MS = 20_000;
const MIN_DESKTOP_IDLE_SECONDS = 300;
const MAX_ATTEMPTS_PER_HOUR = 1;
const MAX_ATTEMPTS_PER_DAY = 2;
const MAX_HISTORY = 64;
const MAX_OBLIGATION_HISTORY = 256;
const MAX_RUN_DIRECTORIES = 64;
const MESSAGE_LIMIT = 200;
const BRIDGE_DESKTOP_INPUT_LEASE_DIRECTORY = "weflow-uia-desktop-input-leases";

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const config = readConfig(options);
  const result = await runScheduledModelCanary(config);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.healthy === false) process.exitCode = 1;
}

async function runScheduledModelCanary(config, dependencies = {}) {
  const now = dependencies.now || (() => Date.now());
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const sleepImpl = dependencies.sleep || sleep;
  const nowMs = normalizeNowMs(now());

  if (config.enabled !== true) {
    return disabledResult(nowMs);
  }
  assertWeFlowCanaryTalkerIsolation({
    weflowInboxChat: config.primaryTalker,
    weflowCanaryChat: config.talker,
  });
  config.targetFingerprint = normalizeFingerprint(config.targetFingerprint)
    || buildTargetFingerprint({ contact: config.contact, talker: config.talker });
  config.explicitDemand = Boolean(normalizeText(config.demandKey));
  config.reason = config.explicitDemand ? "user_demand" : "routine";
  config.obligationKey = config.explicitDemand ? normalizeDemandKey(config.demandKey) : "";
  config.obligationFingerprint = config.explicitDemand ? hashText(config.obligationKey) : "";

  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.mkdirSync(config.runsDir, { recursive: true });
  const releaseLock = acquireOwnerLock(config.lockFile, nowMs, config.probeTimeoutMs);
  if (!releaseLock) {
    const schedule = readSchedule(config.scheduleFile);
    const sameTarget = !normalizeText(schedule.targetFingerprint)
      || normalizeText(schedule.targetFingerprint) === config.targetFingerprint;
    return {
      version: STATE_VERSION,
      mode: MODE,
      healthy: null,
      action: sameTarget ? "already_running" : "target_changed_pending",
      attempted: false,
      repairable: false,
      checkedAt: new Date(nowMs).toISOString(),
      runId: sameTarget ? normalizeRunId(schedule.activeRunId) : "",
      lastRunId: sameTarget ? normalizeRunId(schedule.lastRunId) : "",
      lastSuccessAt: sameTarget ? normalizeIsoTime(schedule.lastSuccessAt) : "",
      consecutiveFailures: sameTarget ? normalizeCount(schedule.consecutiveFailures) : 0,
      nextDueAt: new Date(nowMs).toISOString(),
      detail: sameTarget
        ? "another model E2E process owns the bounded owner-token lock"
        : "the active model E2E lock belongs to a different target",
    };
  }

  try {
    const schedule = readSchedule(config.scheduleFile);
    const persistedTarget = normalizeFingerprint(schedule.targetFingerprint);
    if (persistedTarget && persistedTarget !== config.targetFingerprint
      && normalizeText(schedule.activeRunId)) {
      return {
        version: STATE_VERSION,
        mode: MODE,
        healthy: null,
        action: "target_changed_pending",
        attempted: false,
        repairable: false,
        checkedAt: new Date(nowMs).toISOString(),
        runId: normalizeRunId(schedule.activeRunId),
        lastRunId: "",
        lastSuccessAt: "",
        consecutiveFailures: 0,
        nextDueAt: new Date(nowMs).toISOString(),
        detail: "an active model E2E run belongs to the previous target; no new target probe was started",
      };
    }
    bindScheduleToTarget(schedule, config.targetFingerprint);
    const activeState = readActiveRun(config, schedule, nowMs);
    if (activeState.failure) {
      finalizeRun(config, schedule, activeState.run, activeState.failure, nowMs);
      return annotateOutcome(activeState.failure, schedule);
    }
    const active = activeState.run;

    if (active && config.explicitDemand
      && active.manifest.obligationFingerprint !== config.obligationFingerprint) {
      return {
        version: STATE_VERSION,
        mode: MODE,
        healthy: null,
        action: "obligation_wait",
        attempted: false,
        repairable: false,
        checkedAt: new Date(nowMs).toISOString(),
        runId: active.runId,
        lastRunId: active.runId,
        lastSuccessAt: normalizeIsoTime(schedule.lastSuccessAt),
        consecutiveFailures: normalizeCount(schedule.consecutiveFailures),
        nextDueAt: active.manifest.expiresAt,
        detail: "a different bounded model E2E obligation is active; this demand was not executed or credited",
      };
    }

    let decision = null;
    if (!active) {
      decision = decideModelCanaryDue(schedule, {
        nowMs,
        explicitDemand: config.explicitDemand,
        demandKey: config.obligationKey,
        obligationFingerprint: config.obligationFingerprint,
        targetFingerprint: config.targetFingerprint,
        routineIntervalMs: config.routineIntervalMs,
      });
      if (!decision.due) {
        if (decision.reason === "demand_duplicate" && decision.previousHealthy === false) {
          const reconciled = reconcileHandledModelCanarySuccess(config, schedule, {
            runId: decision.previousRunId,
            obligationFingerprint: config.obligationFingerprint,
            nowMs,
          });
          if (reconciled) {
            return annotateOutcome(reconciled, schedule);
          }
        }
        schedule.nextDueAt = new Date(decision.nextDueAtMs).toISOString();
        writeSchedule(config.scheduleFile, schedule);
        const previous = resolveScheduleHealthy(schedule.lastStatus);
        return {
          version: STATE_VERSION,
          mode: MODE,
          healthy: decision.reason === "demand_duplicate" ? decision.previousHealthy : previous,
          action: decision.reason === "demand_duplicate"
            ? "demand_already_handled"
            : decision.reason.startsWith("budget_")
              ? "budget_wait"
              : "not_due",
          attempted: false,
          repairable: false,
          checkedAt: new Date(nowMs).toISOString(),
          runId: decision.previousRunId || "",
          lastRunId: normalizeRunId(schedule.lastRunId),
          lastSuccessAt: normalizeIsoTime(schedule.lastSuccessAt),
          consecutiveFailures: normalizeCount(schedule.consecutiveFailures),
          nextDueAt: new Date(decision.nextDueAtMs).toISOString(),
          detail: decision.reason,
        };
      }
      config.obligationKey = decision.obligationKey;
      config.obligationFingerprint = decision.obligationFingerprint;
    }

    const run = active || createRun(config, schedule, { nowMs });
    let outcome;
    try {
      outcome = await executeRun(config, run, { fetchImpl, sleepImpl, now });
    } catch (error) {
      outcome = error?.code === "MODEL_CANARY_DESKTOP_ACTIVE"
        ? buildDesktopBusyOutcome(run, error, normalizeNowMs(now()))
        : buildFailureOutcome(run, error, normalizeNowMs(now()));
    }
    finalizeRun(config, schedule, run, outcome, normalizeNowMs(now()));
    pruneRunDirectories(config.runsDir, MAX_RUN_DIRECTORIES);
    return annotateOutcome(outcome, schedule);
  } finally {
    releaseLock();
  }
}

function decideModelCanaryDue(schedule, {
  nowMs,
  explicitDemand = false,
  demandKey = "",
  obligationFingerprint = "",
  targetFingerprint = "",
  routineIntervalMs = DEFAULT_ROUTINE_INTERVAL_MS,
} = {}) {
  const normalizedNowMs = normalizeNowMs(nowMs);
  if (explicitDemand) {
    const key = normalizeDemandKey(demandKey);
    const fingerprint = normalizeFingerprint(obligationFingerprint) || hashText(key);
    if (!key || fingerprint !== hashText(key)) {
      throw new Error("explicit model E2E demand key and fingerprint are required");
    }
    const previous = readObligations(schedule.obligations)
      .find((entry) => entry.fingerprint === fingerprint && entry.state !== "released");
    if (previous) {
      return {
        due: false,
        reason: "demand_duplicate",
        nextDueAtMs: parseTimeMs(schedule.nextDueAt) || normalizedNowMs,
        previousRunId: previous.runId,
        previousHealthy: previous.healthy,
      };
    }
    const gate = getModelCanaryAttemptGate(schedule.attempts, normalizedNowMs);
    if (!gate.allowed) {
      return { due: false, reason: gate.reason, nextDueAtMs: gate.retryAtMs };
    }
    return {
      due: true,
      reason: "user_demand",
      nextDueAtMs: normalizedNowMs,
      obligationKey: key,
      obligationFingerprint: fingerprint,
    };
  }

  const target = normalizeFingerprint(targetFingerprint || schedule.targetFingerprint);
  if (!target) throw new Error("model E2E target fingerprint is required");
  const interval = Math.max(MIN_ROUTINE_INTERVAL_MS, normalizePositiveInteger(routineIntervalMs, DEFAULT_ROUTINE_INTERVAL_MS));
  const lastAttemptMs = parseTimeMs(schedule.lastAttemptAt);
  const dueAtMs = (lastAttemptMs || 0) + interval;
  if (dueAtMs > normalizedNowMs) {
    return { due: false, reason: "routine_interval", nextDueAtMs: dueAtMs };
  }
  const gate = getModelCanaryAttemptGate(schedule.attempts, normalizedNowMs);
  if (!gate.allowed) {
    return { due: false, reason: gate.reason, nextDueAtMs: gate.retryAtMs };
  }
  const anchor = lastAttemptMs ? new Date(dueAtMs).toISOString() : "bootstrap";
  const key = `routine:${target}:${anchor}`;
  return {
    due: true,
    reason: "routine_interval",
    nextDueAtMs: normalizedNowMs,
    obligationKey: key,
    obligationFingerprint: hashText(key),
  };
}

function getModelCanaryAttemptGate(attempts, nowMs) {
  const parsed = (Array.isArray(attempts) ? attempts : [])
    .map(parseTimeMs)
    .filter((value) => value > 0 && value <= nowMs + 10_000)
    .sort((left, right) => left - right);
  const daily = parsed.filter((value) => value > nowMs - 24 * 60 * 60_000);
  const hourly = daily.filter((value) => value > nowMs - 60 * 60_000);
  if (daily.length >= MAX_ATTEMPTS_PER_DAY) {
    return { allowed: false, reason: "budget_daily", retryAtMs: daily[0] + 24 * 60 * 60_000 };
  }
  if (hourly.length >= MAX_ATTEMPTS_PER_HOUR) {
    return { allowed: false, reason: "budget_hourly", retryAtMs: hourly[0] + 60 * 60_000 };
  }
  return { allowed: true, reason: "ready", retryAtMs: nowMs };
}

function createRun(config, schedule, { nowMs }) {
  const previousLastAttemptAt = normalizeIsoTime(schedule.lastAttemptAt);
  const created = createModelCanaryManifest({
    stateDir: config.stateDir,
    talker: config.talker,
    contact: config.contact,
    demandKey: config.obligationKey,
    nowMs,
    ttlMs: config.probeTimeoutMs,
  });
  const run = {
    runId: created.manifest.runId,
    runDir: created.runDir,
    manifest: created.manifest,
    resumed: false,
    startedAtMs: nowMs,
    previousLastAttemptAt,
  };
  const createdAt = created.manifest.createdAt;
  schedule.activeRunId = run.runId;
  schedule.lastRunId = run.runId;
  schedule.lastAttemptAt = createdAt;
  schedule.lastReason = config.reason;
  schedule.attempts = [
    ...(Array.isArray(schedule.attempts) ? schedule.attempts : [])
      .filter((value) => parseTimeMs(value) > nowMs - 24 * 60 * 60_000),
    createdAt,
  ].slice(-MAX_HISTORY);
  schedule.obligations = [
    ...readObligations(schedule.obligations),
    {
      fingerprint: created.manifest.obligationFingerprint,
      runId: run.runId,
      reason: config.reason,
      at: createdAt,
      state: "reserved",
      healthy: null,
    },
  ].slice(-MAX_OBLIGATION_HISTORY);
  writeSchedule(config.scheduleFile, schedule);
  return run;
}

function readActiveRun(config, schedule, nowMs) {
  const rawActive = normalizeText(schedule.activeRunId);
  if (!rawActive) return { run: null, failure: null };
  const runId = normalizeRunId(rawActive);
  const runDir = runId ? path.join(config.runsDir, runId) : "";
  const rawManifest = runDir ? readJson(runDir && path.join(runDir, "manifest.json")) : null;
  const checked = validateModelCanaryManifest(rawManifest, {
    expectedTalker: config.talker,
    expectedContact: config.contact,
    nowMs: Math.min(nowMs, parseTimeMs(rawManifest?.expiresAt) || nowMs),
  });
  const run = {
    runId: runId || rawActive,
    runDir: runDir || config.runsDir,
    manifest: checked.ok ? checked.manifest : (rawManifest || {}),
    resumed: true,
    startedAtMs: nowMs,
  };
  if (!runId || !checked.ok || checked.manifest.targetFingerprint !== config.targetFingerprint) {
    return {
      run,
      failure: buildFailureOutcome(
        run,
        codedError("MODEL_CANARY_ACTIVE_INVALID", `persisted active model E2E run is invalid: ${checked.reason || "run_id_invalid"}`),
        nowMs,
      ),
    };
  }
  if (parseTimeMs(checked.manifest.expiresAt) <= nowMs) {
    return {
      run,
      failure: buildFailureOutcome(
        run,
        codedError("MODEL_CANARY_EXPIRED", "persisted model E2E run expired before complete proof"),
        nowMs,
      ),
    };
  }
  return { run, failure: null };
}

async function executeRun(config, run, { fetchImpl, sleepImpl, now }) {
  const { manifest, runDir } = run;
  const deadlineMs = parseTimeMs(manifest.expiresAt);
  const triggerClaimDir = path.join(runDir, "trigger-send-claim");
  const initialMessages = await fetchMessages(config, fetchImpl);
  let observed = inspectModelCanaryMessages(initialMessages, manifest);
  assertNoDuplicates(observed);
  let triggerLocalId = observed.trigger[0]?.localId || "";
  let bridgeVerified = false;
  const existingClaim = fs.existsSync(triggerClaimDir);
  const leaseReceiptFile = path.join(runDir, "desktop-input-lease.json");
  let existingLeaseReceipt = readJson(leaseReceiptFile);
  if (existingLeaseReceipt) {
    const checkedLease = validateModelCanaryDesktopInputLeaseReceipt(
      existingLeaseReceipt,
      manifest,
      { nowMs: normalizeNowMs(now()) },
    );
    if (!checkedLease.ok) {
      throw codedError(
        "MODEL_CANARY_DESKTOP_LEASE_INVALID",
        `persisted model E2E desktop input lease failed manifest binding: ${checkedLease.reason}`,
      );
    }
  }
  if (!existingLeaseReceipt && existingClaim) {
    const recovered = recoverBridgeDesktopInputLease(config, manifest, {
      nowMs: normalizeNowMs(now()),
    });
    if (recovered) {
      atomicWriteJson(leaseReceiptFile, recovered.receipt);
      existingLeaseReceipt = recovered.receipt;
    }
  }
  if (triggerLocalId && !existingClaim) {
    throw codedError(
      "MODEL_CANARY_TRIGGER_UNCLAIMED",
      "an exact trigger exists without the runner's durable send claim",
    );
  }

  if (!triggerLocalId && !existingClaim) {
    acquireClaimDirectory(triggerClaimDir, {
      version: STATE_VERSION,
      mode: MODE,
      runId: manifest.runId,
      nonce: manifest.nonce,
      obligationFingerprint: manifest.obligationFingerprint,
      ownerToken: crypto.randomBytes(16).toString("hex"),
      claimedAt: new Date(normalizeNowMs(now())).toISOString(),
    });
    let payload;
    try {
      payload = await requestJson(
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
              MIN_DESKTOP_IDLE_SECONDS,
              Number(config.desktopIdleSeconds) || MIN_DESKTOP_IDLE_SECONDS,
            ),
            exactContact: true,
            expectedContact: config.contact,
            expectedTalker: config.talker,
            desktopInputLeaseRequest: {
              version: MODEL_CANARY_VERSION,
              mode: MODE,
              runId: manifest.runId,
              nonce: manifest.nonce,
              targetFingerprint: manifest.targetFingerprint,
              replyIdempotencyKey: manifest.replyIdempotencyKey,
              expiresAt: manifest.expiresAt,
            },
          }),
        },
        {
          label: "watchdog model E2E trigger",
          timeoutMs: config.bridgeSendTimeoutMs + config.requestTimeoutMs,
          fetchImpl,
        },
      );
    } catch (error) {
      if (["CANARY_DESKTOP_ACTIVE", "DESKTOP_ACTIVE", "DESKTOP_NOT_IDLE"].includes(error?.code)) {
        error.code = "MODEL_CANARY_DESKTOP_ACTIVE";
        error.certainPredispatch = true;
        throw error;
      }
      const recovered = recoverBridgeDesktopInputLease(config, manifest, {
        nowMs: normalizeNowMs(now()),
      });
      if (recovered) {
        payload = {
          dispatched: true,
          verified: false,
          uncertain: true,
          targetVerified: true,
          selectedContact: config.contact,
          verifiedTalker: config.talker,
          desktopInputLease: recovered.rawLease,
          recoveredAfterResponseFailure: true,
        };
      } else {
        if (error && typeof error === "object" && error.deliveryUncertain == null) {
          error.deliveryUncertain = true;
        }
        throw error;
      }
    }
    if (payload?.dispatched !== true) {
      const error = codedError("MODEL_CANARY_TRIGGER_NOT_DISPATCHED", "UIA bridge did not dispatch the model E2E trigger");
      error.certainPredispatch = true;
      throw error;
    }
    if (payload?.targetVerified !== true
      || normalizeText(payload?.selectedContact) !== config.contact
      || normalizeText(payload?.verifiedTalker) !== config.talker) {
      throw codedError("MODEL_CANARY_TARGET_NOT_CONFIRMED", "UIA bridge did not prove the exact model E2E contact and talker");
    }
    let desktopInputLeaseReceipt;
    try {
      desktopInputLeaseReceipt = createModelCanaryDesktopInputLeaseReceipt(
        manifest,
        payload?.desktopInputLease,
        { nowMs: normalizeNowMs(now()) },
      );
      atomicWriteJson(leaseReceiptFile, desktopInputLeaseReceipt);
    } catch (error) {
      const leaseError = codedError(
        "MODEL_CANARY_DESKTOP_LEASE_INVALID",
        `UIA bridge did not return a durable manifest-bound desktop input lease: ${formatError(error)}`,
      );
      leaseError.deliveryUncertain = true;
      throw leaseError;
    }
    const returnedLocalId = optionalLocalId(payload?.localId);
    bridgeVerified = payload?.verified === true && Boolean(returnedLocalId);
    triggerLocalId = returnedLocalId;
    atomicWriteJson(path.join(runDir, "trigger-dispatched.json"), {
      version: STATE_VERSION,
      mode: MODE,
      runId: manifest.runId,
      nonce: manifest.nonce,
      obligationFingerprint: manifest.obligationFingerprint,
      triggerLocalId,
      targetVerified: true,
      bridgeVerified,
      desktopInputLeaseManifestFingerprint: desktopInputLeaseReceipt.manifestFingerprint,
      recordedAt: new Date(normalizeNowMs(now())).toISOString(),
    });
  }

  if (existingClaim && !readJson(leaseReceiptFile)) {
    const error = codedError(
      "MODEL_CANARY_DESKTOP_LEASE_MISSING",
      "model E2E trigger claim exists without its durable desktop input lease receipt",
    );
    error.deliveryUncertain = true;
    throw error;
  }
  const durableDesktopInputLease = readJson(leaseReceiptFile);
  const checkedDurableDesktopInputLease = validateModelCanaryDesktopInputLeaseReceipt(
    durableDesktopInputLease,
    manifest,
    { nowMs: normalizeNowMs(now()) },
  );
  if (!checkedDurableDesktopInputLease.ok) {
    throw codedError(
      "MODEL_CANARY_DESKTOP_LEASE_INVALID",
      `model E2E durable desktop input lease receipt is invalid: ${checkedDurableDesktopInputLease.reason}`,
    );
  }
  const desktopInputLeaseManifestFingerprint = checkedDurableDesktopInputLease
    .receipt.manifestFingerprint;

  let lastDetail = existingClaim && !triggerLocalId
    ? "trigger dispatch was previously claimed; reconciling without resending"
    : "waiting for model E2E milestones";
  let quietStartedAtMs = 0;
  while (normalizeNowMs(now()) < deadlineMs) {
    const failure = inspectTerminalFailure(runDir, manifest);
    if (failure) throw failure;
    const receipts = readMilestoneReceipts(runDir);
    const messages = await fetchMessages(config, fetchImpl);
    observed = inspectModelCanaryMessages(messages, manifest);
    assertNoDuplicates(observed);
    triggerLocalId = triggerLocalId || observed.trigger[0]?.localId || "";
    const replyLocalId = observed.reply[0]?.localId || "";
    const milestones = validateModelMilestones({
      manifest,
      receipts,
      triggerLocalId,
      replyLocalId,
    });
    if (milestones.ok) {
      const drain = inspectModelCursorDrain(config.cursorFile, {
        manifest,
        triggerLocalId: milestones.triggerLocalId,
        replyLocalId: milestones.replyLocalId,
        replyObserved: receipts.replyObserved,
      });
      if (!drain.ok) {
        quietStartedAtMs = 0;
        lastDetail = drain.detail;
      } else {
        quietStartedAtMs = quietStartedAtMs || normalizeNowMs(now());
        const quietElapsedMs = Math.max(0, normalizeNowMs(now()) - quietStartedAtMs);
        if (quietElapsedMs >= config.quietWindowMs) {
          return {
            version: STATE_VERSION,
            mode: MODE,
            healthy: true,
            action: "verified",
            attempted: true,
            repairable: false,
            checkedAt: new Date(normalizeNowMs(now())).toISOString(),
            runId: manifest.runId,
            reason: config.reason,
            resumed: run.resumed,
            bridgeVerified,
            targetVerified: true,
            targetContact: manifest.contact,
            targetTalker: manifest.talker,
            targetFingerprint: manifest.targetFingerprint,
            obligationFingerprint: manifest.obligationFingerprint,
            desktopInputLeaseManifestFingerprint,
            triggerLocalId: milestones.triggerLocalId,
            replyLocalId: milestones.replyLocalId,
            threadId: milestones.threadId,
            turnId: milestones.turnId,
            quietWindowMs: config.quietWindowMs,
            cursorCommittedAt: drain.cursorCommittedAt,
            elapsedMs: Math.max(0, normalizeNowMs(now()) - run.startedAtMs),
            detail: "Azzy trigger, runtime handoff, model final, exact reply, turn release, durable cursor commit, and quiet window were proven",
          };
        }
        lastDetail = `waiting for ${Math.max(0, config.quietWindowMs - quietElapsedMs)}ms quiet window`;
      }
    } else {
      quietStartedAtMs = 0;
      lastDetail = milestones.detail;
    }
    await sleepImpl(Math.min(config.pollIntervalMs, Math.max(0, deadlineMs - normalizeNowMs(now()))));
  }
  const error = codedError("MODEL_CANARY_TIMEOUT", `model E2E timed out: ${lastDetail}`);
  error.deliveryUncertain = fs.existsSync(triggerClaimDir);
  throw error;
}

function readMilestoneReceipts(runDir) {
  return {
    ingested: readJson(path.join(runDir, "ingested.json")),
    handoff: readJson(path.join(runDir, "handoff.json")),
    modelCompleted: readJson(path.join(runDir, "model-completed.json")),
    replyDispatched: readJson(path.join(runDir, "reply-dispatched.json")),
    replyObserved: readJson(path.join(runDir, "reply-observed.json")),
    turnReleased: readJson(path.join(runDir, "turn-released.json")),
  };
}

function validateModelMilestones({ manifest, receipts, triggerLocalId, replyLocalId }) {
  const ordered = [
    ["ingested", receipts?.ingested],
    ["handoff", receipts?.handoff],
    ["model-completed", receipts?.modelCompleted],
    ["reply-dispatched", receipts?.replyDispatched],
    ["reply-observed", receipts?.replyObserved],
    ["turn-released", receipts?.turnReleased],
  ];
  for (const [name, receipt] of ordered) {
    if (!receipt) return { ok: false, detail: `${name} receipt is pending` };
    if (!isBoundReceipt(receipt, manifest)) {
      return { ok: false, detail: `${name} receipt failed manifest binding validation` };
    }
  }
  if (normalizeText(receipts.ingested.status) !== "ingested"
    || normalizeText(receipts.handoff.status) !== "accepted"
    || normalizeText(receipts.modelCompleted.status) !== "completed"
    || receipts.modelCompleted.assistantFinalPresent !== true
    || !["verified", "dispatched", "reconciled_from_echo"].includes(normalizeText(receipts.replyDispatched.status))
    || normalizeText(receipts.replyObserved.status) !== "observed"
    || normalizeText(receipts.turnReleased.status) !== "released") {
    return { ok: false, detail: "one or more model E2E milestone statuses are invalid" };
  }
  const finalSha256 = normalizeFingerprint(receipts.modelCompleted.assistantFinalSha256);
  const finalLength = Number(receipts.modelCompleted.assistantFinalLength);
  const finalBytes = Number(receipts.modelCompleted.assistantFinalBytes);
  if (!finalSha256
    || !Number.isSafeInteger(finalLength) || finalLength <= 0
    || !Number.isSafeInteger(finalBytes) || finalBytes < finalLength) {
    return { ok: false, detail: "model completion digest, code-point length, or UTF-8 byte proof is invalid" };
  }
  const threadId = normalizeText(receipts.handoff.threadId);
  const turnId = normalizeText(receipts.handoff.turnId);
  if (!threadId || !turnId) return { ok: false, detail: "runtime handoff threadId or turnId is missing" };
  for (const [name, receipt] of [
    ["model-completed", receipts.modelCompleted],
    ["reply-dispatched", receipts.replyDispatched],
    ["turn-released", receipts.turnReleased],
  ]) {
    const receiptThreadId = normalizeText(receipt.threadId);
    const receiptTurnId = normalizeText(receipt.turnId);
    if (!receiptThreadId || !receiptTurnId || receiptThreadId !== threadId || receiptTurnId !== turnId) {
      return { ok: false, detail: `${name} runtime thread/turn binding is missing or inconsistent` };
    }
  }
  const observedThreadId = normalizeText(receipts.replyObserved.threadId);
  const observedTurnId = normalizeText(receipts.replyObserved.turnId);
  if ((observedThreadId || observedTurnId)
    && (!observedThreadId || !observedTurnId || observedThreadId !== threadId || observedTurnId !== turnId)) {
    return { ok: false, detail: "reply-observed runtime thread/turn binding is inconsistent" };
  }
  const expectedKind = manifest.replyMessageKind;
  const expectedKey = manifest.replyIdempotencyKey;
  for (const receipt of [receipts.replyDispatched, receipts.replyObserved]) {
    if (normalizeText(receipt.messageKind) !== expectedKind
      || normalizeText(receipt.idempotencyKey) !== expectedKey) {
      return { ok: false, detail: "model E2E reply delivery identity is inconsistent" };
    }
  }
  const ingestedTriggerId = optionalLocalId(receipts.ingested.triggerLocalId);
  const dispatchedReplyId = optionalLocalId(receipts.replyDispatched.replyLocalId);
  const observedReplyId = optionalLocalId(receipts.replyObserved.replyLocalId);
  const resolvedTriggerId = optionalLocalId(triggerLocalId) || ingestedTriggerId;
  const resolvedReplyId = optionalLocalId(replyLocalId) || observedReplyId || dispatchedReplyId;
  if (!resolvedTriggerId || !ingestedTriggerId || resolvedTriggerId !== ingestedTriggerId) {
    return { ok: false, detail: "model E2E trigger localId is missing or inconsistent" };
  }
  if (!resolvedReplyId || !dispatchedReplyId || !observedReplyId
    || resolvedReplyId !== dispatchedReplyId || resolvedReplyId !== observedReplyId) {
    return { ok: false, detail: "model E2E reply localId is missing or inconsistent" };
  }
  if (BigInt(resolvedReplyId) <= BigInt(resolvedTriggerId)) {
    return { ok: false, detail: "model E2E reply did not follow its trigger" };
  }
  return { ok: true, triggerLocalId: resolvedTriggerId, replyLocalId: resolvedReplyId, threadId, turnId };
}

function isBoundReceipt(receipt, manifest) {
  return receipt?.version === MODEL_CANARY_VERSION
    && normalizeText(receipt?.mode) === MODE
    && normalizeText(receipt?.runId).toLowerCase() === manifest.runId
    && normalizeText(receipt?.nonce).toLowerCase() === manifest.nonce
    && normalizeFingerprint(receipt?.obligationFingerprint) === manifest.obligationFingerprint;
}

function inspectTerminalFailure(runDir, manifest) {
  const candidates = [
    ["handoff-failed.json", "MODEL_CANARY_HANDOFF_FAILED"],
    ["approval-denied.json", "MODEL_CANARY_APPROVAL_DENIED"],
    ["tool-attempted.json", "MODEL_CANARY_TOOL_ATTEMPTED"],
    ["turn-release-failed.json", "MODEL_CANARY_TURN_RELEASE_FAILED"],
    ["reply-delivery-failed.json", "MODEL_CANARY_REPLY_FAILED"],
    ["turn-completed-without-final.json", "MODEL_CANARY_FINAL_MISSING"],
    ["turn-failed.json", "MODEL_CANARY_TURN_FAILED"],
  ];
  for (const [name, code] of candidates) {
    const receipt = readJson(path.join(runDir, name));
    if (!receipt) continue;
    if (!isBoundReceipt(receipt, manifest)) {
      return codedError("MODEL_CANARY_FAILURE_RECEIPT_INVALID", `${name} failed manifest binding validation`);
    }
    return codedError(code, normalizeText(receipt.error || receipt.reason) || `${name} was recorded`);
  }
  return null;
}

function inspectModelCanaryMessages(messages, manifest) {
  const unique = (expectedText) => {
    const byId = new Map();
    for (const message of messages) {
      if (!isOutgoingMessage(message)
        || normalizeText(message?.senderUsername ?? message?.sender_username) !== manifest.talker
        || readMessageText(message) !== expectedText) continue;
      const localId = optionalLocalId(readLocalId(message));
      if (localId) byId.set(localId, { localId, message });
    }
    return [...byId.values()].sort((left, right) => BigInt(left.localId) < BigInt(right.localId) ? -1 : 1);
  };
  return { trigger: unique(manifest.triggerText), reply: unique(manifest.replyText) };
}

function assertNoDuplicates(observed) {
  if (observed.trigger.length > 1 || observed.reply.length > 1) {
    throw codedError(
      "MODEL_CANARY_DUPLICATE",
      `duplicate model E2E messages: triggers=${observed.trigger.length}, replies=${observed.reply.length}`,
    );
  }
}

function inspectModelCursorDrain(cursorFile, { manifest, triggerLocalId, replyLocalId, replyObserved } = {}) {
  let parsed;
  let stat;
  try {
    const bytes = fs.readFileSync(cursorFile);
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    stat = fs.statSync(cursorFile);
  } catch (error) {
    return { ok: false, detail: `dedicated canary cursor is unavailable: ${formatError(error)}` };
  }
  const cursorTalker = normalizeText(parsed?.talker);
  const lastLocalId = optionalLocalId(parsed?.lastLocalId);
  const seen = Array.isArray(parsed?.seenIdentities)
    ? parsed.seenIdentities.filter((value) => typeof value === "string")
    : null;
  if (parsed?.version !== STATE_VERSION || cursorTalker !== manifest?.talker || !seen
    || !normalizeIsoTime(parsed?.updatedAt) || !normalizeIsoTime(parsed?.lastPolledAt)) {
    return { ok: false, detail: "dedicated canary cursor schema or Azzy talker is invalid" };
  }
  const trigger = optionalLocalId(triggerLocalId);
  const reply = optionalLocalId(replyLocalId);
  const committed = (localId) => Boolean(
    localId && (seen.includes(`local:${localId}`) || (lastLocalId && BigInt(lastLocalId) >= BigInt(localId))),
  );
  if (!committed(trigger) || !committed(reply)) {
    return { ok: false, detail: "dedicated canary cursor has not committed the model trigger and reply localIds" };
  }
  const observedAtMs = parseTimeMs(replyObserved?.recordedAt ?? replyObserved?.replyObservedAt);
  if (observedAtMs && stat.mtimeMs + 1 < observedAtMs) {
    return { ok: false, detail: "dedicated canary cursor was not committed after reply observation" };
  }
  return { ok: true, cursorCommittedAt: new Date(stat.mtimeMs).toISOString() };
}

// A completed echo may win the write-once race against StreamDelivery's
// reply_dispatched event.  Older builds wrote that echo receipt without the
// already-durable runtime thread/turn identity and eventually timed out even
// though every side effect had completed.  An explicit replay of the *same*
// handled demand may repair only that exact historical receipt shape.  This is
// deliberately a local proof reconciliation: it performs no HTTP fetch, no UI
// send, and does not reserve another attempt.
function reconcileHandledModelCanarySuccess(config, schedule, {
  runId,
  obligationFingerprint,
  nowMs = Date.now(),
} = {}) {
  try {
    const normalizedRunId = normalizeRunId(runId);
    const normalizedObligation = normalizeFingerprint(obligationFingerprint);
    if (!normalizedRunId || !normalizedObligation
      || normalizeFingerprint(schedule.targetFingerprint) !== config.targetFingerprint
      || normalizeRunId(schedule.activeRunId)
      || normalizeRunId(schedule.lastRunId) !== normalizedRunId
      || normalizeText(schedule.lastStatus) !== "failed"
      || normalizeText(schedule.lastAction) !== "failed") {
      return null;
    }
    const obligations = readObligations(schedule.obligations)
      .filter((entry) => entry.fingerprint === normalizedObligation && entry.state !== "released");
    if (obligations.length !== 1
      || obligations[0].runId !== normalizedRunId
      || obligations[0].state !== "handled"
      || obligations[0].healthy !== false
      || obligations[0].code !== "MODEL_CANARY_TIMEOUT") {
      return null;
    }
    const matchingHistory = (Array.isArray(schedule.history) ? schedule.history : [])
      .filter((entry) => normalizeRunId(entry?.runId) === normalizedRunId);
    if (matchingHistory.length !== 1
      || matchingHistory[0]?.healthy !== false
      || normalizeText(matchingHistory[0]?.action) !== "failed"
      || normalizeText(matchingHistory[0]?.code) !== "MODEL_CANARY_TIMEOUT") {
      return null;
    }

    const runDir = path.resolve(config.runsDir, normalizedRunId);
    if (path.dirname(runDir) !== path.resolve(config.runsDir)) return null;
    const manifest = readJson(path.join(runDir, "manifest.json"));
    const expiresAtMs = parseTimeMs(manifest?.expiresAt);
    const historicalNowMs = expiresAtMs > 0 ? Math.max(0, expiresAtMs - 1) : 0;
    const checkedManifest = validateModelCanaryManifest(manifest, {
      expectedTalker: config.talker,
      expectedContact: config.contact,
      nowMs: historicalNowMs,
    });
    if (!checkedManifest.ok
      || checkedManifest.manifest.runId !== normalizedRunId
      || checkedManifest.manifest.obligationFingerprint !== normalizedObligation
      || checkedManifest.manifest.targetFingerprint !== config.targetFingerprint) {
      return null;
    }
    const boundManifest = checkedManifest.manifest;
    const existingSummary = readJson(path.join(runDir, "summary.json"));
    const reconciliationPath = path.join(runDir, "late-success-reconciliation.json");
    const existingReconciliation = readJson(reconciliationPath);

    let originalSummary = existingSummary;
    if (existingSummary?.healthy === true || normalizeText(existingSummary?.action) === "verified") {
      if (!validateLateReconciliationReceipt(existingReconciliation, boundManifest, existingSummary)) {
        return null;
      }
      originalSummary = existingReconciliation.originalSummary;
    } else if (!isExactLegacyRaceSummary(existingSummary, boundManifest)) {
      return null;
    }
    if (existingReconciliation
      && (!validateLateReconciliationReceipt(existingReconciliation, boundManifest)
        || !isExactLegacyRaceSummary(existingReconciliation.originalSummary, boundManifest)
        || existingReconciliation.originalSummarySha256
          !== hashText(JSON.stringify(existingReconciliation.originalSummary)))) {
      return null;
    }

    const proof = inspectLateSuccessEvidence(config, runDir, boundManifest, {
      nowMs: normalizeNowMs(nowMs),
      originalSummary,
    });
    if (!proof.ok) return null;

    let dispatch = proof.replyDispatched;
    if (proof.replyDispatchShape === "legacy_missing_runtime_identity") {
      dispatch = upgradeLegacyEchoDispatchReceipt(
        path.join(runDir, "reply-dispatched.json"),
        proof.replyDispatchRaw,
        proof.replyDispatched,
        {
          threadId: proof.threadId,
          turnId: proof.turnId,
          reconciledAt: new Date(normalizeNowMs(nowMs)).toISOString(),
        },
      );
      if (!dispatch) return null;
    }

    const receipts = readMilestoneReceipts(runDir);
    const milestones = validateModelMilestones({
      manifest: boundManifest,
      receipts,
      triggerLocalId: proof.triggerLocalId,
      replyLocalId: proof.replyLocalId,
    });
    if (!milestones.ok
      || normalizeText(dispatch.threadId) !== milestones.threadId
      || normalizeText(dispatch.turnId) !== milestones.turnId) {
      return null;
    }
    const cursor = inspectModelCursorDrain(config.cursorFile, {
      manifest: boundManifest,
      triggerLocalId: milestones.triggerLocalId,
      replyLocalId: milestones.replyLocalId,
      replyObserved: receipts.replyObserved,
    });
    if (!cursor.ok) return null;

    const checkedAt = existingReconciliation
      ? normalizeIsoTime(existingReconciliation.reconciledAt)
      : new Date(normalizeNowMs(nowMs)).toISOString();
    const legacyReceiptSha256 = normalizeFingerprint(dispatch.legacyReceiptSha256)
      || hashText(proof.replyDispatchRaw);
    const reconciliation = existingReconciliation || {
      version: STATE_VERSION,
      mode: MODE,
      runId: boundManifest.runId,
      nonce: boundManifest.nonce,
      obligationFingerprint: boundManifest.obligationFingerprint,
      status: "verified_late_success",
      originalFailureCode: "MODEL_CANARY_TIMEOUT",
      originalFailureError: normalizeText(originalSummary.error),
      originalFailureCheckedAt: normalizeIsoTime(originalSummary.checkedAt),
      originalFailureElapsedMs: Number(originalSummary.elapsedMs),
      originalSummary,
      originalSummarySha256: hashText(JSON.stringify(originalSummary)),
      legacyReplyDispatchSha256: legacyReceiptSha256,
      triggerLocalId: milestones.triggerLocalId,
      replyLocalId: milestones.replyLocalId,
      threadId: milestones.threadId,
      turnId: milestones.turnId,
      ledgerEntryId: proof.ledgerEntryId,
      leaseTokenSha256: proof.leaseTokenSha256,
      reconciledAt: checkedAt,
    };
    if (!existingReconciliation) atomicWriteJson(reconciliationPath, reconciliation);
    const persistedReconciliation = readJson(reconciliationPath);
    if (!validateLateReconciliationReceipt(persistedReconciliation, boundManifest, null, {
      triggerLocalId: milestones.triggerLocalId,
      replyLocalId: milestones.replyLocalId,
      threadId: milestones.threadId,
      turnId: milestones.turnId,
      legacyReceiptSha256,
      ledgerEntryId: proof.ledgerEntryId,
      leaseTokenSha256: proof.leaseTokenSha256,
      originalSummarySha256: hashText(JSON.stringify(originalSummary)),
    })) {
      return null;
    }

    const outcome = {
      version: STATE_VERSION,
      mode: MODE,
      healthy: true,
      action: "verified",
      attempted: false,
      repairable: false,
      checkedAt,
      runId: boundManifest.runId,
      reason: "user_demand",
      resumed: true,
      lateReconciled: true,
      originalFailureCode: "MODEL_CANARY_TIMEOUT",
      bridgeVerified: proof.bridgeVerified,
      targetVerified: true,
      targetContact: boundManifest.contact,
      targetTalker: boundManifest.talker,
      targetFingerprint: boundManifest.targetFingerprint,
      obligationFingerprint: boundManifest.obligationFingerprint,
      desktopInputLeaseManifestFingerprint: proof.desktopInputLeaseManifestFingerprint,
      triggerLocalId: milestones.triggerLocalId,
      replyLocalId: milestones.replyLocalId,
      threadId: milestones.threadId,
      turnId: milestones.turnId,
      quietWindowMs: Math.max(0, Number(config.quietWindowMs) || 0),
      cursorCommittedAt: cursor.cursorCommittedAt,
      elapsedMs: Math.max(0, normalizeNowMs(nowMs) - parseTimeMs(boundManifest.createdAt)),
      detail: "late reconciliation proved the original Azzy trigger, runtime handoff, model final, consumed desktop lease, exact ledger reply, echo, turn release, and durable cursor without another send",
    };
    atomicWriteJson(path.join(runDir, "summary.json"), outcome);
    updateScheduleForLateSuccess(config, schedule, outcome, normalizedObligation);
    writeSchedule(config.scheduleFile, schedule);
    return outcome;
  } catch {
    // Evidence that cannot be parsed or atomically upgraded is not success.
    // Preserve the original handled result and let the caller return the
    // existing exactly-once outcome.
    return null;
  }
}

function inspectLateSuccessEvidence(config, runDir, manifest, { nowMs, originalSummary } = {}) {
  if (!isExactLegacyRaceSummary(originalSummary, manifest)) {
    return { ok: false, reason: "legacy_summary_invalid" };
  }
  if (inspectTerminalFailure(runDir, manifest)) {
    return { ok: false, reason: "terminal_failure_present" };
  }
  const expiresAtMs = parseTimeMs(manifest.expiresAt);
  const createdAtMs = parseTimeMs(manifest.createdAt);
  if (!createdAtMs || !expiresAtMs || createdAtMs >= expiresAtMs) {
    return { ok: false, reason: "manifest_time_invalid" };
  }
  const bound = (receipt) => isBoundReceipt(receipt, manifest);
  const triggerClaim = readJson(path.join(runDir, "trigger-send-claim", "claim.json"));
  const triggerDispatched = readJson(path.join(runDir, "trigger-dispatched.json"));
  const leaseReceipt = readJson(path.join(runDir, "desktop-input-lease.json"));
  const ingested = readJson(path.join(runDir, "ingested.json"));
  const handoffClaim = readJson(path.join(runDir, "handoff-claim", "claim.json"));
  const handoff = readJson(path.join(runDir, "handoff.json"));
  const modelCompleted = readJson(path.join(runDir, "model-completed.json"));
  const replyClaim = readJson(path.join(runDir, "reply-send-claim", "claim.json"));
  const replyDispatchPath = path.join(runDir, "reply-dispatched.json");
  const replyDispatchRaw = readUtf8Text(replyDispatchPath);
  const replyDispatched = parseJsonObject(replyDispatchRaw);
  const replyObserved = readJson(path.join(runDir, "reply-observed.json"));
  const turnReleased = readJson(path.join(runDir, "turn-released.json"));
  if (![triggerClaim, triggerDispatched, ingested, handoffClaim, handoff, modelCompleted,
    replyClaim, replyDispatched, replyObserved, turnReleased].every(bound)) {
    return { ok: false, reason: "receipt_binding_invalid" };
  }
  const threadId = normalizeText(handoff.threadId);
  const turnId = normalizeText(handoff.turnId);
  const triggerLocalId = optionalLocalId(ingested.triggerLocalId);
  const replyLocalId = optionalLocalId(replyObserved.replyLocalId);
  if (normalizeText(handoff.status) !== "accepted" || !threadId || !turnId
    || normalizeText(modelCompleted.status) !== "completed"
    || modelCompleted.assistantFinalPresent !== true
    || !normalizeFingerprint(modelCompleted.assistantFinalSha256)
    || !normalizePositiveInteger(modelCompleted.assistantFinalLength, 0)
    || !normalizePositiveInteger(modelCompleted.assistantFinalBytes, 0)
    || normalizePositiveInteger(modelCompleted.assistantFinalBytes, 0)
      < normalizePositiveInteger(modelCompleted.assistantFinalLength, 0)
    || normalizeText(turnReleased.status) !== "released"
    || normalizeText(modelCompleted.threadId) !== threadId
    || normalizeText(modelCompleted.turnId) !== turnId
    || normalizeText(turnReleased.threadId) !== threadId
    || normalizeText(turnReleased.turnId) !== turnId
    || normalizeText(replyClaim.status) !== "claimed"
    || normalizeText(replyClaim.threadId) !== threadId
    || normalizeText(replyClaim.turnId) !== turnId
    || normalizeText(replyClaim.messageKind) !== manifest.replyMessageKind
    || normalizeText(replyClaim.idempotencyKey) !== manifest.replyIdempotencyKey
    || normalizeText(ingested.status) !== "ingested"
    || normalizeText(ingested.talker) !== manifest.talker
    || normalizeText(ingested.direction).toLowerCase() !== "outgoing"
    || optionalLocalId(handoffClaim.triggerLocalId) !== triggerLocalId
    || !normalizeIsoTime(handoffClaim.claimedAt)
    || normalizeText(replyObserved.status) !== "observed"
    || normalizeText(replyObserved.talker) !== manifest.talker
    || normalizeText(replyObserved.direction).toLowerCase() !== "outgoing"
    || normalizeText(replyObserved.messageKind) !== manifest.replyMessageKind
    || normalizeText(replyObserved.idempotencyKey) !== manifest.replyIdempotencyKey
    || !triggerLocalId || !replyLocalId || BigInt(replyLocalId) <= BigInt(triggerLocalId)) {
    return { ok: false, reason: "lifecycle_identity_invalid" };
  }
  if ((normalizeText(replyObserved.threadId) || normalizeText(replyObserved.turnId))
    && (normalizeText(replyObserved.threadId) !== threadId
      || normalizeText(replyObserved.turnId) !== turnId)) {
    return { ok: false, reason: "observed_runtime_identity_mismatch" };
  }
  if (normalizeText(replyDispatched.status) !== "reconciled_from_echo"
    || normalizeText(replyDispatched.talker) !== manifest.talker
    || normalizeText(replyDispatched.contact) !== manifest.contact
    || optionalLocalId(replyDispatched.replyLocalId) !== replyLocalId
    || normalizeText(replyDispatched.messageKind) !== manifest.replyMessageKind
    || normalizeText(replyDispatched.idempotencyKey) !== manifest.replyIdempotencyKey) {
    return { ok: false, reason: "legacy_reply_dispatch_invalid" };
  }
  const dispatchThreadId = normalizeText(replyDispatched.threadId);
  const dispatchTurnId = normalizeText(replyDispatched.turnId);
  const replyDispatchShape = !dispatchThreadId && !dispatchTurnId
    ? "legacy_missing_runtime_identity"
    : dispatchThreadId === threadId && dispatchTurnId === turnId
      && normalizeFingerprint(replyDispatched.legacyReceiptSha256)
      && normalizeIsoTime(replyDispatched.lateReconciledAt)
      ? "late_upgraded"
      : "invalid";
  if (replyDispatchShape === "invalid") {
    return { ok: false, reason: "legacy_reply_dispatch_shape_invalid" };
  }
  if (normalizeText(triggerClaim.mode) !== MODE
    || normalizeText(triggerClaim.runId).toLowerCase() !== manifest.runId
    || !normalizeIsoTime(triggerClaim.claimedAt)
    || triggerDispatched.targetVerified !== true
    || triggerDispatched.bridgeVerified !== true
    || optionalLocalId(triggerDispatched.triggerLocalId) !== triggerLocalId) {
    return { ok: false, reason: "trigger_proof_invalid" };
  }

  const historicalLeaseNow = Math.max(createdAtMs, expiresAtMs - 1);
  const checkedLease = validateModelCanaryDesktopInputLeaseReceipt(leaseReceipt, manifest, {
    nowMs: historicalLeaseNow,
  });
  if (!checkedLease.ok
    || normalizeFingerprint(triggerDispatched.desktopInputLeaseManifestFingerprint)
      !== checkedLease.receipt.manifestFingerprint) {
    return { ok: false, reason: "desktop_lease_receipt_invalid" };
  }
  const privateLeasePath = path.resolve(
    config.stateDir,
    BRIDGE_DESKTOP_INPUT_LEASE_DIRECTORY,
    `${manifest.runId}.json`,
  );
  if (path.dirname(privateLeasePath) !== path.resolve(config.stateDir, BRIDGE_DESKTOP_INPUT_LEASE_DIRECTORY)) {
    return { ok: false, reason: "desktop_lease_path_invalid" };
  }
  const privateLease = readJson(privateLeasePath);
  const privateLeaseClaim = readJson(`${privateLeasePath}.claim`);
  const leaseTokenSha256 = hashText(checkedLease.receipt.leaseToken);
  const leaseClaimedAtMs = parseTimeMs(privateLease?.claimedAt);
  const leaseConsumedAtMs = parseTimeMs(privateLease?.consumedAt);
  const turnReleasedAtMs = parseTimeMs(turnReleased.recordedAt);
  if (Number(privateLease?.version) !== MODEL_CANARY_VERSION
    || normalizeText(privateLease?.mode) !== MODE
    || normalizeRunId(privateLease?.runId) !== manifest.runId
    || normalizeText(privateLease?.nonce).toLowerCase() !== manifest.nonce
    || normalizeFingerprint(privateLease?.targetFingerprint) !== manifest.targetFingerprint
    || normalizeText(privateLease?.contact) !== manifest.contact
    || normalizeText(privateLease?.talker) !== manifest.talker
    || normalizeText(privateLease?.replyIdempotencyKey) !== manifest.replyIdempotencyKey
    || normalizeIsoTime(privateLease?.expiresAt) !== manifest.expiresAt
    || normalizeText(privateLease?.status) !== "consumed"
    || normalizeText(privateLease?.token)
    || normalizeFingerprint(privateLease?.tokenSha256) !== leaseTokenSha256
    || Number(privateLease?.lastInputTick) !== checkedLease.receipt.triggerLastInputTick
    || Math.abs(parseTimeMs(privateLease?.issuedAt) - parseTimeMs(checkedLease.receipt.issuedAt)) > 1_000
    || normalizeFingerprint(privateLease?.triggerTextSha256) !== hashText(manifest.triggerText)
    || normalizeFingerprint(privateLease?.replyTextSha256) !== hashText(manifest.replyText)
    || !leaseClaimedAtMs || !leaseConsumedAtMs || !turnReleasedAtMs
    || leaseClaimedAtMs < parseTimeMs(privateLease.issuedAt)
    || leaseConsumedAtMs < leaseClaimedAtMs
    || leaseConsumedAtMs > expiresAtMs
    || leaseConsumedAtMs > turnReleasedAtMs
    || Number(privateLeaseClaim?.version) !== MODEL_CANARY_VERSION
    || normalizeText(privateLeaseClaim?.mode) !== MODE
    || normalizeRunId(privateLeaseClaim?.runId) !== manifest.runId
    || normalizeFingerprint(privateLeaseClaim?.tokenSha256) !== leaseTokenSha256
    || normalizeIsoTime(privateLeaseClaim?.claimedAt) !== normalizeIsoTime(privateLease?.claimedAt)) {
    return { ok: false, reason: "consumed_desktop_lease_invalid" };
  }

  const ledger = readJson(config.ledgerFile || path.join(config.stateDir, "weflow-message-ledger.json"));
  if (Number(ledger?.version) !== 3 || !Array.isArray(ledger?.entries)) {
    return { ok: false, reason: "ledger_invalid" };
  }
  const ledgerMatches = ledger.entries.filter((entry) => (
    normalizeText(entry?.talker) === manifest.talker
    && normalizeText(entry?.idempotencyKey) === manifest.replyIdempotencyKey
  ));
  if (ledgerMatches.length !== 1) return { ok: false, reason: "ledger_identity_not_unique" };
  const ledgerEntry = ledgerMatches[0];
  if (normalizeText(ledgerEntry.status) !== "verified"
    || optionalLocalId(ledgerEntry.localId) !== replyLocalId
    || normalizeText(ledgerEntry.messageKind) !== manifest.replyMessageKind
    || normalizeText(ledgerEntry.expectedDirection).toLowerCase() !== "outgoing"
    || normalizeText(ledgerEntry.contentKind) !== "text"
    || normalizeFingerprint(ledgerEntry.contentHash) !== hashWeFlowMessageContent(manifest.replyText)
    || ledgerEntry.uncertain !== false
    || Number(ledgerEntry.attemptCount) !== 1
    || normalizeText(ledgerEntry.failedAt)
    || normalizeText(ledgerEntry.failureCode)
    || normalizeText(ledgerEntry.failureHash)
    || Math.abs(parseTimeMs(ledgerEntry.observedAt) - parseTimeMs(replyObserved.replyObservedAt)) > 1_000) {
    return { ok: false, reason: "ledger_reply_proof_invalid" };
  }

  const evidenceTimes = [
    triggerClaim.claimedAt,
    triggerDispatched.recordedAt,
    leaseReceipt.issuedAt,
    leaseReceipt.recordedAt,
    ingested.triggerObservedAt,
    ingested.ingestedAt,
    handoffClaim.claimedAt,
    handoff.recordedAt,
    handoff.acceptedAt,
    modelCompleted.recordedAt,
    replyClaim.recordedAt,
    replyDispatched.recordedAt,
    replyObserved.replyObservedAt,
    replyObserved.recordedAt,
    privateLease.issuedAt,
    privateLease.claimedAt,
    privateLease.consumedAt,
    privateLeaseClaim.claimedAt,
    ledgerEntry.createdAt,
    ledgerEntry.sendingAt,
    ledgerEntry.observedAt,
    ledgerEntry.verifiedAt,
    ledgerEntry.updatedAt,
    turnReleased.recordedAt,
  ];
  if (!evidenceTimes.every((value) => {
    const timeMs = parseTimeMs(value);
    return timeMs >= createdAtMs - 10_000 && timeMs <= expiresAtMs;
  })) {
    return { ok: false, reason: "evidence_time_outside_manifest" };
  }
  const triggerDispatchedAtMs = parseTimeMs(triggerDispatched.recordedAt);
  const ingestedAtMs = parseTimeMs(ingested.ingestedAt);
  const handoffAtMs = parseTimeMs(handoff.acceptedAt || handoff.recordedAt);
  const modelCompletedAtMs = parseTimeMs(modelCompleted.recordedAt);
  const replyClaimedAtMs = parseTimeMs(replyClaim.recordedAt);
  const replyDispatchedAtMs = parseTimeMs(replyDispatched.recordedAt);
  const replyObservedRecordedAtMs = parseTimeMs(replyObserved.recordedAt);
  const ledgerUpdatedAtMs = parseTimeMs(ledgerEntry.updatedAt);
  if (triggerDispatchedAtMs > ingestedAtMs
    || ingestedAtMs > handoffAtMs
    || handoffAtMs > modelCompletedAtMs
    || modelCompletedAtMs > replyClaimedAtMs
    || replyClaimedAtMs > leaseClaimedAtMs
    || leaseClaimedAtMs > replyDispatchedAtMs
    || replyDispatchedAtMs !== replyObservedRecordedAtMs
    || replyObservedRecordedAtMs > leaseConsumedAtMs
    || leaseConsumedAtMs > ledgerUpdatedAtMs
    || ledgerUpdatedAtMs > turnReleasedAtMs) {
    return { ok: false, reason: "evidence_order_invalid" };
  }
  const observedSourceAtMs = parseTimeMs(replyObserved.replyObservedAt);
  if (observedSourceAtMs > replyObservedRecordedAtMs + 10_000
    || observedSourceAtMs < replyClaimedAtMs - 10_000) {
    return { ok: false, reason: "reply_observed_clock_skew_invalid" };
  }
  const cursorState = readJson(config.cursorFile);
  const seenIdentities = Array.isArray(cursorState?.seenIdentities) ? cursorState.seenIdentities : [];
  if (cursorState?.version !== STATE_VERSION
    || normalizeText(cursorState?.talker) !== manifest.talker
    || !seenIdentities.includes(`local:${triggerLocalId}`)
    || !seenIdentities.includes(`local:${replyLocalId}`)
    || parseTimeMs(cursorState?.updatedAt) < replyObservedRecordedAtMs
    || normalizeNowMs(nowMs) < replyObservedRecordedAtMs + Math.max(0, Number(config.quietWindowMs) || 0)) {
    return { ok: false, reason: "strict_cursor_proof_invalid" };
  }
  const cursor = inspectModelCursorDrain(config.cursorFile, {
    manifest,
    triggerLocalId,
    replyLocalId,
    replyObserved,
  });
  if (!cursor.ok) return { ok: false, reason: "cursor_proof_invalid" };
  return {
    ok: true,
    triggerLocalId,
    replyLocalId,
    threadId,
    turnId,
    bridgeVerified: triggerDispatched.bridgeVerified === true,
    desktopInputLeaseManifestFingerprint: checkedLease.receipt.manifestFingerprint,
    leaseTokenSha256,
    ledgerEntryId: normalizeText(ledgerEntry.id),
    replyDispatchRaw,
    replyDispatched,
    replyDispatchShape,
  };
}

function isExactLegacyRaceSummary(summary, manifest) {
  const checkedAtMs = parseTimeMs(summary?.checkedAt);
  const expiresAtMs = parseTimeMs(manifest?.expiresAt);
  return summary?.version === STATE_VERSION
    && normalizeText(summary?.mode) === MODE
    && normalizeRunId(summary?.runId) === manifest?.runId
    && summary.healthy === false
    && normalizeText(summary.action) === "failed"
    && summary.attempted === true
    && summary.repairable === false
    && summary.certainPredispatch === false
    && summary.deliveryUncertain === true
    && normalizeText(summary.code) === "MODEL_CANARY_TIMEOUT"
    && Boolean(checkedAtMs)
    && Boolean(expiresAtMs)
    && checkedAtMs >= expiresAtMs
    && checkedAtMs <= expiresAtMs + 10_000
    && Number.isFinite(Number(summary.elapsedMs))
    && Number(summary.elapsedMs) >= 0
    && /reply-dispatched runtime thread\/turn binding is missing or inconsistent/iu
      .test(normalizeText(summary.error || summary.detail));
}

function upgradeLegacyEchoDispatchReceipt(filePath, expectedRaw, receipt, {
  threadId,
  turnId,
  reconciledAt,
} = {}) {
  if (!expectedRaw || readUtf8Text(filePath) !== expectedRaw
    || normalizeText(receipt?.status) !== "reconciled_from_echo"
    || normalizeText(receipt?.threadId) || normalizeText(receipt?.turnId)
    || !normalizeText(threadId) || !normalizeText(turnId)) {
    return null;
  }
  const upgraded = {
    ...receipt,
    threadId: normalizeText(threadId),
    turnId: normalizeText(turnId),
    legacyReceiptSha256: hashText(expectedRaw),
    lateReconciledAt: normalizeIsoTime(reconciledAt),
  };
  atomicReplaceJsonIfUnchanged(filePath, expectedRaw, upgraded);
  const persisted = readJson(filePath);
  return normalizeText(persisted?.threadId) === upgraded.threadId
    && normalizeText(persisted?.turnId) === upgraded.turnId
    && normalizeFingerprint(persisted?.legacyReceiptSha256) === upgraded.legacyReceiptSha256
    ? persisted
    : null;
}

function validateLateReconciliationReceipt(receipt, manifest, summary = null, expected = {}) {
  if (!isBoundReceipt(receipt, manifest)
    || normalizeText(receipt?.status) !== "verified_late_success"
    || normalizeText(receipt?.originalFailureCode) !== "MODEL_CANARY_TIMEOUT"
    || !/reply-dispatched runtime thread\/turn binding is missing or inconsistent/iu
      .test(normalizeText(receipt?.originalFailureError))
    || !normalizeIsoTime(receipt?.originalFailureCheckedAt)
    || !Number.isFinite(Number(receipt?.originalFailureElapsedMs))
    || Number(receipt?.originalFailureElapsedMs) < 0
    || !isExactLegacyRaceSummary(receipt?.originalSummary, manifest)
    || normalizeText(receipt?.originalFailureCode) !== normalizeText(receipt?.originalSummary?.code)
    || normalizeText(receipt?.originalFailureError) !== normalizeText(receipt?.originalSummary?.error)
    || normalizeIsoTime(receipt?.originalFailureCheckedAt)
      !== normalizeIsoTime(receipt?.originalSummary?.checkedAt)
    || Number(receipt?.originalFailureElapsedMs) !== Number(receipt?.originalSummary?.elapsedMs)
    || !normalizeFingerprint(receipt?.originalSummarySha256)
    || normalizeFingerprint(receipt?.originalSummarySha256)
      !== hashText(JSON.stringify(receipt?.originalSummary))
    || !normalizeFingerprint(receipt?.legacyReplyDispatchSha256)
    || !normalizeText(receipt?.ledgerEntryId)
    || !normalizeFingerprint(receipt?.leaseTokenSha256)
    || !optionalLocalId(receipt?.triggerLocalId)
    || !optionalLocalId(receipt?.replyLocalId)
    || !normalizeText(receipt?.threadId)
    || !normalizeText(receipt?.turnId)
    || !normalizeIsoTime(receipt?.reconciledAt)) {
    return false;
  }
  if (summary && (summary.healthy !== true
    || normalizeText(summary.action) !== "verified"
    || summary.lateReconciled !== true
    || normalizeRunId(summary.runId) !== manifest.runId
    || optionalLocalId(summary.triggerLocalId) !== optionalLocalId(receipt.triggerLocalId)
    || optionalLocalId(summary.replyLocalId) !== optionalLocalId(receipt.replyLocalId)
    || normalizeText(summary.threadId) !== normalizeText(receipt.threadId)
    || normalizeText(summary.turnId) !== normalizeText(receipt.turnId))) {
    return false;
  }
  return (!expected.triggerLocalId || optionalLocalId(receipt.triggerLocalId) === expected.triggerLocalId)
    && (!expected.replyLocalId || optionalLocalId(receipt.replyLocalId) === expected.replyLocalId)
    && (!expected.threadId || normalizeText(receipt.threadId) === expected.threadId)
    && (!expected.turnId || normalizeText(receipt.turnId) === expected.turnId)
    && (!expected.legacyReceiptSha256
      || normalizeFingerprint(receipt.legacyReplyDispatchSha256) === expected.legacyReceiptSha256)
    && (!expected.ledgerEntryId || normalizeText(receipt.ledgerEntryId) === expected.ledgerEntryId)
    && (!expected.leaseTokenSha256
      || normalizeFingerprint(receipt.leaseTokenSha256) === expected.leaseTokenSha256)
    && (!expected.originalSummarySha256
      || normalizeFingerprint(receipt.originalSummarySha256) === expected.originalSummarySha256);
}

function updateScheduleForLateSuccess(config, schedule, outcome, obligationFingerprint) {
  schedule.activeRunId = "";
  schedule.lastRunId = outcome.runId;
  schedule.lastStatus = "healthy";
  schedule.lastError = "";
  schedule.lastSuccessAt = outcome.checkedAt;
  schedule.consecutiveFailures = 0;
  schedule.lastAction = "verified";
  schedule.lastDetail = outcome.detail;
  schedule.nextDueAt = new Date(parseTimeMs(outcome.checkedAt) + config.routineIntervalMs).toISOString();
  schedule.obligations = readObligations(schedule.obligations).map((entry) => (
    entry.fingerprint === obligationFingerprint && entry.runId === outcome.runId
      ? { ...entry, state: "handled", healthy: true, code: "" }
      : entry
  )).slice(-MAX_OBLIGATION_HISTORY);
  schedule.history = [
    ...(Array.isArray(schedule.history) ? schedule.history : []),
    {
      runId: outcome.runId,
      checkedAt: outcome.checkedAt,
      healthy: true,
      action: "verified",
      code: "",
      triggerLocalId: outcome.triggerLocalId,
      replyLocalId: outcome.replyLocalId,
      lateReconciled: true,
    },
  ].slice(-MAX_HISTORY);
}

function atomicReplaceJsonIfUnchanged(filePath, expectedRaw, value) {
  if (readUtf8Text(filePath) !== expectedRaw) throw new Error("model E2E receipt changed during reconciliation");
  const temporary = `${filePath}.${process.pid}-${crypto.randomBytes(6).toString("hex")}.upgrade.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    if (readUtf8Text(filePath) !== expectedRaw) {
      throw new Error("model E2E receipt changed before reconciliation commit");
    }
    fs.renameSync(temporary, filePath);
  } finally {
    if (descriptor !== null) try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function readUtf8Text(filePath) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(filePath));
  } catch {
    return "";
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function finalizeRun(config, schedule, run, outcome, nowMs) {
  if (run.runDir && run.runDir !== config.runsDir) {
    atomicWriteJson(path.join(run.runDir, "summary.json"), outcome);
  }
  schedule.activeRunId = "";
  schedule.lastRunId = normalizeRunId(run.runId);
  const predispatch = outcome.action === "deferred_busy" || outcome.certainPredispatch === true;
  if (predispatch) {
    schedule.attempts = (Array.isArray(schedule.attempts) ? schedule.attempts : [])
      .filter((value) => normalizeIsoTime(value) !== normalizeIsoTime(run.manifest?.createdAt));
    schedule.lastAttemptAt = normalizeIsoTime(run.previousLastAttemptAt)
      || normalizeIsoTime(schedule.attempts.at(-1));
  } else {
    schedule.lastAttemptAt = normalizeIsoTime(schedule.lastAttemptAt) || normalizeIsoTime(run.manifest?.createdAt);
    schedule.lastStatus = outcome.healthy === true ? "healthy" : "failed";
    schedule.lastError = outcome.healthy === true ? "" : normalizeText(outcome.error || outcome.detail).slice(0, 500);
    if (outcome.healthy === true) {
      schedule.lastSuccessAt = outcome.checkedAt || new Date(nowMs).toISOString();
      schedule.consecutiveFailures = 0;
    } else {
      schedule.lastFailureAt = outcome.checkedAt || new Date(nowMs).toISOString();
      schedule.consecutiveFailures = Math.min(100, normalizeCount(schedule.consecutiveFailures) + 1);
    }
  }
  schedule.obligations = readObligations(schedule.obligations).map((entry) => (
    entry.runId === normalizeRunId(run.runId)
      ? {
        ...entry,
        state: predispatch ? "released" : "handled",
        healthy: predispatch ? null : outcome.healthy === true,
        code: normalizeText(outcome.code),
      }
      : entry
  )).slice(-MAX_OBLIGATION_HISTORY);
  schedule.lastAction = normalizeText(outcome.action);
  schedule.lastDetail = normalizeText(outcome.detail || outcome.error).slice(0, 500);
  schedule.nextDueAt = new Date(nowMs + (predispatch ? 60_000 : config.routineIntervalMs)).toISOString();
  schedule.history = [
    ...(Array.isArray(schedule.history) ? schedule.history : []),
    {
      runId: normalizeRunId(run.runId),
      checkedAt: outcome.checkedAt || new Date(nowMs).toISOString(),
      healthy: outcome.healthy === true ? true : outcome.healthy === false ? false : null,
      action: normalizeText(outcome.action),
      code: normalizeText(outcome.code),
      triggerLocalId: optionalLocalId(outcome.triggerLocalId),
      replyLocalId: optionalLocalId(outcome.replyLocalId),
    },
  ].slice(-MAX_HISTORY);
  writeSchedule(config.scheduleFile, schedule);
}

function annotateOutcome(outcome, schedule) {
  const failures = normalizeCount(schedule.consecutiveFailures);
  outcome.consecutiveFailures = failures;
  outcome.confirmedFailure = outcome.healthy === false && failures >= 2;
  outcome.lastSuccessAt = normalizeIsoTime(schedule.lastSuccessAt);
  outcome.nextDueAt = normalizeIsoTime(schedule.nextDueAt);
  return outcome;
}

function buildFailureOutcome(run, error, nowMs) {
  const code = normalizeText(error?.code) || "MODEL_CANARY_FAILED";
  const claimExists = Boolean(run.runDir && fs.existsSync(path.join(run.runDir, "trigger-send-claim")));
  const certainPredispatch = error?.certainPredispatch === true || !claimExists;
  return {
    version: STATE_VERSION,
    mode: MODE,
    healthy: false,
    action: "failed",
    attempted: !certainPredispatch,
    repairable: false,
    checkedAt: new Date(nowMs).toISOString(),
    runId: normalizeRunId(run.runId),
    code,
    certainPredispatch,
    deliveryUncertain: error?.deliveryUncertain === true || (claimExists && !certainPredispatch),
    error: formatError(error),
    resumed: Boolean(run.resumed),
    elapsedMs: Math.max(0, nowMs - Number(run.startedAtMs || nowMs)),
  };
}

function buildDesktopBusyOutcome(run, error, nowMs) {
  return {
    version: STATE_VERSION,
    mode: MODE,
    healthy: null,
    action: "deferred_busy",
    attempted: false,
    repairable: false,
    checkedAt: new Date(nowMs).toISOString(),
    runId: normalizeRunId(run.runId),
    code: "MODEL_CANARY_DESKTOP_ACTIVE",
    certainPredispatch: true,
    desktopIdleSeconds: Number.isFinite(Number(error?.desktopIdleSeconds))
      ? Math.max(0, Math.floor(Number(error.desktopIdleSeconds)))
      : null,
    resumed: Boolean(run.resumed),
    elapsedMs: Math.max(0, nowMs - Number(run.startedAtMs || nowMs)),
    detail: formatError(error),
  };
}

function disabledResult(nowMs) {
  return {
    version: STATE_VERSION,
    mode: MODE,
    healthy: null,
    status: "disabled",
    action: "not_run",
    attempted: false,
    repairable: false,
    checkedAt: new Date(nowMs).toISOString(),
    runId: "",
    consecutiveFailures: 0,
    confirmedFailure: false,
    nextDueAt: "",
    detail: "model E2E canary is disabled by configuration",
  };
}

function readConfig(options = {}) {
  const stateDir = path.resolve(options.stateDir || bootstrapStateDir || DEFAULT_USER_STATE_DIR);
  const enabled = readBoolEnv("CYBERBOSS_ENABLE_WEFLOW_MODEL_CANARY");
  if (!enabled) {
    return {
      enabled: false,
      stateDir,
      runsDir: path.join(stateDir, "model-e2e-probes"),
      scheduleFile: path.join(stateDir, "cyberboss-watchdog-model-canary.json"),
      lockFile: path.join(stateDir, "cyberboss-watchdog-model-canary.lock"),
    };
  }
  const talker = requiredEnv("CYBERBOSS_WEFLOW_CANARY_CHAT");
  const contact = requiredEnv("CYBERBOSS_WEFLOW_CANARY_DISPLAY_NAME");
  const primaryTalker = normalizeText(process.env.CYBERBOSS_WEFLOW_INBOX_CHAT);
  assertWeFlowCanaryTalkerIsolation({ weflowInboxChat: primaryTalker, weflowCanaryChat: talker });
  const probeTimeoutMs = boundedIntegerEnv(
    "CYBERBOSS_WATCHDOG_MODEL_CANARY_TIMEOUT_MS",
    DEFAULT_PROBE_TIMEOUT_MS,
    30_000,
    MAX_MODEL_CANARY_TTL_MS,
  );
  return {
    enabled: true,
    stateDir,
    runsDir: path.join(stateDir, "model-e2e-probes"),
    scheduleFile: path.join(stateDir, "cyberboss-watchdog-model-canary.json"),
    lockFile: path.join(stateDir, "cyberboss-watchdog-model-canary.lock"),
    bridgeBaseUrl: normalizeLoopbackBaseUrl(
      process.env.CYBERBOSS_WEFLOW_BRIDGE_BASE_URL || "http://127.0.0.1:8766",
      "CYBERBOSS_WEFLOW_BRIDGE_BASE_URL",
    ),
    weflowBaseUrl: normalizeLoopbackBaseUrl(
      process.env.CYBERBOSS_WEFLOW_BASE_URL || "http://127.0.0.1:5031",
      "CYBERBOSS_WEFLOW_BASE_URL",
    ),
    token: requiredEnv("CYBERBOSS_WEFLOW_TOKEN"),
    primaryTalker,
    talker,
    contact,
    targetFingerprint: buildTargetFingerprint({ contact, talker }),
    demandKey: normalizeText(options.demandKey),
    desktopIdleSeconds: Math.max(MIN_DESKTOP_IDLE_SECONDS, boundedIntegerEnv(
      "CYBERBOSS_WATCHDOG_DESKTOP_IDLE_SECONDS",
      MIN_DESKTOP_IDLE_SECONDS,
      0,
      24 * 60 * 60,
    )),
    probeTimeoutMs,
    routineIntervalMs: Math.max(MIN_ROUTINE_INTERVAL_MS, boundedIntegerEnv(
      "CYBERBOSS_WATCHDOG_MODEL_CANARY_INTERVAL_MS",
      DEFAULT_ROUTINE_INTERVAL_MS,
      MIN_ROUTINE_INTERVAL_MS,
      30 * 24 * 60 * 60_000,
    )),
    pollIntervalMs: boundedIntegerEnv(
      "CYBERBOSS_WATCHDOG_MODEL_CANARY_POLL_INTERVAL_MS",
      DEFAULT_POLL_INTERVAL_MS,
      100,
      5_000,
    ),
    quietWindowMs: boundedIntegerEnv(
      "CYBERBOSS_WATCHDOG_MODEL_CANARY_QUIET_WINDOW_MS",
      DEFAULT_QUIET_WINDOW_MS,
      DEFAULT_QUIET_WINDOW_MS,
      15_000,
    ),
    requestTimeoutMs: boundedIntegerEnv(
      "CYBERBOSS_WATCHDOG_MODEL_CANARY_REQUEST_TIMEOUT_MS",
      DEFAULT_REQUEST_TIMEOUT_MS,
      1_000,
      30_000,
    ),
    bridgeSendTimeoutMs: boundedIntegerEnv(
      "CYBERBOSS_WATCHDOG_MODEL_CANARY_SEND_TIMEOUT_MS",
      DEFAULT_BRIDGE_SEND_TIMEOUT_MS,
      1_000,
      60_000,
    ),
    cursorFile: path.join(stateDir, "weflow-canary-inbox-cursor.json"),
  };
}

async function fetchMessages(config, fetchImpl) {
  const url = new URL("/api/v1/messages", `${config.weflowBaseUrl}/`);
  url.searchParams.set("talker", config.talker);
  url.searchParams.set("limit", String(MESSAGE_LIMIT));
  const payload = await requestJson(url, {
    headers: { Authorization: `Bearer ${config.token}` },
  }, {
    label: "WeFlow model E2E messages",
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
    clearTimeout(timer);
    if (error?.name === "AbortError") {
      throw codedError("MODEL_CANARY_REQUEST_TIMEOUT", `${label} timed out after ${timeoutMs}ms`);
    }
    throw codedError("MODEL_CANARY_REQUEST_FAILED", `${label} failed: ${formatError(error)}`);
  }
  clearTimeout(timer);
  let payload = null;
  try { payload = await response.json(); } catch {}
  if (!response.ok) {
    const error = codedError(
      normalizeText(payload?.code) || "MODEL_CANARY_HTTP_ERROR",
      `${label} failed: ${normalizeText(payload?.error) || `HTTP ${response.status}`}`,
    );
    if (Number.isFinite(Number(payload?.desktopIdleSeconds))) {
      error.desktopIdleSeconds = Math.max(0, Math.floor(Number(payload.desktopIdleSeconds)));
    }
    if (payload?.dispatched === false) error.certainPredispatch = true;
    if (payload?.dispatched === true) error.deliveryUncertain = true;
    throw error;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw codedError("MODEL_CANARY_INVALID_JSON", `${label} returned invalid JSON`);
  }
  return payload;
}

function inspectModelTarget(manifest, config, nowMs) {
  return validateModelCanaryManifest(manifest, {
    expectedTalker: config.talker,
    expectedContact: config.contact,
    nowMs,
  });
}

function readSchedule(filePath) {
  const parsed = readJson(filePath);
  if (!parsed || parsed.version !== STATE_VERSION || normalizeText(parsed.mode) !== MODE) return emptySchedule();
  return {
    ...emptySchedule(),
    ...parsed,
    version: STATE_VERSION,
    mode: MODE,
    activeRunId: normalizeText(parsed.activeRunId).toLowerCase(),
    lastRunId: normalizeRunId(parsed.lastRunId),
    consecutiveFailures: normalizeCount(parsed.consecutiveFailures),
    attempts: Array.isArray(parsed.attempts)
      ? parsed.attempts.filter((value) => parseTimeMs(value) > 0).slice(-MAX_HISTORY)
      : [],
    obligations: readObligations(parsed.obligations),
    history: Array.isArray(parsed.history) ? parsed.history.slice(-MAX_HISTORY) : [],
  };
}

function emptySchedule() {
  return {
    version: STATE_VERSION,
    mode: MODE,
    targetFingerprint: "",
    activeRunId: "",
    lastRunId: "",
    lastAttemptAt: "",
    lastSuccessAt: "",
    lastFailureAt: "",
    lastStatus: "never",
    lastError: "",
    lastAction: "",
    lastDetail: "",
    lastReason: "",
    nextDueAt: "",
    consecutiveFailures: 0,
    attempts: [],
    obligations: [],
    history: [],
  };
}

function bindScheduleToTarget(schedule, fingerprint) {
  const normalized = normalizeFingerprint(fingerprint);
  if (!normalized) throw new Error("model E2E target fingerprint is required");
  if (normalizeFingerprint(schedule.targetFingerprint) === normalized) return false;
  schedule.targetFingerprint = normalized;
  schedule.activeRunId = "";
  schedule.lastRunId = "";
  schedule.lastAttemptAt = "";
  schedule.lastSuccessAt = "";
  schedule.lastFailureAt = "";
  schedule.lastStatus = "never";
  schedule.lastError = "";
  schedule.lastAction = "target_changed";
  schedule.lastDetail = "model E2E target changed; fresh exact-target proof is required";
  schedule.lastReason = "target_changed";
  schedule.nextDueAt = "";
  schedule.consecutiveFailures = 0;
  // Preserve global attempts, obligations, and history so a target change cannot bypass budgets.
  return true;
}

function readObligations(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).map((entry) => ({
    fingerprint: normalizeFingerprint(entry.fingerprint),
    runId: normalizeRunId(entry.runId),
    reason: normalizeText(entry.reason),
    at: normalizeIsoTime(entry.at),
    state: ["reserved", "handled", "released"].includes(normalizeText(entry.state))
      ? normalizeText(entry.state)
      : "handled",
    healthy: entry.healthy === true ? true : entry.healthy === false ? false : null,
    code: normalizeText(entry.code),
  })).filter((entry) => entry.fingerprint && entry.runId && entry.at).slice(-MAX_OBLIGATION_HISTORY);
}

function writeSchedule(filePath, schedule) {
  atomicWriteJson(filePath, { ...schedule, version: STATE_VERSION, mode: MODE });
}

function acquireOwnerLock(lockFile, nowMs, probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  const staleAfterMs = Math.max(MAX_MODEL_CANARY_TTL_MS, probeTimeoutMs) + 60_000;
  const ownerToken = crypto.randomBytes(16).toString("hex");
  const create = () => {
    const descriptor = fs.openSync(lockFile, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify({
      version: STATE_VERSION,
      mode: MODE,
      pid: process.pid,
      ownerToken,
      createdAt: new Date(nowMs).toISOString(),
    })}\n`, "utf8");
    fs.closeSync(descriptor);
  };
  try {
    create();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let stat;
    try { stat = fs.statSync(lockFile); } catch { return null; }
    if (nowMs - stat.mtimeMs <= staleAfterMs) return null;
    try { fs.unlinkSync(lockFile); } catch { return null; }
    try { create(); } catch { return null; }
  }
  return () => {
    try {
      const current = readJson(lockFile);
      if (current?.ownerToken === ownerToken) fs.unlinkSync(lockFile);
    } catch {}
  };
}

function acquireClaimDirectory(directory, payload) {
  try {
    fs.mkdirSync(directory, { recursive: false });
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  atomicWriteJson(path.join(directory, "claim.json"), payload);
  return true;
}

function pruneRunDirectories(runsDir, maximum) {
  let entries;
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && normalizeRunId(entry.name))
      .map((entry) => ({ path: path.join(runsDir, entry.name), mtimeMs: fs.statSync(path.join(runsDir, entry.name)).mtimeMs }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
  } catch { return; }
  for (const entry of entries.slice(maximum)) {
    try { fs.rmSync(entry.path, { recursive: true, force: false }); } catch {}
  }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, filePath);
  } finally {
    if (descriptor !== null) try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function readJson(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return isObject(value) ? value : null;
  } catch { return null; }
}

function recoverBridgeDesktopInputLease(config, manifest, { nowMs = Date.now() } = {}) {
  const runId = normalizeRunId(manifest?.runId);
  if (!runId) return null;
  const recordPath = path.resolve(
    config.stateDir,
    BRIDGE_DESKTOP_INPUT_LEASE_DIRECTORY,
    `${runId}.json`,
  );
  const expectedRoot = path.resolve(config.stateDir, BRIDGE_DESKTOP_INPUT_LEASE_DIRECTORY);
  if (path.dirname(recordPath) !== expectedRoot) return null;
  if (fs.existsSync(`${recordPath}.claim`)) return null;
  const record = readJson(recordPath);
  const token = normalizeText(record?.token).toLowerCase();
  const tokenHash = normalizeFingerprint(record?.tokenSha256);
  if (!record
    || normalizeText(record.status) !== "issued"
    || Number(record.version) !== MODEL_CANARY_VERSION
    || normalizeText(record.mode) !== MODE
    || normalizeRunId(record.runId) !== runId
    || normalizeText(record.nonce).toLowerCase() !== normalizeText(manifest.nonce).toLowerCase()
    || normalizeFingerprint(record.targetFingerprint) !== normalizeFingerprint(manifest.targetFingerprint)
    || normalizeText(record.contact) !== normalizeText(manifest.contact)
    || normalizeText(record.talker) !== normalizeText(manifest.talker)
    || normalizeText(record.replyIdempotencyKey) !== normalizeText(manifest.replyIdempotencyKey)
    || normalizeIsoTime(record.expiresAt) !== normalizeIsoTime(manifest.expiresAt)
    || normalizeFingerprint(record.triggerTextSha256) !== hashText(manifest.triggerText)
    || normalizeFingerprint(record.replyTextSha256) !== hashText(manifest.replyText)
    || !/^[a-f0-9]{64}$/u.test(token)
    || tokenHash !== hashText(token)) {
    return null;
  }
  const rawLease = {
    version: MODEL_CANARY_VERSION,
    mode: MODE,
    runId,
    nonce: normalizeText(record.nonce).toLowerCase(),
    targetFingerprint: normalizeFingerprint(record.targetFingerprint),
    replyIdempotencyKey: normalizeText(record.replyIdempotencyKey),
    expiresAt: normalizeIsoTime(record.expiresAt),
    token,
    lastInputTick: Number(record.lastInputTick),
    issuedAt: normalizeIsoTime(record.issuedAt),
  };
  try {
    const receipt = createModelCanaryDesktopInputLeaseReceipt(manifest, rawLease, { nowMs });
    return { receipt, rawLease, recordPath };
  } catch {
    return null;
  }
}

function extractMessages(payload) {
  if (Array.isArray(payload)) return payload.filter(isObject);
  for (const key of ["messages", "data", "items"]) {
    const candidate = payload?.[key];
    if (Array.isArray(candidate)) return candidate.filter(isObject);
    if (isObject(candidate)) {
      for (const nested of ["messages", "items", "list"]) {
        if (Array.isArray(candidate[nested])) return candidate[nested].filter(isObject);
      }
    }
  }
  throw codedError("MODEL_CANARY_MESSAGES_INVALID", "WeFlow response did not contain a message list");
}

function isOutgoingMessage(message) {
  const value = message?.isSend ?? message?.is_send;
  return value === true || value === 1 || value === "1"
    || normalizeText(message?.direction).toLowerCase() === "outgoing";
}

function readMessageText(message) {
  for (const key of ["parsedContent", "content", "text"]) {
    if (typeof message?.[key] === "string" && message[key].trim()) return message[key].trim();
  }
  return "";
}

function readLocalId(message) {
  for (const key of ["localId", "local_id", "id", "msgId", "msg_id"]) {
    const localId = optionalLocalId(message?.[key]);
    if (localId) return localId;
  }
  return "";
}

function parseArguments(argv) {
  const options = { stateDir: "", demandKey: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!["--state-dir", "--demand-key"].includes(value)) throw new Error(`unknown argument: ${value}`);
    const next = argv[index + 1];
    if (typeof next !== "string") throw new Error(`${value} requires a value`);
    index += 1;
    if (value === "--state-dir") options.stateDir = next;
    if (value === "--demand-key") options.demandKey = next;
  }
  return options;
}

function normalizeDemandKey(value) {
  const text = normalizeText(value);
  if (!text) return "";
  if (text.length > 512) throw new Error("model E2E demand key must not exceed 512 characters");
  return text;
}

function requiredEnv(name) {
  const value = normalizeText(process.env[name]);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readBoolEnv(name) {
  return /^(1|true|yes|on)$/iu.test(normalizeText(process.env[name]));
}

function boundedIntegerEnv(name, fallback, minimum, maximum) {
  const raw = normalizeText(process.env[name]);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function normalizeLoopbackBaseUrl(value, name) {
  let parsed;
  try { parsed = new URL(normalizeText(value)); } catch { throw new Error(`${name} must be a valid URL`); }
  if (!["http:", "https:"].includes(parsed.protocol)
    || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error(`${name} must use HTTP on a loopback host`);
  }
  return parsed.toString().replace(/\/$/u, "");
}

function buildUrl(baseUrl, pathname) {
  return new URL(pathname, `${baseUrl}/`);
}

function buildTargetFingerprint({ contact, talker } = {}) {
  const normalizedContact = normalizeText(contact);
  const normalizedTalker = normalizeText(talker);
  if (!normalizedContact || !normalizedTalker) throw new Error("model E2E contact and talker are required");
  return hashText(`${normalizedContact}\n${normalizedTalker}`);
}

function normalizeRunId(value) {
  const text = normalizeText(value).toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(text) ? text : "";
}

function normalizeFingerprint(value) {
  const text = normalizeText(value).toLowerCase();
  return /^[0-9a-f]{64}$/u.test(text) ? text : "";
}

function optionalLocalId(value) {
  const text = normalizeText(value);
  return /^\d+$/u.test(text) && BigInt(text) > 0n ? BigInt(text).toString() : "";
}

function normalizeIsoTime(value) {
  const text = normalizeText(value);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function parseTimeMs(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeNowMs(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Date.now();
}

function normalizePositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeCount(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function resolveScheduleHealthy(status) {
  if (normalizeText(status) === "healthy") return true;
  if (normalizeText(status) === "failed") return false;
  return null;
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
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
  return error instanceof Error ? error.message : String(error || "unknown model E2E failure");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({
      version: STATE_VERSION,
      mode: MODE,
      healthy: false,
      action: "error",
      attempted: false,
      repairable: false,
      checkedAt: new Date().toISOString(),
      code: normalizeText(error?.code) || "MODEL_CANARY_RUNNER_ERROR",
      error: formatError(error),
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  MAX_ATTEMPTS_PER_DAY,
  MAX_ATTEMPTS_PER_HOUR,
  MIN_DESKTOP_IDLE_SECONDS,
  MIN_ROUTINE_INTERVAL_MS,
  acquireOwnerLock,
  atomicWriteJson,
  bindScheduleToTarget,
  buildTargetFingerprint,
  decideModelCanaryDue,
  emptySchedule,
  getModelCanaryAttemptGate,
  inspectModelCanaryMessages,
  inspectModelCursorDrain,
  inspectModelTarget,
  inspectTerminalFailure,
  readSchedule,
  recoverBridgeDesktopInputLease,
  runScheduledModelCanary,
  validateModelMilestones,
};
