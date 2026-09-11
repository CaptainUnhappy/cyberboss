const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const watchdogPath = path.join(projectRoot, "scripts", "cyberboss-watchdog.ps1");
const fixtureModelContact = "Azzy Model Fixture";
const fixtureModelTalker = "wxid_azzy_model_fixture";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function modelEnvironment(extra = {}) {
  return {
    CYBERBOSS_ENABLE_WEFLOW_MODEL_CANARY: "true",
    CYBERBOSS_WEFLOW_CANARY_CHAT: fixtureModelTalker,
    CYBERBOSS_WEFLOW_CANARY_DISPLAY_NAME: fixtureModelContact,
    ...extra,
  };
}

function tempDir(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-watchdog-model-policy-"));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function invokeLibrary(command, stateDir, environment = {}) {
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

function writeVerifiedProof(stateDir, result) {
  const runDir = path.join(stateDir, "model-e2e-probes", result.runId);
  fs.mkdirSync(runDir, { recursive: true });
  const manifest = {
    version: 1,
    mode: "model_e2e",
    runId: result.runId,
    nonce: "0123456789abcdef01234567",
    obligationFingerprint: "a".repeat(64),
    triggerText: `[Cyberboss心跳模型探针 trigger=${result.runId} nonce=0123456789abcdef01234567]`,
    replyText: `[Cyberboss心跳模型正常 trigger=${result.runId}]`,
    replyMessageKind: `model_canary_reply:${result.runId}`,
    replyIdempotencyKey: `model-canary-reply:${result.runId}`,
    talker: fixtureModelTalker,
    contact: fixtureModelContact,
    targetFingerprint: sha256(`${fixtureModelContact}\n${fixtureModelTalker}`),
    createdAt: "2026-08-29T11:59:00.000Z",
    expiresAt: "2026-08-29T12:04:00.000Z",
  };
  const desktopInputLeaseManifestFingerprint = "d".repeat(64);
  result.desktopInputLeaseManifestFingerprint = desktopInputLeaseManifestFingerprint;
  fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(manifest), "utf8");
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(result), "utf8");
  const bound = (fields) => ({
    version: 1,
    mode: "model_e2e",
    runId: result.runId,
    nonce: manifest.nonce,
    obligationFingerprint: manifest.obligationFingerprint,
    ...fields,
  });
  const receipts = {
    "ingested.json": bound({
      status: "ingested",
      talker: fixtureModelTalker,
      direction: "outgoing",
      triggerLocalId: result.triggerLocalId,
    }),
    "handoff.json": bound({ status: "accepted", threadId: result.threadId, turnId: result.turnId }),
    "model-completed.json": bound({
      status: "completed",
      assistantFinalPresent: true,
      assistantFinalSha256: "c".repeat(64),
      assistantFinalLength: 8,
      assistantFinalBytes: 12,
      threadId: result.threadId,
      turnId: result.turnId,
    }),
    "reply-dispatched.json": bound({
      status: "verified",
      talker: fixtureModelTalker,
      contact: fixtureModelContact,
      replyLocalId: result.replyLocalId,
      messageKind: manifest.replyMessageKind,
      idempotencyKey: manifest.replyIdempotencyKey,
      threadId: result.threadId,
      turnId: result.turnId,
    }),
    "reply-observed.json": bound({
      status: "observed",
      talker: fixtureModelTalker,
      direction: "outgoing",
      replyLocalId: result.replyLocalId,
      messageKind: manifest.replyMessageKind,
      idempotencyKey: manifest.replyIdempotencyKey,
    }),
    "turn-released.json": bound({ status: "released", threadId: result.threadId, turnId: result.turnId }),
  };
  for (const [name, receipt] of Object.entries(receipts)) {
    fs.writeFileSync(path.join(runDir, name), JSON.stringify(receipt), "utf8");
  }
  fs.writeFileSync(path.join(runDir, "desktop-input-lease.json"), JSON.stringify(bound({
    targetFingerprint: manifest.targetFingerprint,
    talker: manifest.talker,
    contact: manifest.contact,
    replyIdempotencyKey: manifest.replyIdempotencyKey,
    manifestFingerprint: desktopInputLeaseManifestFingerprint,
    leaseToken: "e".repeat(64),
    triggerLastInputTick: 77,
    issuedAt: "2026-08-29T11:59:05.000Z",
    recordedAt: "2026-08-29T11:59:06.000Z",
    expiresAt: manifest.expiresAt,
  })), "utf8");
  const cursorAt = new Date().toISOString();
  fs.writeFileSync(path.join(stateDir, "weflow-canary-inbox-cursor.json"), JSON.stringify({
    version: 1,
    talker: fixtureModelTalker,
    lastLocalId: result.replyLocalId,
    seenIdentities: [`local:${result.triggerLocalId}`, `local:${result.replyLocalId}`],
    updatedAt: cursorAt,
    lastPolledAt: cursorAt,
  }), "utf8");
  return runDir;
}

test("disabled model E2E is explicit null/disabled/not_run and cannot alter transport top health", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const result = invokeLibrary([
    "$disabled=Read-ModelCanaryStatus;",
    "$disabledSnapshot=[ordered]@{healthy=$true};Set-SnapshotModelCanaryResult -Snapshot $disabledSnapshot -ModelCanary $disabled;",
    "$ModelCanaryEnabled=$true;",
    "$single=[ordered]@{enabled=$true;healthy=$false;confirmedFailure=$false};$singleSnapshot=[ordered]@{healthy=$true};Set-SnapshotModelCanaryResult -Snapshot $singleSnapshot -ModelCanary $single;",
    "$confirmed=[ordered]@{enabled=$true;healthy=$false;confirmedFailure=$true};$confirmedSnapshot=[ordered]@{healthy=$true};Set-SnapshotModelCanaryResult -Snapshot $confirmedSnapshot -ModelCanary $confirmed;",
    "$transportSnapshot=[ordered]@{healthy=$false;cyberboss=[pscustomobject]@{alive=$true};appServer=[pscustomobject]@{ready=$true};weflow=[pscustomobject]@{ready=$true};uiaBridge=[pscustomobject]@{ready=$true};weixin=[pscustomobject]@{alive=$true};sendSource='azzy';inboxQueue=[pscustomobject]@{healthy=$true};pendingInbound=[pscustomobject]@{healthy=$true};deferredReplies=[pscustomobject]@{healthy=$true};replyObligations=[pscustomobject]@{healthy=$true};activity=[pscustomobject]@{healthy=$true};modelE2E=$confirmed};",
    "$transport=[ordered]@{healthy=$true};Set-SnapshotCanaryResult -Snapshot $transportSnapshot -Canary $transport;",
    "$value=[ordered]@{disabled=$disabled;disabledTop=$disabledSnapshot.healthy;singleTop=$singleSnapshot.healthy;confirmedTop=$confirmedSnapshot.healthy;confirmedPreservedAfterTransport=$transportSnapshot.healthy};$value|ConvertTo-Json -Depth 5 -Compress",
  ].join(""), stateDir, { CYBERBOSS_ENABLE_WEFLOW_MODEL_CANARY: "false" });

  assert.equal(result.disabled.healthy, null);
  assert.equal(result.disabled.status, "disabled");
  assert.equal(result.disabled.action, "not_run");
  assert.equal(result.disabledTop, true);
  assert.equal(result.singleTop, true);
  assert.equal(result.confirmedTop, false);
  assert.equal(result.confirmedPreservedAfterTransport, false);
});

test("only consecutive handled routine model failures confirm the non-repairable model fault", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const result = invokeLibrary([
    "$routine=[pscustomobject]@{obligations=@([pscustomobject]@{state='handled';reason='routine';healthy=$false},[pscustomobject]@{state='handled';reason='routine';healthy=$false})};",
    "$explicitTail=[pscustomobject]@{obligations=@($routine.obligations+[pscustomobject]@{state='handled';reason='user_demand';healthy=$false})};",
    "$successTail=[pscustomobject]@{obligations=@($routine.obligations+[pscustomobject]@{state='handled';reason='routine';healthy=$true})};",
    "$releasedTail=[pscustomobject]@{obligations=@($routine.obligations+[pscustomobject]@{state='released';reason='routine';healthy=$null})};",
    "$value=[ordered]@{routine=(Get-ModelRoutineConsecutiveFailures -Schedule $routine);explicitTail=(Get-ModelRoutineConsecutiveFailures -Schedule $explicitTail);successTail=(Get-ModelRoutineConsecutiveFailures -Schedule $successTail);releasedTail=(Get-ModelRoutineConsecutiveFailures -Schedule $releasedTail)};$value|ConvertTo-Json -Compress",
  ].join(""), stateDir, { CYBERBOSS_ENABLE_WEFLOW_MODEL_CANARY: "true" });

  assert.deepEqual(result, { routine: 2, explicitTail: 0, successTail: 0, releasedTail: 2 });
});

test("model E2E reuses the complete transport idle gate and additionally requires verified transport E2E", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const command = [
    "$snapshot=[pscustomobject]@{cyberboss=[pscustomobject]@{alive=$true};appServer=[pscustomobject]@{ready=$true};weflow=[pscustomobject]@{ready=$true};uiaBridge=[pscustomobject]@{ready=$true};weixin=[pscustomobject]@{alive=$true};sendSource='azzy';transportE2E=[pscustomobject]@{healthy=$true};canary=[pscustomobject]@{healthy=$true};inboxQueue=[pscustomobject]@{healthy=$true;pendingCount=0;outgoingPoll=[pscustomobject]@{ready=$true;healthy=$true}};pendingInbound=[pscustomobject]@{healthy=$true;pendingCount=0};deferredReplies=[pscustomobject]@{healthy=$true;pendingCount=0};replyObligations=[pscustomobject]@{healthy=$true;openCount=0};activity=[pscustomobject]@{ready=$true;healthy=$true;idle=$true;activeTurnCount=0;turnGateCount=0;activeDeliveryCount=0;pendingInboundCount=0;userIdleSeconds=600};desktopInput=[pscustomobject]@{ready=$true;idle=$true;desktopIdleSeconds=600}};",
    "$ready=Test-ModelCanaryIdleGate -Snapshot $snapshot;",
    "$snapshot.activity.userIdleSeconds=30;$recent=Test-ModelCanaryIdleGate -Snapshot $snapshot;$snapshot.activity.userIdleSeconds=600;",
    "$snapshot.desktopInput.idle=$false;$desktop=Test-ModelCanaryIdleGate -Snapshot $snapshot;$snapshot.desktopInput.idle=$true;",
    "$snapshot.replyObligations.openCount=1;$queue=Test-ModelCanaryIdleGate -Snapshot $snapshot;$snapshot.replyObligations.openCount=0;",
    "$snapshot.transportE2E.healthy=$false;$transport=Test-ModelCanaryIdleGate -Snapshot $snapshot;$blockers=@(Get-ModelCanaryIdleGateBlockers -Snapshot $snapshot);",
    "$value=[ordered]@{ready=$ready;recent=$recent;desktop=$desktop;queue=$queue;transport=$transport;blockers=$blockers};$value|ConvertTo-Json -Depth 4 -Compress",
  ].join("");
  const result = invokeLibrary(command, stateDir, { CYBERBOSS_ENABLE_WEFLOW_MODEL_CANARY: "true" });
  assert.deepEqual({
    ready: result.ready,
    recent: result.recent,
    desktop: result.desktop,
    queue: result.queue,
    transport: result.transport,
  }, { ready: true, recent: false, desktop: false, queue: false, transport: false });
  assert.ok(result.blockers.includes("transport_e2e_unverified"));
});

test("watchdog accepts model success only with exact runner fields, a bound input lease, and all lifecycle receipts", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const runnerPath = path.join(stateDir, "model-runner.js");
  const argvPath = path.join(stateDir, "argv.jsonl");
  const runId = "22222222-2222-4222-8222-222222222222";
  const runnerResult = {
    version: 1,
    mode: "model_e2e",
    healthy: true,
    action: "verified",
    attempted: true,
    repairable: false,
    confirmedFailure: false,
    checkedAt: "2026-08-29T12:00:00.000Z",
    runId,
    targetVerified: true,
    targetContact: fixtureModelContact,
    targetTalker: fixtureModelTalker,
    targetFingerprint: sha256(`${fixtureModelContact}\n${fixtureModelTalker}`),
    triggerLocalId: "8100",
    replyLocalId: "8101",
    threadId: "thread-model-policy",
    turnId: "turn-model-policy",
    cursorCommittedAt: new Date(Date.now() - 2_000).toISOString(),
    detail: "fixture verified",
  };
  const runDir = writeVerifiedProof(stateDir, runnerResult);
  fs.writeFileSync(path.join(stateDir, "cyberboss-watchdog-model-canary.json"), JSON.stringify({
    version: 1,
    mode: "model_e2e",
    lastRunId: runId,
    lastStatus: "healthy",
    lastAction: "verified",
    obligations: [{ state: "handled", reason: "routine", healthy: true, runId }],
    history: [{ runId, triggerLocalId: "8100", replyLocalId: "8101" }],
  }), "utf8");
  fs.writeFileSync(runnerPath, [
    "const fs=require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(argvPath)},JSON.stringify(process.argv.slice(2))+'\\n');`,
    `process.stdout.write(${JSON.stringify(`${JSON.stringify(runnerResult)}\n`)});`,
  ].join("\n"), "utf8");

  const result = invokeLibrary([
    `$ModelCanaryScript=${psQuote(runnerPath)};`,
    "$verified=Invoke-ModelCanaryCheck -DemandKey 'manual:model-proof';",
    "$persisted=Read-ModelCanaryStatus;",
    `Remove-Item -LiteralPath ${psQuote(path.join(runDir, "turn-released.json"))} -Force;`,
    "$incomplete=Invoke-ModelCanaryCheck -DemandKey 'manual:model-incomplete';",
    "$value=[ordered]@{verified=$verified;persisted=$persisted;incomplete=$incomplete};$value|ConvertTo-Json -Depth 6 -Compress",
  ].join(""), stateDir, modelEnvironment());
  const calls = fs.readFileSync(argvPath, "utf8").trim().split(/\r?\n/u).map(JSON.parse);

  assert.equal(result.verified.healthy, true, JSON.stringify(result.verified));
  assert.equal(result.verified.action, "verified");
  assert.equal(result.verified.receiptsVerified, true);
  assert.equal(result.verified.triggerLocalId, "8100");
  assert.equal(result.verified.replyLocalId, "8101");
  assert.equal(result.persisted.healthy, true);
  assert.equal(result.persisted.receiptsVerified, true);
  assert.equal(result.incomplete.healthy, false);
  assert.equal(result.incomplete.action, "failed");
  assert.equal(result.incomplete.code, "MODEL_CANARY_PROOF_INCOMPLETE");
  assert.equal(result.incomplete.repairable, false);
  for (const [index, demand] of ["manual:model-proof", "manual:model-incomplete"].entries()) {
    assert.deepEqual(calls[index].slice(calls[index].indexOf("--demand-key"), calls[index].indexOf("--demand-key") + 2), ["--demand-key", demand]);
    assert.equal(calls[index].includes("--force"), false);
  }
});

test("model proof independently binds current target, ordered IDs, digest metrics, and the dedicated cursor", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const runId = "33333333-3333-4333-8333-333333333333";
  const result = {
    version: 1,
    mode: "model_e2e",
    healthy: true,
    action: "verified",
    attempted: true,
    runId,
    targetVerified: true,
    targetContact: fixtureModelContact,
    targetTalker: fixtureModelTalker,
    targetFingerprint: sha256(`${fixtureModelContact}\n${fixtureModelTalker}`),
    triggerLocalId: "9100",
    replyLocalId: "9101",
    threadId: "thread-proof-contract",
    turnId: "turn-proof-contract",
    cursorCommittedAt: new Date(Date.now() - 2_000).toISOString(),
  };
  const runDir = writeVerifiedProof(stateDir, result);
  const proofCommand = [
    `$summary=Read-WatchdogStrictJson -Path ${psQuote(path.join(runDir, "summary.json"))};`,
    "$proof=Test-ModelCanaryReceiptProof -Result $summary;",
    "$proof|ConvertTo-Json -Depth 4 -Compress",
  ].join("");
  const check = () => invokeLibrary(proofCommand, stateDir, modelEnvironment());
  const rewrite = (file, mutate) => {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    mutate(value);
    fs.writeFileSync(file, JSON.stringify(value), "utf8");
  };

  const baseline = check();
  assert.equal(baseline.verified, true, JSON.stringify(baseline));

  const cursorPath = path.join(stateDir, "weflow-canary-inbox-cursor.json");
  fs.rmSync(cursorPath);
  assert.match(check().detail, /cursor/iu);

  writeVerifiedProof(stateDir, result);
  rewrite(cursorPath, (cursor) => { cursor.seenIdentities = []; cursor.lastLocalId = "1"; });
  assert.match(check().detail, /both trigger and reply/iu);

  writeVerifiedProof(stateDir, result);
  const manifestPath = path.join(runDir, "manifest.json");
  rewrite(manifestPath, (manifest) => { manifest.targetFingerprint = "d".repeat(64); });
  assert.match(check().detail, /manifest current target binding/iu);

  writeVerifiedProof(stateDir, result);
  const desktopInputLeasePath = path.join(runDir, "desktop-input-lease.json");
  fs.rmSync(desktopInputLeasePath);
  assert.match(check().detail, /desktop input lease/iu);

  writeVerifiedProof(stateDir, result);
  rewrite(desktopInputLeasePath, (lease) => { lease.targetFingerprint = "f".repeat(64); });
  assert.match(check().detail, /desktop input lease/iu);

  writeVerifiedProof(stateDir, result);
  const completedPath = path.join(runDir, "model-completed.json");
  rewrite(completedPath, (receipt) => { receipt.assistantFinalSha256 = "NOT-A-SHA256"; });
  assert.match(check().detail, /SHA-256/iu);

  writeVerifiedProof(stateDir, result);
  rewrite(completedPath, (receipt) => { receipt.assistantFinalLength = 20; receipt.assistantFinalBytes = 8; });
  assert.match(check().detail, /shorter/iu);

  for (const receiptName of ["model-completed.json", "reply-dispatched.json", "turn-released.json"]) {
    writeVerifiedProof(stateDir, result);
    rewrite(path.join(runDir, receiptName), (receipt) => {
      delete receipt.threadId;
      delete receipt.turnId;
    });
    assert.match(check().detail, /runtime thread\/turn binding/iu, receiptName);
  }

  const terminalReceipts = [
    "handoff-failed.json",
    "approval-denied.json",
    "tool-attempted.json",
    "turn-release-failed.json",
    "reply-delivery-failed.json",
    "turn-completed-without-final.json",
    "turn-failed.json",
  ];
  for (const receiptName of terminalReceipts) {
    writeVerifiedProof(stateDir, result);
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
    const terminalPath = path.join(runDir, receiptName);
    fs.writeFileSync(terminalPath, JSON.stringify({
      version: 1,
      mode: "model_e2e",
      runId: manifest.runId,
      nonce: manifest.nonce,
      obligationFingerprint: manifest.obligationFingerprint,
      status: "failed",
      reason: "synthetic_success_terminal_race",
    }), "utf8");
    const terminalProof = check();
    assert.equal(terminalProof.verified, false, receiptName);
    assert.match(terminalProof.detail, /terminal failure receipt is present/iu, receiptName);
    fs.rmSync(terminalPath);
  }

  writeVerifiedProof(stateDir, result);
  const invalidTerminalPath = path.join(runDir, "tool-attempted.json");
  fs.writeFileSync(invalidTerminalPath, JSON.stringify({
    version: 1,
    mode: "model_e2e",
    runId,
    nonce: "fedcba9876543210fedcba98",
    obligationFingerprint: "f".repeat(64),
    status: "failed",
  }), "utf8");
  const invalidTerminalProof = check();
  assert.equal(invalidTerminalProof.verified, false);
  assert.match(invalidTerminalProof.detail, /terminal receipt exists but failed manifest binding/iu);
  fs.rmSync(invalidTerminalPath);

  const reversed = { ...result, triggerLocalId: "9201", replyLocalId: "9200" };
  writeVerifiedProof(stateDir, reversed);
  assert.match(check().detail, /does not follow/iu);
});

test("explicit model demand blocked by activity never reaches the runner or repair state", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const marker = path.join(stateDir, "runner-touched");
  const result = invokeLibrary([
    `$ModelCanaryScript=${psQuote(marker)};`,
    "$snapshot=[ordered]@{healthy=$true;cyberboss=[pscustomobject]@{alive=$true};appServer=[pscustomobject]@{ready=$true};weflow=[pscustomobject]@{ready=$true};uiaBridge=[pscustomobject]@{ready=$true};weixin=[pscustomobject]@{alive=$true};sendSource='azzy';transportE2E=[pscustomobject]@{healthy=$true};canary=[pscustomobject]@{healthy=$true};inboxQueue=[pscustomobject]@{healthy=$true;pendingCount=0;outgoingPoll=[pscustomobject]@{ready=$true;healthy=$true}};pendingInbound=[pscustomobject]@{healthy=$true;pendingCount=0};deferredReplies=[pscustomobject]@{healthy=$true;pendingCount=0};replyObligations=[pscustomobject]@{healthy=$true;openCount=0};activity=[pscustomobject]@{ready=$true;healthy=$true;idle=$false;busy=$true;activeTurnCount=1;turnGateCount=0;activeDeliveryCount=0;pendingInboundCount=0;userIdleSeconds=30};desktopInput=[pscustomobject]@{ready=$true;idle=$false;desktopIdleSeconds=10}};",
    "$blocked=Invoke-ExplicitModelCanaryDemand -Snapshot $snapshot -DemandIdentity 'manual:busy';",
    `$value=[ordered]@{action=$blocked.modelE2E.action;healthy=$blocked.modelE2E.healthy;attempted=$blocked.modelE2E.attempted;repairable=$blocked.modelE2E.repairable;runnerTouched=(Test-Path -LiteralPath ${psQuote(marker)})};$value|ConvertTo-Json -Compress`,
  ].join(""), stateDir, { CYBERBOSS_ENABLE_WEFLOW_MODEL_CANARY: "true" });

  assert.deepEqual(result, {
    action: "deferred_busy",
    healthy: null,
    attempted: false,
    repairable: false,
    runnerTouched: false,
  });
});

test("confirmed routine failure survives already_running and target_changed_pending and remains non-restartable", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const result = invokeLibrary([
    "function New-ModelFailureSnapshot { param($Model)",
    "return [ordered]@{healthy=$false;cyberboss=[pscustomobject]@{alive=$true};appServer=[pscustomobject]@{ready=$true};weflow=[pscustomobject]@{ready=$true};uiaBridge=[pscustomobject]@{ready=$true};weixin=[pscustomobject]@{alive=$true};sendSource='azzy';canary=[pscustomobject]@{healthy=$true};transportE2E=[pscustomobject]@{healthy=$true};inboxQueue=[pscustomobject]@{healthy=$true;pendingCount=0};pendingInbound=[pscustomobject]@{healthy=$true;pendingCount=0};deferredReplies=[pscustomobject]@{healthy=$true;pendingCount=0};replyObligations=[pscustomobject]@{healthy=$true;openCount=0};mainDelivery=[pscustomobject]@{healthy=$true};activity=[pscustomobject]@{healthy=$true};modelE2E=$Model}};",
    "$results=@(foreach($action in @('already_running','target_changed_pending')){",
    "$persisted=[ordered]@{enabled=$true;healthy=$false;status='failed';action='failed';attempted=$true;repairable=$false;confirmedFailure=$true;routineFailureActive=$true;routineConsecutiveFailures=2;lastReason='routine';nextDueAt='2026-08-31T00:00:00Z'};",
    "$snapshot=New-ModelFailureSnapshot -Model $persisted;",
    "$deferred=[ordered]@{enabled=$true;healthy=$null;status='deferred';action=$action;attempted=$false;repairable=$false;confirmedFailure=$false;routineFailureActive=$false;routineConsecutiveFailures=0;lastReason='';nextDueAt=''};",
    "Set-SnapshotModelCanaryResult -Snapshot $snapshot -ModelCanary $deferred;",
    "$isolation=Get-ModelCanaryIsolationDisposition -Snapshot $snapshot;",
    "[ordered]@{schedulerAction=$action;healthy=$snapshot.modelE2E.healthy;confirmedFailure=$snapshot.modelE2E.confirmedFailure;routineFailureActive=$snapshot.modelE2E.routineFailureActive;routineConsecutiveFailures=$snapshot.modelE2E.routineConsecutiveFailures;topHealthy=$snapshot.healthy;disposition=$isolation.action;repairable=$isolation.repairable;exitCode=$isolation.exitCode}",
    "});$results|ConvertTo-Json -Depth 5 -Compress",
  ].join(""), stateDir, modelEnvironment());

  assert.equal(result.length, 2);
  for (const [index, action] of ["already_running", "target_changed_pending"].entries()) {
    assert.deepEqual(result[index], {
      schedulerAction: action,
      healthy: false,
      confirmedFailure: true,
      routineFailureActive: true,
      routineConsecutiveFailures: 2,
      topHealthy: false,
      disposition: "pipeline_blocked",
      repairable: false,
      exitCode: 2,
    });
  }
});

test("model demand and confirmed routine failure branches exit before every repair path", () => {
  const source = fs.readFileSync(watchdogPath, "utf8");
  assert.match(source, /\[string\]\$ModelDemandKey = ""/u);
  assert.match(source, /transportE2E = \$canary[\s\S]+?modelE2E = \$modelCanary/u);

  const main = source.indexOf("$mutex = New-Object");
  const explicit = source.indexOf("if ($ExplicitModelDemandKey)", main);
  const pendingRepair = source.indexOf("if ($recovery.pendingRepairVerification", explicit);
  assert.ok(explicit > main && pendingRepair > explicit);
  const explicitSlice = source.slice(explicit, pendingRepair);
  assert.match(explicitSlice, /model_e2e_verified[\s\S]+?model_e2e_deferred[\s\S]+?model_e2e_failed/u);
  assert.doesNotMatch(explicitSlice, /Get-RecoveryGate|Update-RecoveryCanaryState|\$recovery\.repairAttempts|Start-Process/u);

  const routine = source.indexOf("if ($ModelCanaryEnabled)", pendingRepair);
  const failedComponents = source.indexOf("$failed = @(Get-WatchdogFailedComponents", routine);
  const routineSlice = source.slice(routine, failedComponents);
  assert.match(routineSlice, /Get-ModelCanaryIsolationDisposition[\s\S]+?Save-Status[\s\S]+?\$modelIsolation\.action[\s\S]+?exit \(\[int\]\$modelIsolation\.exitCode\)/u);
  assert.match(routineSlice, /model_e2e_observing/u);
  assert.doesNotMatch(routineSlice, /Get-RecoveryGate|\$recovery\.repairAttempts|Start-Process|Update-RecoveryCanaryState/u);
  assert.doesNotMatch(source, /\$failed \+= "modelE2E"/u);

  const unattributed = source.indexOf("if ($failed.Count -eq 0)", failedComponents);
  const disposition = source.indexOf("$disposition = Get-WatchdogFailureDisposition", failedComponents);
  const repairGate = source.indexOf("$gate = Get-RecoveryGate", failedComponents);
  assert.ok(unattributed > failedComponents && disposition > unattributed && repairGate > disposition);
  const unattributedSlice = source.slice(unattributed, disposition);
  assert.match(unattributedSlice, /blocked_nonrestartable/u);
  assert.match(unattributedSlice, /pipeline_blocked[\s\S]+?exit 2/u);
  assert.doesNotMatch(unattributedSlice, /Get-RecoveryGate|repairAttempts|Start-Process|cyberboss-service/u);
});

test("ModelDemandKey is rejected in Status mode before any service or runner action", {
  skip: process.platform !== "win32",
}, () => {
  const result = spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    watchdogPath,
    "-Mode",
    "Status",
    "-ModelDemandKey",
    "manual:invalid-status",
  ], { cwd: projectRoot, encoding: "utf8", windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /demand keys are only valid in Once mode/iu);
});
