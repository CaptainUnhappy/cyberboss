const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  activateRestartNotification,
  cancelRestartNotification,
  createRestartNotification,
  dispatchPendingRestartNotifications,
  dispatchRestartNotification,
  ensureRestartNotification,
  readRestartNotificationState,
  writeRestartNotificationState,
} = require("../scripts/cyberboss-watchdog-restart-notification");
const {
  WeFlowMessageLedgerStore,
} = require("../src/integrations/weflow-message-ledger-store");

const REPAIR_IDENTITY = "2026-09-09T02:30:00.0000000Z";
const IDEMPOTENCY_KEY = `watchdog-restart:${REPAIR_IDENTITY}`;
const NOTIFICATION_TEXT = "✅ Cyberboss 守护管家已完成 Restart，服务已恢复。";
const projectRoot = path.resolve(__dirname, "..");
const watchdogPath = path.join(projectRoot, "scripts", "cyberboss-watchdog.ps1");
const helperPath = path.resolve(__dirname, "..", "scripts", "cyberboss-watchdog-restart-notification.js");

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function readWatchdogSource() {
  return fs.readFileSync(watchdogPath, "utf8").replace(/^\uFEFF/u, "");
}

function invokeWatchdogLibrary(command, stateDir, environment = {}) {
  const source = [
    "$ErrorActionPreference='Stop'",
    "$env:CYBERBOSS_WATCHDOG_LIBRARY_ONLY='1'",
    `$env:CYBERBOSS_STATE_DIR=${psQuote(stateDir)}`,
    `. ${psQuote(watchdogPath)}`,
    command,
  ].join("; ");
  const result = spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    source,
  ], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...environment },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

function createTempDir(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-watchdog-restart-notice-"));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function createFixture(t, overrides = {}) {
  const stateDir = createTempDir(t);
  return {
    stateDir,
    stateFile: path.join(stateDir, "cyberboss-watchdog-restart-notifications.json"),
    ledgerFile: path.join(stateDir, "weflow-message-ledger.json"),
    repairIdentity: REPAIR_IDENTITY,
    repairMode: "Restart",
    components: ["cyberboss", "uia"],
    primaryTalker: "wxid_primary_account",
    primaryContact: "Main Account",
    canaryTalker: "wxid_canary_self",
    text: NOTIFICATION_TEXT,
    config: {
      weflowBridgeBaseUrl: "http://127.0.0.1:8766",
      weflowBridgeTimeoutMs: 1_000,
    },
    ...overrides,
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function findNotification(state, repairIdentity = REPAIR_IDENTITY) {
  assert.equal(state.version, 1);
  assert.ok(Array.isArray(state.notifications));
  const notification = state.notifications.find((entry) => entry.repairIdentity === repairIdentity);
  assert.ok(notification, `missing restart notification for ${repairIdentity}`);
  return notification;
}

function findLedgerEntry(ledgerFile, talker = "wxid_primary_account") {
  const ledger = readJson(ledgerFile);
  assert.equal(ledger.version, 3);
  const entries = ledger.entries.filter((entry) => (
    entry.talker === talker && entry.idempotencyKey === IDEMPOTENCY_KEY
  ));
  assert.equal(entries.length, 1, "one repair identity must own exactly one ledger operation");
  return entries[0];
}

function enqueueAndActivate(fixture, deps = {}) {
  const ensured = ensureRestartNotification(fixture, deps);
  const activated = activateRestartNotification(fixture, deps);
  assert.ok(["activated", "already_activated"].includes(activated.action));
  return ensured.notification;
}

function runHelperCli(action, requestFile) {
  const result = spawnSync(process.execPath, [
    helperPath,
    "--action",
    action,
    "--request-file",
    requestFile,
  ], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

test("CLI exposes enqueue, activate, and cancel as separate lifecycle actions", (t) => {
  const fixture = createFixture(t);
  const requestFile = path.join(fixture.stateDir, "request.json");
  fs.writeFileSync(requestFile, JSON.stringify(fixture), "utf8");
  assert.equal(runHelperCli("enqueue", requestFile).action, "enqueued");
  assert.equal(findNotification(readJson(fixture.stateFile)).status, "awaiting_repair_verification");

  fs.writeFileSync(requestFile, JSON.stringify({
    ...fixture,
    text: "mismatched later CLI payload",
    components: ["mismatched"],
  }), "utf8");
  assert.equal(runHelperCli("activate", requestFile).action, "activated");
  let persisted = findNotification(readJson(fixture.stateFile));
  assert.equal(persisted.status, "pending");
  assert.equal(persisted.text, fixture.text);
  assert.deepEqual(persisted.components, fixture.components);

  fs.writeFileSync(requestFile, JSON.stringify({
    stateFile: fixture.stateFile,
    repairIdentity: fixture.repairIdentity,
    cancelReason: "fixture repair failed",
  }), "utf8");
  assert.equal(runHelperCli("cancel", requestFile).action, "cancelled");
  persisted = findNotification(readJson(fixture.stateFile));
  assert.equal(persisted.status, "cancelled");
  assert.equal(persisted.cancelReason, "fixture repair failed");
});

test("enqueue is inert until repair verification activates the persisted payload", async (t) => {
  const fixture = createFixture(t);
  const ensured = ensureRestartNotification(fixture, {
    now: () => Date.parse("2026-09-09T02:30:00.000Z"),
  });
  assert.equal(ensured.created, true);
  assert.equal(ensured.notification.status, "awaiting_repair_verification");
  assert.equal(ensured.notification.attemptCount, 0);

  let sends = 0;
  const beforeVerification = await dispatchRestartNotification(fixture, {
    fetchImpl: async () => { sends += 1; },
  });
  assert.equal(beforeVerification.action, "awaiting_repair_verification");
  assert.equal(sends, 0);
  assert.deepEqual(await dispatchPendingRestartNotifications(fixture, {
    fetchImpl: async () => { sends += 1; },
  }), []);
  assert.equal(sends, 0);
  assert.equal(fs.existsSync(fixture.ledgerFile), false);

  const mismatchedCallerPayload = {
    ...fixture,
    repairMode: "FullRestart",
    components: ["different-component"],
    text: "this later caller text must never replace the enqueued payload",
  };
  const activated = activateRestartNotification(mismatchedCallerPayload, {
    now: () => Date.parse("2026-09-09T02:31:00.000Z"),
  });
  assert.equal(activated.action, "activated");
  const persisted = findNotification(readJson(fixture.stateFile));
  assert.equal(persisted.status, "pending");
  assert.equal(persisted.repairMode, fixture.repairMode);
  assert.deepEqual(persisted.components, fixture.components);
  assert.equal(persisted.text, fixture.text);

  const sentBodies = [];
  const delivered = await dispatchRestartNotification(mismatchedCallerPayload, {
    fetchImpl: async (_url, init = {}) => {
      sentBodies.push(JSON.parse(init.body));
      return jsonResponse({
        dispatched: true,
        verified: true,
        localId: "700",
        targetVerified: true,
        selectedContact: fixture.primaryContact,
        verifiedTalker: fixture.primaryTalker,
      });
    },
  });
  assert.equal(delivered.action, "verified");
  assert.equal(sentBodies.length, 1);
  assert.equal(sentBodies[0].text, fixture.text);
});

test("a failed repair can cancel its inert or active notification without ever sending", async (t) => {
  const fixture = createFixture(t);
  ensureRestartNotification(fixture);
  const cancelled = cancelRestartNotification({
    stateFile: fixture.stateFile,
    repairIdentity: fixture.repairIdentity,
    cancelReason: "repair controller failed",
  }, {
    now: () => Date.parse("2026-09-09T02:31:00.000Z"),
  });
  assert.equal(cancelled.action, "cancelled");
  let persisted = findNotification(readJson(fixture.stateFile));
  assert.equal(persisted.status, "cancelled");
  assert.equal(persisted.cancelReason, "repair controller failed");
  assert.equal(persisted.cancelledAt, "2026-09-09T02:31:00.000Z");

  assert.equal(activateRestartNotification(fixture).action, "cancelled");
  let sends = 0;
  assert.equal((await dispatchRestartNotification(fixture, {
    fetchImpl: async () => { sends += 1; },
  })).action, "cancelled");
  assert.deepEqual(await dispatchPendingRestartNotifications(fixture, {
    fetchImpl: async () => { sends += 1; },
  }), []);
  assert.equal(cancelRestartNotification({
    stateFile: fixture.stateFile,
    repairIdentity: fixture.repairIdentity,
  }).action, "already_cancelled");
  assert.equal(sends, 0);
  assert.equal(fs.existsSync(fixture.ledgerFile), false);
  persisted = findNotification(readJson(fixture.stateFile));
  assert.equal(persisted.attemptCount, 0);
});

test("drain revalidates the current primary and canary configuration before sending", async (t) => {
  const fixture = createFixture(t);
  enqueueAndActivate(fixture);
  let sends = 0;
  const changedPrimary = await dispatchPendingRestartNotifications({
    ...fixture,
    primaryTalker: "wxid_new_primary",
  }, {
    fetchImpl: async () => { sends += 1; },
  });
  assert.equal(changedPrimary.length, 1);
  assert.equal(changedPrimary[0].action, "configuration_blocked");
  assert.match(changedPrimary[0].lastError, /current primaryTalker/u);

  const aliasedCanary = await dispatchPendingRestartNotifications({
    ...fixture,
    canaryTalker: fixture.primaryTalker,
  }, {
    fetchImpl: async () => { sends += 1; },
  });
  assert.equal(aliasedCanary.length, 1);
  assert.equal(aliasedCanary[0].action, "configuration_blocked");
  assert.match(aliasedCanary[0].lastError, /canary/u);
  assert.equal(sends, 0);
  assert.equal(findNotification(readJson(fixture.stateFile)).attemptCount, 0);
  assert.equal(fs.existsSync(fixture.ledgerFile), false);
});

test("state pruning always retains every unfinished notification obligation", (t) => {
  const fixture = createFixture(t);
  const notifications = [];
  for (let index = 0; index < 270; index += 1) {
    notifications.push({
      ...createRestartNotification({
        ...fixture,
        repairIdentity: `terminal-${index}`,
      }, Date.parse("2026-09-01T00:00:00.000Z") + index),
      status: "cancelled",
      cancelledAt: new Date(Date.parse("2026-09-01T00:00:00.000Z") + index).toISOString(),
    });
  }
  const unfinishedIds = [];
  for (let index = 0; index < 7; index += 1) {
    const repairIdentity = `unfinished-${index}`;
    unfinishedIds.push(repairIdentity);
    notifications.splice(index * 20, 0, {
      ...createRestartNotification({ ...fixture, repairIdentity }),
      status: index % 3 === 0
        ? "awaiting_repair_verification"
        : (index % 3 === 1 ? "pending" : "uncertain_pending"),
    });
  }
  const saved = writeRestartNotificationState(fixture.stateFile, {
    version: 1,
    notifications,
  });
  assert.equal(saved.notifications.length, 256);
  assert.deepEqual(
    saved.notifications.filter((entry) => !["verified", "cancelled"].includes(entry.status))
      .map((entry) => entry.repairIdentity).sort(),
    [...unfinishedIds].sort(),
  );

  const allUnfinished = Array.from({ length: 270 }, (_, index) => createRestartNotification({
    ...fixture,
    repairIdentity: `all-unfinished-${index}`,
  }));
  const retained = writeRestartNotificationState(fixture.stateFile, {
    version: 1,
    notifications: allUnfinished,
  });
  assert.equal(retained.notifications.length, 270, "unfinished duties override the history size cap");
});

test("Windows replacement fallback never deletes the only primary state file", (t) => {
  const fixture = createFixture(t);
  const first = createRestartNotification(fixture);
  writeRestartNotificationState(fixture.stateFile, { version: 1, notifications: [first] });
  const second = createRestartNotification({ ...fixture, repairIdentity: "repair-two" });

  const originalRenameSync = fs.renameSync;
  const originalRmSync = fs.rmSync;
  let forcedRenameFailure = false;
  let primaryDeleteAttempted = false;
  fs.renameSync = (source, destination) => {
    if (!forcedRenameFailure
        && path.resolve(destination) === path.resolve(fixture.stateFile)
        && String(source).endsWith(".tmp")
        && fs.existsSync(fixture.stateFile)) {
      forcedRenameFailure = true;
      const error = new Error("simulated Windows sharing violation");
      error.code = "EPERM";
      throw error;
    }
    return originalRenameSync(source, destination);
  };
  fs.rmSync = (target, options) => {
    if (path.resolve(target) === path.resolve(fixture.stateFile)) {
      primaryDeleteAttempted = true;
      throw new Error("the durable primary must not be deleted before replacement");
    }
    return originalRmSync(target, options);
  };
  try {
    writeRestartNotificationState(fixture.stateFile, {
      version: 1,
      notifications: [first, second],
    });
  } finally {
    fs.renameSync = originalRenameSync;
    fs.rmSync = originalRmSync;
  }

  assert.equal(forcedRenameFailure, true);
  assert.equal(primaryDeleteAttempted, false);
  assert.equal(readJson(fixture.stateFile).notifications.length, 2);
  assert.equal(readJson(`${fixture.stateFile}.bak`).notifications.length, 1);
});

test("a valid backup is used when the primary state is syntactically or structurally corrupt", (t) => {
  const fixture = createFixture(t);
  const first = createRestartNotification(fixture);
  writeRestartNotificationState(fixture.stateFile, { version: 1, notifications: [first] });
  const second = createRestartNotification({ ...fixture, repairIdentity: "repair-two" });
  writeRestartNotificationState(fixture.stateFile, { version: 1, notifications: [first, second] });
  assert.equal(readJson(`${fixture.stateFile}.bak`).notifications.length, 1);

  fs.writeFileSync(fixture.stateFile, JSON.stringify({ version: 999, notifications: [] }), "utf8");
  const recovered = readRestartNotificationState(fixture.stateFile);
  assert.equal(recovered.notifications.length, 1);
  assert.equal(recovered.notifications[0].repairIdentity, fixture.repairIdentity);
});

test("restart notification targets only the configured main account and records a verified receipt", async (t) => {
  const fixture = createFixture(t);
  const requests = [];
  enqueueAndActivate(fixture, {
    now: () => Date.parse("2026-09-09T02:31:00.000Z"),
  });
  const result = await dispatchRestartNotification(fixture, {
    now: () => Date.parse("2026-09-09T02:31:00.000Z"),
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: new URL(url), body: JSON.parse(init.body) });
      const inFlight = findNotification(readJson(fixture.stateFile));
      assert.equal(inFlight.status, "pending", "the durable obligation must exist before UI dispatch");
      assert.equal(inFlight.attemptCount, 1);
      return jsonResponse({
        dispatched: true,
        verified: true,
        localId: "731",
        targetVerified: true,
        selectedContact: fixture.primaryContact,
        verifiedTalker: fixture.primaryTalker,
      });
    },
  });

  assert.equal(result.action, "verified");
  assert.equal(result.verified, true);
  assert.equal(result.localId, "731");
  assert.equal(result.idempotencyKey, IDEMPOTENCY_KEY);
  assert.equal(result.talker, fixture.primaryTalker);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.pathname, "/api/send");
  assert.equal(requests[0].body.contact, fixture.primaryContact);
  assert.equal(requests[0].body.talker, fixture.primaryTalker);
  assert.equal(requests[0].body.text, fixture.text);
  assert.equal(requests[0].body.exactContact, true);
  assert.equal(requests[0].body.expectedContact, fixture.primaryContact);
  assert.equal(requests[0].body.expectedTalker, fixture.primaryTalker);
  assert.notEqual(requests[0].body.talker, fixture.canaryTalker);

  const notification = findNotification(readJson(fixture.stateFile));
  assert.equal(notification.status, "verified");
  assert.equal(notification.targetTalker, fixture.primaryTalker);
  assert.equal(notification.targetContact, fixture.primaryContact);
  assert.equal(notification.messageKind, "watchdog_restart_notification");
  assert.equal(notification.idempotencyKey, IDEMPOTENCY_KEY);
  assert.equal(notification.localId, "731");
  assert.equal(notification.attemptCount, 1);
  assert.match(notification.verifiedAt, /^2026-09-09T02:31:00\.000Z$/u);

  const ledgerEntry = findLedgerEntry(fixture.ledgerFile);
  assert.equal(ledgerEntry.status, "verified");
  assert.equal(ledgerEntry.localId, "731");
  assert.equal(ledgerEntry.messageKind, "watchdog_restart_notification");
  assert.equal(ledgerEntry.expectedDirection, "outgoing");
});

test("the same repair identity is exactly-once and reuses its verified local id", async (t) => {
  const fixture = createFixture(t);
  enqueueAndActivate(fixture);
  let sends = 0;
  const fetchImpl = async () => {
    sends += 1;
    return jsonResponse({
      dispatched: true,
      verified: true,
      localId: "9001",
      targetVerified: true,
      selectedContact: fixture.primaryContact,
      verifiedTalker: fixture.primaryTalker,
    });
  };

  const first = await dispatchRestartNotification(fixture, { fetchImpl });
  const second = await dispatchRestartNotification(fixture, {
    fetchImpl: async () => {
      throw new Error("a verified restart notification must not be sent twice");
    },
  });

  assert.equal(first.action, "verified");
  assert.equal(second.action, "already_verified");
  assert.equal(first.localId, "9001");
  assert.equal(second.localId, first.localId);
  assert.equal(second.idempotencyKey, first.idempotencyKey);
  assert.equal(sends, 1);
  assert.equal(findNotification(readJson(fixture.stateFile)).attemptCount, 1);
  assert.equal(findLedgerEntry(fixture.ledgerFile).attemptCount, 1);
});

test("a certain pre-dispatch failure remains pending and retries without changing identity", async (t) => {
  const fixture = createFixture(t);
  enqueueAndActivate(fixture, {
    now: () => Date.parse("2026-09-09T02:30:30.000Z"),
  });
  let sends = 0;
  const failed = await dispatchRestartNotification(fixture, {
    now: () => Date.parse("2026-09-09T02:31:00.000Z"),
    fetchImpl: async () => {
      sends += 1;
      return jsonResponse({ error: "UIA bridge is starting", dispatched: false }, 503);
    },
  });

  assert.equal(failed.action, "retry_pending");
  assert.equal(failed.verified, false);
  assert.equal(failed.idempotencyKey, IDEMPOTENCY_KEY);
  let notification = findNotification(readJson(fixture.stateFile));
  assert.equal(notification.status, "pending");
  assert.equal(notification.attemptCount, 1);
  assert.match(notification.lastError, /UIA bridge is starting/u);
  let ledgerEntry = findLedgerEntry(fixture.ledgerFile);
  assert.equal(ledgerEntry.status, "failed");
  assert.equal(ledgerEntry.uncertain, false);

  const recovered = await dispatchRestartNotification(fixture, {
    now: () => Date.parse("2026-09-09T02:32:00.000Z"),
    fetchImpl: async () => {
      sends += 1;
      return jsonResponse({
        dispatched: true,
        verified: true,
        localId: "9020",
        targetVerified: true,
        selectedContact: fixture.primaryContact,
        verifiedTalker: fixture.primaryTalker,
      });
    },
  });

  assert.equal(recovered.action, "verified");
  assert.equal(recovered.idempotencyKey, failed.idempotencyKey);
  assert.equal(recovered.localId, "9020");
  assert.equal(sends, 2);
  notification = findNotification(readJson(fixture.stateFile));
  assert.equal(notification.status, "verified");
  assert.equal(notification.attemptCount, 2);
  ledgerEntry = findLedgerEntry(fixture.ledgerFile);
  assert.equal(ledgerEntry.status, "verified");
  assert.equal(ledgerEntry.attemptCount, 2);
});

test("a UIA dispatch with WeFlow messages HTTP 500/-105 stays exact-once uncertain until ledger observation", async (t) => {
  const fixture = createFixture(t);
  enqueueAndActivate(fixture, {
    now: () => Date.parse("2026-09-09T02:30:30.000Z"),
  });
  let sends = 0;
  const uncertain = await dispatchRestartNotification(fixture, {
    now: () => Date.parse("2026-09-09T02:31:00.000Z"),
    fetchImpl: async () => {
      sends += 1;
      return jsonResponse({
        dispatched: true,
        verified: false,
        uncertain: true,
        verificationError: "outgoing message was not observed in WeFlow before timeout (HTTP 500, code -105)",
        targetVerified: true,
        selectedContact: fixture.primaryContact,
        verifiedTalker: fixture.primaryTalker,
      });
    },
  });
  assert.equal(uncertain.action, "uncertain_pending");
  assert.equal(uncertain.verified, false);
  assert.equal(findNotification(readJson(fixture.stateFile)).status, "uncertain_pending");
  assert.match(findNotification(readJson(fixture.stateFile)).lastError, /HTTP 500.*-105/u);
  assert.equal(findLedgerEntry(fixture.ledgerFile).status, "failed_uncertain");

  const suppressed = await dispatchRestartNotification(fixture, {
    fetchImpl: async () => {
      throw new Error("an uncertain UI dispatch must not be repeated");
    },
  });
  assert.equal(suppressed.action, "uncertain_pending");
  assert.equal(sends, 1);

  const drained = await dispatchPendingRestartNotifications(fixture, {
    fetchImpl: async () => {
      throw new Error("draining an uncertain UI dispatch must not press Enter again");
    },
  });
  assert.equal(drained.length, 1);
  assert.equal(drained[0].action, "uncertain_pending");
  assert.equal(drained[0].attemptCount, 1);
  assert.equal(sends, 1);

  const ledger = new WeFlowMessageLedgerStore({
    filePath: fixture.ledgerFile,
    now: () => Date.parse("2026-09-09T02:32:00.000Z"),
  });
  const observed = ledger.classifyObservedOutgoing({
    talker: fixture.primaryTalker,
    direction: "outgoing",
    localId: "9021",
    text: fixture.text,
    observedAt: "2026-09-09T02:32:00.000Z",
  });
  assert.equal(observed.origin, "cyberboss");

  const reconciled = await dispatchRestartNotification(fixture, {
    fetchImpl: async () => {
      throw new Error("ledger reconciliation must not press Enter again");
    },
  });
  assert.equal(reconciled.action, "already_verified");
  assert.equal(reconciled.verified, true);
  assert.equal(reconciled.localId, "9021");
  assert.equal(sends, 1);
  const notification = findNotification(readJson(fixture.stateFile));
  assert.equal(notification.status, "verified");
  assert.equal(notification.localId, "9021");
  assert.equal(notification.attemptCount, 1);
});

test("a ledger row without a positive local id never clears the pending obligation", async (t) => {
  const fixture = createFixture(t);
  enqueueAndActivate(fixture);
  const ledger = new WeFlowMessageLedgerStore({ filePath: fixture.ledgerFile });
  const { entry } = ledger.planAndClaimOutbound({
    talker: fixture.primaryTalker,
    text: fixture.text,
    messageKind: "watchdog_restart_notification",
    expectedDirection: "outgoing",
    idempotencyKey: IDEMPOTENCY_KEY,
  });
  ledger.markVerified(entry, {});
  assert.equal(findLedgerEntry(fixture.ledgerFile).status, "verified");
  assert.equal(findLedgerEntry(fixture.ledgerFile).localId, "");

  const result = await dispatchRestartNotification(fixture, {
    fetchImpl: async () => {
      throw new Error("a claimed ledger row must suppress duplicate dispatch");
    },
  });
  assert.equal(result.action, "uncertain_pending");
  assert.equal(result.verified, false);
  assert.equal(result.localId, "");
  assert.equal(findNotification(readJson(fixture.stateFile)).status, "uncertain_pending");
});

test("missing or canary-aliased main targets fail closed before creating state or sending", async (t) => {
  for (const overrides of [
    { primaryTalker: "" },
    { primaryContact: "" },
    { primaryTalker: "wxid_canary_self" },
  ]) {
    const fixture = createFixture(t, overrides);
    let sends = 0;
    await assert.rejects(
      Promise.resolve().then(() => ensureRestartNotification(fixture, {
        fetchImpl: async () => { sends += 1; },
      })),
      /primary|main|canary|target/i,
    );
    assert.equal(sends, 0);
    assert.equal(fs.existsSync(fixture.stateFile), false);
    assert.equal(fs.existsSync(fixture.ledgerFile), false);
  }
});

test("watchdog persists the repair budget then enqueues and activates one identity before starting the controller", () => {
  const source = readWatchdogSource();
  const attemptStart = source.indexOf("$attemptAt =");
  const attemptsMutation = source.indexOf("$recovery.repairAttempts =", attemptStart);
  const recoveryPersist = source.indexOf("Save-RecoveryState -State $recovery", attemptsMutation);
  const enqueueAction = source.indexOf('-Action "enqueue"', recoveryPersist);
  const activateAction = source.indexOf('-Action "activate"', enqueueAction + 1);
  const controllerStart = source.indexOf("$repairProcess = Start-Process", recoveryPersist);

  assert.ok(attemptStart >= 0, "the guarded repair must allocate one durable identity");
  assert.ok(attemptsMutation > attemptStart, "the repair budget must include that identity");
  assert.ok(recoveryPersist > attemptsMutation, "the updated repair budget must be durable first");
  assert.ok(enqueueAction > recoveryPersist, "notification enqueue must follow repair-budget persistence");
  assert.ok(activateAction > enqueueAction, "the same notification must be activated after enqueue");
  assert.ok(controllerStart > activateAction, "enqueue and activation must finish before controller startup");

  const enqueueCallStart = source.lastIndexOf("Invoke-WatchdogRestartNotification", enqueueAction);
  const enqueueCall = source.slice(enqueueCallStart, activateAction);
  const activateCallStart = source.lastIndexOf("Invoke-WatchdogRestartNotification", activateAction);
  const activateCall = source.slice(activateCallStart, controllerStart);
  assert.match(enqueueCall, /-RepairIdentity\s+\$attemptAt/u);
  assert.match(activateCall, /-RepairIdentity\s+\$attemptAt/u);
});

test("Complete-VerifiedRepair dispatches the persisted notification by identity only", () => {
  const source = readWatchdogSource();
  const functionStart = source.indexOf("function Complete-VerifiedRepair");
  const functionEnd = source.indexOf("\nfunction ", functionStart + 1);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const body = source.slice(functionStart, functionEnd);

  assert.match(
    body,
    /Invoke-WatchdogRestartNotification\s+`?\r?\n\s+-Action "dispatch"\s+`?\r?\n\s+-RepairIdentity \$repairIdentity/u,
  );
  assert.doesNotMatch(body, /Get-WatchdogRestartNotificationText/u);
  assert.doesNotMatch(body, /-Action "activate"/u);
  assert.doesNotMatch(body, /-RepairMode\s+\$repairMode/u);
  assert.doesNotMatch(body, /-Components\s+/u);
});

test("a notification dispatch failure leaves the repair-attempt budget byte-for-byte unchanged", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = createTempDir(t);
  const result = invokeWatchdogLibrary([
    "$recovery=New-RecoveryState",
    "$recovery.repairAttempts=@('2026-09-09T01:00:00.000Z','2026-09-09T02:00:00.000Z')",
    "$recovery.currentRepairIdentity='repair-fixture'",
    "$recovery.lastRepairAttemptAt='2026-09-09T02:00:00.000Z'",
    "$recovery.lastRepairMode='Restart'",
    "$before=@($recovery.repairAttempts)",
    "$snapshot=[ordered]@{checkedAt='2026-09-09T02:01:00.000Z';healthy=$true;uiaBridge=[ordered]@{ready=$true}}",
    "$global:notificationCalls=@()",
    "function global:Save-RecoveryState { param($State) }",
    "function global:Save-Status { param($Snapshot,$Action,$Detail,$RecoveryState) }",
    "function global:Write-WatchdogLog { param($Message) }",
    "function global:Invoke-WatchdogRestartNotification { param([string]$Action,[string]$RepairIdentity,[string]$RepairMode,[string[]]$Components,[string]$CancelReason);$global:notificationCalls+=,[ordered]@{action=$Action;repairIdentity=$RepairIdentity;repairMode=$RepairMode;components=@($Components)};[pscustomobject]@{action='error';verified=$false;localId='';lastError='';error='fixture notification failure'} }",
    "Complete-VerifiedRepair -Snapshot $snapshot -RecoveryState $recovery -Detail 'different detail must stay out of the payload'",
    "$value=[ordered]@{before=$before;after=@($recovery.repairAttempts);calls=@($global:notificationCalls)}",
    "$value|ConvertTo-Json -Depth 6 -Compress",
  ].join("; "), stateDir);

  assert.deepEqual(result.after, result.before);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].action, "dispatch");
  assert.equal(result.calls[0].repairIdentity, "repair-fixture");
  assert.equal(result.calls[0].repairMode, "");
  // Windows PowerShell 5.1 serializes an empty nested array as JSON null.
  assert.deepEqual(result.calls[0].components ?? [], []);
});

test("normal Once drains ready notification duties while Status exits before every send", () => {
  const source = readWatchdogSource();
  const mainStart = source.indexOf("$mutex = New-Object");
  const statusStart = source.indexOf('if ($Mode -eq "Status")', mainStart);
  const statusExit = source.indexOf("exit $(if ($snapshot.healthy)", statusStart);
  const drainAction = source.indexOf('-Action "drain"', statusExit);
  const nextGuard = source.indexOf("if (-not [bool]$recovery.recoveryStateValid)", drainAction);

  assert.ok(mainStart >= 0 && statusStart > mainStart);
  assert.ok(statusExit > statusStart);
  assert.ok(drainAction > statusExit, "Status must exit before the normal Once drain path");
  const statusBranch = source.slice(statusStart, statusExit);
  assert.doesNotMatch(statusBranch, /Invoke-WatchdogRestartNotification/u);

  assert.ok(nextGuard > drainAction);
  const drainBlock = source.slice(statusExit, nextGuard);
  assert.match(drainBlock, /if \(\$snapshot\.uiaBridge\.ready -and \(Test-DesktopInputIdleGate -Snapshot \$snapshot\)\)/u);
  assert.match(drainBlock, /Get-WatchdogRestartNotificationStatus/u);
  assert.match(drainBlock, /Invoke-WatchdogRestartNotification -Action "drain"/u);
  assert.match(drainBlock, /\$snapshot = Get-HealthSnapshot/u);
  assert.doesNotMatch(drainBlock, /repairAttempts\s*=|Set-WatchdogRepairStarted|Add-RecoveryRepairAttemptJournal/u);
});

test("Windows PowerShell 5.1 parses the non-ASCII watchdog from its UTF-8 BOM", {
  skip: process.platform !== "win32",
}, () => {
  const bytes = fs.readFileSync(watchdogPath);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const decoded = bytes.subarray(3).toString("utf8");
  assert.match(decoded, /[^\x00-\x7f]/u, "the fixture must exercise non-ASCII source text");

  const command = [
    "$tokens=$null",
    "$errors=$null",
    `[void][System.Management.Automation.Language.Parser]::ParseFile(${psQuote(watchdogPath)},[ref]$tokens,[ref]$errors)`,
    "if($errors.Count -gt 0){$errors|ForEach-Object{$_.ToString()}|Write-Error;exit 1}",
    "Write-Output 'PS51_PARSE_OK'",
  ].join("; ");
  const parsed = spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    command,
  ], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);
  assert.match(parsed.stdout, /PS51_PARSE_OK/u);
});

test("main delivery health excludes a certain watchdog restart-notification failure", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = createTempDir(t);
  const ledgerFile = path.join(stateDir, "weflow-message-ledger.json");
  fs.writeFileSync(ledgerFile, `${JSON.stringify({
    version: 3,
    entries: [{
      id: "watchdog-restart-ledger-fixture",
      idempotencyKey: "watchdog-restart:repair-fixture",
      talker: "wxid_primary_account",
      contentHash: "a".repeat(64),
      contentKind: "text",
      imageDigest: "",
      messageKind: "watchdog_restart_notification",
      expectedDirection: "outgoing",
      status: "failed",
      localId: "",
      attemptCount: 1,
      uncertain: false,
      createdAt: "2026-09-09T02:58:00.000Z",
      updatedAt: "2026-09-09T02:59:00.000Z",
      sendingAt: "2026-09-09T02:58:30.000Z",
      verifiedAt: "",
      failedAt: "2026-09-09T02:59:00.000Z",
      observedAt: "",
      failureCode: "WEFLOW_BRIDGE_HTTP_ERROR",
      failureHash: "b".repeat(64),
    }],
  }, null, 2)}\n`, "utf8");

  const health = invokeWatchdogLibrary([
    `$health=Get-MainDeliveryHealth -Path ${psQuote(ledgerFile)} -Talker 'wxid_primary_account' -WindowSeconds 600 -Now ([DateTimeOffset]::Parse('2026-09-09T03:00:00.000Z'))`,
    "$health|ConvertTo-Json -Depth 5 -Compress",
  ].join("; "), stateDir);

  assert.equal(health.ready, true);
  assert.equal(health.healthy, true);
  assert.equal(health.terminalFailureCount, 0);
  assert.notEqual(health.reason, "terminal_outbound_failed");
});
