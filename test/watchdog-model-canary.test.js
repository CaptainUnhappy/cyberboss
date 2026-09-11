const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createModelCanaryDesktopInputLeaseReceipt,
  createModelCanaryManifest,
} = require("../src/integrations/weflow-model-canary");
const {
  MIN_DESKTOP_IDLE_SECONDS,
  MIN_ROUTINE_INTERVAL_MS,
  acquireOwnerLock,
  atomicWriteJson,
  buildTargetFingerprint,
  decideModelCanaryDue,
  emptySchedule,
  getModelCanaryAttemptGate,
  inspectModelCursorDrain,
  inspectTerminalFailure,
  recoverBridgeDesktopInputLease,
  runScheduledModelCanary,
  validateModelMilestones,
} = require("../scripts/cyberboss-watchdog-model-canary");

function createTempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-model-canary-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function createConfig(stateDir, overrides = {}) {
  const config = {
    enabled: true,
    stateDir,
    runsDir: path.join(stateDir, "model-e2e-probes"),
    scheduleFile: path.join(stateDir, "cyberboss-watchdog-model-canary.json"),
    lockFile: path.join(stateDir, "cyberboss-watchdog-model-canary.lock"),
    bridgeBaseUrl: "http://127.0.0.1:8766",
    weflowBaseUrl: "http://127.0.0.1:5031",
    token: "test-token",
    primaryTalker: "wxid_primary",
    talker: "wxid_azzy_self",
    contact: "Azzy",
    demandKey: "",
    desktopIdleSeconds: MIN_DESKTOP_IDLE_SECONDS,
    probeTimeoutMs: 60_000,
    routineIntervalMs: MIN_ROUTINE_INTERVAL_MS,
    pollIntervalMs: 1,
    quietWindowMs: 0,
    requestTimeoutMs: 1_000,
    bridgeSendTimeoutMs: 1_000,
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

function writeBoundReceipt(runDir, manifest, name, fields) {
  atomicWriteJson(path.join(runDir, name), {
    version: 1,
    mode: "model_e2e",
    runId: manifest.runId,
    nonce: manifest.nonce,
    obligationFingerprint: manifest.obligationFingerprint,
    ...fields,
  });
}

function createVerifiedHarness(config, { assertBridgeBody, failAfterDurableLease = false } = {}) {
  const messages = [];
  let sendCount = 0;
  return {
    get sendCount() { return sendCount; },
    messages,
    async fetchImpl(url, init = {}) {
      const parsed = new URL(url);
      if (parsed.pathname === "/api/v1/messages") return jsonResponse({ messages });
      assert.equal(parsed.pathname, "/api/send");
      sendCount += 1;
      const body = JSON.parse(init.body);
      assertBridgeBody?.(body);
      const runId = body.text.match(/trigger=([0-9a-f-]{36})/u)[1];
      const runDir = path.join(config.runsDir, runId);
      const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
      const triggerLocalId = "8100";
      const replyLocalId = "8101";
      const recordedAt = new Date(Date.now() - 1_000).toISOString();
      messages.push(
        { isSend: 1, localId: triggerLocalId, content: manifest.triggerText, senderUsername: config.talker },
        { isSend: 1, localId: replyLocalId, content: manifest.replyText, senderUsername: config.talker },
      );
      writeBoundReceipt(runDir, manifest, "ingested.json", {
        status: "ingested",
        triggerLocalId,
        ingestedAt: recordedAt,
      });
      writeBoundReceipt(runDir, manifest, "handoff.json", {
        status: "accepted",
        threadId: "thread-model-probe",
        turnId: "turn-model-probe",
        acceptedAt: recordedAt,
      });
      writeBoundReceipt(runDir, manifest, "model-completed.json", {
        status: "completed",
        assistantFinalPresent: true,
        assistantFinalSha256: "c".repeat(64),
        assistantFinalLength: 8,
        assistantFinalBytes: 12,
        threadId: "thread-model-probe",
        turnId: "turn-model-probe",
        recordedAt,
      });
      writeBoundReceipt(runDir, manifest, "reply-dispatched.json", {
        status: "verified",
        replyLocalId,
        messageKind: manifest.replyMessageKind,
        idempotencyKey: manifest.replyIdempotencyKey,
        threadId: "thread-model-probe",
        turnId: "turn-model-probe",
        verified: true,
        recordedAt,
      });
      writeBoundReceipt(runDir, manifest, "reply-observed.json", {
        status: "observed",
        replyLocalId,
        messageKind: manifest.replyMessageKind,
        idempotencyKey: manifest.replyIdempotencyKey,
        recordedAt,
      });
      writeBoundReceipt(runDir, manifest, "turn-released.json", {
        status: "released",
        threadId: "thread-model-probe",
        turnId: "turn-model-probe",
        recordedAt,
      });
      atomicWriteJson(config.cursorFile, {
        version: 1,
        talker: config.talker,
        lastLocalId: replyLocalId,
        seenIdentities: [`local:${triggerLocalId}`, `local:${replyLocalId}`],
        updatedAt: new Date().toISOString(),
        lastPolledAt: new Date().toISOString(),
      });
      const leaseToken = "a".repeat(64);
      atomicWriteJson(path.join(
        config.stateDir,
        "weflow-uia-desktop-input-leases",
        `${manifest.runId}.json`,
      ), {
        version: 1,
        mode: "model_e2e",
        runId: manifest.runId,
        nonce: manifest.nonce,
        targetFingerprint: manifest.targetFingerprint,
        replyIdempotencyKey: manifest.replyIdempotencyKey,
        expiresAt: manifest.expiresAt,
        status: "issued",
        contact: manifest.contact,
        talker: manifest.talker,
        triggerTextSha256: crypto.createHash("sha256").update(manifest.triggerText, "utf8").digest("hex"),
        replyTextSha256: crypto.createHash("sha256").update(manifest.replyText, "utf8").digest("hex"),
        token: leaseToken,
        tokenSha256: crypto.createHash("sha256").update(leaseToken, "utf8").digest("hex"),
        lastInputTick: 77,
        issuedAt: manifest.createdAt,
      });
      if (failAfterDurableLease) {
        throw new Error("synthetic connection loss after bridge lease persistence");
      }
      return jsonResponse({
        dispatched: true,
        verified: true,
        localId: triggerLocalId,
        targetVerified: true,
        selectedContact: config.contact,
        verifiedTalker: config.talker,
        desktopInputLease: {
          version: 1,
          mode: "model_e2e",
          runId: manifest.runId,
          nonce: manifest.nonce,
          targetFingerprint: manifest.targetFingerprint,
          replyIdempotencyKey: manifest.replyIdempotencyKey,
          expiresAt: manifest.expiresAt,
          token: leaseToken,
          lastInputTick: 77,
          issuedAt: manifest.createdAt,
        },
      });
    },
  };
}

function createLateRaceHarness(t, { tamper } = {}) {
  const stateDir = createTempDir(t);
  const config = createConfig(stateDir, {
    demandKey: "user:model-e2e:late-race",
    quietWindowMs: 5_000,
  });
  const createdAtMs = Date.parse("2026-08-29T12:00:00.000Z");
  const nowMs = createdAtMs + 2 * 60_000;
  const created = createModelCanaryManifest({
    stateDir,
    talker: config.talker,
    contact: config.contact,
    demandKey: config.demandKey,
    nowMs: createdAtMs,
    ttlMs: 60_000,
  });
  const { manifest, runDir } = created;
  const at = (offsetMs) => new Date(createdAtMs + offsetMs).toISOString();
  const triggerLocalId = "9";
  const replyLocalId = "10";
  const threadId = "thread-late-race";
  const turnId = "turn-late-race";
  const token = "d".repeat(64);
  const tokenSha256 = crypto.createHash("sha256").update(token, "utf8").digest("hex");
  const lease = createModelCanaryDesktopInputLeaseReceipt(manifest, {
    version: 1,
    mode: "model_e2e",
    runId: manifest.runId,
    nonce: manifest.nonce,
    targetFingerprint: manifest.targetFingerprint,
    replyIdempotencyKey: manifest.replyIdempotencyKey,
    expiresAt: manifest.expiresAt,
    token,
    lastInputTick: 77,
    issuedAt: at(3_000),
  }, { nowMs: createdAtMs + 3_100 });
  atomicWriteJson(path.join(runDir, "desktop-input-lease.json"), lease);

  fs.mkdirSync(path.join(runDir, "trigger-send-claim"));
  writeBoundReceipt(path.join(runDir, "trigger-send-claim"), manifest, "claim.json", {
    ownerToken: "a".repeat(32),
    claimedAt: at(100),
  });
  writeBoundReceipt(runDir, manifest, "trigger-dispatched.json", {
    triggerLocalId,
    targetVerified: true,
    bridgeVerified: true,
    desktopInputLeaseManifestFingerprint: lease.manifestFingerprint,
    recordedAt: at(3_200),
  });
  writeBoundReceipt(runDir, manifest, "ingested.json", {
    status: "ingested",
    talker: config.talker,
    direction: "outgoing",
    triggerLocalId,
    triggerMessageId: "server-trigger-9",
    triggerObservedAt: at(3_000),
    ingestedAt: at(4_000),
  });
  fs.mkdirSync(path.join(runDir, "handoff-claim"));
  writeBoundReceipt(path.join(runDir, "handoff-claim"), manifest, "claim.json", {
    triggerLocalId,
    triggerMessageId: "server-trigger-9",
    claimedAt: at(4_010),
  });
  writeBoundReceipt(runDir, manifest, "handoff.json", {
    status: "accepted",
    threadId,
    turnId,
    bindingKey: "binding-late-race",
    workspaceRoot: "D:/fixture-workspace",
    recordedAt: at(5_000),
    acceptedAt: at(5_000),
  });
  writeBoundReceipt(runDir, manifest, "model-completed.json", {
    status: "completed",
    threadId,
    turnId,
    assistantFinalPresent: true,
    assistantFinalSha256: "c".repeat(64),
    assistantFinalLength: 8,
    assistantFinalBytes: 8,
    recordedAt: at(10_000),
  });
  fs.mkdirSync(path.join(runDir, "reply-send-claim"));
  writeBoundReceipt(path.join(runDir, "reply-send-claim"), manifest, "claim.json", {
    status: "claimed",
    threadId,
    turnId,
    messageKind: manifest.replyMessageKind,
    idempotencyKey: manifest.replyIdempotencyKey,
    recordedAt: at(10_010),
  });
  writeBoundReceipt(runDir, manifest, "reply-dispatched.json", {
    status: "reconciled_from_echo",
    talker: config.talker,
    contact: config.contact,
    replyLocalId,
    messageKind: manifest.replyMessageKind,
    idempotencyKey: manifest.replyIdempotencyKey,
    recordedAt: at(12_000),
  });
  writeBoundReceipt(runDir, manifest, "reply-observed.json", {
    status: "observed",
    talker: config.talker,
    direction: "outgoing",
    replyLocalId,
    replyMessageId: "server-reply-10",
    replyObservedAt: at(11_000),
    messageKind: manifest.replyMessageKind,
    idempotencyKey: manifest.replyIdempotencyKey,
    matchedBy: "content_hash_fifo",
    recordedAt: at(12_000),
  });
  writeBoundReceipt(runDir, manifest, "turn-released.json", {
    status: "released",
    threadId,
    turnId,
    recordedAt: at(12_300),
  });

  const privateLeaseDir = path.join(stateDir, "weflow-uia-desktop-input-leases");
  const privateLeasePath = path.join(privateLeaseDir, `${manifest.runId}.json`);
  atomicWriteJson(privateLeasePath, {
    version: 1,
    mode: "model_e2e",
    runId: manifest.runId,
    nonce: manifest.nonce,
    targetFingerprint: manifest.targetFingerprint,
    replyIdempotencyKey: manifest.replyIdempotencyKey,
    expiresAt: manifest.expiresAt,
    status: "consumed",
    contact: manifest.contact,
    talker: manifest.talker,
    triggerTextSha256: crypto.createHash("sha256").update(manifest.triggerText, "utf8").digest("hex"),
    replyTextSha256: crypto.createHash("sha256").update(manifest.replyText, "utf8").digest("hex"),
    tokenSha256,
    lastInputTick: 77,
    issuedAt: at(3_000),
    claimedAt: at(10_100),
    consumedAt: at(12_100),
  });
  atomicWriteJson(`${privateLeasePath}.claim`, {
    version: 1,
    mode: "model_e2e",
    runId: manifest.runId,
    tokenSha256,
    claimedAt: at(10_100),
  });
  atomicWriteJson(path.join(stateDir, "weflow-message-ledger.json"), {
    version: 3,
    entries: [{
      id: "ledger-late-race",
      idempotencyKey: manifest.replyIdempotencyKey,
      talker: manifest.talker,
      contentHash: crypto.createHash("sha256").update(manifest.replyText, "utf8").digest("hex"),
      contentKind: "text",
      imageDigest: "",
      messageKind: manifest.replyMessageKind,
      expectedDirection: "outgoing",
      status: "verified",
      localId: replyLocalId,
      attemptCount: 1,
      uncertain: false,
      createdAt: at(10_020),
      updatedAt: at(12_200),
      sendingAt: at(10_020),
      verifiedAt: at(11_000),
      failedAt: "",
      observedAt: at(11_000),
      failureCode: "",
      failureHash: "",
    }],
  });
  atomicWriteJson(config.cursorFile, {
    version: 1,
    talker: manifest.talker,
    lastLocalId: replyLocalId,
    seenIdentities: [`local:${triggerLocalId}`, `local:${replyLocalId}`],
    updatedAt: at(12_050),
    lastPolledAt: at(12_050),
  });
  const failureSummary = {
    version: 1,
    mode: "model_e2e",
    healthy: false,
    action: "failed",
    attempted: true,
    repairable: false,
    checkedAt: new Date(Date.parse(manifest.expiresAt) + 1).toISOString(),
    runId: manifest.runId,
    code: "MODEL_CANARY_TIMEOUT",
    certainPredispatch: false,
    deliveryUncertain: true,
    error: "model E2E timed out: reply-dispatched runtime thread/turn binding is missing or inconsistent",
    resumed: false,
    elapsedMs: 60_001,
  };
  atomicWriteJson(path.join(runDir, "summary.json"), failureSummary);
  const attempts = [manifest.createdAt];
  atomicWriteJson(config.scheduleFile, {
    ...emptySchedule(),
    targetFingerprint: manifest.targetFingerprint,
    lastRunId: manifest.runId,
    lastAttemptAt: manifest.createdAt,
    lastFailureAt: failureSummary.checkedAt,
    lastStatus: "failed",
    lastError: failureSummary.error,
    lastAction: "failed",
    lastDetail: failureSummary.error,
    lastReason: "user_demand",
    nextDueAt: at(24 * 60 * 60_000),
    consecutiveFailures: 2,
    attempts,
    obligations: [{
      fingerprint: manifest.obligationFingerprint,
      runId: manifest.runId,
      reason: "user_demand",
      at: manifest.createdAt,
      state: "handled",
      healthy: false,
      code: "MODEL_CANARY_TIMEOUT",
    }],
    history: [{
      runId: manifest.runId,
      checkedAt: failureSummary.checkedAt,
      healthy: false,
      action: "failed",
      code: "MODEL_CANARY_TIMEOUT",
      triggerLocalId: "",
      replyLocalId: "",
    }],
  });
  tamper?.({ config, manifest, runDir, privateLeasePath });
  return { config, manifest, runDir, nowMs, attempts, failureSummary, threadId, turnId };
}

test("disabled runner stays inert and reports disabled/not_run", async (t) => {
  const stateDir = createTempDir(t);
  const result = await runScheduledModelCanary({ enabled: false, stateDir }, {
    fetchImpl: async () => { throw new Error("network must stay unused"); },
    now: () => Date.parse("2026-08-29T12:00:00.000Z"),
  });
  assert.equal(result.healthy, null);
  assert.equal(result.status, "disabled");
  assert.equal(result.action, "not_run");
  assert.equal(result.attempted, false);
  assert.equal(fs.readdirSync(stateDir).length, 0);
});

test("routine cadence is at least 24 hours and model budget is one/hour, two/day", () => {
  const nowMs = Date.parse("2026-08-29T12:00:00.000Z");
  const targetFingerprint = buildTargetFingerprint({ contact: "Azzy", talker: "wxid_azzy_self" });
  const schedule = {
    ...emptySchedule(),
    targetFingerprint,
    lastAttemptAt: new Date(nowMs - 23 * 60 * 60_000).toISOString(),
  };
  assert.equal(decideModelCanaryDue(schedule, {
    nowMs,
    targetFingerprint,
    routineIntervalMs: 1,
  }).due, false, "a caller cannot shorten the routine interval below 24h");
  schedule.lastAttemptAt = new Date(nowMs - 24 * 60 * 60_000).toISOString();
  assert.equal(decideModelCanaryDue(schedule, { nowMs, targetFingerprint }).due, true);

  const oneRecent = [new Date(nowMs - 30 * 60_000).toISOString()];
  assert.deepEqual(getModelCanaryAttemptGate(oneRecent, nowMs), {
    allowed: false,
    reason: "budget_hourly",
    retryAtMs: nowMs + 30 * 60_000,
  });
  const twoDaily = [2, 10].map((hours) => new Date(nowMs - hours * 60 * 60_000).toISOString());
  assert.equal(getModelCanaryAttemptGate(twoDaily, nowMs).reason, "budget_daily");
});

for (const [receiptName, expectedCode] of [
  ["tool-attempted.json", "MODEL_CANARY_TOOL_ATTEMPTED"],
  ["turn-release-failed.json", "MODEL_CANARY_TURN_RELEASE_FAILED"],
]) {
  test(`${receiptName} is a manifest-bound terminal model failure`, (t) => {
    const stateDir = createTempDir(t);
    const created = createModelCanaryManifest({
      stateDir,
      talker: "wxid_azzy_self",
      contact: "Azzy",
      demandKey: `fixture:${receiptName}`,
    });
    writeBoundReceipt(created.runDir, created.manifest, receiptName, {
      status: "failed",
      reason: "fixture_terminal_failure",
    });
    const error = inspectTerminalFailure(created.runDir, created.manifest);
    assert.equal(error.code, expectedCode);
    assert.match(error.message, /fixture_terminal_failure/);
  });
}

test("verified run proves every model milestone, exact Azzy route, cursor commit, initial idle gate, and same-run lease", async (t) => {
  const stateDir = createTempDir(t);
  const config = createConfig(stateDir, { demandKey: "user:model-e2e:one", desktopIdleSeconds: 10 });
  const harness = createVerifiedHarness(config, {
    assertBridgeBody(body) {
      assert.equal(body.contact, "Azzy");
      assert.equal(body.talker, config.talker);
      assert.equal(body.exactContact, true);
      assert.equal(body.expectedContact, "Azzy");
      assert.equal(body.expectedTalker, config.talker);
      assert.equal(body.requireDesktopIdleSeconds, 300);
      assert.deepEqual(body.desktopInputLeaseRequest, {
        version: 1,
        mode: "model_e2e",
        runId: body.text.match(/trigger=([0-9a-f-]{36})/u)[1],
        nonce: body.text.match(/nonce=([0-9a-f]{24})/u)[1],
        targetFingerprint: config.targetFingerprint,
        replyIdempotencyKey: `model-canary-reply:${body.text.match(/trigger=([0-9a-f-]{36})/u)[1]}`,
        expiresAt: body.desktopInputLeaseRequest.expiresAt,
      });
      assert.match(body.text, /^\[Cyberboss心跳模型探针 trigger=/u);
    },
  });
  const nowMs = Date.parse("2026-08-29T12:00:00.000Z");
  const result = await runScheduledModelCanary(config, {
    now: () => nowMs,
    fetchImpl: harness.fetchImpl,
    sleep: async () => {},
  });
  assert.equal(result.healthy, true);
  assert.equal(result.action, "verified");
  assert.equal(result.repairable, false);
  assert.equal(result.triggerLocalId, "8100");
  assert.equal(result.replyLocalId, "8101");
  assert.equal(result.threadId, "thread-model-probe");
  assert.equal(result.turnId, "turn-model-probe");
  assert.equal(result.confirmedFailure, false);
  assert.equal(harness.sendCount, 1);
  assert.equal(fs.existsSync(path.join(config.runsDir, result.runId, "trigger-send-claim", "claim.json")), true);
  const leaseReceipt = JSON.parse(fs.readFileSync(
    path.join(config.runsDir, result.runId, "desktop-input-lease.json"),
    "utf8",
  ));
  assert.equal(leaseReceipt.runId, result.runId);
  assert.equal(leaseReceipt.targetFingerprint, config.targetFingerprint);
  assert.equal(leaseReceipt.replyIdempotencyKey, `model-canary-reply:${result.runId}`);
  assert.equal(leaseReceipt.triggerLastInputTick, 77);
  assert.match(leaseReceipt.manifestFingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(fs.existsSync(path.join(config.runsDir, result.runId, "summary.json")), true);
});

test("a bridge-private issued lease recovers the Enter-to-response crash gap without resending", async (t) => {
  const stateDir = createTempDir(t);
  const config = createConfig(stateDir, { demandKey: "user:model-e2e:lease-response-gap" });
  const harness = createVerifiedHarness(config, { failAfterDurableLease: true });
  const nowMs = Date.parse("2026-08-29T12:00:00.000Z");
  const result = await runScheduledModelCanary(config, {
    now: () => nowMs,
    fetchImpl: harness.fetchImpl,
    sleep: async () => {},
  });
  assert.equal(result.healthy, true, JSON.stringify(result));
  assert.equal(result.action, "verified");
  assert.equal(harness.sendCount, 1);
  const receipt = JSON.parse(fs.readFileSync(
    path.join(config.runsDir, result.runId, "desktop-input-lease.json"),
    "utf8",
  ));
  assert.equal(receipt.leaseToken, "a".repeat(64));
  assert.equal(receipt.triggerLastInputTick, 77);
});

test("a restarted runner reconstructs the manifest receipt from the bridge-private issued lease", async (t) => {
  const stateDir = createTempDir(t);
  const config = createConfig(stateDir, { demandKey: "user:model-e2e:lease-restart-gap" });
  const nowMs = Date.parse("2026-08-29T12:00:00.000Z");
  const created = createModelCanaryManifest({
    stateDir,
    talker: config.talker,
    contact: config.contact,
    demandKey: config.demandKey,
    nowMs: nowMs - 1_000,
    ttlMs: 60_000,
  });
  const { manifest, runDir } = created;
  fs.mkdirSync(path.join(runDir, "trigger-send-claim"));
  atomicWriteJson(path.join(runDir, "trigger-send-claim", "claim.json"), {
    version: 1,
    mode: "model_e2e",
    runId: manifest.runId,
    nonce: manifest.nonce,
    obligationFingerprint: manifest.obligationFingerprint,
  });
  atomicWriteJson(config.scheduleFile, {
    ...emptySchedule(),
    targetFingerprint: config.targetFingerprint,
    activeRunId: manifest.runId,
    lastRunId: manifest.runId,
    lastAttemptAt: manifest.createdAt,
    attempts: [manifest.createdAt],
    obligations: [{
      fingerprint: manifest.obligationFingerprint,
      runId: manifest.runId,
      reason: "user_demand",
      at: manifest.createdAt,
      state: "reserved",
      healthy: null,
    }],
  });
  const harness = createVerifiedHarness(config, { failAfterDurableLease: true });
  await assert.rejects(harness.fetchImpl(`${config.bridgeBaseUrl}/api/send`, {
    method: "POST",
    body: JSON.stringify({ text: manifest.triggerText }),
  }), /synthetic connection loss/iu);
  assert.ok(recoverBridgeDesktopInputLease(config, manifest, { nowMs }));
  const bridgeClaimPath = path.join(
    config.stateDir,
    "weflow-uia-desktop-input-leases",
    `${manifest.runId}.json.claim`,
  );
  atomicWriteJson(bridgeClaimPath, { version: 1, runId: manifest.runId });
  assert.equal(recoverBridgeDesktopInputLease(config, manifest, { nowMs }), null);
  fs.unlinkSync(bridgeClaimPath);

  const result = await runScheduledModelCanary(config, {
    now: () => nowMs,
    fetchImpl: harness.fetchImpl,
    sleep: async () => {},
  });
  assert.equal(result.healthy, true, JSON.stringify(result));
  assert.equal(result.resumed, true);
  assert.equal(harness.sendCount, 1, "restart recovery must not re-enter /api/send");
  assert.equal(fs.existsSync(path.join(runDir, "desktop-input-lease.json")), true);
});

test("a dispatched trigger without a bridge-issued lease is fail-closed and never reaches model proof", async (t) => {
  const stateDir = createTempDir(t);
  const config = createConfig(stateDir, { demandKey: "user:model-e2e:lease-missing" });
  const nowMs = Date.parse("2026-08-29T12:00:00.000Z");
  let sends = 0;
  const result = await runScheduledModelCanary(config, {
    now: () => nowMs,
    sleep: async () => {},
    async fetchImpl(url) {
      if (new URL(url).pathname === "/api/v1/messages") {
        return jsonResponse({ messages: [] });
      }
      sends += 1;
      return jsonResponse({
        dispatched: true,
        verified: true,
        localId: "9001",
        targetVerified: true,
        selectedContact: config.contact,
        verifiedTalker: config.talker,
      });
    },
  });
  assert.equal(result.healthy, false);
  assert.equal(result.code, "MODEL_CANARY_DESKTOP_LEASE_INVALID");
  assert.equal(result.deliveryUncertain, true);
  assert.equal(sends, 1);
  assert.equal(
    fs.existsSync(path.join(config.runsDir, result.runId, "desktop-input-lease.json")),
    false,
  );
});

test("same explicit obligation is exactly once and returns its prior proof", async (t) => {
  const stateDir = createTempDir(t);
  const config = createConfig(stateDir, { demandKey: "user:model-e2e:duplicate" });
  const harness = createVerifiedHarness(config);
  const nowMs = Date.parse("2026-08-29T12:00:00.000Z");
  const first = await runScheduledModelCanary(config, {
    now: () => nowMs,
    fetchImpl: harness.fetchImpl,
    sleep: async () => {},
  });
  const second = await runScheduledModelCanary(config, {
    now: () => nowMs + 1_000,
    fetchImpl: harness.fetchImpl,
    sleep: async () => {},
  });
  assert.equal(first.healthy, true);
  assert.equal(second.healthy, true);
  assert.equal(second.action, "demand_already_handled");
  assert.equal(second.attempted, false);
  assert.equal(second.runId, first.runId);
  assert.equal(harness.sendCount, 1);
});

test("a handled legacy echo race upgrades the same run from complete local proof without fetch, send, or budget use", async (t) => {
  const fixture = createLateRaceHarness(t);
  let fetches = 0;
  const scheduleBefore = JSON.parse(fs.readFileSync(fixture.config.scheduleFile, "utf8"));
  const result = await runScheduledModelCanary(fixture.config, {
    now: () => fixture.nowMs,
    fetchImpl: async () => { fetches += 1; throw new Error("late reconciliation must stay local"); },
    sleep: async () => {},
  });
  assert.equal(result.healthy, true, JSON.stringify(result));
  assert.equal(result.action, "verified");
  assert.equal(result.attempted, false);
  assert.equal(result.lateReconciled, true);
  assert.equal(result.triggerLocalId, "9");
  assert.equal(result.replyLocalId, "10");
  assert.equal(result.threadId, fixture.threadId);
  assert.equal(result.turnId, fixture.turnId);
  assert.equal(fetches, 0);

  const dispatch = JSON.parse(fs.readFileSync(path.join(fixture.runDir, "reply-dispatched.json"), "utf8"));
  assert.equal(dispatch.threadId, fixture.threadId);
  assert.equal(dispatch.turnId, fixture.turnId);
  assert.match(dispatch.legacyReceiptSha256, /^[a-f0-9]{64}$/u);
  const schedule = JSON.parse(fs.readFileSync(fixture.config.scheduleFile, "utf8"));
  assert.deepEqual(schedule.attempts, scheduleBefore.attempts);
  assert.equal(schedule.lastStatus, "healthy");
  assert.equal(schedule.obligations[0].healthy, true);
  assert.equal(schedule.history.length, 2);
  assert.equal(schedule.history[0].healthy, false, "the original timeout remains auditable");
  assert.equal(schedule.history[1].healthy, true);
  assert.equal(schedule.history[1].lateReconciled, true);
  const summary = JSON.parse(fs.readFileSync(path.join(fixture.runDir, "summary.json"), "utf8"));
  assert.equal(summary.healthy, true);
  assert.equal(summary.runId, fixture.manifest.runId);
  assert.equal(summary.attempted, false);
  assert.equal(fs.existsSync(path.join(fixture.runDir, "late-success-reconciliation.json")), true);

  // Simulate a crash after the verified summary was committed but before the
  // schedule replacement. The same demand reconstructs from the durable audit
  // receipt and completes without another attempt or any I/O call.
  atomicWriteJson(fixture.config.scheduleFile, scheduleBefore);
  const recovered = await runScheduledModelCanary(fixture.config, {
    now: () => fixture.nowMs + 1_000,
    fetchImpl: async () => { fetches += 1; throw new Error("recovery must stay local"); },
    sleep: async () => {},
  });
  assert.equal(recovered.healthy, true, JSON.stringify(recovered));
  assert.equal(recovered.action, "verified");
  assert.equal(recovered.runId, fixture.manifest.runId);
  assert.equal(fetches, 0);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(fixture.config.scheduleFile, "utf8")).attempts,
    scheduleBefore.attempts,
  );
});

for (const [name, tamper] of [
  ["missing consumed lease claim", ({ privateLeasePath }) => fs.unlinkSync(`${privateLeasePath}.claim`)],
  ["wrong consumed lease claim", ({ privateLeasePath }) => {
    const claim = JSON.parse(fs.readFileSync(`${privateLeasePath}.claim`, "utf8"));
    atomicWriteJson(`${privateLeasePath}.claim`, { ...claim, tokenSha256: "0".repeat(64) });
  }],
  ["cursor lastLocalId without explicit seen identities", ({ config }) => {
    const cursor = JSON.parse(fs.readFileSync(config.cursorFile, "utf8"));
    atomicWriteJson(config.cursorFile, { ...cursor, seenIdentities: ["local:9"] });
  }],
  ["ledger localId mismatch", ({ config }) => {
    const ledgerPath = path.join(config.stateDir, "weflow-message-ledger.json");
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    ledger.entries[0].localId = "11";
    atomicWriteJson(ledgerPath, ledger);
  }],
  ["imprecise timeout flags", ({ runDir }) => {
    const summaryPath = path.join(runDir, "summary.json");
    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    atomicWriteJson(summaryPath, { ...summary, certainPredispatch: true });
  }],
  ["terminal runtime receipt", ({ runDir, manifest }) => {
    writeBoundReceipt(runDir, manifest, "tool-attempted.json", {
      status: "failed",
      reason: "fixture_terminal_failure",
    });
  }],
  ["reversed reply claim/lease order", ({ privateLeasePath }) => {
    const lease = JSON.parse(fs.readFileSync(privateLeasePath, "utf8"));
    atomicWriteJson(privateLeasePath, { ...lease, claimedAt: new Date(Date.parse(lease.claimedAt) - 1_000).toISOString() });
    const claim = JSON.parse(fs.readFileSync(`${privateLeasePath}.claim`, "utf8"));
    atomicWriteJson(`${privateLeasePath}.claim`, { ...claim, claimedAt: new Date(Date.parse(claim.claimedAt) - 1_000).toISOString() });
  }],
]) {
  test(`late reconciliation fails closed for ${name}`, async (t) => {
    const fixture = createLateRaceHarness(t, { tamper });
    let fetches = 0;
    const result = await runScheduledModelCanary(fixture.config, {
      now: () => fixture.nowMs,
      fetchImpl: async () => { fetches += 1; throw new Error("must not fetch"); },
      sleep: async () => {},
    });
    assert.equal(result.healthy, false);
    assert.equal(result.action, "demand_already_handled");
    assert.equal(result.attempted, false);
    assert.equal(fetches, 0);
    const dispatch = JSON.parse(fs.readFileSync(path.join(fixture.runDir, "reply-dispatched.json"), "utf8"));
    assert.equal(dispatch.threadId, undefined);
    assert.equal(dispatch.turnId, undefined);
    const schedule = JSON.parse(fs.readFileSync(fixture.config.scheduleFile, "utf8"));
    assert.deepEqual(schedule.attempts, fixture.attempts);
    assert.equal(schedule.lastStatus, "failed");
  });
}

test("uncertain trigger dispatch is never retried for the same obligation", async (t) => {
  const stateDir = createTempDir(t);
  const config = createConfig(stateDir, { demandKey: "user:model-e2e:uncertain" });
  let sends = 0;
  const fetchImpl = async (url) => {
    if (new URL(url).pathname === "/api/v1/messages") return jsonResponse({ messages: [] });
    sends += 1;
    throw new Error("connection reset after request bytes left the process");
  };
  const nowMs = Date.parse("2026-08-29T12:00:00.000Z");
  const first = await runScheduledModelCanary(config, {
    now: () => nowMs,
    fetchImpl,
    sleep: async () => {},
  });
  assert.equal(first.healthy, false);
  assert.equal(first.deliveryUncertain, true);
  assert.equal(first.certainPredispatch, false);
  assert.equal(sends, 1);

  const second = await runScheduledModelCanary(config, {
    now: () => nowMs + 1_000,
    fetchImpl,
    sleep: async () => {},
  });
  assert.equal(second.action, "demand_already_handled");
  assert.equal(second.attempted, false);
  assert.equal(sends, 1, "the durable trigger claim prevents a second send");
});

test("two distinct failed model probes are required before failure is confirmed", async (t) => {
  const stateDir = createTempDir(t);
  let sends = 0;
  const fetchImpl = async (url) => {
    if (new URL(url).pathname === "/api/v1/messages") return jsonResponse({ messages: [] });
    sends += 1;
    throw new Error("uncertain send failure");
  };
  const firstAt = Date.parse("2026-08-29T12:00:00.000Z");
  const first = await runScheduledModelCanary(createConfig(stateDir, { demandKey: "failure-one" }), {
    now: () => firstAt,
    fetchImpl,
    sleep: async () => {},
  });
  assert.equal(first.healthy, false);
  assert.equal(first.consecutiveFailures, 1);
  assert.equal(first.confirmedFailure, false);

  const secondAt = firstAt + 2 * 60 * 60_000;
  const second = await runScheduledModelCanary(createConfig(stateDir, { demandKey: "failure-two" }), {
    now: () => secondAt,
    fetchImpl,
    sleep: async () => {},
  });
  assert.equal(second.healthy, false);
  assert.equal(second.consecutiveFailures, 2);
  assert.equal(second.confirmedFailure, true);
  assert.equal(second.repairable, false);
  assert.equal(sends, 2);
});

test("desktop busy is a pre-dispatch deferral and releases demand plus budget reservation", async (t) => {
  const stateDir = createTempDir(t);
  const config = createConfig(stateDir, { demandKey: "user:model-e2e:busy" });
  let sendCalls = 0;
  const nowMs = Date.parse("2026-08-29T12:00:00.000Z");
  const result = await runScheduledModelCanary(config, {
    now: () => nowMs,
    sleep: async () => {},
    fetchImpl: async (url) => {
      if (new URL(url).pathname === "/api/v1/messages") return jsonResponse({ messages: [] });
      sendCalls += 1;
      return jsonResponse({
        code: "CANARY_DESKTOP_ACTIVE",
        error: "desktop input is recent",
        dispatched: false,
        desktopIdleSeconds: 12,
      }, 409);
    },
  });
  assert.equal(result.healthy, null);
  assert.equal(result.action, "deferred_busy");
  assert.equal(result.attempted, false);
  assert.equal(result.desktopIdleSeconds, 12);
  assert.equal(sendCalls, 1);
  const schedule = JSON.parse(fs.readFileSync(config.scheduleFile, "utf8"));
  assert.deepEqual(schedule.attempts, []);
  assert.equal(schedule.obligations.at(-1).state, "released");
});

test("a new explicit demand never resumes or credits a different active obligation", async (t) => {
  const stateDir = createTempDir(t);
  const config = createConfig(stateDir, { demandKey: "new-demand" });
  const nowMs = Date.parse("2026-08-29T12:00:00.000Z");
  const created = createModelCanaryManifest({
    stateDir,
    talker: config.talker,
    contact: config.contact,
    demandKey: "old-demand",
    nowMs: nowMs - 1_000,
    ttlMs: 60_000,
  });
  atomicWriteJson(config.scheduleFile, {
    ...emptySchedule(),
    targetFingerprint: config.targetFingerprint,
    activeRunId: created.manifest.runId,
    lastRunId: created.manifest.runId,
    lastAttemptAt: created.manifest.createdAt,
    attempts: [created.manifest.createdAt],
    obligations: [{
      fingerprint: created.manifest.obligationFingerprint,
      runId: created.manifest.runId,
      reason: "user_demand",
      at: created.manifest.createdAt,
      state: "reserved",
      healthy: null,
    }],
  });
  let fetches = 0;
  const result = await runScheduledModelCanary(config, {
    now: () => nowMs,
    fetchImpl: async () => { fetches += 1; throw new Error("must not fetch"); },
  });
  assert.equal(result.healthy, null);
  assert.equal(result.action, "obligation_wait");
  assert.equal(result.runId, created.manifest.runId);
  assert.equal(fetches, 0);
});

test("milestone validation rejects a receipt copied from another obligation", () => {
  const manifest = {
    runId: "123e4567-e89b-42d3-a456-426614174000",
    nonce: "0123456789abcdef01234567",
    obligationFingerprint: "a".repeat(64),
    replyMessageKind: "model_canary_reply:123e4567-e89b-42d3-a456-426614174000",
    replyIdempotencyKey: "model-canary-reply:123e4567-e89b-42d3-a456-426614174000",
  };
  const bound = (fields) => ({
    version: 1,
    mode: "model_e2e",
    runId: manifest.runId,
    nonce: manifest.nonce,
    obligationFingerprint: manifest.obligationFingerprint,
    ...fields,
  });
  const receipts = {
    ingested: bound({ status: "ingested", triggerLocalId: "1" }),
    handoff: bound({ status: "accepted", threadId: "thread", turnId: "turn" }),
    modelCompleted: bound({
      status: "completed",
      assistantFinalPresent: true,
      assistantFinalSha256: "c".repeat(64),
      assistantFinalLength: 8,
      assistantFinalBytes: 12,
      threadId: "thread",
      turnId: "turn",
    }),
    replyDispatched: bound({
      status: "verified",
      replyLocalId: "2",
      messageKind: manifest.replyMessageKind,
      idempotencyKey: manifest.replyIdempotencyKey,
      threadId: "thread",
      turnId: "turn",
    }),
    replyObserved: bound({
      status: "observed",
      replyLocalId: "2",
      messageKind: manifest.replyMessageKind,
      idempotencyKey: manifest.replyIdempotencyKey,
    }),
    turnReleased: bound({ status: "released", threadId: "thread", turnId: "turn" }),
  };
  receipts.modelCompleted.obligationFingerprint = "b".repeat(64);
  const result = validateModelMilestones({ manifest, receipts, triggerLocalId: "1", replyLocalId: "2" });
  assert.equal(result.ok, false);
  assert.match(result.detail, /binding/iu);
});

for (const receiptName of ["modelCompleted", "replyDispatched", "turnReleased"]) {
  test(`${receiptName} requires complete runtime thread/turn identity`, () => {
    for (const missingField of ["threadId", "turnId"]) {
      const manifest = {
        runId: "123e4567-e89b-42d3-a456-426614174000",
        nonce: "0123456789abcdef01234567",
        obligationFingerprint: "a".repeat(64),
        replyMessageKind: "model_canary_reply:123e4567-e89b-42d3-a456-426614174000",
        replyIdempotencyKey: "model-canary-reply:123e4567-e89b-42d3-a456-426614174000",
      };
      const bound = (fields) => ({
        version: 1,
        mode: "model_e2e",
        runId: manifest.runId,
        nonce: manifest.nonce,
        obligationFingerprint: manifest.obligationFingerprint,
        ...fields,
      });
      const receipts = {
        ingested: bound({ status: "ingested", triggerLocalId: "1" }),
        handoff: bound({ status: "accepted", threadId: "thread", turnId: "turn" }),
        modelCompleted: bound({
          status: "completed",
          assistantFinalPresent: true,
          assistantFinalSha256: "c".repeat(64),
          assistantFinalLength: 8,
          assistantFinalBytes: 12,
          threadId: "thread",
          turnId: "turn",
        }),
        replyDispatched: bound({
          status: "verified",
          replyLocalId: "2",
          messageKind: manifest.replyMessageKind,
          idempotencyKey: manifest.replyIdempotencyKey,
          threadId: "thread",
          turnId: "turn",
        }),
        replyObserved: bound({
          status: "observed",
          replyLocalId: "2",
          messageKind: manifest.replyMessageKind,
          idempotencyKey: manifest.replyIdempotencyKey,
        }),
        turnReleased: bound({ status: "released", threadId: "thread", turnId: "turn" }),
      };
      delete receipts[receiptName][missingField];
      const result = validateModelMilestones({ manifest, receipts, triggerLocalId: "1", replyLocalId: "2" });
      assert.equal(result.ok, false, `${receiptName}.${missingField}`);
      assert.match(result.detail, /runtime thread\/turn binding/iu, `${receiptName}.${missingField}`);
    }
  });
}

test("cursor proof requires the Azzy talker and both committed localIds", (t) => {
  const stateDir = createTempDir(t);
  const cursorFile = path.join(stateDir, "cursor.json");
  atomicWriteJson(cursorFile, {
    version: 1,
    talker: "wxid_wrong",
    lastLocalId: "2",
    seenIdentities: ["local:1", "local:2"],
    updatedAt: new Date().toISOString(),
    lastPolledAt: new Date().toISOString(),
  });
  const wrong = inspectModelCursorDrain(cursorFile, {
    manifest: { talker: "wxid_azzy_self" },
    triggerLocalId: "1",
    replyLocalId: "2",
  });
  assert.equal(wrong.ok, false);
  atomicWriteJson(cursorFile, {
    version: 1,
    talker: "wxid_azzy_self",
    lastLocalId: "2",
    seenIdentities: ["local:1", "local:2"],
    updatedAt: new Date().toISOString(),
    lastPolledAt: new Date().toISOString(),
  });
  assert.equal(inspectModelCursorDrain(cursorFile, {
    manifest: { talker: "wxid_azzy_self" },
    triggerLocalId: "1",
    replyLocalId: "2",
  }).ok, true);
});

test("owner-token lock prevents an old owner from deleting a replacement lock", (t) => {
  const stateDir = createTempDir(t);
  const lockFile = path.join(stateDir, "model.lock");
  const firstRelease = acquireOwnerLock(lockFile, 1_000, 30_000);
  assert.equal(typeof firstRelease, "function");
  fs.utimesSync(lockFile, new Date(0), new Date(0));
  const secondRelease = acquireOwnerLock(lockFile, 2_000_000, 30_000);
  assert.equal(typeof secondRelease, "function");
  firstRelease();
  assert.equal(fs.existsSync(lockFile), true);
  secondRelease();
  assert.equal(fs.existsSync(lockFile), false);
});
