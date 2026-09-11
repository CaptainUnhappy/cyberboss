const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
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
  runScheduledCanary,
  validateManifest,
  validateMilestones,
} = require("../scripts/cyberboss-watchdog-canary");

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-watchdog-canary-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function createConfig(stateDir, overrides = {}) {
  const config = {
    stateDir,
    runsDir: path.join(stateDir, "e2e-probes"),
    scheduleFile: path.join(stateDir, "cyberboss-watchdog-canary.json"),
    lockFile: path.join(stateDir, "cyberboss-watchdog-canary.lock"),
    bridgeBaseUrl: "http://127.0.0.1:8766",
    weflowBaseUrl: "http://127.0.0.1:5031",
    token: "test-token",
    primaryTalker: "wxid_primary",
    talker: "wxid_canary_self",
    contact: "Azzy",
    probeTimeoutMs: 60_000,
    routineIntervalMs: 6 * 60 * 60_000,
    acceleratedIntervalMs: 15 * 60_000,
    failureRetryMs: 2 * 60_000,
    pollIntervalMs: 1,
    quietWindowMs: 0,
    requestTimeoutMs: 1_000,
    bridgeSendTimeoutMs: 1_000,
    desktopIdleSeconds: 300,
    force: false,
    reason: "routine",
    demandKey: "",
    cursorFile: path.join(stateDir, "weflow-canary-inbox-cursor.json"),
    ...overrides,
  };
  config.targetFingerprint = overrides.targetFingerprint
    || buildTargetFingerprint({ contact: config.contact, talker: config.talker });
  return config;
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function createVerifiedCanaryHarness({ config, stateDir }) {
  const messages = [];
  let sends = 0;
  let nextLocalId = 1_000n;
  return {
    get sends() { return sends; },
    async fetchImpl(url, init = {}) {
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname === "/api/v1/messages") {
        return jsonResponse({ messages });
      }
      if (parsedUrl.pathname !== "/api/send") {
        throw new Error(`unexpected URL: ${parsedUrl}`);
      }
      sends += 1;
      const body = JSON.parse(init.body);
      const runId = body.text.match(/trigger=([0-9a-f-]{36})/u)[1];
      const runDir = path.join(stateDir, "e2e-probes", runId);
      const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
      const triggerLocalId = String(nextLocalId);
      const replyLocalId = String(nextLocalId + 1n);
      nextLocalId += 2n;
      messages.push(
        { isSend: 1, localId: triggerLocalId, content: manifest.triggerText, senderUsername: config.talker },
        { isSend: 1, localId: replyLocalId, content: manifest.replyText, senderUsername: config.talker },
      );
      atomicWriteJson(path.join(runDir, "ingested.json"), {
        version: 1,
        runId,
        triggerLocalId,
      });
      atomicWriteJson(path.join(runDir, "reply-dispatched.json"), {
        version: 1,
        runId,
        replyLocalId,
      });
      atomicWriteJson(path.join(runDir, "reply-observed.json"), {
        version: 1,
        runId,
        replyLocalId,
      });
      atomicWriteJson(config.cursorFile, {
        version: 1,
        talker: config.talker,
        lastLocalId: replyLocalId,
        seenIdentities: [`local:${triggerLocalId}`, `local:${replyLocalId}`],
        updatedAt: new Date().toISOString(),
        lastPolledAt: new Date().toISOString(),
      });
      return jsonResponse({
        dispatched: true,
        verified: true,
        localId: triggerLocalId,
        targetVerified: true,
        selectedContact: config.contact,
        verifiedTalker: config.talker,
      });
    },
  };
}

test("routine, accelerated, and failed schedules are independently bounded", () => {
  const nowMs = Date.parse("2026-08-28T12:00:00.000Z");
  const schedule = {
    ...emptySchedule(),
    lastAttemptAt: new Date(nowMs - 5 * 60_000).toISOString(),
    lastSuccessAt: new Date(nowMs - 5 * 60_000).toISOString(),
    lastStatus: "healthy",
    lastDemandKey: "pending:one",
  };

  assert.equal(decideCanaryDue(schedule, {
    nowMs,
    routineIntervalMs: 6 * 60 * 60_000,
  }).due, false);
  assert.equal(decideCanaryDue(schedule, {
    nowMs,
    force: true,
    demandKey: "pending:one",
    acceleratedIntervalMs: 15 * 60_000,
  }).due, false);
  assert.equal(decideCanaryDue(schedule, {
    nowMs,
    force: true,
    demandKey: "pending:two",
    acceleratedIntervalMs: 15 * 60_000,
  }).due, true);

  schedule.lastStatus = "failed";
  assert.equal(decideCanaryDue(schedule, {
    nowMs,
    force: true,
    demandKey: "pending:two",
    failureRetryMs: 2 * 60_000,
  }).due, true);
});

test("desktop idle configuration is hard-clamped to five minutes", () => {
  assert.equal(normalizeCanaryDesktopIdleSeconds(0), 300);
  assert.equal(normalizeCanaryDesktopIdleSeconds(60), 300);
  assert.equal(normalizeCanaryDesktopIdleSeconds(600), 600);
});

test("a stale lock owner cannot delete the replacement owner's lock", (t) => {
  const stateDir = createTempDir(t);
  const lockFile = path.join(stateDir, "canary.lock");
  const firstRelease = acquireRunLock(lockFile, 1_000);
  assert.equal(typeof firstRelease, "function");
  fs.utimesSync(lockFile, new Date(0), new Date(0));
  const secondRelease = acquireRunLock(lockFile, 500_000);
  assert.equal(typeof secondRelease, "function");

  firstRelease();
  assert.equal(fs.existsSync(lockFile), true, "old owner must preserve the replacement lock");
  secondRelease();
  assert.equal(fs.existsSync(lockFile), false);
});

test("a lock owned by the old target never leaks its healthy state to the newly configured target", async (t) => {
  const stateDir = createTempDir(t);
  const config = createConfig(stateDir);
  const oldFingerprint = buildTargetFingerprint({ contact: "yourself", talker: "wxid_primary" });
  atomicWriteJson(config.scheduleFile, {
    ...emptySchedule(),
    targetFingerprint: oldFingerprint,
    lastStatus: "healthy",
    lastRunId: "123e4567-e89b-42d3-a456-426614174000",
    lastSuccessAt: "2026-08-28T11:50:00.000Z",
    nextDueAt: "2026-08-28T17:50:00.000Z",
  });
  const releaseLock = acquireRunLock(config.lockFile, Date.parse("2026-08-28T12:00:00.000Z"));
  t.after(() => releaseLock());

  const result = await runScheduledCanary(config, {
    now: () => Date.parse("2026-08-28T12:00:01.000Z"),
  });

  assert.equal(result.healthy, null);
  assert.equal(result.action, "target_changed_pending");
  assert.equal(result.repairable, false);
  assert.equal(result.lastRunId, "");
  assert.equal(result.lastSuccessAt, "");
  assert.equal(result.nextDueAt, "2026-08-28T12:00:01.000Z");
  assert.match(result.detail, /different target/);
});

test("a different active obligation is never resumed or credited to a new urgent demand", async (t) => {
  const stateDir = createTempDir(t);
  const nowMs = Date.parse("2026-08-28T12:00:00.000Z");
  const oldConfig = createConfig(stateDir, {
    force: true,
    reason: "repair_verification",
    demandKey: "repair:old",
  });
  const oldDemandFingerprint = buildUrgentDemandFingerprint({
    targetFingerprint: oldConfig.targetFingerprint,
    reason: oldConfig.reason,
    demandKey: oldConfig.demandKey,
  });
  const runId = "123e4567-e89b-42d3-a456-426614174000";
  const nonce = "0123456789abcdef01234567";
  const createdAt = new Date(nowMs - 1_000).toISOString();
  const runDir = path.join(oldConfig.runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  atomicWriteJson(path.join(runDir, "manifest.json"), {
    version: 1,
    runId,
    nonce,
    triggerText: `[Cyberboss心跳探针 trigger=${runId} nonce=${nonce}]`,
    replyText: `[Cyberboss心跳正常 trigger=${runId}]`,
    requestedAt: createdAt,
    createdAt,
    expiresAt: new Date(nowMs + 60_000).toISOString(),
    talker: oldConfig.talker,
    contact: oldConfig.contact,
    targetFingerprint: oldConfig.targetFingerprint,
    reason: oldConfig.reason,
    urgentDemandFingerprint: oldDemandFingerprint,
  });
  atomicWriteJson(oldConfig.scheduleFile, {
    ...emptySchedule(),
    targetFingerprint: oldConfig.targetFingerprint,
    activeRunId: runId,
    lastRunId: runId,
    lastAttemptAt: createdAt,
    attempts: [createdAt],
    urgentAttempts: [{
      at: createdAt,
      runId,
      reason: oldConfig.reason,
      demandFingerprint: oldDemandFingerprint,
      state: "reserved",
    }],
  });
  const newConfig = createConfig(stateDir, {
    force: true,
    reason: "user_demand",
    demandKey: "manual:new",
  });
  let fetches = 0;

  const result = await runScheduledCanary(newConfig, {
    now: () => nowMs,
    fetchImpl: async () => { fetches += 1; },
  });
  assert.equal(result.healthy, null);
  assert.equal(result.action, "obligation_wait");
  assert.equal(result.attempted, false);
  assert.equal(result.lastRunId, runId);
  assert.equal(fetches, 0);
  const schedule = JSON.parse(fs.readFileSync(newConfig.scheduleFile, "utf8"));
  assert.equal(schedule.activeRunId, runId);
});

test("runner rejects an aliased primary/canary talker before polling or dispatch", async (t) => {
  const stateDir = createTempDir(t);
  const config = createConfig(stateDir, {
    primaryTalker: "wxid_same",
    talker: "wxid_same",
  });
  let fetches = 0;
  await assert.rejects(
    runScheduledCanary(config, { fetchImpl: async () => { fetches += 1; } }),
    (error) => error?.code === "CANARY_TALKER_CONFLICT" && error?.repairable === false,
  );
  assert.equal(fetches, 0);
  assert.equal(fs.existsSync(config.runsDir), false);
});

test("changed backlog identities never bypass the three-per-hour and four-per-day hard probe budget", () => {
  const nowMs = Date.parse("2026-08-28T12:00:00.000Z");
  const schedule = {
    ...emptySchedule(),
    lastStatus: "healthy",
    lastDemandKey: "old",
    attempts: [5, 10, 15].map((minutes) => new Date(nowMs - minutes * 60_000).toISOString()),
  };
  const changedDemand = decideCanaryDue(schedule, {
    nowMs,
    force: true,
    demandKey: "brand-new-stuck-key",
    acceleratedIntervalMs: 2 * 60_000,
  });
  assert.equal(changedDemand.due, false);
  assert.equal(changedDemand.reason, "budget_hourly");

  const cycleGate = getCanaryAttemptGate(
    [5, 10].map((minutes) => new Date(nowMs - minutes * 60_000).toISOString()),
    nowMs,
  );
  assert.equal(cycleGate.allowed, true, "failure, confirmation, and post-repair verification must fit one cycle");

  const cycleStart = nowMs - 10 * 60_000;
  const failAndConfirmation = [cycleStart, cycleStart + 2 * 60_000]
    .map((value) => new Date(value).toISOString());
  assert.equal(getCanaryAttemptGate(failAndConfirmation, nowMs).allowed, true);
  const withRepairVerification = [
    ...failAndConfirmation,
    new Date(cycleStart + 4 * 60_000).toISOString(),
  ];
  assert.equal(getCanaryAttemptGate(withRepairVerification, nowMs).allowed, false, "fourth hourly probe is blocked");

  const dailyAttempts = [2, 8, 14, 20].map((hours) => new Date(nowMs - hours * 60 * 60_000).toISOString());
  const gate = getCanaryAttemptGate(dailyAttempts, nowMs);
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, "budget_daily");
});

test("urgent repair and explicit demands bypass routine due time but are exactly-once per target key", () => {
  const nowMs = Date.parse("2026-08-28T12:00:00.000Z");
  const targetFingerprint = buildTargetFingerprint({ contact: "Azzy", talker: "wxid_canary_self" });
  const demandKey = "manual:2026-08-28T12:00:00Z";
  const demandFingerprint = buildUrgentDemandFingerprint({
    targetFingerprint,
    reason: "user_demand",
    demandKey,
  });
  const schedule = {
    ...emptySchedule(),
    targetFingerprint,
    lastAttemptAt: new Date(nowMs - 60_000).toISOString(),
    lastSuccessAt: new Date(nowMs - 60_000).toISOString(),
    lastStatus: "healthy",
    nextDueAt: new Date(nowMs + 6 * 60 * 60_000).toISOString(),
  };

  const explicit = decideCanaryDue(schedule, {
    nowMs,
    force: true,
    explicitDemand: true,
    demandKey,
    urgentDemandFingerprint: demandFingerprint,
  });
  assert.equal(explicit.due, true);
  assert.equal(explicit.reason, "user_demand");

  schedule.lastStatus = "failed";
  const repairKey = "repair:attempt-1";
  const repairFingerprint = buildUrgentDemandFingerprint({
    targetFingerprint,
    reason: "repair_verification",
    demandKey: repairKey,
  });
  const repair = decideCanaryDue(schedule, {
    nowMs,
    force: true,
    repairVerification: true,
    demandKey: repairKey,
    urgentDemandFingerprint: repairFingerprint,
    failureRetryMs: 60 * 60_000,
  });
  assert.equal(repair.due, true);
  assert.equal(repair.reason, "repair_verification");

  schedule.urgentAttempts = [{
    at: new Date(nowMs - 1_000).toISOString(),
    runId: "123e4567-e89b-42d3-a456-426614174000",
    reason: "user_demand",
    demandFingerprint,
  }];
  const duplicate = decideCanaryDue(schedule, {
    nowMs,
    explicitDemand: true,
    demandKey,
    urgentDemandFingerprint: demandFingerprint,
  });
  assert.equal(duplicate.due, false);
  assert.equal(duplicate.reason, "urgent_demand_duplicate");
});

test("urgent canary lane is capped at two per hour and four per day independently of routine attempts", () => {
  const nowMs = Date.parse("2026-08-28T12:00:00.000Z");
  const entry = (minutes, suffix) => ({
    at: new Date(nowMs - minutes * 60_000).toISOString(),
    runId: `123e4567-e89b-42d3-a456-4266141740${suffix}`,
    reason: "user_demand",
    demandFingerprint: suffix.repeat(64).slice(0, 64),
  });
  assert.equal(getUrgentCanaryAttemptGate([entry(10, "00")], nowMs).allowed, true);
  const hourly = getUrgentCanaryAttemptGate([entry(10, "00"), entry(20, "11")], nowMs);
  assert.equal(hourly.allowed, false);
  assert.equal(hourly.reason, "urgent_budget_hourly");
  const daily = getUrgentCanaryAttemptGate([
    entry(90, "00"),
    entry(180, "11"),
    entry(360, "22"),
    entry(720, "33"),
  ], nowMs);
  assert.equal(daily.allowed, false);
  assert.equal(daily.reason, "urgent_budget_daily");

  const routineExhausted = [5, 10, 15]
    .map((minutes) => new Date(nowMs - minutes * 60_000).toISOString());
  assert.equal(getCanaryAttemptGate(routineExhausted, nowMs).allowed, false);
  assert.equal(getUrgentCanaryAttemptGate([], nowMs).allowed, true);
});

test("a new explicit demand executes one full chain despite routine budget and the same key never dispatches twice", async (t) => {
  const stateDir = createTempDir(t);
  const nowMs = Date.parse("2026-08-28T12:00:00.000Z");
  const demandKey = "manual:request-42";
  const config = createConfig(stateDir, {
    force: true,
    reason: "user_demand",
    demandKey,
  });
  atomicWriteJson(config.scheduleFile, {
    ...emptySchedule(),
    targetFingerprint: config.targetFingerprint,
    lastStatus: "healthy",
    lastAttemptAt: new Date(nowMs - 60_000).toISOString(),
    lastSuccessAt: new Date(nowMs - 60_000).toISOString(),
    nextDueAt: new Date(nowMs + 6 * 60 * 60_000).toISOString(),
    attempts: [5, 10, 15].map((minutes) => new Date(nowMs - minutes * 60_000).toISOString()),
  });
  const harness = createVerifiedCanaryHarness({ config, stateDir });

  const first = await runScheduledCanary(config, {
    now: () => nowMs,
    fetchImpl: harness.fetchImpl,
    sleep: async () => {},
  });
  assert.equal(first.action, "verified");
  assert.equal(first.healthy, true);
  assert.equal(harness.sends, 1);
  const afterFirst = JSON.parse(fs.readFileSync(config.scheduleFile, "utf8"));
  assert.equal(afterFirst.attempts.length, 4, "urgent attempts also depress later routine probes");
  assert.equal(afterFirst.urgentAttempts.length, 1);
  assert.equal(afterFirst.urgentAttempts[0].state, "handled");
  assert.equal(afterFirst.urgentAttempts[0].result.action, "verified");
  assert.equal(afterFirst.urgentAttempts[0].result.triggerLocalId, first.triggerLocalId);
  assert.equal(afterFirst.urgentAttempts[0].result.replyLocalId, first.replyLocalId);

  // Compatibility path: older handled schedules do not have an embedded result,
  // so replay must recover the exact terminal summary without sending again.
  delete afterFirst.urgentAttempts[0].result;
  atomicWriteJson(config.scheduleFile, afterFirst);

  const duplicate = await runScheduledCanary(config, {
    now: () => nowMs + 1_000,
    fetchImpl: harness.fetchImpl,
    sleep: async () => {},
  });
  assert.equal(duplicate.action, "verified");
  assert.equal(duplicate.healthy, true);
  assert.equal(duplicate.attempted, false);
  assert.equal(duplicate.replayed, true);
  assert.equal(duplicate.runId, first.runId);
  assert.equal(duplicate.triggerLocalId, first.triggerLocalId);
  assert.equal(duplicate.replyLocalId, first.replyLocalId);
  assert.equal(harness.sends, 1);
});

test("a completed demand replays its embedded verified terminal result after run artifacts are gone", async (t) => {
  const stateDir = createTempDir(t);
  const nowMs = Date.parse("2026-08-28T12:00:00.000Z");
  const runId = "123e4567-e89b-42d3-a456-426614174000";
  const demandKey = "repair:durable-result";
  const config = createConfig(stateDir, {
    force: true,
    reason: "repair_verification",
    demandKey,
  });
  const demandFingerprint = buildUrgentDemandFingerprint({
    targetFingerprint: config.targetFingerprint,
    reason: config.reason,
    demandKey,
  });
  atomicWriteJson(config.scheduleFile, {
    ...emptySchedule(),
    targetFingerprint: config.targetFingerprint,
    lastRunId: runId,
    lastStatus: "healthy",
    lastSuccessAt: new Date(nowMs - 1_000).toISOString(),
    nextDueAt: new Date(nowMs + 60_000).toISOString(),
    urgentAttempts: [{
      at: new Date(nowMs - 1_000).toISOString(),
      runId,
      reason: config.reason,
      demandFingerprint,
      state: "completed",
      result: {
        version: 1,
        healthy: true,
        action: "verified",
        checkedAt: new Date(nowMs - 1_000).toISOString(),
        runId,
        targetFingerprint: config.targetFingerprint,
        triggerLocalId: "410",
        replyLocalId: "411",
        detail: "stored terminal proof",
      },
    }],
  });
  let fetches = 0;

  const replayed = await runScheduledCanary(config, {
    now: () => nowMs,
    fetchImpl: async () => { fetches += 1; },
  });

  assert.equal(replayed.action, "verified");
  assert.equal(replayed.healthy, true);
  assert.equal(replayed.attempted, false);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.runId, runId);
  assert.equal(replayed.triggerLocalId, "410");
  assert.equal(replayed.replyLocalId, "411");
  assert.equal(fetches, 0);
});

test("certain predispatch failures release only the demand token while the urgent retry budget remains bounded", async (t) => {
  const stateDir = createTempDir(t);
  const startMs = Date.parse("2026-08-28T12:00:00.000Z");
  const config = createConfig(stateDir, {
    force: true,
    reason: "user_demand",
    demandKey: "manual:predispatch",
  });
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    throw new Error("messages API was unavailable before dispatch");
  };

  const first = await runScheduledCanary(config, { now: () => startMs, fetchImpl });
  assert.equal(first.healthy, false);
  assert.equal(first.certainPredispatch, true);
  let schedule = JSON.parse(fs.readFileSync(config.scheduleFile, "utf8"));
  assert.equal(schedule.urgentAttempts[0].state, "released");

  const second = await runScheduledCanary(config, { now: () => startMs + 1_000, fetchImpl });
  assert.equal(second.healthy, false);
  assert.equal(second.certainPredispatch, true);
  schedule = JSON.parse(fs.readFileSync(config.scheduleFile, "utf8"));
  assert.deepEqual(schedule.urgentAttempts.map((attempt) => attempt.state), ["released", "released"]);

  const third = await runScheduledCanary(config, { now: () => startMs + 2_000, fetchImpl });
  assert.equal(third.action, "urgent_budget_wait");
  assert.equal(third.attempted, false);
  assert.equal(fetches, 2);
});

test("an uncertain bridge failure after dispatch starts permanently consumes the exact demand token", async (t) => {
  const stateDir = createTempDir(t);
  const startMs = Date.parse("2026-08-28T12:00:00.000Z");
  const config = createConfig(stateDir, {
    force: true,
    reason: "user_demand",
    demandKey: "manual:uncertain-send",
  });
  let bridgeCalls = 0;
  const fetchImpl = async (url) => {
    if (new URL(url).pathname === "/api/v1/messages") return jsonResponse({ messages: [] });
    bridgeCalls += 1;
    throw new Error("connection reset after request write");
  };

  const first = await runScheduledCanary(config, { now: () => startMs, fetchImpl });
  assert.equal(first.healthy, false);
  assert.equal(first.certainPredispatch, false);
  assert.equal(bridgeCalls, 1);
  const schedule = JSON.parse(fs.readFileSync(config.scheduleFile, "utf8"));
  assert.equal(schedule.urgentAttempts[0].state, "handled");
  assert.equal(schedule.urgentAttempts[0].result.action, "failed");

  const duplicate = await runScheduledCanary(config, {
    now: () => startMs + 1_000,
    fetchImpl,
  });
  assert.equal(duplicate.action, "failed");
  assert.equal(duplicate.healthy, false);
  assert.equal(duplicate.attempted, false);
  assert.equal(duplicate.replayed, true);
  assert.equal(duplicate.runId, first.runId);
  assert.equal(duplicate.code, first.code);
  assert.equal(bridgeCalls, 1);
});

test("manifest validation binds a UUID, nonce, talker, exact texts, and a 120 second TTL", () => {
  const runId = "123e4567-e89b-42d3-a456-426614174000";
  const nonce = "0123456789abcdef01234567";
  const createdAt = "2026-08-28T12:00:00.000Z";
  const manifest = {
    version: 1,
    runId,
    nonce,
    triggerText: `[Cyberboss心跳探针 trigger=${runId} nonce=${nonce}]`,
    replyText: `[Cyberboss心跳正常 trigger=${runId}]`,
    requestedAt: createdAt,
    createdAt,
    expiresAt: "2026-08-28T12:02:00.000Z",
    talker: "wxid_canary_self",
    contact: "Azzy",
    targetFingerprint: buildTargetFingerprint({ contact: "Azzy", talker: "wxid_canary_self" }),
    reason: "routine",
    urgentDemandFingerprint: "",
  };

  const identity = {
    runId,
    talker: "wxid_canary_self",
    contact: "Azzy",
    targetFingerprint: manifest.targetFingerprint,
  };
  assert.equal(validateManifest(manifest, identity), true);
  assert.equal(validateManifest({ ...manifest, talker: "other" }, identity), false);
  assert.equal(validateManifest({ ...manifest, contact: "Azzy (2)" }, identity), false);
  assert.equal(validateManifest({ ...manifest, expiresAt: "2026-08-28T12:02:00.001Z" }, {
    ...identity,
  }), false);
  assert.equal(validateManifest({ ...manifest, triggerText: `${manifest.triggerText} changed` }, {
    ...identity,
  }), false);
});

test("changing the exact canary target invalidates an old healthy schedule without resetting budgets", () => {
  const oldFingerprint = buildTargetFingerprint({ contact: "yourself", talker: "wxid_primary" });
  const newFingerprint = buildTargetFingerprint({ contact: "Azzy", talker: "wxid_canary_self" });
  const attempts = ["2026-08-28T11:55:00.000Z"];
  const schedule = {
    ...emptySchedule(),
    targetFingerprint: oldFingerprint,
    lastStatus: "healthy",
    lastAttemptAt: "2026-08-28T11:50:00.000Z",
    lastSuccessAt: "2026-08-28T11:50:00.000Z",
    lastTriggerLocalId: "10",
    lastReplyLocalId: "11",
    activeRunId: "123e4567-e89b-42d3-a456-426614174000",
    attempts,
  };
  assert.equal(bindScheduleToTarget(schedule, newFingerprint), true);
  assert.equal(schedule.targetFingerprint, newFingerprint);
  assert.equal(schedule.lastStatus, "never");
  assert.equal(schedule.lastSuccessAt, "");
  assert.equal(schedule.lastAttemptAt, "");
  assert.equal(schedule.activeRunId, "");
  assert.deepEqual(schedule.attempts, attempts);
});

test("a target migration blocked by retained daily budget is pending, never inherited healthy", async (t) => {
  const stateDir = createTempDir(t);
  const nowMs = Date.parse("2026-08-28T12:00:00.000Z");
  const config = createConfig(stateDir);
  const attempts = [2, 8, 14, 20]
    .map((hours) => new Date(nowMs - hours * 60 * 60_000).toISOString());
  atomicWriteJson(config.scheduleFile, {
    ...emptySchedule(),
    targetFingerprint: buildTargetFingerprint({ contact: "yourself", talker: "wxid_old" }),
    lastStatus: "healthy",
    lastSuccessAt: new Date(nowMs - 60_000).toISOString(),
    attempts,
  });
  let fetches = 0;

  const result = await runScheduledCanary(config, {
    now: () => nowMs,
    fetchImpl: async () => { fetches += 1; },
  });

  assert.equal(result.healthy, null);
  assert.equal(result.action, "target_verification_budget_wait");
  assert.equal(result.detail, "budget_daily");
  assert.equal(fetches, 0);
  const schedule = JSON.parse(fs.readFileSync(config.scheduleFile, "utf8"));
  assert.equal(schedule.targetFingerprint, config.targetFingerprint);
  assert.equal(schedule.lastStatus, "never");
  assert.deepEqual(schedule.attempts, attempts);
});

test("milestones require matching stable localIds in strict trigger then reply order", () => {
  const manifest = { runId: "123e4567-e89b-42d3-a456-426614174000" };
  const valid = validateMilestones({
    manifest,
    ingested: { version: 1, runId: manifest.runId, triggerLocalId: "101" },
    replyDispatched: { version: 1, runId: manifest.runId, replyLocalId: "102" },
    replyObserved: { version: 1, runId: manifest.runId, replyLocalId: "102" },
    triggerLocalId: "101",
    replyLocalId: "102",
  });
  assert.deepEqual(valid, { ok: true, triggerLocalId: "101", replyLocalId: "102" });

  assert.equal(validateMilestones({
    manifest,
    ingested: { version: 1, runId: manifest.runId, triggerLocalId: "101" },
    replyDispatched: { version: 1, runId: manifest.runId, replyLocalId: "102" },
    replyObserved: { version: 1, runId: manifest.runId, replyLocalId: "103" },
    triggerLocalId: "101",
    replyLocalId: "102",
  }).ok, false);
});

test("cursor drain requires the dedicated talker schema and a committed reply localId, not only fresh mtime", (t) => {
  const stateDir = createTempDir(t);
  const cursorFile = path.join(stateDir, "weflow-canary-inbox-cursor.json");
  const replyObserved = { recordedAt: new Date(Date.now() - 5_000).toISOString() };
  const manifest = { talker: "wxid_canary_self" };
  const baseCursor = {
    version: 1,
    talker: manifest.talker,
    lastLocalId: "101",
    seenIdentities: ["local:101"],
    updatedAt: new Date().toISOString(),
    lastPolledAt: new Date().toISOString(),
  };
  atomicWriteJson(cursorFile, baseCursor);

  const notCommitted = inspectCursorDrain(cursorFile, {
    manifest,
    triggerLocalId: "101",
    replyLocalId: "102",
    replyObserved,
  });
  assert.equal(notCommitted.ok, false);
  assert.match(notCommitted.detail, /has not committed.*reply localId/);

  atomicWriteJson(cursorFile, { ...baseCursor, talker: "wxid_other", lastLocalId: "102" });
  assert.match(inspectCursorDrain(cursorFile, {
    manifest,
    triggerLocalId: "101",
    replyLocalId: "102",
    replyObserved,
  }).detail, /schema or talker/);

  atomicWriteJson(cursorFile, {
    ...baseCursor,
    lastLocalId: "102",
    seenIdentities: ["local:101", "local:102"],
  });
  const committed = inspectCursorDrain(cursorFile, {
    manifest,
    triggerLocalId: "101",
    replyLocalId: "102",
    replyObserved,
  });
  assert.equal(committed.ok, true);
  assert.match(committed.cursorCommittedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("message inspection deduplicates representations by localId but exposes real duplicates", () => {
  const manifest = { triggerText: "probe", replyText: "reply", talker: "wxid_canary_self" };
  const messages = [
    { isSend: 1, localId: "10", content: "probe", senderUsername: "wxid_canary_self" },
    { direction: "outgoing", local_id: "10", parsedContent: "probe", senderUsername: "wxid_canary_self" },
    { isSend: true, localId: "11", content: "reply", senderUsername: "wxid_canary_self" },
  ];
  const once = inspectCanaryMessages(messages, manifest);
  assert.deepEqual(once.trigger.map((item) => item.localId), ["10"]);
  assert.deepEqual(once.reply.map((item) => item.localId), ["11"]);

  const duplicate = inspectCanaryMessages([
    ...messages,
    { isSend: 1, localId: "12", content: "probe", senderUsername: "wxid_canary_self" },
  ], manifest);
  assert.equal(duplicate.trigger.length, 2);
});

test("scheduled canary verifies the real message order and all three app milestones", async (t) => {
  const stateDir = createTempDir(t);
  const config = createConfig(stateDir);
  const messages = [];
  let sends = 0;

  const fetchImpl = async (url, init = {}) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === "/api/v1/messages") {
      return jsonResponse({ messages });
    }
    if (parsedUrl.pathname === "/api/send") {
      sends += 1;
      const body = JSON.parse(init.body);
      assert.equal(body.contact, "Azzy");
      assert.equal(body.talker, "wxid_canary_self");
      assert.equal(body.exactContact, true);
      assert.equal(body.expectedContact, "Azzy");
      assert.equal(body.expectedTalker, "wxid_canary_self");
      const runId = body.text.match(/trigger=([0-9a-f-]{36})/u)[1];
      const runDir = path.join(stateDir, "e2e-probes", runId);
      const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
      messages.push({ isSend: 1, localId: "101", content: manifest.triggerText, senderUsername: config.talker });
      messages.push({ isSend: 1, localId: "102", content: manifest.replyText, senderUsername: config.talker });
      atomicWriteJson(path.join(runDir, "ingested.json"), {
        version: 1,
        runId,
        triggerLocalId: "101",
      });
      atomicWriteJson(path.join(runDir, "reply-dispatched.json"), {
        version: 1,
        runId,
        replyLocalId: "102",
      });
      atomicWriteJson(path.join(runDir, "reply-observed.json"), {
        version: 1,
        runId,
        replyLocalId: "102",
      });
      atomicWriteJson(config.cursorFile, {
        version: 1,
        talker: config.talker,
        lastLocalId: "102",
        seenIdentities: ["local:101", "local:102"],
        updatedAt: new Date().toISOString(),
        lastPolledAt: new Date().toISOString(),
      });
      return jsonResponse({
        dispatched: true,
        verified: true,
        localId: "101",
        targetVerified: true,
        selectedContact: config.contact,
        verifiedTalker: config.talker,
      });
    }
    throw new Error(`unexpected URL: ${parsedUrl}`);
  };

  const result = await runScheduledCanary(config, { fetchImpl, sleep: async () => {} });
  assert.equal(result.healthy, true);
  assert.equal(result.action, "verified");
  assert.equal(result.triggerLocalId, "101");
  assert.equal(result.replyLocalId, "102");
  assert.equal(sends, 1);

  const schedule = JSON.parse(fs.readFileSync(config.scheduleFile, "utf8"));
  assert.equal(schedule.lastStatus, "healthy");
  assert.equal(schedule.lastAction, "verified");
  assert.equal(schedule.lastTriggerLocalId, "101");
  assert.equal(schedule.lastReplyLocalId, "102");
  assert.equal(schedule.consecutiveFailures, 0);
  assert.equal(schedule.activeRunId, "");
  assert.equal(fs.existsSync(path.join(stateDir, "e2e-probes", result.runId, "summary.json")), true);
});

test("resumed run with dispatch-started evidence reconciles until TTL without pressing Enter again", async (t) => {
  const stateDir = createTempDir(t);
  const config = createConfig(stateDir, { probeTimeoutMs: 10_000 });
  const startMs = Date.parse("2026-08-28T12:00:00.000Z");
  const runId = "123e4567-e89b-42d3-a456-426614174000";
  const nonce = "0123456789abcdef01234567";
  const runDir = path.join(config.runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  atomicWriteJson(path.join(runDir, "manifest.json"), {
    version: 1,
    runId,
    nonce,
    triggerText: `[Cyberboss心跳探针 trigger=${runId} nonce=${nonce}]`,
    replyText: `[Cyberboss心跳正常 trigger=${runId}]`,
    requestedAt: new Date(startMs).toISOString(),
    createdAt: new Date(startMs).toISOString(),
    expiresAt: new Date(startMs + 10_000).toISOString(),
    talker: config.talker,
    contact: config.contact,
    targetFingerprint: config.targetFingerprint,
    reason: "routine",
    urgentDemandFingerprint: "",
  });
  atomicWriteJson(path.join(runDir, "trigger-dispatch-started.json"), {
    version: 1,
    runId,
    startedAt: new Date(startMs + 1_000).toISOString(),
  });
  atomicWriteJson(config.scheduleFile, {
    ...emptySchedule(),
    targetFingerprint: config.targetFingerprint,
    activeRunId: runId,
    lastRunId: runId,
    lastAttemptAt: new Date(startMs).toISOString(),
    attempts: [new Date(startMs).toISOString()],
  });

  let clock = startMs + 1_000;
  let sends = 0;
  const result = await runScheduledCanary(config, {
    now: () => {
      clock += 1_000;
      return clock;
    },
    sleep: async () => {},
    fetchImpl: async (url) => {
      if (new URL(url).pathname === "/api/send") sends += 1;
      return jsonResponse({ messages: [] });
    },
  });
  assert.equal(result.healthy, false);
  assert.equal(result.code, "CANARY_TIMEOUT");
  assert.equal(sends, 0);
});

test("canary timeout persists one failure and does not loop-send during the same run", async (t) => {
  const stateDir = createTempDir(t);
  const config = createConfig(stateDir, { probeTimeoutMs: 10_000 });
  let clock = Date.parse("2026-08-28T12:00:00.000Z");
  let sends = 0;
  const fetchImpl = async (url) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === "/api/v1/messages") {
      return jsonResponse({ messages: [] });
    }
    if (parsedUrl.pathname === "/api/send") {
      sends += 1;
      return jsonResponse({
        dispatched: true,
        verified: false,
        uncertain: true,
        targetVerified: true,
        selectedContact: config.contact,
        verifiedTalker: config.talker,
      });
    }
    throw new Error(`unexpected URL: ${parsedUrl}`);
  };

  const result = await runScheduledCanary(config, {
    fetchImpl,
    sleep: async () => {},
    now: () => {
      clock += 1_000;
      return clock;
    },
  });
  assert.equal(result.healthy, false);
  assert.equal(result.code, "CANARY_TIMEOUT");
  assert.equal(sends, 1);

  const schedule = JSON.parse(fs.readFileSync(config.scheduleFile, "utf8"));
  assert.equal(schedule.lastStatus, "failed");
  assert.equal(schedule.consecutiveFailures, 1);
  assert.equal(schedule.activeRunId, "");
});

test("bridge desktop race is deferred without consuming a canary failure or probe budget", async (t) => {
  const stateDir = createTempDir(t);
  const config = createConfig(stateDir, { desktopIdleSeconds: 60 });
  let bridgeRequests = 0;
  let bridgeBody;
  const fetchImpl = async (url, init = {}) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === "/api/v1/messages") {
      return jsonResponse({ messages: [] });
    }
    if (parsedUrl.pathname === "/api/send") {
      bridgeRequests += 1;
      bridgeBody = JSON.parse(init.body);
      return jsonResponse({
        dispatched: false,
        code: "CANARY_DESKTOP_ACTIVE",
        error: "desktop input became active immediately before dispatch",
        desktopIdleSeconds: 2,
        requiredDesktopIdleSeconds: 300,
      }, 409);
    }
    throw new Error(`unexpected URL: ${parsedUrl}`);
  };

  const result = await runScheduledCanary(config, { fetchImpl, sleep: async () => {} });
  assert.equal(bridgeRequests, 1);
  assert.equal(bridgeBody.requireDesktopIdleSeconds, 300);
  assert.equal(result.healthy, null);
  assert.equal(result.action, "deferred_busy");
  assert.equal(result.code, "CANARY_DESKTOP_ACTIVE");
  assert.equal(result.attempted, false);
  assert.equal(result.desktopIdleSeconds, 2);

  const schedule = JSON.parse(fs.readFileSync(config.scheduleFile, "utf8"));
  assert.equal(schedule.lastStatus, "never");
  assert.equal(schedule.lastAction, "deferred_busy");
  assert.equal(schedule.consecutiveFailures, 0);
  assert.deepEqual(schedule.attempts, []);
  assert.equal(schedule.activeRunId, "");
});

test("desktop deferral preserves a prior completed nonrepairable target failure", async (t) => {
  const stateDir = createTempDir(t);
  const nowMs = Date.parse("2026-08-28T12:00:00.000Z");
  const config = createConfig(stateDir, { failureRetryMs: 60_000 });
  const priorAttempt = new Date(nowMs - 2 * 60_000).toISOString();
  atomicWriteJson(config.scheduleFile, {
    ...emptySchedule(),
    targetFingerprint: config.targetFingerprint,
    lastRunId: "123e4567-e89b-42d3-a456-426614174000",
    lastAttemptAt: priorAttempt,
    lastFailureAt: priorAttempt,
    lastStatus: "failed",
    lastError: "exact target was not confirmed",
    lastRepairable: false,
    lastAction: "failed",
    consecutiveFailures: 2,
    attempts: [priorAttempt],
  });
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/api/v1/messages") return jsonResponse({ messages: [] });
    if (pathname === "/api/send") {
      return jsonResponse({
        dispatched: false,
        code: "CANARY_DESKTOP_ACTIVE",
        error: "desktop became active",
        desktopIdleSeconds: 1,
      }, 409);
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const result = await runScheduledCanary(config, {
    now: () => nowMs,
    fetchImpl,
    sleep: async () => {},
  });
  assert.equal(result.action, "deferred_busy");

  const schedule = JSON.parse(fs.readFileSync(config.scheduleFile, "utf8"));
  assert.equal(schedule.lastStatus, "failed");
  assert.equal(schedule.lastError, "exact target was not confirmed");
  assert.equal(schedule.lastRepairable, false);
  assert.equal(schedule.consecutiveFailures, 2);
  assert.equal(schedule.lastAttemptAt, priorAttempt);
  assert.deepEqual(schedule.attempts, [priorAttempt]);
  assert.equal(schedule.lastAction, "deferred_busy");
});

test("an unconfirmed exact Azzy search target fails closed and is marked non-restartable", async (t) => {
  const stateDir = createTempDir(t);
  const config = createConfig(stateDir);
  const fetchImpl = async (url) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === "/api/v1/messages") return jsonResponse({ messages: [] });
    if (parsedUrl.pathname === "/api/send") {
      return jsonResponse({
        dispatched: false,
        verified: false,
        targetVerified: false,
        code: "TARGET_NOT_CONFIRMED",
        error: "exact search returned zero results",
      }, 409);
    }
    throw new Error(`unexpected URL: ${parsedUrl}`);
  };

  const result = await runScheduledCanary(config, { fetchImpl, sleep: async () => {} });
  assert.equal(result.healthy, false);
  assert.equal(result.code, "TARGET_NOT_CONFIRMED");
  assert.equal(result.repairable, false);
  const schedule = JSON.parse(fs.readFileSync(config.scheduleFile, "utf8"));
  assert.equal(schedule.lastStatus, "failed");
  assert.equal(schedule.consecutiveFailures, 1);
  assert.equal(schedule.lastRepairable, false);

  const waiting = await runScheduledCanary(config, { fetchImpl, sleep: async () => {} });
  assert.equal(waiting.action, "waiting_retry");
  assert.equal(waiting.repairable, false);
});

test("a persisted reply target mismatch stops the run without retrying UI dispatch", async (t) => {
  const stateDir = createTempDir(t);
  const config = createConfig(stateDir);
  const messages = [];
  let sends = 0;
  const fetchImpl = async (url, init = {}) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === "/api/v1/messages") return jsonResponse({ messages });
    if (parsedUrl.pathname === "/api/send") {
      sends += 1;
      const body = JSON.parse(init.body);
      const runId = body.text.match(/trigger=([0-9a-f-]{36})/u)[1];
      const runDir = path.join(config.runsDir, runId);
      messages.push({
        isSend: 1,
        localId: "601",
        content: body.text,
        senderUsername: config.talker,
      });
      atomicWriteJson(path.join(runDir, "reply-failed.json"), {
        version: 1,
        runId,
        code: "TARGET_NOT_CONFIRMED",
        repairable: false,
        error: "exact reply title mismatch",
      });
      return jsonResponse({
        dispatched: true,
        verified: true,
        localId: "601",
        targetVerified: true,
        selectedContact: config.contact,
        verifiedTalker: config.talker,
      });
    }
    throw new Error(`unexpected URL: ${parsedUrl}`);
  };
  const result = await runScheduledCanary(config, { fetchImpl, sleep: async () => {} });
  assert.equal(result.code, "TARGET_NOT_CONFIRMED");
  assert.equal(result.repairable, false);
  assert.equal(sends, 1);
});
