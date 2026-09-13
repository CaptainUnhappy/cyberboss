const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const watchdogPath = path.join(projectRoot, "scripts", "cyberboss-watchdog.ps1");

function tempDir(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-watchdog-policy-"));
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

function replyObligationEntry({
  idCharacter = "a",
  status = "awaiting_final",
  terminal = false,
  terminalOutcome = "",
  createdAt = "2026-08-29T11:55:00.000Z",
  deadlineAt = "2026-08-29T12:05:00.000Z",
  terminalAt = "",
  lastError = "",
} = {}) {
  return {
    id: `reply-obligation:${idCharacter.repeat(64)}`,
    sourceProvider: "weflow-uia",
    sourceMessageIds: [`weflow:${idCharacter}`],
    senderId: `sender-${idCharacter}`,
    status,
    terminal,
    terminalOutcome,
    createdAt,
    updatedAt: terminalAt || createdAt,
    handoffStartedAt: createdAt,
    noReplyTimeoutMs: 600_000,
    noReplyDeadlineAt: deadlineAt,
    terminalAt,
    lastError,
  };
}

function replyObligationStore(obligations, overrides = {}) {
  return {
    version: 1,
    writerInstanceId: "watchdog-policy-fixture",
    updatedAt: "2026-08-29T12:00:00.000Z",
    integrity: { status: "healthy", recoveredAt: "", lastError: "" },
    policy: {
      noReplyTimeoutMs: 600_000,
      retentionMs: 604_800_000,
      maxEntries: 2_000,
    },
    summary: {},
    obligations,
    ...overrides,
  };
}

test("watchdog policy selects targeted Restart for pipeline-only faults and keeps two confirmations", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const result = invokeLibrary([
    "$value=[ordered]@{",
    "pipeline=(Get-WatchdogRepairMode -Failed @('inboxQueue','canary'));",
    "mixed=(Get-WatchdogRepairMode -Failed @('canary','weflow'));",
    "first=(Get-WatchdogFailureDisposition -Failed @('canary') -ConsecutiveFailures 1 -RequiredConfirmations 2).action;",
    "second=(Get-WatchdogFailureDisposition -Failed @('canary') -ConsecutiveFailures 2 -RequiredConfirmations 2).action",
    "}; $value | ConvertTo-Json -Compress",
  ].join(" "), stateDir);

  assert.deepEqual(result, {
    pipeline: "Restart",
    mixed: "FullRestart",
    first: "observing",
    second: "repair",
  });
});

test("healthy UIA transport waits for a logged-in Weixin chat window instead of restarting", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const result = invokeLibrary([
    "$waiting=[pscustomobject]@{cyberboss=[pscustomobject]@{alive=$true};appServer=[pscustomobject]@{ready=$true};weflow=[pscustomobject]@{ready=$true};uiaBridge=[pscustomobject]@{alive=$true;health=$true;ready=$false};weixin=[pscustomobject]@{alive=$true}};",
    "$transportDown=$waiting.PSObject.Copy();$transportDown.uiaBridge=[pscustomobject]@{alive=$true;health=$false;ready=$false};",
    "$coreDown=$waiting.PSObject.Copy();$coreDown.cyberboss=[pscustomobject]@{alive=$false};",
    "$value=[ordered]@{waiting=(Test-UiAWaitingForWeixinSnapshot -Snapshot $waiting);transportDown=(Test-UiAWaitingForWeixinSnapshot -Snapshot $transportDown);coreDown=(Test-UiAWaitingForWeixinSnapshot -Snapshot $coreDown)};$value|ConvertTo-Json -Compress",
  ].join(" "), stateDir);

  assert.deepEqual(result, {
    waiting: true,
    transportDown: false,
    coreDown: false,
  });

  const source = fs.readFileSync(watchdogPath, "utf8");
  const waitGuard = source.indexOf("if (Test-UiAWaitingForWeixinSnapshot -Snapshot $currentSnapshot)");
  const repairGate = source.indexOf("$gate = Get-RecoveryGate -State $recovery", waitGuard);
  assert.ok(waitGuard >= 0, "pre-repair login wait guard must exist");
  assert.ok(repairGate > waitGuard, "login wait guard must run before repair budget evaluation");
});

test("main delivery health reports an unresolved certain failure until a later verified or sending replacement", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const failedPath = path.join(stateDir, "ledger-failed.json");
  const unrelatedPath = path.join(stateDir, "ledger-unrelated.json");
  const verifiedPath = path.join(stateDir, "ledger-verified.json");
  const sendingPath = path.join(stateDir, "ledger-sending.json");
  const relapsePath = path.join(stateDir, "ledger-relapse.json");
  const hash = (character) => character.repeat(64);
  const entry = (id, overrides = {}) => ({
    id,
    idempotencyKey: id,
    talker: "wxid_main",
    contentHash: hash("a"),
    contentKind: "text",
    messageKind: "inbound_ack",
    expectedDirection: "outgoing",
    status: "failed",
    uncertain: false,
    createdAt: "2026-08-28T11:55:00.000Z",
    updatedAt: "2026-08-28T11:55:00.000Z",
    failedAt: "2026-08-28T11:55:00.000Z",
    failureCode: "TARGET_NOT_CONFIRMED",
    failureHash: hash("f"),
    ...overrides,
  });
  const failedEntries = [
    entry("old", {
      createdAt: "2026-08-28T11:40:00.000Z",
      updatedAt: "2026-08-28T11:40:00.000Z",
      failedAt: "2026-08-28T11:40:00.000Z",
    }),
    entry("ack-1"),
    entry("ack-2", {
      createdAt: "2026-08-28T11:55:30.000Z",
      updatedAt: "2026-08-28T11:55:30.000Z",
      failedAt: "2026-08-28T11:55:30.000Z",
      failureHash: hash("e"),
    }),
    entry("final", {
      contentHash: hash("b"),
      messageKind: "",
      createdAt: "2026-08-28T11:56:00.000Z",
      updatedAt: "2026-08-28T11:56:00.000Z",
      failedAt: "2026-08-28T11:56:00.000Z",
    }),
    entry("uncertain", {
      status: "failed_uncertain",
      uncertain: true,
      createdAt: "2026-08-28T11:57:00.000Z",
      updatedAt: "2026-08-28T11:57:00.000Z",
      failedAt: "2026-08-28T11:57:00.000Z",
    }),
    entry("progress", {
      contentHash: hash("9"),
      messageKind: "progress",
      createdAt: "2026-08-28T11:57:30.000Z",
      updatedAt: "2026-08-28T11:57:30.000Z",
      failedAt: "2026-08-28T11:57:30.000Z",
    }),
    entry("incoming", {
      expectedDirection: "incoming",
      messageKind: "native_reply",
      status: "verified",
      createdAt: "2026-08-28T11:58:00.000Z",
      updatedAt: "2026-08-28T11:58:00.000Z",
      verifiedAt: "2026-08-28T11:58:00.000Z",
      failedAt: "",
      failureCode: "",
      failureHash: "",
    }),
    entry("other-talker", {
      talker: "wxid_other",
      status: "verified",
      createdAt: "2026-08-28T11:59:00.000Z",
      updatedAt: "2026-08-28T11:59:00.000Z",
      verifiedAt: "2026-08-28T11:59:00.000Z",
      failedAt: "",
      failureCode: "",
      failureHash: "",
    }),
  ];
  const verifiedAck = entry("verified-ack", {
    status: "verified",
    createdAt: "2026-08-28T11:58:15.000Z",
    updatedAt: "2026-08-28T11:58:15.000Z",
    verifiedAt: "2026-08-28T11:58:15.000Z",
    failedAt: "",
    failureCode: "",
    failureHash: "",
  });
  const verified = entry("verified-final", {
    status: "verified",
    contentHash: hash("b"),
    messageKind: "",
    createdAt: "2026-08-28T11:58:30.000Z",
    updatedAt: "2026-08-28T11:58:30.000Z",
    verifiedAt: "2026-08-28T11:58:30.000Z",
    failedAt: "",
    failureCode: "",
    failureHash: "",
  });
  const sendingAck = entry("sending-ack", {
    status: "sending",
    createdAt: "2026-08-28T11:58:45.000Z",
    updatedAt: "2026-08-28T11:58:45.000Z",
    sendingAt: "2026-08-28T11:58:45.000Z",
    failedAt: "",
    failureCode: "",
    failureHash: "",
  });
  const sending = entry("sending-final", {
    status: "sending",
    contentHash: hash("b"),
    messageKind: "",
    createdAt: "2026-08-28T11:59:00.000Z",
    updatedAt: "2026-08-28T11:59:00.000Z",
    sendingAt: "2026-08-28T11:59:00.000Z",
    failedAt: "",
    failureCode: "",
    failureHash: "",
  });
  const unrelated = entry("verified-restart-notice", {
    status: "verified",
    contentHash: hash("d"),
    messageKind: "",
    createdAt: "2026-08-28T11:59:15.000Z",
    updatedAt: "2026-08-28T11:59:15.000Z",
    verifiedAt: "2026-08-28T11:59:15.000Z",
    failedAt: "",
    failureCode: "",
    failureHash: "",
  });
  const relapse = entry("relapse", {
    contentHash: hash("c"),
    messageKind: "",
    createdAt: "2026-08-28T11:59:30.000Z",
    updatedAt: "2026-08-28T11:59:30.000Z",
    failedAt: "2026-08-28T11:59:30.000Z",
  });
  fs.writeFileSync(failedPath, JSON.stringify({ version: 3, entries: failedEntries }), "utf8");
  fs.writeFileSync(unrelatedPath, JSON.stringify({ version: 3, entries: [...failedEntries, unrelated] }), "utf8");
  fs.writeFileSync(verifiedPath, JSON.stringify({ version: 3, entries: [...failedEntries, verifiedAck, verified] }), "utf8");
  fs.writeFileSync(sendingPath, JSON.stringify({ version: 3, entries: [...failedEntries, sendingAck, sending] }), "utf8");
  fs.writeFileSync(relapsePath, JSON.stringify({
    version: 3,
    entries: [...failedEntries, verifiedAck, verified, relapse],
  }), "utf8");

  const result = invokeLibrary([
    "$now=[DateTimeOffset]::Parse('2026-08-28T12:00:00.000Z');",
    `$failed=Get-MainDeliveryHealth -Path ${psQuote(failedPath)} -Talker 'wxid_main' -WindowSeconds 600 -Now $now;`,
    `$unrelated=Get-MainDeliveryHealth -Path ${psQuote(unrelatedPath)} -Talker 'wxid_main' -WindowSeconds 600 -Now $now;`,
    `$verified=Get-MainDeliveryHealth -Path ${psQuote(verifiedPath)} -Talker 'wxid_main' -WindowSeconds 600 -Now $now;`,
    `$sending=Get-MainDeliveryHealth -Path ${psQuote(sendingPath)} -Talker 'wxid_main' -WindowSeconds 600 -Now $now;`,
    `$relapse=Get-MainDeliveryHealth -Path ${psQuote(relapsePath)} -Talker 'wxid_main' -WindowSeconds 600 -Now $now;`,
    "$value=[ordered]@{failed=$failed;unrelated=$unrelated;verified=$verified;sending=$sending;relapse=$relapse};$value|ConvertTo-Json -Depth 5 -Compress",
  ].join(" "), stateDir);

  assert.equal(result.failed.healthy, false);
  assert.equal(result.failed.ready, true);
  assert.equal(result.failed.reason, "terminal_outbound_failed");
  assert.equal(result.failed.failedAt, "2026-08-28T11:56:00.0000000+00:00");
  assert.equal(result.failed.terminalFailureCount, 2, "duplicate ack attempts should be one logical failure");
  assert.equal(result.failed.messageKind, "");
  assert.equal(result.failed.failureCode, "TARGET_NOT_CONFIRMED");
  assert.equal(result.unrelated.healthy, false, "an unrelated verified notice must not hide a lost reply");
  assert.equal(result.unrelated.entryId, "final");
  assert.equal(result.verified.healthy, true);
  assert.equal(result.verified.latestStatus, "verified");
  assert.equal(result.sending.healthy, true);
  assert.equal(result.sending.latestStatus, "sending");
  assert.equal(result.relapse.healthy, false);
  assert.equal(result.relapse.entryId, "relapse");
});

test("main delivery ledger compatibility ignores missing and legacy stores but rejects invalid v3 UTF-8", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const missingPath = path.join(stateDir, "missing.json");
  const legacyPath = path.join(stateDir, "legacy.json");
  const invalidPath = path.join(stateDir, "invalid.json");
  const emptyPath = path.join(stateDir, "empty.json");
  const residuePath = path.join(stateDir, "residue.json");
  fs.writeFileSync(legacyPath, JSON.stringify({ version: 2, entries: [] }), "utf8");
  fs.writeFileSync(invalidPath, Buffer.from([0xff, 0xfe, 0xfd]));
  fs.writeFileSync(emptyPath, JSON.stringify({ version: 3, entries: [] }), "utf8");
  fs.writeFileSync(residuePath, JSON.stringify({
    version: 3,
    entries: [{
      id: "malformed-old-residue",
      talker: "wxid_main",
      expectedDirection: "outgoing",
      status: "failed",
      uncertain: false,
      createdAt: "not-a-time",
      updatedAt: "not-a-time",
      failedAt: "not-a-time",
    }],
  }), "utf8");

  const result = invokeLibrary([
    "$now=[DateTimeOffset]::Parse('2026-08-28T12:00:00.000Z');",
    `$missing=Get-MainDeliveryHealth -Path ${psQuote(missingPath)} -Talker 'wxid_main' -Now $now;`,
    `$legacy=Get-MainDeliveryHealth -Path ${psQuote(legacyPath)} -Talker 'wxid_main' -Now $now;`,
    `$invalid=Get-MainDeliveryHealth -Path ${psQuote(invalidPath)} -Talker 'wxid_main' -Now $now;`,
    `$empty=Get-MainDeliveryHealth -Path ${psQuote(emptyPath)} -Talker 'wxid_main' -Now $now;`,
    `$residue=Get-MainDeliveryHealth -Path ${psQuote(residuePath)} -Talker 'wxid_main' -Now $now;`,
    "$value=[ordered]@{missing=$missing;legacy=$legacy;invalid=$invalid;empty=$empty;residue=$residue};$value|ConvertTo-Json -Depth 4 -Compress",
  ].join(" "), stateDir);

  assert.equal(result.missing.healthy, true);
  assert.equal(result.missing.ready, false);
  assert.equal(result.missing.reason, "ledger_missing");
  assert.equal(result.legacy.healthy, true);
  assert.equal(result.legacy.ready, false);
  assert.equal(result.legacy.reason, "ledger_version_unsupported");
  assert.equal(result.invalid.healthy, false);
  assert.equal(result.invalid.repairable, false);
  assert.equal(result.invalid.reason, "ledger_invalid");
  assert.equal(result.empty.healthy, true);
  assert.equal(result.empty.ready, true);
  assert.equal(result.residue.healthy, true);
  assert.equal(result.residue.invalidEntryCount, 1);
});

test("main delivery failure observes once and then blocks the pipeline without authorizing restart", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const result = invokeLibrary([
    "$delivery=[pscustomobject]@{healthy=$false;repairable=$false;reason='terminal_outbound_failed'};",
    "$first=Get-WatchdogFailureDisposition -Failed @('mainDelivery') -ConsecutiveFailures 1 -RequiredConfirmations 2;",
    "$second=Get-WatchdogFailureDisposition -Failed @('mainDelivery') -ConsecutiveFailures 2 -RequiredConfirmations 2;",
    "$blocked=Test-MainDeliveryFailureNonRestartable -Failed @('mainDelivery') -MainDelivery $delivery;",
    "$mixed=Test-MainDeliveryFailureNonRestartable -Failed @('mainDelivery','weflow') -MainDelivery $delivery;",
    "$mixedFirst=Get-WatchdogFailureDisposition -Failed @('mainDelivery','app-server') -ConsecutiveFailures 1 -RequiredConfirmations 2;",
    "$mixedSecond=Get-WatchdogFailureDisposition -Failed @('mainDelivery','app-server') -ConsecutiveFailures 2 -RequiredConfirmations 2;",
    "$mixedConfirmed=if($mixedSecond.action -eq 'repair' -and -not (Test-MainDeliveryFailureNonRestartable -Failed @('mainDelivery','app-server') -MainDelivery $delivery)){Get-WatchdogRepairMode -Failed @('app-server')}else{'pipeline_blocked'};",
    "$mixedWeFlow=if(-not (Test-MainDeliveryFailureNonRestartable -Failed @('mainDelivery','weflow') -MainDelivery $delivery)){Get-WatchdogRepairMode -Failed @('weflow')}else{'pipeline_blocked'};",
    "$infra=[pscustomobject]@{cyberboss=[pscustomobject]@{alive=$true};appServer=[pscustomobject]@{ready=$true};weflow=[pscustomobject]@{ready=$true};uiaBridge=[pscustomobject]@{ready=$true};weixin=[pscustomobject]@{alive=$true};sendSource='azzy';inboxQueue=[pscustomobject]@{healthy=$true};pendingInbound=[pscustomobject]@{healthy=$true};deferredReplies=[pscustomobject]@{healthy=$true};mainDelivery=$delivery;activity=[pscustomobject]@{healthy=$true}};",
    "$infraBlocked=Test-SnapshotInfrastructureHealthy -Snapshot $infra;$infraIgnoringDelivery=Test-SnapshotInfrastructureHealthy -Snapshot $infra -IgnoreMainDelivery;$infra.mainDelivery=[pscustomobject]@{healthy=$true};$infraRecovered=Test-SnapshotInfrastructureHealthy -Snapshot $infra;",
    "$finalAction=if($second.action -eq 'repair' -and $blocked){'pipeline_blocked'}else{'Restart'};",
    "$value=[ordered]@{first=$first.action;second=$second.action;blocked=$blocked;mixed=$mixed;mixedFirst=$mixedFirst.action;mixedConfirmed=$mixedConfirmed;mixedWeFlow=$mixedWeFlow;infraBlocked=$infraBlocked;infraIgnoringDelivery=$infraIgnoringDelivery;infraRecovered=$infraRecovered;finalAction=$finalAction};$value|ConvertTo-Json -Compress",
  ].join(" "), stateDir);

  assert.deepEqual(result, {
    first: "observing",
    second: "repair",
    blocked: true,
    mixed: false,
    mixedFirst: "observing",
    mixedConfirmed: "Restart",
    mixedWeFlow: "FullRestart",
    infraBlocked: false,
    infraIgnoringDelivery: true,
    infraRecovered: true,
    finalAction: "pipeline_blocked",
  });

  const source = fs.readFileSync(watchdogPath, "utf8");
  const blockedBranch = source.indexOf("Test-MainDeliveryFailureNonRestartable -Failed $failed");
  const recoveryGate = source.indexOf("$gate = Get-RecoveryGate -State $recovery", blockedBranch);
  const restart = source.indexOf("$repairProcess = Start-Process", blockedBranch);
  assert.ok(blockedBranch > 0);
  assert.ok(recoveryGate > blockedBranch, "non-restartable delivery must block before repair budget logic");
  assert.ok(restart > blockedBranch, "non-restartable delivery must block before any restart process");
  assert.match(
    source.slice(blockedBranch, recoveryGate),
    /Save-Status -Snapshot \$snapshot -Action "pipeline_blocked"[\s\S]+?exit 2/u,
  );
  assert.match(source, /\$repairableFailed = @\(\$failed \| Where-Object \{ \$_ -notin @\("mainDelivery", "replyObligations"\) \}\)/u);
  assert.match(source, /Get-WatchdogRepairPlan[\s\S]+?-Failed \$repairableFailed/u);
  assert.match(source, /independent desktop WeChat recovery completed; logical delivery failure remains terminal/u);
  assert.match(source, /repaired independent components; logical delivery failure remains terminal/u);
});

test("durable queue health distinguishes fresh busy work from stale blocked work", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const queuePath = path.join(stateDir, "pending-inbound.json");
  fs.writeFileSync(queuePath, JSON.stringify({
    version: 5,
    scopes: [{
      messages: [
        { pendingId: "fresh", receivedAt: "2026-08-28T11:59:30.000Z" },
        { pendingId: "stale", receivedAt: "2026-08-28T11:50:00.000Z" },
      ],
    }],
    sharedScopes: [],
  }), "utf8");

  const result = invokeLibrary([
    `$health=Get-PendingInboundQueueHealth -Path ${psQuote(queuePath)} -StaleAfterSeconds 300 -Now ([DateTimeOffset]::Parse('2026-08-28T12:00:00Z'));`,
    "$health | ConvertTo-Json -Compress",
  ].join(" "), stateDir);
  assert.equal(result.healthy, false);
  assert.equal(result.pendingCount, 2);
  assert.equal(result.oldestKey, "stale");
  assert.equal(result.oldestAgeSeconds, 600);
  assert.equal(result.reason, "stale_pending_inbound");
});

test("pipeline activity requires a fresh matching process snapshot and five quiet minutes", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const activityPath = path.join(stateDir, "activity.json");
  const command = [
    `$payload=[ordered]@{version=1;pid=$PID;updatedAt='2026-08-28T12:00:00Z';lastUserInboundAt='2026-08-28T11:55:00Z';activeTurnCount=0;turnGateCount=0;activeDeliveryCount=0;pendingInboundCount=0};`,
    `$payload | ConvertTo-Json | Set-Content -LiteralPath ${psQuote(activityPath)} -Encoding UTF8;`,
    `$activity=Get-PipelineActivityHealth -ExpectedPid $PID -Path ${psQuote(activityPath)} -Now ([DateTimeOffset]::Parse('2026-08-28T12:00:10Z'));`,
    "$snapshot=[pscustomobject]@{cyberboss=[pscustomobject]@{alive=$true};appServer=[pscustomobject]@{ready=$true};weflow=[pscustomobject]@{ready=$true};uiaBridge=[pscustomobject]@{ready=$true};weixin=[pscustomobject]@{alive=$true};sendSource='azzy';activity=$activity;desktopInput=[pscustomobject]@{ready=$true;idle=$true;desktopIdleSeconds=600;reason=''};inboxQueue=[pscustomobject]@{healthy=$true;pendingCount=0;outgoingPoll=[pscustomobject]@{ready=$true;healthy=$true}};pendingInbound=[pscustomobject]@{healthy=$true;pendingCount=0};deferredReplies=[pscustomobject]@{healthy=$true;pendingCount=0}};",
    "$result=[ordered]@{activity=$activity;idleGate=(Test-CanaryIdleGate -Snapshot $snapshot)}; $result | ConvertTo-Json -Depth 5 -Compress",
  ].join(" ");
  const result = invokeLibrary(command, stateDir);
  assert.equal(result.activity.ready, true);
  assert.equal(result.activity.healthy, true);
  assert.equal(result.activity.idle, true);
  assert.equal(result.activity.userIdleSeconds, 310);
  assert.equal(result.idleGate, true);
});

test("routine canary requires five minutes of desktop input idle and fails closed when unavailable", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const result = invokeLibrary([
    "$quiet=[pscustomobject]@{desktopInput=[pscustomobject]@{ready=$true;idle=$true;desktopIdleSeconds=300;reason=''}};",
    "$active=[pscustomobject]@{desktopInput=[pscustomobject]@{ready=$true;idle=$false;desktopIdleSeconds=45;reason='desktop_recent_input'}};",
    "$missing=[pscustomobject]@{desktopInput=[pscustomobject]@{ready=$false;idle=$false;desktopIdleSeconds=$null;reason='desktop_input_unavailable'}};",
    "$value=[ordered]@{quiet=(Test-DesktopInputIdleGate -Snapshot $quiet);active=(Test-DesktopInputIdleGate -Snapshot $active);missing=(Test-DesktopInputIdleGate -Snapshot $missing);threshold=$CanaryDesktopQuietSeconds}; $value | ConvertTo-Json -Compress",
  ].join(" "), stateDir, { CYBERBOSS_WATCHDOG_DESKTOP_IDLE_SECONDS: "60" });
  assert.deepEqual(result, {
    quiet: true,
    active: false,
    missing: false,
    threshold: 300,
  });

  const source = fs.readFileSync(watchdogPath, "utf8");
  assert.match(source, /function Get-DesktopInputIdleState[\s\S]+?GetLastInputInfo/u);
  assert.match(source, /Test-PipelineRepairIdleGate -Snapshot \$snapshot\) `[\s\S]+?Test-DesktopInputIdleGate -Snapshot \$snapshot/u);
  assert.match(source, /Invoke-PostRepairCanaryVerification[\s\S]+?Test-CanaryIdleGate -Snapshot \$Snapshot/u);
});

// A repair calls Ensure-AzzySource right after (re)starting the UIA bridge. The
// bridge is contacted with a 3 second per-request timeout, so a bridge that has
// not started listening yet failed the first call, which aborted the repair and
// drove another - the stack was seen restarting every few minutes while the
// endpoint answered correctly moments later. Pin the bounded retry.
test("setting the azzy send source retries a bridge that has not started listening yet", () => {
  const source = fs.readFileSync(watchdogPath, "utf8");
  const start = source.indexOf("function Ensure-AzzySource");
  assert.notEqual(start, -1, "Ensure-AzzySource must exist");
  const body = source.slice(start, source.indexOf("\n}\n", start));

  assert.match(body, /\[int\]\$TimeoutSeconds\s*=\s*30/u,
    "the retry window must be configurable with a sane default");
  assert.match(body, /while\s*\(\$true\)/u, "it must poll instead of trying once");
  assert.match(body, /Start-Sleep/u, "it must wait between attempts");
  assert.match(body, /did not persist the azzy send source within/u,
    "it must still fail loudly once the window is exhausted");
  assert.match(body, /deadline/u, "the retry must be bounded");
});

test("outgoing backfill uses fresh cursor progress instead of wall-clock range lag", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const cursorPath = path.join(stateDir, "cursor.json");
  const stalledPath = path.join(stateDir, "cursor-stalled.json");
  const cursor = {
    version: 7,
    pendingEvents: [],
    outgoingPollCursor: {
      polledThrough: Math.floor(Date.parse("2026-08-28T11:00:00.000Z") / 1000),
      backfillActive: true,
      stallAttempt: 0,
      retryNotBefore: "",
    },
  };
  fs.writeFileSync(cursorPath, JSON.stringify(cursor), "utf8");
  fs.writeFileSync(stalledPath, JSON.stringify({
    ...cursor,
    outgoingPollCursor: { ...cursor.outgoingPollCursor, stallAttempt: 3 },
  }), "utf8");
  fs.utimesSync(cursorPath, new Date("2026-08-28T12:00:00.000Z"), new Date("2026-08-28T12:00:00.000Z"));
  fs.utimesSync(stalledPath, new Date("2026-08-28T12:00:00.000Z"), new Date("2026-08-28T12:00:00.000Z"));

  const result = invokeLibrary([
    `$health=Get-InboxQueueHealth -Path ${psQuote(cursorPath)} -StaleAfterSeconds 300 -Now ([DateTimeOffset]::Parse('2026-08-28T12:00:10Z'));`,
    `$stalled=Get-InboxQueueHealth -Path ${psQuote(stalledPath)} -StaleAfterSeconds 300 -Now ([DateTimeOffset]::Parse('2026-08-28T12:00:10Z'));`,
    "$value=[ordered]@{health=$health;stalled=$stalled}; $value | ConvertTo-Json -Depth 6 -Compress",
  ].join(" "), stateDir);
  assert.equal(result.health.outgoingPoll.backfillActive, true);
  assert.equal(result.health.outgoingPoll.lagSeconds, 3610);
  assert.equal(result.health.outgoingPoll.cursorAgeSeconds, 10);
  assert.equal(result.health.outgoingPoll.healthy, true);
  assert.equal(result.health.healthy, true);
  assert.equal(result.stalled.outgoingPoll.healthy, false);
  assert.equal(result.stalled.outgoingPoll.reason, "outgoing_poll_stalled");
  assert.equal(result.stalled.healthy, false);
});

test("an inbox event with no parseable timestamp is unhealthy instead of permanently fresh", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const cursorPath = path.join(stateDir, "cursor-missing-timestamp.json");
  const now = "2026-08-28T12:00:00.000Z";
  fs.writeFileSync(cursorPath, JSON.stringify({
    version: 7,
    pendingEvents: [{ key: "message.new:unknown-age", push: {} }],
    outgoingPollCursor: {
      polledThrough: Math.floor(Date.parse(now) / 1000),
      backfillActive: false,
      stallAttempt: 0,
      retryNotBefore: "",
    },
  }), "utf8");
  const mtime = new Date("2026-08-28T11:59:55.000Z");
  fs.utimesSync(cursorPath, mtime, mtime);

  const result = invokeLibrary([
    `$health=Get-InboxQueueHealth -Path ${psQuote(cursorPath)} -StaleAfterSeconds 300 -Now ([DateTimeOffset]::Parse('${now}'));`,
    "$health|ConvertTo-Json -Depth 5 -Compress",
  ].join(" "), stateDir);

  assert.equal(result.pendingCount, 1);
  assert.equal(result.oldestKey, "message.new:unknown-age");
  assert.equal(result.oldestAgeSeconds, null);
  assert.equal(result.outgoingPoll.healthy, true);
  assert.equal(result.healthy, false);
  assert.equal(result.reason, "pending_timestamp_missing");
});

test("combined inbox health keeps main pending metrics and detects a stale lightweight canary cursor", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const mainPath = path.join(stateDir, "weflow-inbox-cursor.json");
  const canaryPath = path.join(stateDir, "weflow-canary-inbox-cursor.json");
  const freshCanaryPath = path.join(stateDir, "weflow-canary-inbox-cursor-fresh.json");
  const now = "2026-08-28T12:00:00.000Z";
  const polledThrough = Math.floor(Date.parse(now) / 1000);
  const cursor = (pendingEvents) => ({
    version: 7,
    pendingEvents,
    outgoingPollCursor: {
      polledThrough,
      backfillActive: false,
      stallAttempt: 0,
      retryNotBefore: "",
    },
  });
  fs.writeFileSync(mainPath, JSON.stringify(cursor([{
    key: "message.new:main-fresh",
    push: { timestamp: Math.floor(Date.parse("2026-08-28T11:59:30.000Z") / 1000) },
  }])), "utf8");
  const lightweightCursor = (lastPolledAt) => ({
    version: 1,
    talker: "wxid_fixture_self",
    lastLocalId: "2",
    seenIdentities: ["local:1", "local:2"],
    updatedAt: lastPolledAt,
    lastPolledAt,
  });
  fs.writeFileSync(canaryPath, JSON.stringify(lightweightCursor("2026-08-28T11:50:00.000Z")), "utf8");
  fs.writeFileSync(freshCanaryPath, JSON.stringify(lightweightCursor("2026-08-28T11:59:50.000Z")), "utf8");
  const mtime = new Date("2026-08-28T11:59:55.000Z");
  fs.utimesSync(mainPath, mtime, mtime);
  fs.utimesSync(canaryPath, mtime, mtime);
  fs.utimesSync(freshCanaryPath, mtime, mtime);

  const result = invokeLibrary([
    `$health=Get-CombinedInboxQueueHealth -MainPath ${psQuote(mainPath)} -CanaryPath ${psQuote(canaryPath)} -CanaryConfigured $true -ExpectedCanaryTalker 'wxid_fixture_self' -ServiceAlive $true -ServiceUptimeSeconds 300 -StaleAfterSeconds 300 -Now ([DateTimeOffset]::Parse('${now}'));`,
    `$fresh=Get-InboxQueueHealth -Path ${psQuote(freshCanaryPath)} -Now ([DateTimeOffset]::Parse('${now}')) -Lightweight -ExpectedTalker 'wxid_fixture_self';`,
    `$mismatch=Get-CombinedInboxQueueHealth -MainPath ${psQuote(mainPath)} -CanaryPath ${psQuote(freshCanaryPath)} -CanaryConfigured $true -ExpectedCanaryTalker 'wxid_other_self' -ServiceAlive $true -ServiceUptimeSeconds 300 -StaleAfterSeconds 300 -Now ([DateTimeOffset]::Parse('${now}'));`,
    "$value=[ordered]@{health=$health;fresh=$fresh;mismatch=$mismatch};$value | ConvertTo-Json -Depth 8 -Compress",
  ].join(" "), stateDir);

  assert.equal(result.health.healthy, false);
  assert.equal(result.health.pendingCount, 1);
  assert.equal(result.health.oldestAgeSeconds, 30);
  assert.equal(result.health.oldestKey, "message.new:main-fresh");
  assert.equal(result.health.oldestQueue, "main");
  assert.equal(result.health.reason, "canary_outgoing_poll_stale");
  assert.equal(result.health.cursorPresent, true);
  assert.equal(result.health.outgoingPoll.ready, true);
  assert.equal(result.health.outgoingPoll.healthy, false);
  assert.equal(result.health.main.healthy, true);
  assert.equal(result.health.canary.healthy, false);
  assert.equal(result.health.canary.outgoingPoll.lagSeconds, 600);
  assert.equal(result.health.canary.outgoingPoll.cursorAgeSeconds, 5);

  assert.equal(result.fresh.healthy, true);
  assert.equal(result.fresh.pendingCount, 0);
  assert.equal(result.fresh.outgoingPoll.ready, true);
  assert.equal(result.fresh.outgoingPoll.healthy, true);
  assert.equal(result.fresh.outgoingPoll.lagSeconds, 10);
  assert.equal(result.fresh.outgoingPoll.cursorAgeSeconds, 5);

  assert.equal(result.mismatch.healthy, false);
  assert.equal(result.mismatch.reason, "canary_cursor_target_mismatch");
  assert.equal(result.mismatch.canary.reason, "cursor_target_mismatch");
  assert.equal(result.mismatch.canary.outgoingPoll.healthy, false);
});

test("a configured canary cursor has startup grace, then becomes a repairable inbox fault", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const mainPath = path.join(stateDir, "weflow-inbox-cursor.json");
  const missingCanaryPath = path.join(stateDir, "weflow-canary-inbox-cursor.json");
  const now = "2026-08-28T12:00:00.000Z";
  fs.writeFileSync(mainPath, JSON.stringify({
    version: 7,
    pendingEvents: [],
    outgoingPollCursor: {
      polledThrough: Math.floor(Date.parse(now) / 1000),
      backfillActive: false,
      stallAttempt: 0,
      retryNotBefore: "",
    },
  }), "utf8");
  const mtime = new Date("2026-08-28T11:59:55.000Z");
  fs.utimesSync(mainPath, mtime, mtime);

  const result = invokeLibrary([
    `$early=Get-CombinedInboxQueueHealth -MainPath ${psQuote(mainPath)} -CanaryPath ${psQuote(missingCanaryPath)} -CanaryConfigured $true -ExpectedCanaryTalker 'wxid_fixture_self' -ServiceAlive $true -ServiceUptimeSeconds 60 -Now ([DateTimeOffset]::Parse('${now}'));`,
    `$late=Get-CombinedInboxQueueHealth -MainPath ${psQuote(mainPath)} -CanaryPath ${psQuote(missingCanaryPath)} -CanaryConfigured $true -ExpectedCanaryTalker 'wxid_fixture_self' -ServiceAlive $true -ServiceUptimeSeconds 121 -Now ([DateTimeOffset]::Parse('${now}'));`,
    `$disabled=Get-CombinedInboxQueueHealth -MainPath ${psQuote(mainPath)} -CanaryPath ${psQuote(missingCanaryPath)} -CanaryConfigured $false -ServiceAlive $true -ServiceUptimeSeconds 121 -Now ([DateTimeOffset]::Parse('${now}'));`,
    "$base=[pscustomobject]@{cyberboss=[pscustomobject]@{alive=$true};appServer=[pscustomobject]@{alive=$true};activity=[pscustomobject]@{ready=$true;healthy=$true;idle=$true;userIdleSeconds=600};pendingInbound=[pscustomobject]@{healthy=$true;pendingCount=0};deferredReplies=[pscustomobject]@{healthy=$true;pendingCount=0}};",
    "$earlySnapshot=$base.PSObject.Copy();$earlySnapshot | Add-Member -NotePropertyName inboxQueue -NotePropertyValue $early;",
    "$lateSnapshot=$base.PSObject.Copy();$lateSnapshot | Add-Member -NotePropertyName inboxQueue -NotePropertyValue $late;",
    "$value=[ordered]@{early=$early;late=$late;disabled=$disabled;earlyRepairGate=(Test-PipelineRepairIdleGate -Snapshot $earlySnapshot);lateRepairGate=(Test-PipelineRepairIdleGate -Snapshot $lateSnapshot)};$value | ConvertTo-Json -Depth 8 -Compress",
  ].join(" "), stateDir);

  assert.equal(result.early.healthy, true);
  assert.equal(result.early.cursorPresent, false);
  assert.equal(result.early.reason, "canary_initializing");
  assert.equal(result.early.outgoingPoll.ready, false);
  assert.equal(result.early.canary.healthy, true);
  assert.equal(result.earlyRepairGate, false);

  assert.equal(result.late.healthy, false);
  assert.equal(result.late.reason, "canary_cursor_missing");
  assert.equal(result.late.outgoingPoll.ready, false);
  assert.equal(result.late.outgoingPoll.healthy, false);
  assert.equal(result.late.canary.reason, "cursor_missing");
  assert.equal(result.lateRepairGate, true);

  assert.equal(result.disabled.healthy, true);
  assert.equal(result.disabled.cursorPresent, true);
  assert.equal(result.disabled.outgoingPoll.ready, true);
  assert.equal(result.disabled.canary.configured, false);
  assert.equal(result.disabled.canary.reason, "disabled");
});

test("dead services can recover while every live repair remains activity-idle gated", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const result = invokeLibrary([
    "$base=[pscustomobject]@{cyberboss=[pscustomobject]@{alive=$true};appServer=[pscustomobject]@{alive=$true};activity=[pscustomobject]@{ready=$true;healthy=$true;idle=$true;userIdleSeconds=600};inboxQueue=[pscustomobject]@{healthy=$true;pendingCount=0;outgoingPoll=[pscustomobject]@{ready=$true}};pendingInbound=[pscustomobject]@{healthy=$true;pendingCount=0};deferredReplies=[pscustomobject]@{healthy=$true;pendingCount=0}};",
    "$dead=$base.PSObject.Copy(); $dead.cyberboss=[pscustomobject]@{alive=$false}; $dead.activity=[pscustomobject]@{ready=$false;healthy=$false;idle=$false;userIdleSeconds=$null};",
    "$appDeadBusy=$base.PSObject.Copy(); $appDeadBusy.appServer=[pscustomobject]@{alive=$false;ready=$false}; $appDeadBusy.activity=[pscustomobject]@{ready=$true;healthy=$true;idle=$false;activeTurnCount=1;turnGateCount=1;activeDeliveryCount=0;pendingInboundCount=0;userIdleSeconds=600};",
    "$appDeadStrandedGate=$base.PSObject.Copy(); $appDeadStrandedGate.appServer=[pscustomobject]@{alive=$false;ready=$false}; $appDeadStrandedGate.activity=[pscustomobject]@{ready=$true;healthy=$true;idle=$false;activeTurnCount=0;turnGateCount=1;activeDeliveryCount=0;pendingInboundCount=0;userIdleSeconds=600};",
    "$busy=$base.PSObject.Copy(); $busy.activity=[pscustomobject]@{ready=$true;healthy=$true;idle=$false;userIdleSeconds=600};",
    "$recent=$base.PSObject.Copy(); $recent.activity=[pscustomobject]@{ready=$true;healthy=$true;idle=$true;userIdleSeconds=30};",
    "$value=[ordered]@{dead=(Test-PipelineRepairIdleGate -Snapshot $dead);appDeadBusy=(Test-PipelineRepairIdleGate -Snapshot $appDeadBusy);appDeadStrandedGate=(Test-PipelineRepairIdleGate -Snapshot $appDeadStrandedGate);busy=(Test-PipelineRepairIdleGate -Snapshot $busy);recent=(Test-PipelineRepairIdleGate -Snapshot $recent);idle=(Test-PipelineRepairIdleGate -Snapshot $base)}; $value | ConvertTo-Json -Compress",
  ].join(" "), stateDir);
  assert.deepEqual(result, {
    dead: true,
    appDeadBusy: false,
    appDeadStrandedGate: true,
    busy: false,
    recent: false,
    idle: true,
  });

  const source = fs.readFileSync(watchdogPath, "utf8");
  const mainStart = source.indexOf("$mutex = New-Object");
  const liveIdleGate = source.indexOf("if (-not (Test-PipelineRepairIdleGate -Snapshot $currentSnapshot))", mainStart);
  const repairGate = source.indexOf("Get-RecoveryGate -State $recovery", liveIdleGate);
  const budgetMutation = source.indexOf("$attemptAt =", repairGate);
  assert.ok(liveIdleGate > mainStart);
  assert.ok(repairGate > liveIdleGate);
  assert.ok(budgetMutation > repairGate, "every repair action must pass current idle and recovery gates before budget mutation");
});

test("an active turn or recent user message acquired after probe start defers an empty-queue timeout", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const result = invokeLibrary([
    "$queues=[ordered]@{inboxQueue=[pscustomobject]@{healthy=$true;pendingCount=0};pendingInbound=[pscustomobject]@{healthy=$true;pendingCount=0};deferredReplies=[pscustomobject]@{healthy=$true;pendingCount=0}};",
    "$active=[pscustomobject]@{inboxQueue=$queues.inboxQueue;pendingInbound=$queues.pendingInbound;deferredReplies=$queues.deferredReplies;activity=[pscustomobject]@{busy=$true;userIdleSeconds=600};desktopInput=[pscustomobject]@{ready=$true;idle=$true}};",
    "$recent=[pscustomobject]@{inboxQueue=$queues.inboxQueue;pendingInbound=$queues.pendingInbound;deferredReplies=$queues.deferredReplies;activity=[pscustomobject]@{busy=$false;userIdleSeconds=30};desktopInput=[pscustomobject]@{ready=$true;idle=$true}};",
    "$desktop=[pscustomobject]@{inboxQueue=$queues.inboxQueue;pendingInbound=$queues.pendingInbound;deferredReplies=$queues.deferredReplies;activity=[pscustomobject]@{busy=$false;userIdleSeconds=600};desktopInput=[pscustomobject]@{ready=$true;idle=$false}};",
    "$idle=[pscustomobject]@{inboxQueue=$queues.inboxQueue;pendingInbound=$queues.pendingInbound;deferredReplies=$queues.deferredReplies;activity=[pscustomobject]@{busy=$false;userIdleSeconds=600};desktopInput=[pscustomobject]@{ready=$true;idle=$true}};",
    "$recovery=Read-RecoveryState; Update-RecoveryCanaryState -RecoveryState $recovery -Canary ([pscustomobject]@{status='deferred';action='deferred_busy';attempted=$false;healthy=$null;code='CANARY_DESKTOP_ACTIVE'});",
    "$value=[ordered]@{active=(Test-CanaryProbeDeferredByActivity -Snapshot $active);recent=(Test-CanaryProbeDeferredByActivity -Snapshot $recent);desktop=(Test-CanaryProbeDeferredByActivity -Snapshot $desktop);code=(Test-CanaryProbeDeferredByActivity -Snapshot $idle -ProbeCode 'CANARY_DESKTOP_ACTIVE');idle=(Test-CanaryProbeDeferredByActivity -Snapshot $idle);confirmations=$recovery.canaryConsecutiveFailures}; $value | ConvertTo-Json -Compress",
  ].join(" "), stateDir);
  assert.deepEqual(result, {
    active: true,
    recent: true,
    desktop: true,
    code: true,
    idle: false,
    confirmations: 0,
  });
});

test("busy collisions and deferred post-repair verification cannot become false repair confirmations", () => {
  const source = fs.readFileSync(watchdogPath, "utf8");
  const mainStart = source.indexOf("$mutex = New-Object");
  const becameBusy = source.indexOf("$becameBusy =", mainStart);
  const deferredMutation = source.indexOf("Set-SnapshotCanaryResult -Snapshot $afterProbe -Canary $snapshot.canary -Deferred", becameBusy);
  const confirmationUpdate = source.indexOf("Update-RecoveryCanaryState -RecoveryState $recovery -Canary $snapshot.canary", becameBusy);
  assert.ok(becameBusy > mainStart);
  assert.ok(deferredMutation > becameBusy);
  assert.ok(confirmationUpdate > deferredMutation, "busy classification must happen before confirmation counters update");

  assert.match(source, /if \(\$recovery\.pendingRepairVerification -and \(Test-SnapshotInfrastructureHealthy -Snapshot \$snapshot\)\)/u);
  assert.match(source, /\$verified = \$canary\.action -eq "verified"[\s\S]+?triggerLocalId[\s\S]+?replyLocalId/u);
  assert.match(source, /Save-Status -Snapshot \$localSnapshot -Action "repair_verification_deferred"/u);
  assert.match(source, /Save-Status -Snapshot \$repaired -Action "repair_verification_deferred"/u);

  const postRepairStart = source.indexOf("function Invoke-PostRepairCanaryVerification");
  const postRepairRunner = source.indexOf("$canary = Invoke-CanaryCheck", postRepairStart);
  const persistedPending = source.lastIndexOf("Set-PendingRepairVerification -RecoveryState $RecoveryState", postRepairRunner);
  const persistedBeforeRunner = source.lastIndexOf("Save-RecoveryState -State $RecoveryState", postRepairRunner);
  assert.ok(persistedPending > postRepairStart);
  assert.ok(persistedBeforeRunner > persistedPending);
  assert.ok(persistedBeforeRunner < postRepairRunner, "post-repair verification must be durable before runner execution");
  assert.match(
    source.slice(postRepairStart, postRepairRunner),
    /repair_verification_blocked[\s\S]+?Set-SnapshotCanaryResult[\s\S]+?Save-RecoveryState -State \$RecoveryState[\s\S]+?return \$Snapshot/u,
  );
});

test("repair verification identity age is stable while each check records its own time and true idle blockers", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const result = invokeLibrary([
    "$snapshot=[pscustomobject]@{checkedAt='2026-08-28T12:00:00.000Z';healthy=$false;cyberboss=[pscustomobject]@{alive=$true};appServer=[pscustomobject]@{ready=$true};weflow=[pscustomobject]@{ready=$true};uiaBridge=[pscustomobject]@{ready=$true};weixin=[pscustomobject]@{alive=$true};sendSource='azzy';inboxQueue=[pscustomobject]@{healthy=$true;pendingCount=1;outgoingPoll=[pscustomobject]@{ready=$false;healthy=$false}};pendingInbound=[pscustomobject]@{healthy=$true;pendingCount=0};deferredReplies=[pscustomobject]@{healthy=$true;pendingCount=0};activity=[pscustomobject]@{ready=$true;healthy=$true;idle=$false;activeTurnCount=1;turnGateCount=0;activeDeliveryCount=0;pendingInboundCount=0;userIdleSeconds=30};desktopInput=[pscustomobject]@{ready=$true;idle=$false;desktopIdleSeconds=45};canary=[pscustomobject]@{healthy=$true}};",
    "$recovery=Read-RecoveryState;$recovery.pendingRepairVerification=$true;$recovery.pendingRepairVerificationAt='2026-08-28T10:00:00.000Z';$recovery.pendingRepairVerificationIdentity='repair-a';",
    "Set-PendingRepairVerification -RecoveryState $recovery -RepairIdentity 'repair-a';$sameAt=$recovery.pendingRepairVerificationAt;$sameCheck=$recovery.lastVerificationCheckAt;",
    "Set-PendingRepairVerification -RecoveryState $recovery -RepairIdentity 'repair-b';$changedAt=$recovery.pendingRepairVerificationAt;",
    "$marker=Join-Path $StateDir 'runner-touched';$CanaryScript=$marker;$blocked=Invoke-ExplicitCanaryDemand -Snapshot $snapshot -RecoveryState $recovery -DemandIdentity 'manual:blockers';",
    "$value=[ordered]@{sameAt=$sameAt;sameCheck=$sameCheck;changedAt=$changedAt;identity=$recovery.pendingRepairVerificationIdentity;blockers=@(Get-CanaryIdleGateBlockers -Snapshot $snapshot);blockedAction=$blocked.canary.action;blockedDetail=$blocked.canary.detail;runnerTouched=(Test-Path -LiteralPath $marker)};$value|ConvertTo-Json -Depth 5 -Compress",
  ].join(" "), stateDir);

  assert.equal(result.sameAt, "2026-08-28T10:00:00.000Z");
  assert.match(result.sameCheck, /^\d{4}-\d{2}-\d{2}T/u);
  assert.notEqual(result.changedAt, result.sameAt);
  assert.equal(result.identity, "repair-b");
  assert.deepEqual(result.blockers, [
    "poll_not_ready",
    "inbox_queue_pending",
    "activity_busy",
    "user_recent",
    "desktop_recent_input",
  ]);
  assert.equal(result.blockedAction, "demand_blocked");
  assert.match(result.blockedDetail, /poll_not_ready,inbox_queue_pending,activity_busy,user_recent,desktop_recent_input/u);
  assert.equal(result.runnerTouched, false);
});

test("an explicit demand passes its unique identity through the urgent runner and never enters repair in that turn", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const runnerPath = path.join(stateDir, "explicit-demand-runner.js");
  const argvPath = path.join(stateDir, "explicit-demand-argv.jsonl");
  fs.writeFileSync(runnerPath, [
    "const fs=require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2))+'\\n');`,
    "const failed=process.env.PROBE_CASE==='failed';",
    "process.stdout.write(JSON.stringify(failed ? {healthy:false,action:'failed',checkedAt:'2026-08-28T12:01:00.000Z',runId:'33333333-3333-4333-8333-333333333333',code:'CANARY_TIMEOUT',error:'fixture timeout',repairable:true} : {healthy:true,action:'verified',checkedAt:'2026-08-28T12:00:00.000Z',runId:'22222222-2222-4222-8222-222222222222',triggerLocalId:'10',replyLocalId:'11'})+'\\n');",
    "process.exitCode=failed?1:0;",
  ].join("\n"), "utf8");
  const command = [
    `$CanaryScript=${psQuote(runnerPath)};`,
    "$global:fixture=[pscustomobject]@{checkedAt='2026-08-28T12:00:00.000Z';healthy=$true;cyberboss=[pscustomobject]@{alive=$true};appServer=[pscustomobject]@{ready=$true};weflow=[pscustomobject]@{ready=$true};uiaBridge=[pscustomobject]@{ready=$true};weixin=[pscustomobject]@{alive=$true};sendSource='azzy';inboxQueue=[pscustomobject]@{healthy=$true;pendingCount=0;outgoingPoll=[pscustomobject]@{ready=$true;healthy=$true}};pendingInbound=[pscustomobject]@{healthy=$true;pendingCount=0};deferredReplies=[pscustomobject]@{healthy=$true;pendingCount=0};activity=[pscustomobject]@{ready=$true;healthy=$true;idle=$true;busy=$false;activeTurnCount=0;turnGateCount=0;activeDeliveryCount=0;pendingInboundCount=0;userIdleSeconds=600};desktopInput=[pscustomobject]@{ready=$true;idle=$true;desktopIdleSeconds=600};canary=[pscustomobject]@{healthy=$true}};",
    "function global:Get-HealthSnapshot{return $global:fixture.PSObject.Copy()};",
    "$recovery=Read-RecoveryState;$recovery.consecutiveFailures=2;$recovery.canaryConsecutiveFailures=2;$env:PROBE_CASE='verified';",
    "$verified=Invoke-ExplicitCanaryDemand -Snapshot ($global:fixture.PSObject.Copy()) -RecoveryState $recovery -DemandIdentity 'manual:one';Set-VerifiedRecoveryState -Snapshot $verified -RecoveryState $recovery;",
    "$afterVerified=[ordered]@{global=$recovery.consecutiveFailures;canary=$recovery.canaryConsecutiveFailures;error=$recovery.lastCanaryError};",
    "$env:PROBE_CASE='failed';$failed=Invoke-ExplicitCanaryDemand -Snapshot ($global:fixture.PSObject.Copy()) -RecoveryState $recovery -DemandIdentity 'manual:two';",
    "$value=[ordered]@{verifiedAction=$verified.canary.action;trigger=$verified.canary.triggerLocalId;reply=$verified.canary.replyLocalId;afterVerified=$afterVerified;failedAction=$failed.canary.action;failedConfirmations=$recovery.canaryConsecutiveFailures};$value|ConvertTo-Json -Depth 5 -Compress",
  ].join(" ");
  const result = invokeLibrary(command, stateDir, {
    CYBERBOSS_WEFLOW_INBOX_CHAT: "wxid_primary",
    CYBERBOSS_WEFLOW_CANARY_CHAT: "wxid_canary_self",
    CYBERBOSS_WEFLOW_CANARY_DISPLAY_NAME: "Azzy",
  });
  const calls = fs.readFileSync(argvPath, "utf8").trim().split(/\r?\n/u).map(JSON.parse);

  assert.equal(result.verifiedAction, "verified");
  assert.equal(result.trigger, "10");
  assert.equal(result.reply, "11");
  assert.deepEqual(result.afterVerified, { global: 0, canary: 0, error: "" });
  assert.equal(result.failedAction, "failed");
  assert.equal(result.failedConfirmations, 1);
  for (const [index, demand] of ["manual:one", "manual:two"].entries()) {
    assert.ok(calls[index].includes("--force"));
    assert.deepEqual(calls[index].slice(calls[index].indexOf("--reason"), calls[index].indexOf("--reason") + 2), ["--reason", "user_demand"]);
    assert.deepEqual(calls[index].slice(calls[index].indexOf("--demand-key"), calls[index].indexOf("--demand-key") + 2), ["--demand-key", demand]);
  }

  const source = fs.readFileSync(watchdogPath, "utf8");
  const pendingBranch = source.indexOf("if ($recovery.pendingRepairVerification");
  const explicitBranch = source.indexOf("if ($ExplicitDemandKey)", pendingBranch);
  const routineBranch = source.indexOf("$queuePendingCount =", explicitBranch);
  const explicitSlice = source.slice(explicitBranch, routineBranch);
  assert.ok(pendingBranch > 0 && explicitBranch > pendingBranch && routineBranch > explicitBranch);
  assert.match(explicitSlice, /Invoke-ExplicitCanaryDemand/u);
  assert.match(explicitSlice, /Save-Status[\s\S]+?exit [01]/u);
  assert.doesNotMatch(explicitSlice, /Get-RecoveryGate|Start-Process|\$attemptAt/u);
});

test("target-not-confirmed remains non-restartable in runner output and persisted canary state", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const runnerPath = path.join(stateDir, "target-not-confirmed.js");
  const explicitSchedulePath = path.join(stateDir, "canary-explicit.json");
  const legacySchedulePath = path.join(stateDir, "canary-legacy.json");
  fs.writeFileSync(runnerPath, [
    "process.stdout.write(JSON.stringify({",
    "  healthy: false,",
    "  action: 'failed',",
    "  repairable: false,",
    "  checkedAt: '2026-08-28T12:00:00.000Z',",
    "  runId: '11111111-1111-4111-8111-111111111111',",
    "  code: 'TARGET_NOT_CONFIRMED',",
    "  error: 'configured self target was not confirmed',",
    "  detail: 'target preflight failed'",
    "}) + '\\n');",
    "process.exitCode = 1;",
  ].join("\n"), "utf8");
  const schedule = {
    version: 1,
    lastStatus: "failed",
    lastAction: "failed",
    lastRepairable: false,
    lastRunId: "11111111-1111-4111-8111-111111111111",
    lastError: "TARGET_NOT_CONFIRMED",
    consecutiveFailures: 2,
  };
  fs.writeFileSync(explicitSchedulePath, JSON.stringify(schedule), "utf8");
  const { lastRepairable, ...legacySchedule } = schedule;
  assert.equal(lastRepairable, false);
  fs.writeFileSync(legacySchedulePath, JSON.stringify(legacySchedule), "utf8");

  const result = invokeLibrary([
    `$CanaryScript=${psQuote(runnerPath)};`,
    "$recovery=Read-RecoveryState;",
    "$first=Invoke-CanaryCheck;Update-RecoveryCanaryState -RecoveryState $recovery -Canary $first;",
    "$second=Invoke-CanaryCheck;Update-RecoveryCanaryState -RecoveryState $recovery -Canary $second;",
    "$disposition=Get-WatchdogFailureDisposition -Failed @('canary') -ConsecutiveFailures $recovery.canaryConsecutiveFailures -RequiredConfirmations 2;",
    "$blocked=Test-CanaryFailureNonRestartable -Failed @('canary') -Canary $second;",
    "$finalAction=if($disposition.action -eq 'repair' -and $blocked){'pipeline_blocked'}else{'Restart'};",
    `$WatchdogCanaryState=${psQuote(explicitSchedulePath)};$persisted=Read-CanaryStatus;`,
    `$WatchdogCanaryState=${psQuote(legacySchedulePath)};$legacy=Read-CanaryStatus;`,
    "$value=[ordered]@{firstRepairable=$first.repairable;secondRepairable=$second.repairable;confirmations=$recovery.canaryConsecutiveFailures;disposition=$disposition.action;blocked=$blocked;finalAction=$finalAction;persistedRepairable=$persisted.repairable;legacyRepairable=$legacy.repairable};$value|ConvertTo-Json -Compress",
  ].join(" "), stateDir);

  assert.deepEqual(result, {
    firstRepairable: false,
    secondRepairable: false,
    confirmations: 2,
    disposition: "repair",
    blocked: true,
    finalAction: "pipeline_blocked",
    persistedRepairable: false,
    legacyRepairable: true,
  });

  const source = fs.readFileSync(watchdogPath, "utf8");
  assert.match(source, /Test-CanaryFailureNonRestartable[\s\S]+?Save-Status -Snapshot \$snapshot -Action "pipeline_blocked"[\s\S]+?exit 2/u);
});

test("missing and invalid canary runners become confirmed non-restartable checker failures", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const invalidRunner = path.join(stateDir, "invalid-canary.js");
  fs.writeFileSync(invalidRunner, "process.stdout.write('not-json\\n');\n", "utf8");
  const missingRunner = path.join(stateDir, "missing-canary.js");
  const result = invokeLibrary([
    "$recovery=Read-RecoveryState;",
    `$CanaryScript=${psQuote(missingRunner)};`,
    "$missing1=Invoke-CanaryCheck; Update-RecoveryCanaryState -RecoveryState $recovery -Canary $missing1;",
    "$missing2=Invoke-CanaryCheck; Update-RecoveryCanaryState -RecoveryState $recovery -Canary $missing2;",
    "$missingCount=$recovery.canaryConsecutiveFailures;",
    "$recovery.canaryConsecutiveFailures=0;",
    `$CanaryScript=${psQuote(invalidRunner)};`,
    "$invalid1=Invoke-CanaryCheck; Update-RecoveryCanaryState -RecoveryState $recovery -Canary $invalid1;",
    "$invalid2=Invoke-CanaryCheck; Update-RecoveryCanaryState -RecoveryState $recovery -Canary $invalid2;",
    "$value=[ordered]@{missingAttempted=$missing1.attempted;missingRepairable=$missing1.repairable;missingCount=$missingCount;invalidAttempted=$invalid1.attempted;invalidRepairable=$invalid1.repairable;invalidCount=$recovery.canaryConsecutiveFailures;disposition=(Get-WatchdogFailureDisposition -Failed @('canary') -ConsecutiveFailures $recovery.canaryConsecutiveFailures -RequiredConfirmations 2).action}; $value | ConvertTo-Json -Compress",
  ].join(" "), stateDir);

  assert.deepEqual(result, {
    missingAttempted: true,
    missingRepairable: false,
    missingCount: 2,
    invalidAttempted: true,
    invalidRepairable: false,
    invalidCount: 2,
    disposition: "repair",
  });
  const source = fs.readFileSync(watchdogPath, "utf8");
  assert.match(source, /blocked_nonrestartable[\s\S]+?Save-Status -Snapshot \$snapshot -Action "pipeline_blocked"/u);
});

test("deferred schedule reads preserve the last completed tri-state and explicit nonrepairability", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const schedules = {
    busy: {
      version: 1,
      lastStatus: "failed",
      lastAction: "deferred_busy",
      lastRepairable: false,
      consecutiveFailures: 2,
    },
    budget: {
      version: 1,
      lastStatus: "healthy",
      lastAction: "budget_wait",
      lastRepairable: false,
      consecutiveFailures: 0,
    },
    changed: {
      version: 1,
      lastStatus: "healthy",
      lastAction: "target_changed_pending",
      lastRepairable: false,
      consecutiveFailures: 0,
    },
    targetBudget: {
      version: 1,
      lastStatus: "failed",
      lastAction: "target_verification_budget_wait",
      lastRepairable: false,
      consecutiveFailures: 2,
    },
  };
  const files = {};
  for (const [name, schedule] of Object.entries(schedules)) {
    files[name] = path.join(stateDir, `${name}.json`);
    fs.writeFileSync(files[name], JSON.stringify(schedule), "utf8");
  }

  const result = invokeLibrary([
    `$WatchdogCanaryState=${psQuote(files.busy)};$busy=Read-CanaryStatus;`,
    `$WatchdogCanaryState=${psQuote(files.budget)};$budget=Read-CanaryStatus;`,
    `$WatchdogCanaryState=${psQuote(files.changed)};$changed=Read-CanaryStatus;`,
    `$WatchdogCanaryState=${psQuote(files.targetBudget)};$targetBudget=Read-CanaryStatus;`,
    "$value=[ordered]@{busy=$busy;budget=$budget;changed=$changed;targetBudget=$targetBudget};$value|ConvertTo-Json -Depth 5 -Compress",
  ].join(" "), stateDir);

  assert.equal(result.busy.status, "deferred");
  assert.equal(result.busy.healthy, false);
  assert.equal(result.busy.repairable, false);
  assert.equal(result.budget.status, "deferred");
  assert.equal(result.budget.healthy, true);
  assert.equal(result.budget.repairable, false);
  assert.equal(result.changed.status, "deferred");
  assert.equal(result.changed.healthy, null);
  assert.equal(result.changed.repairable, false);
  assert.equal(result.targetBudget.status, "deferred");
  assert.equal(result.targetBudget.healthy, null);
  assert.equal(result.targetBudget.repairable, false);
});

test("target verification deferrals stay unknown without consuming failures and a later verification clears counters", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const runnerPath = path.join(stateDir, "tri-state-canary.js");
  fs.writeFileSync(runnerPath, [
    "const outcomes = {",
    "  pending: { healthy: null, action: 'target_changed_pending', attempted: false, repairable: false, checkedAt: '2026-08-28T12:00:00.000Z' },",
    "  budget: { healthy: null, action: 'target_verification_budget_wait', attempted: false, repairable: false, checkedAt: '2026-08-28T12:01:00.000Z', nextDueAt: '2026-08-28T13:00:00.000Z' },",
    "  verified: { healthy: true, action: 'verified', attempted: true, repairable: true, checkedAt: '2026-08-28T13:00:00.000Z', runId: '22222222-2222-4222-8222-222222222222', triggerLocalId: '2', replyLocalId: '3' },",
    "};",
    "process.stdout.write(JSON.stringify(outcomes[process.env.PROBE_CASE]) + '\\n');",
  ].join("\n"), "utf8");

  const result = invokeLibrary([
    `$CanaryScript=${psQuote(runnerPath)};`,
    "$recovery=Read-RecoveryState;$recovery.canaryConsecutiveFailures=2;$recovery.consecutiveFailures=2;$recovery.lastCanaryError='prior exact-target failure';",
    "$prior=[pscustomobject]@{healthy=$false;status='failed';action='failed';attempted=$true;repairable=$false};",
    "$blockedBefore=Test-CanaryFailureNonRestartable -Failed @('canary') -Canary $prior;",
    "$env:PROBE_CASE='pending';$pending=Invoke-CanaryCheck;Update-RecoveryCanaryState -RecoveryState $recovery -Canary $pending;$afterPending=$recovery.canaryConsecutiveFailures;$globalAfterPending=$recovery.consecutiveFailures;",
    "$env:PROBE_CASE='budget';$budget=Invoke-CanaryCheck;Update-RecoveryCanaryState -RecoveryState $recovery -Canary $budget;$afterBudget=$recovery.canaryConsecutiveFailures;$globalAfterBudget=$recovery.consecutiveFailures;",
    "$env:PROBE_CASE='verified';$verified=Invoke-CanaryCheck;Update-RecoveryCanaryState -RecoveryState $recovery -Canary $verified;$afterVerified=$recovery.canaryConsecutiveFailures;",
    "$snapshot=[ordered]@{checkedAt='2026-08-28T13:00:00.000Z';healthy=$true};Complete-VerifiedRepair -Snapshot $snapshot -RecoveryState $recovery -Detail 'fixture verified';",
    "$value=[ordered]@{blockedBefore=$blockedBefore;pending=$pending;afterPending=$afterPending;globalAfterPending=$globalAfterPending;budget=$budget;afterBudget=$afterBudget;globalAfterBudget=$globalAfterBudget;verified=$verified;afterVerified=$afterVerified;finalFailures=$recovery.consecutiveFailures;finalCanaryFailures=$recovery.canaryConsecutiveFailures;finalError=$recovery.lastCanaryError};$value|ConvertTo-Json -Depth 5 -Compress",
  ].join(" "), stateDir, {
    CYBERBOSS_WEFLOW_INBOX_CHAT: "wxid_primary",
    CYBERBOSS_WEFLOW_CANARY_CHAT: "wxid_canary_self",
    CYBERBOSS_WEFLOW_CANARY_DISPLAY_NAME: "Azzy",
  });

  assert.equal(result.blockedBefore, true);
  assert.equal(result.pending.healthy, null);
  assert.equal(result.pending.status, "deferred");
  assert.equal(result.pending.attempted, false);
  assert.equal(result.pending.repairable, false);
  assert.equal(result.afterPending, 2);
  assert.equal(result.globalAfterPending, 2);
  assert.equal(result.budget.healthy, null);
  assert.equal(result.budget.status, "deferred");
  assert.equal(result.budget.attempted, false);
  assert.equal(result.budget.repairable, false);
  assert.equal(result.afterBudget, 2);
  assert.equal(result.globalAfterBudget, 2);
  assert.equal(result.verified.healthy, true);
  assert.equal(result.verified.status, "healthy");
  assert.equal(result.verified.attempted, true);
  assert.equal(result.afterVerified, 0);
  assert.equal(result.finalFailures, 0);
  assert.equal(result.finalCanaryFailures, 0);
  assert.equal(result.finalError, "");

  const source = fs.readFileSync(watchdogPath, "utf8");
  assert.doesNotMatch(source, /\$confirmedCanaryFailure/u);
  assert.match(source, /if \(Test-CanaryIdleGate -Snapshot \$snapshot\)[\s\S]+?Invoke-CanaryCheck -Reason "routine"/u);
});

test("an aliased primary and canary talker fails before runner execution and remains non-restartable", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const runnerPath = path.join(stateDir, "must-not-run.js");
  const markerPath = path.join(stateDir, "runner-touched.txt");
  fs.writeFileSync(runnerPath, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(markerPath)}, 'unexpected', 'utf8');`,
    "process.stdout.write(JSON.stringify({ healthy: true, action: 'verified' }) + '\\n');",
  ].join("\n"), "utf8");

  const result = invokeLibrary([
    `$CanaryScript=${psQuote(runnerPath)};`,
    "$recovery=Read-RecoveryState;",
    "$first=Invoke-CanaryCheck;Update-RecoveryCanaryState -RecoveryState $recovery -Canary $first;",
    "$second=Invoke-CanaryCheck;Update-RecoveryCanaryState -RecoveryState $recovery -Canary $second;",
    "$value=[ordered]@{conflict=$WeFlowCanaryTargetConflict;code=$first.code;action=$first.action;attempted=$first.attempted;repairable=$first.repairable;runnerTouched=(Test-Path -LiteralPath " + psQuote(markerPath) + ");confirmations=$recovery.canaryConsecutiveFailures;blocked=(Test-CanaryFailureNonRestartable -Failed @('canary') -Canary $second);disposition=(Get-WatchdogFailureDisposition -Failed @('canary') -ConsecutiveFailures $recovery.canaryConsecutiveFailures -RequiredConfirmations 2).action};$value|ConvertTo-Json -Compress",
  ].join(" "), stateDir, {
    CYBERBOSS_WEFLOW_INBOX_CHAT: "wxid_same",
    CYBERBOSS_WEFLOW_CANARY_CHAT: "wxid_same",
    CYBERBOSS_WEFLOW_CANARY_DISPLAY_NAME: "Azzy",
  });

  assert.deepEqual(result, {
    conflict: true,
    code: "CANARY_TARGET_CONFLICT",
    action: "failed",
    attempted: true,
    repairable: false,
    runnerTouched: false,
    confirmations: 2,
    blocked: true,
    disposition: "repair",
  });

  const source = fs.readFileSync(watchdogPath, "utf8");
  const configCheck = source.indexOf("if ($null -ne (Get-CanaryTargetConfigurationFailure))");
  const idleCheck = source.indexOf("elseif (Test-CanaryIdleGate -Snapshot $snapshot)", configCheck);
  assert.ok(configCheck > 0);
  assert.ok(idleCheck > configCheck, "same-talker validation must precede idle-gated runner execution");
});

test("unknown canary health is verification-pending, never heartbeat-healthy or repairable", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const result = invokeLibrary([
    "$snapshot=[pscustomobject]@{checkedAt='2026-08-28T12:00:00.000Z';healthy=$true;cyberboss=[pscustomobject]@{alive=$true};appServer=[pscustomobject]@{ready=$true};weflow=[pscustomobject]@{ready=$true};uiaBridge=[pscustomobject]@{ready=$true};weixin=[pscustomobject]@{alive=$true};sendSource='azzy';inboxQueue=[pscustomobject]@{healthy=$true};pendingInbound=[pscustomobject]@{healthy=$true};deferredReplies=[pscustomobject]@{healthy=$true};activity=[pscustomobject]@{healthy=$true};canary=[pscustomobject]@{healthy=$null;status='deferred';action='target_changed_pending';attempted=$false;repairable=$false;nextDueAt='2026-08-28T13:00:00.000Z'}};",
    "$recovery=Read-RecoveryState;$recovery.consecutiveFailures=1;$recovery.canaryConsecutiveFailures=2;",
    "$pendingBefore=(Test-CanaryVerificationPending -Snapshot $snapshot);",
    "Set-SnapshotCanaryResult -Snapshot $snapshot -Canary $snapshot.canary;",
    "$failed=$snapshot.PSObject.Copy();$failed.canary=[pscustomobject]@{healthy=$false};",
    "$infraFault=$snapshot.PSObject.Copy();$infraFault.weflow=[pscustomobject]@{ready=$false};",
    "$value=[ordered]@{pendingBefore=$pendingBefore;snapshotHealthy=$snapshot.healthy;pendingAfter=(Test-CanaryVerificationPending -Snapshot $snapshot);completedFailurePending=(Test-CanaryVerificationPending -Snapshot $failed);infraFaultPending=(Test-CanaryVerificationPending -Snapshot $infraFault);globalConfirmations=$recovery.consecutiveFailures;canaryConfirmations=$recovery.canaryConsecutiveFailures};$value|ConvertTo-Json -Compress",
  ].join(" "), stateDir);

  assert.deepEqual(result, {
    pendingBefore: true,
    snapshotHealthy: false,
    pendingAfter: true,
    completedFailurePending: false,
    infraFaultPending: false,
    globalConfirmations: 1,
    canaryConfirmations: 2,
  });

  const source = fs.readFileSync(watchdogPath, "utf8");
  const mainStart = source.indexOf("$mutex = New-Object");
  const routineStart = source.indexOf("$queuePendingCount =", mainStart);
  const pendingBranch = source.indexOf("if (Test-CanaryVerificationPending -Snapshot $snapshot)", routineStart);
  const healthyBranch = source.indexOf("if ($snapshot.healthy)", pendingBranch);
  const confirmationMutation = source.indexOf("Update-WatchdogFailureObservation", pendingBranch);
  const budgetMutation = source.indexOf("$attemptAt =", pendingBranch);
  assert.ok(pendingBranch > mainStart);
  assert.ok(healthyBranch > pendingBranch, "unknown canary state must be handled before heartbeat healthy");
  assert.ok(confirmationMutation > pendingBranch);
  assert.ok(budgetMutation > confirmationMutation);
  assert.match(
    source.slice(pendingBranch, healthyBranch),
    /Save-Status -Snapshot \$snapshot -Action "verification_pending"[\s\S]+?exit 0/u,
  );
});

test("every sole deferred canary action leaves global failure confirmations unchanged", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const result = invokeLibrary([
    "$recovery=Read-RecoveryState;$recovery.canaryConsecutiveFailures=2;",
    "$decisions=[ordered]@{};",
    "foreach($action in $CanaryDeferredActions){$canary=[pscustomobject]@{action=$action};$decisions[$action]=(Test-CanaryDeferredOnly -Failed @('canary') -Canary $canary);if(-not $decisions[$action]){$recovery.consecutiveFailures++}};",
    "$twoRounds=[pscustomobject]@{action='budget_wait'};foreach($round in 1..2){if(-not (Test-CanaryDeferredOnly -Failed @('canary') -Canary $twoRounds)){$recovery.consecutiveFailures++}};",
    "$threshold=[ordered]@{};foreach($action in @('already_running','budget_wait')){$threshold[$action]=[ordered]@{deferred=(Test-CanaryDeferredOnly -Failed @('canary') -Canary ([pscustomobject]@{action=$action}));confirmations=$recovery.canaryConsecutiveFailures}};",
    "$value=[ordered]@{decisions=$decisions;afterAllDeferred=$recovery.consecutiveFailures;threshold=$threshold;mixed=(Test-CanaryDeferredOnly -Failed @('canary','weflow') -Canary $twoRounds);completed=(Test-CanaryDeferredOnly -Failed @('canary') -Canary ([pscustomobject]@{action='failed'}))};$value|ConvertTo-Json -Depth 5 -Compress",
  ].join(" "), stateDir);

  assert.deepEqual(Object.keys(result.decisions).sort(), [
    "already_running",
    "budget_wait",
    "deferred_busy",
    "demand_already_handled",
    "demand_blocked",
    "not_due",
    "obligation_wait",
    "target_changed_pending",
    "target_verification_budget_wait",
    "urgent_budget_wait",
    "waiting_retry",
  ]);
  assert.ok(Object.values(result.decisions).every(Boolean));
  assert.equal(result.afterAllDeferred, 0);
  assert.deepEqual(result.threshold, {
    already_running: { deferred: true, confirmations: 2 },
    budget_wait: { deferred: true, confirmations: 2 },
  });
  assert.equal(result.mixed, false);
  assert.equal(result.completed, false);

  const source = fs.readFileSync(watchdogPath, "utf8");
  assert.match(source, /\$canaryWaitingOnly = Test-CanaryDeferredOnly -Failed \$failed -Canary \$snapshot\.canary/u);
  const waitingBranch = source.indexOf("if ($canaryWaitingOnly)");
  const disposition = source.indexOf("$disposition = Get-WatchdogFailureDisposition", waitingBranch);
  assert.ok(waitingBranch > 0);
  assert.ok(disposition > waitingBranch);
  assert.match(
    source.slice(waitingBranch, disposition),
    /Save-Status -Snapshot \$snapshot -Action "canary_deferred"[\s\S]+?exit 0/u,
  );
});

test("reply obligation health is strict v1 and distinguishes fresh, overdue, terminal, deferred, and corrupt state", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const missingPath = path.join(stateDir, "missing-reply-obligations.json");
  const freshPath = path.join(stateDir, "fresh-reply-obligations.json");
  const overduePath = path.join(stateDir, "overdue-reply-obligations.json");
  const terminalPath = path.join(stateDir, "terminal-reply-obligations.json");
  const recoveredPath = path.join(stateDir, "recovered-reply-obligations.json");
  const unsupportedPath = path.join(stateDir, "unsupported-reply-obligations.json");
  const schemaPath = path.join(stateDir, "schema-reply-obligations.json");
  const invalidUtf8Path = path.join(stateDir, "invalid-utf8-reply-obligations.json");

  const verified = replyObligationEntry({
    idCharacter: "b",
    status: "verified",
    terminal: true,
    terminalOutcome: "verified",
    terminalAt: "2026-08-29T11:57:00.000Z",
  });
  const silent = replyObligationEntry({
    idCharacter: "c",
    status: "suppressed",
    terminal: true,
    terminalOutcome: "explicit_silent",
    terminalAt: "2026-08-29T11:58:00.000Z",
  });
  const deferred = replyObligationEntry({
    idCharacter: "d",
    status: "deferred",
    terminal: true,
    terminalOutcome: "deferred_durable",
    terminalAt: "2026-08-29T11:59:00.000Z",
  });
  const fresh = replyObligationEntry({ idCharacter: "a" });
  fs.writeFileSync(freshPath, JSON.stringify(replyObligationStore([
    fresh,
    verified,
    silent,
    deferred,
  ])), "utf8");
  fs.writeFileSync(overduePath, JSON.stringify(replyObligationStore([
    replyObligationEntry({
      idCharacter: "e",
      createdAt: "2026-08-29T11:40:00.000Z",
      deadlineAt: "2026-08-29T11:50:00.000Z",
    }),
  ])), "utf8");
  fs.writeFileSync(terminalPath, JSON.stringify(replyObligationStore([
    verified,
    silent,
    deferred,
    replyObligationEntry({
      idCharacter: "f",
      status: "timed_out",
      terminal: true,
      terminalOutcome: "no_reply_timeout",
      terminalAt: "2026-08-29T11:59:30.000Z",
      lastError: "reply obligation exceeded its no-reply deadline",
    }),
  ])), "utf8");
  fs.writeFileSync(recoveredPath, JSON.stringify(replyObligationStore([], {
    integrity: {
      status: "recovered_corrupt",
      recoveredAt: "2026-08-29T11:59:00.000Z",
      lastError: "invalid persisted JSON",
    },
  })), "utf8");
  fs.writeFileSync(unsupportedPath, JSON.stringify({
    ...replyObligationStore([]),
    version: 2,
  }), "utf8");
  fs.writeFileSync(schemaPath, JSON.stringify({
    ...replyObligationStore([]),
    obligations: {},
  }), "utf8");
  fs.writeFileSync(invalidUtf8Path, Buffer.from([0xff, 0xfe, 0xfd]));

  const result = invokeLibrary([
    "$now=[DateTimeOffset]::Parse('2026-08-29T12:00:00.000Z');",
    `$missing=Get-ReplyObligationHealth -Path ${psQuote(missingPath)} -Now $now;`,
    `$fresh=Get-ReplyObligationHealth -Path ${psQuote(freshPath)} -Now $now;`,
    `$overdue=Get-ReplyObligationHealth -Path ${psQuote(overduePath)} -Now $now;`,
    `$terminal=Get-ReplyObligationHealth -Path ${psQuote(terminalPath)} -Now $now;`,
    `$recovered=Get-ReplyObligationHealth -Path ${psQuote(recoveredPath)} -Now $now;`,
    `$unsupported=Get-ReplyObligationHealth -Path ${psQuote(unsupportedPath)} -Now $now;`,
    `$schema=Get-ReplyObligationHealth -Path ${psQuote(schemaPath)} -Now $now;`,
    `$invalidUtf8=Get-ReplyObligationHealth -Path ${psQuote(invalidUtf8Path)} -Now $now;`,
    "$value=[ordered]@{missing=$missing;fresh=$fresh;overdue=$overdue;terminal=$terminal;recovered=$recovered;unsupported=$unsupported;schema=$schema;invalidUtf8=$invalidUtf8};$value|ConvertTo-Json -Depth 6 -Compress",
  ].join(" "), stateDir);

  assert.equal(result.missing.healthy, true);
  assert.equal(result.missing.ready, false);
  assert.equal(result.missing.reason, "store_missing");

  assert.equal(result.fresh.healthy, true);
  assert.equal(result.fresh.ready, true);
  assert.equal(result.fresh.openCount, 1);
  assert.equal(result.fresh.pendingCount, 1);
  assert.equal(result.fresh.overdueCount, 0);
  assert.equal(result.fresh.verifiedCount, 1);
  assert.equal(result.fresh.suppressedCount, 1);
  assert.equal(result.fresh.deferredCount, 1);
  assert.equal(result.fresh.terminalFailureCount, 0);
  assert.equal(result.fresh.attentionRequiredCount, 1);
  assert.equal(result.fresh.oldestOpenAgeSeconds, 300);
  assert.match(result.fresh.oldestKey, /^reply-obligation:a{64}$/u);
  assert.equal(result.fresh.nextDeadlineAt, "2026-08-29T12:05:00.0000000+00:00");

  assert.equal(result.overdue.healthy, false);
  assert.equal(result.overdue.repairable, false);
  assert.equal(result.overdue.openCount, 1);
  assert.equal(result.overdue.overdueCount, 1);
  assert.equal(result.overdue.reason, "reply_obligation_overdue");

  assert.equal(result.terminal.healthy, true);
  assert.equal(result.terminal.repairable, false);
  assert.equal(result.terminal.openCount, 0);
  assert.equal(result.terminal.deferredCount, 1);
  assert.equal(result.terminal.terminalFailureCount, 1);
  assert.equal(result.terminal.attentionRequiredCount, 2);
  assert.equal(result.terminal.latestFailureOutcome, "no_reply_timeout");
  assert.equal(result.terminal.latestFailureError, "reply obligation exceeded its no-reply deadline");
  assert.equal(result.terminal.reason, "terminal_reply_failure_attention");

  assert.equal(result.recovered.healthy, false);
  assert.equal(result.recovered.ready, true);
  assert.equal(result.recovered.reason, "store_recovered_corrupt");
  for (const invalid of [result.unsupported, result.schema, result.invalidUtf8]) {
    assert.equal(invalid.healthy, false);
    assert.equal(invalid.ready, false);
    assert.equal(invalid.repairable, false);
    assert.equal(invalid.reason, "store_invalid");
  }
});

test("reply obligations participate in top health, idle gates, two-confirmation blocking, and mixed infrastructure repair", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const result = invokeLibrary([
    "$obligationFailure=[pscustomobject]@{healthy=$false;repairable=$false;openCount=0;overdueCount=0;terminalFailureCount=1;deferredCount=1;reason='terminal_reply_failure'};",
    "$obligationOpen=[pscustomobject]@{healthy=$true;repairable=$false;openCount=1;overdueCount=0;terminalFailureCount=0;deferredCount=0;reason=''};",
    "$obligationHealthy=[pscustomobject]@{healthy=$true;repairable=$false;openCount=0;overdueCount=0;terminalFailureCount=0;deferredCount=1;reason=''};",
    "$base=[pscustomobject]@{cyberboss=[pscustomobject]@{alive=$true};appServer=[pscustomobject]@{alive=$true;ready=$true};weflow=[pscustomobject]@{ready=$true};uiaBridge=[pscustomobject]@{ready=$true};weixin=[pscustomobject]@{alive=$true};sendSource='azzy';inboxQueue=[pscustomobject]@{healthy=$true;pendingCount=0;outgoingPoll=[pscustomobject]@{ready=$true;healthy=$true}};pendingInbound=[pscustomobject]@{healthy=$true;pendingCount=0};deferredReplies=[pscustomobject]@{healthy=$true;pendingCount=0};mainDelivery=[pscustomobject]@{healthy=$true};activity=[pscustomobject]@{ready=$true;healthy=$true;idle=$true;busy=$false;activeTurnCount=0;turnGateCount=0;activeDeliveryCount=0;pendingInboundCount=0;userIdleSeconds=600};desktopInput=[pscustomobject]@{ready=$true;idle=$true;desktopIdleSeconds=600}};",
    "$healthy=$base.PSObject.Copy();$healthy|Add-Member -NotePropertyName replyObligations -NotePropertyValue $obligationHealthy;",
    "$open=$base.PSObject.Copy();$open|Add-Member -NotePropertyName replyObligations -NotePropertyValue $obligationOpen;",
    "$failed=$base.PSObject.Copy();$failed|Add-Member -NotePropertyName replyObligations -NotePropertyValue $obligationFailure;",
    "$first=Get-WatchdogFailureDisposition -Failed @('replyObligations') -ConsecutiveFailures 1 -RequiredConfirmations 2;",
    "$second=Get-WatchdogFailureDisposition -Failed @('replyObligations') -ConsecutiveFailures 2 -RequiredConfirmations 2;",
    "$value=[ordered]@{healthyTop=(Test-SnapshotInfrastructureHealthy -Snapshot $healthy);failedTop=(Test-SnapshotInfrastructureHealthy -Snapshot $failed);ignoredTop=(Test-SnapshotInfrastructureHealthy -Snapshot $failed -IgnoreReplyObligations);healthyCanary=(Test-CanaryIdleGate -Snapshot $healthy);openCanary=(Test-CanaryIdleGate -Snapshot $open);openRepairIdle=(Test-PipelineRepairIdleGate -Snapshot $open);openBlockers=@(Get-CanaryIdleGateBlockers -Snapshot $open);first=$first.action;second=$second.action;soleBlocked=(Test-ReplyObligationFailureNonRestartable -Failed @('replyObligations') -ReplyObligations $obligationFailure);logicalOnlyBlocked=(Test-ReplyObligationFailureNonRestartable -Failed @('replyObligations','mainDelivery') -ReplyObligations $obligationFailure);mixedBlocked=(Test-ReplyObligationFailureNonRestartable -Failed @('replyObligations','weflow') -ReplyObligations $obligationFailure);mixedRepairMode=(Get-WatchdogRepairMode -Failed @('weflow'));pipelineMode=(Get-WatchdogRepairMode -Failed @('replyObligations','app-server'))};$value|ConvertTo-Json -Depth 5 -Compress",
  ].join(" "), stateDir);

  assert.deepEqual(result, {
    healthyTop: true,
    failedTop: false,
    ignoredTop: true,
    healthyCanary: true,
    openCanary: false,
    openRepairIdle: false,
    openBlockers: ["reply_obligations_pending"],
    first: "observing",
    second: "repair",
    soleBlocked: true,
    logicalOnlyBlocked: true,
    mixedBlocked: false,
    mixedRepairMode: "FullRestart",
    pipelineMode: "Restart",
  });

  const source = fs.readFileSync(watchdogPath, "utf8");
  assert.match(source, /\$replyObligations = Get-ReplyObligationHealth/u);
  assert.match(source, /-and \$replyObligations\.healthy/u);
  assert.match(source, /replyObligations = \$replyObligations/u);
  assert.match(source, /if \(-not \$Snapshot\.replyObligations\.healthy\) \{ \$failed \+= "replyObligations" \}/u);
  assert.match(source, /replyObligations=\$\(\$snapshot\.replyObligations\.openCount\)\/\$\(\$snapshot\.replyObligations\.overdueCount\)/u);
  assert.match(source, /Test-ReplyObligationFailureNonRestartable[\s\S]+?Save-Status -Snapshot \$snapshot -Action "pipeline_blocked"[\s\S]+?exit 2/u);
  assert.match(source, /\$repairableFailed = @\(\$failed \| Where-Object \{ \$_ -notin @\("mainDelivery", "replyObligations"\) \}\)/u);
  assert.match(source, /-IgnoreReplyObligations:\$ignoreReplyObligationsDuringRepair/u);
  assert.match(source, /logical delivery failure remains terminal/u);
});

test("WeFlow functional health rejects a successful health endpoint when the messages probe fails", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const result = invokeLibrary([
    "$global:messagesProbeHealthy=$false;",
    "function global:Invoke-JsonEndpoint { param([string]$Uri,[string]$Method='GET',[string]$Token='',[string]$Body='') if($Uri -match '/api/v1/health$'){return [pscustomobject]@{Ok=$true;Status=200;Body=[pscustomobject]@{status='ok'};Error=''}}; if($global:messagesProbeHealthy){return [pscustomobject]@{Ok=$true;Status=200;Body=[pscustomobject]@{messages=@()};Error=''}}; return [pscustomobject]@{Ok=$false;Status=500;Body=[pscustomobject]@{code=-105};Error='fixture messages failed'} };",
    "$broken=Get-WeFlowFunctionalHealth;",
    "$global:messagesProbeHealthy=$true;",
    "$healthy=Get-WeFlowFunctionalHealth;",
    "$value=[ordered]@{broken=$broken;healthy=$healthy;repairMode=(Get-WatchdogRepairMode -Failed @('weflow'))};$value|ConvertTo-Json -Depth 6 -Compress",
  ].join(" "), stateDir, {
    CYBERBOSS_ENABLE_WEFLOW_INBOX: "true",
    CYBERBOSS_WEFLOW_TOKEN: "fixture-token",
    CYBERBOSS_WEFLOW_INBOX_CHAT: "wxid_fixture_self",
    CYBERBOSS_WEFLOW_BASE_URL: "http://127.0.0.1:5031",
  });

  assert.equal(result.broken.healthReady, true);
  assert.equal(result.broken.healthStatus, 200);
  assert.equal(result.broken.messagesReady, false);
  assert.equal(result.broken.messagesStatus, 500);
  assert.equal(result.broken.ready, false);
  assert.equal(result.broken.reason, "messages_http_500");
  assert.equal(result.broken.error, "fixture messages failed");
  assert.equal(result.healthy.healthReady, true);
  assert.equal(result.healthy.messagesReady, true);
  assert.equal(result.healthy.ready, true);
  assert.equal(result.healthy.reason, "");
  assert.equal(result.repairMode, "FullRestart");
});

test("failure fingerprints reset on change or expiry and escalate Restart through FullRestart to a same-fault circuit", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const result = invokeLibrary([
    "$snapshot=[pscustomobject]@{appServer=[pscustomobject]@{alive=$false;ready=$false};weflow=[pscustomobject]@{reason='messages_http_500'}};",
    "$fingerprint=Get-WatchdogFailureFingerprint -Failed @('weflow','app-server','weflow') -Snapshot $snapshot;",
    "$observation=New-RecoveryState;",
    "$first=Update-WatchdogFailureObservation -RecoveryState $observation -Fingerprint 'fault-a' -Now ([DateTimeOffset]::Parse('2026-08-29T00:00:00Z')) -WindowMinutes 30;",
    "$second=Update-WatchdogFailureObservation -RecoveryState $observation -Fingerprint 'fault-a' -Now ([DateTimeOffset]::Parse('2026-08-29T00:10:00Z')) -WindowMinutes 30;",
    "$changed=Update-WatchdogFailureObservation -RecoveryState $observation -Fingerprint 'fault-b' -Now ([DateTimeOffset]::Parse('2026-08-29T00:20:00Z')) -WindowMinutes 30;",
    "$repeated=Update-WatchdogFailureObservation -RecoveryState $observation -Fingerprint 'fault-b' -Now ([DateTimeOffset]::Parse('2026-08-29T00:25:00Z')) -WindowMinutes 30;",
    "$expired=Update-WatchdogFailureObservation -RecoveryState $observation -Fingerprint 'fault-b' -Now ([DateTimeOffset]::Parse('2026-08-29T01:00:01Z')) -WindowMinutes 30;",
    "$planState=New-RecoveryState;$planState.lastRepairFailureFingerprint='fault-b';$planState.lastRepairAttemptAt='2026-08-29T01:00:00Z';$planState.lastRepairMode='Restart';$planState.lastRepairOutcome='repair_failed';",
    "$fullRestart=Get-WatchdogRepairPlan -Failed @('inboxQueue') -RecoveryState $planState -Fingerprint 'fault-b' -Now ([DateTimeOffset]::Parse('2026-08-29T02:00:00Z'));",
    "$planState.lastRepairMode='FullRestart';",
    "$circuit=Get-WatchdogRepairPlan -Failed @('inboxQueue') -RecoveryState $planState -Fingerprint 'fault-b' -Now ([DateTimeOffset]::Parse('2026-08-29T02:00:00Z'));",
    "$changedFault=Get-WatchdogRepairPlan -Failed @('inboxQueue') -RecoveryState $planState -Fingerprint 'fault-c' -Now ([DateTimeOffset]::Parse('2026-08-29T02:00:00Z'));",
    "$value=[ordered]@{fingerprint=$fingerprint;first=$first;second=$second;changed=$changed;repeated=$repeated;expired=$expired;finalFingerprint=$observation.failureFingerprint;finalCount=$observation.failureCount;legacyCount=$observation.consecutiveFailures;fullRestart=$fullRestart;circuit=$circuit;changedFault=$changedFault};$value|ConvertTo-Json -Depth 6 -Compress",
  ].join(" "), stateDir, {
    CYBERBOSS_WATCHDOG_SAME_FAULT_RETRY_HOURS: "6",
  });

  assert.equal(result.fingerprint, "app-server=alive=false,ready=false|weflow=messages_http_500");
  assert.deepEqual([
    result.first,
    result.second,
    result.changed,
    result.repeated,
    result.expired,
  ], [1, 2, 1, 2, 1]);
  assert.equal(result.finalFingerprint, "fault-b");
  assert.equal(result.finalCount, 1);
  assert.equal(result.legacyCount, 1);
  assert.equal(result.fullRestart.mode, "FullRestart");
  assert.equal(result.fullRestart.escalated, true);
  assert.equal(result.fullRestart.blocked, false);
  assert.equal(result.fullRestart.reason, "same_fault_restart_ineffective");
  assert.equal(result.circuit.blocked, true);
  assert.equal(result.circuit.reason, "same_fault_full_restart_ineffective");
  assert.equal(Date.parse(result.circuit.retryAt), Date.parse("2026-08-29T07:00:00Z"));
  assert.equal(result.changedFault.mode, "Restart");
  assert.equal(result.changedFault.escalated, false);
  assert.equal(result.changedFault.blocked, false);
  assert.equal(result.changedFault.reason, "base_policy");
});

test("narrow desktop and send-source repairs escalate instead of repeating the same ineffective action", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const result = invokeLibrary([
    "$now=[DateTimeOffset]::Parse('2026-08-29T02:00:00Z');",
    "$state=New-RecoveryState;$state.lastRepairFailureFingerprint='fault-a';$state.lastRepairAttemptAt='2026-08-29T01:00:00Z';$state.lastRepairOutcome='repair_failed';",
    "$state.lastRepairMode='StartWeixin';$weixin=Get-WatchdogRepairPlan -Failed @('weixin') -RecoveryState $state -Fingerprint 'fault-a' -PreferredMode 'StartWeixin' -Now $now;",
    "$state.lastRepairMode='ResetAzzySource';$source=Get-WatchdogRepairPlan -Failed @('send-source') -RecoveryState $state -Fingerprint 'fault-a' -PreferredMode 'ResetAzzySource' -Now $now;",
    "$state.lastRepairMode='StartWeixin';$state.lastRepairOutcome='waiting_for_login';$login=Get-WatchdogRepairPlan -Failed @('weixin') -RecoveryState $state -Fingerprint 'fault-a' -PreferredMode 'StartWeixin' -Now $now;",
    "$value=[ordered]@{weixin=$weixin;source=$source;login=$login};$value|ConvertTo-Json -Depth 5 -Compress",
  ].join(" "), stateDir);

  for (const plan of [result.weixin, result.source]) {
    assert.equal(plan.mode, "Restart");
    assert.equal(plan.escalated, true);
    assert.equal(plan.blocked, false);
    assert.equal(plan.reason, "same_fault_local_repair_ineffective");
  }
  assert.equal(result.login.blocked, true);
  assert.equal(result.login.reason, "weixin_login_required");
  assert.equal(Date.parse(result.login.retryAt), Date.parse("2026-08-29T07:00:00Z"));

  const source = fs.readFileSync(watchdogPath, "utf8");
  assert.match(source, /if \(\$repairMode -eq "StartWeixin"\)/u);
  assert.match(source, /if \(\$repairMode -eq "ResetAzzySource"\)/u);
});

test("recovery gate reports every active budget constraint and the latest retry deadline", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const result = invokeLibrary([
    "$now=[DateTimeOffset]::UtcNow;",
    "$dailyOldest=$now.AddHours(-23).AddMinutes(-55);$hourlyOldest=$now.AddMinutes(-50);$recent=$now.AddMinutes(-10);$last=$now.AddMinutes(-1);",
    "$state=New-RecoveryState;$state.repairAttempts=@($dailyOldest.ToString('o'),$hourlyOldest.ToString('o'),$recent.ToString('o'),$last.ToString('o'));$state.lastRepairAttemptAt=$last.ToString('o');",
    "$gate=Get-RecoveryGate -State $state;",
    "$value=[ordered]@{gate=$gate;dailyRetry=$dailyOldest.AddHours(24).ToString('o');hourlyRetry=$hourlyOldest.AddHours(1).ToString('o');cooldownRetry=$last.AddMinutes(15).ToString('o')};$value|ConvertTo-Json -Depth 6 -Compress",
  ].join(" "), stateDir);

  assert.equal(result.gate.allowed, false);
  assert.equal(result.gate.reason, "cooldown");
  assert.deepEqual([...result.gate.constraints].sort(), [
    "cooldown",
    "daily_budget",
    "hourly_budget",
  ]);
  assert.equal(result.gate.repairsLastHour, 3);
  assert.equal(result.gate.repairsLast24Hours, 4);
  assert.equal(Date.parse(result.gate.retryAt), Date.parse(result.cooldownRetry));
  assert.ok(Date.parse(result.gate.retryAt) > Date.parse(result.hourlyRetry));
  assert.ok(Date.parse(result.gate.retryAt) > Date.parse(result.dailyRetry));
});

test("the append-only repair journal merges over a valid primary recovery state", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const result = invokeLibrary([
    "$persisted=New-RecoveryState;$persisted.repairAttempts=@('2026-08-29T00:00:00Z');$persisted.lastRepairAttemptAt='2026-08-29T00:00:00Z';Save-RecoveryState -State $persisted;",
    "Add-RecoveryRepairAttemptJournal -AttemptAt '2026-08-29T01:00:00Z' -Fingerprint 'fault-a' -RepairMode 'Restart' -RepairIdentity 'repair-a';",
    "$merged=Read-RecoveryState;",
    "$value=[ordered]@{valid=$merged.recoveryStateValid;source=$merged.recoveryStateSource;attempts=@($merged.repairAttempts);lastRepairAttemptAt=$merged.lastRepairAttemptAt};$value|ConvertTo-Json -Depth 5 -Compress",
  ].join(" "), stateDir);

  assert.equal(result.valid, true);
  assert.equal(result.source, "primary+journal");
  assert.deepEqual(result.attempts.map(Date.parse), [
    Date.parse("2026-08-29T00:00:00Z"),
    Date.parse("2026-08-29T01:00:00Z"),
  ]);
  assert.equal(Date.parse(result.lastRepairAttemptAt), Date.parse("2026-08-29T01:00:00Z"));
});

test("the repair journal preserves budget and interrupted repair identity when JSON snapshots disappear", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const result = invokeLibrary([
    "Add-RecoveryRepairAttemptJournal -AttemptAt '2026-08-29T01:00:00Z' -Fingerprint 'fault-journal' -RepairMode 'FullRestart' -RepairIdentity 'repair-journal';",
    "$state=Read-RecoveryState;",
    "$value=[ordered]@{valid=$state.recoveryStateValid;source=$state.recoveryStateSource;attempts=@($state.repairAttempts);lastRepairAttemptAt=$state.lastRepairAttemptAt;fingerprint=$state.lastRepairFailureFingerprint;mode=$state.lastRepairMode;outcome=$state.lastRepairOutcome;identity=$state.currentRepairIdentity};$value|ConvertTo-Json -Depth 5 -Compress",
  ].join(" "), stateDir);

  assert.equal(result.valid, true);
  assert.equal(result.source, "journal");
  assert.deepEqual(result.attempts.map(Date.parse), [Date.parse("2026-08-29T01:00:00Z")]);
  assert.equal(Date.parse(result.lastRepairAttemptAt), Date.parse("2026-08-29T01:00:00Z"));
  assert.equal(result.fingerprint, "fault-journal");
  assert.equal(result.mode, "FullRestart");
  assert.equal(result.outcome, "started");
  assert.equal(result.identity, "repair-journal");
});

test("corrupt primary and backup recovery JSON with no journal fails the repair gate closed", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  fs.writeFileSync(path.join(stateDir, "cyberboss-watchdog-recovery.json"), "{", "utf8");
  fs.writeFileSync(path.join(stateDir, "cyberboss-watchdog-recovery.json.bak"), "not-json", "utf8");

  const result = invokeLibrary([
    "$state=Read-RecoveryState;$gate=Get-RecoveryGate -State $state;",
    "$value=[ordered]@{valid=$state.recoveryStateValid;source=$state.recoveryStateSource;error=$state.recoveryStateError;allowed=$gate.allowed;reason=$gate.reason;constraints=@($gate.constraints);retryAt=$gate.retryAt};$value|ConvertTo-Json -Depth 5 -Compress",
  ].join(" "), stateDir);

  assert.equal(result.valid, false);
  assert.equal(result.source, "invalid");
  assert.match(result.error, /cyberboss-watchdog-recovery\.json/u);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "recovery_state_invalid");
  assert.deepEqual(result.constraints, ["recovery_state_invalid"]);
  assert.equal(result.retryAt, "");
});

test("an old deferred reply remains healthy while surfacing operator attention", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const queuePath = path.join(stateDir, "deferred-system-replies-old.json");
  fs.writeFileSync(queuePath, JSON.stringify({
    replies: [{
      id: "deferred:old",
      createdAt: "2026-08-29T10:00:00.000Z",
      message: "fixture deferred reply",
    }],
  }), "utf8");

  const result = invokeLibrary([
    `$health=Get-DeferredReplyQueueHealth -Path ${psQuote(queuePath)} -StaleAfterSeconds 300 -Now ([DateTimeOffset]::Parse('2026-08-29T12:00:00Z'));`,
    "$health|ConvertTo-Json -Depth 5 -Compress",
  ].join(" "), stateDir);

  assert.equal(result.healthy, true);
  assert.equal(result.repairable, false);
  assert.equal(result.attentionRequired, true);
  assert.equal(result.pendingCount, 1);
  assert.equal(result.oldestAgeSeconds, 7_200);
  assert.equal(result.oldestKey, "deferred:old");
  assert.equal(result.reason, "waiting_for_inbound");
});

test("a parked old deferred reply does not deadlock infrastructure repair while fresh work still does", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const result = invokeLibrary([
    "$activity=[pscustomobject]@{ready=$true;healthy=$true;idle=$true;userIdleSeconds=$null};",
    "$inbox=[pscustomobject]@{pendingCount=0;healthy=$false;outgoingPoll=[pscustomobject]@{ready=$true}};",
    "$pending=[pscustomobject]@{pendingCount=0;healthy=$true};",
    "$oldDeferred=[pscustomobject]@{pendingCount=1;healthy=$true;attentionRequired=$true;reason='waiting_for_inbound'};",
    "$freshDeferred=[pscustomobject]@{pendingCount=1;healthy=$true;attentionRequired=$false;reason=''};",
    "$old=[pscustomobject]@{cyberboss=[pscustomobject]@{alive=$true};activity=$activity;inboxQueue=$inbox;pendingInbound=$pending;deferredReplies=$oldDeferred};",
    "$fresh=[pscustomobject]@{cyberboss=[pscustomobject]@{alive=$true};activity=$activity;inboxQueue=$inbox;pendingInbound=$pending;deferredReplies=$freshDeferred};",
    "$value=[ordered]@{old=(Test-PipelineRepairIdleGate -Snapshot $old);fresh=(Test-PipelineRepairIdleGate -Snapshot $fresh)};$value|ConvertTo-Json -Compress",
  ].join(" "), stateDir);

  assert.deepEqual(result, { old: true, fresh: false });
});

test("a completed negative post-repair canary closes verification and records one ineffective repair", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const result = invokeLibrary([
    "function global:Test-CanaryIdleGate { param($Snapshot) return $true };",
    "function global:Invoke-CanaryCheck { param([switch]$Force,[string]$Reason,[string]$DemandKey) return [pscustomobject]@{healthy=$false;status='failed';action='failed';attempted=$true;repairable=$true;runId='fixture-run';checkedAt='2026-08-29T02:00:00Z';triggerLocalId='';replyLocalId='';nextDueAt='';code='CANARY_FIXTURE_FAILURE';error='fixture failure';detail='fixture failure'} };",
    "function global:Update-RecoveryCanaryState { param($RecoveryState,$Canary) };",
    "function global:Get-HealthSnapshot { return [pscustomobject]@{checkedAt='2026-08-29T02:00:01Z';healthy=$true;canary=[pscustomobject]@{healthy=$null;action='never'}} };",
    "function global:Set-SnapshotCanaryResult { param($Snapshot,$Canary,[switch]$Deferred) $Snapshot.canary=$Canary;if($Canary.healthy -eq $false){$Snapshot.healthy=$false} };",
    "$state=New-RecoveryState;Set-WatchdogRepairStarted -RecoveryState $state -Fingerprint 'fault-a' -RepairMode 'Restart' -RepairIdentity 'repair-a';",
    "$snapshot=[pscustomobject]@{checkedAt='2026-08-29T02:00:00Z';healthy=$true;canary=[pscustomobject]@{healthy=$null;action='never'}};",
    "$result=Invoke-PostRepairCanaryVerification -Snapshot $snapshot -RecoveryState $state -RepairIdentity 'repair-a';",
    "Save-PostRepairCanaryFailure -Snapshot $result -RecoveryState $state -RepairMode 'Restart';",
    "$persisted=Read-RecoveryState;$status=Get-Content -LiteralPath $WatchdogStatus -Raw|ConvertFrom-Json;",
    "$value=[ordered]@{canaryAction=$result.canary.action;healthy=$result.healthy;pending=$persisted.pendingRepairVerification;outcome=$persisted.lastRepairOutcome;ineffective=$persisted.ineffectiveRepairCount;identity=$persisted.currentRepairIdentity;statusAction=$status.action};$value|ConvertTo-Json -Depth 5 -Compress",
  ].join(" "), stateDir);

  assert.equal(result.canaryAction, "repair_verification_failed");
  assert.equal(result.healthy, false);
  assert.equal(result.pending, false);
  assert.equal(result.outcome, "verification_failed");
  assert.equal(result.ineffective, 1);
  assert.equal(result.identity, "");
  assert.equal(result.statusAction, "repair_failed");
});

test("watchdog process health requires both a live PID and the expected command identity", {
  skip: process.platform !== "win32",
}, (t) => {
  const stateDir = tempDir(t);
  const result = invokeLibrary([
    `$pidValue=${process.pid};`,
    "$value=[ordered]@{alive=(Test-PidAlive -PidValue $pidValue);matching=(Test-VerifiedPidAlive -PidValue $pidValue -CommandPattern 'node');mismatch=(Test-VerifiedPidAlive -PidValue $pidValue -CommandPattern 'definitely-not-the-node-test-runner')};$value|ConvertTo-Json -Compress",
  ].join(" "), stateDir);
  assert.equal(result.alive, true);
  assert.equal(result.matching, true);
  assert.equal(result.mismatch, false);

  const source = fs.readFileSync(watchdogPath, "utf8");
  const healthFunction = source.slice(
    source.indexOf("function Get-HealthSnapshot"),
    source.indexOf("function Save-Status"),
  );
  assert.match(healthFunction, /Test-VerifiedPidAlive -PidValue \$bridgePid -CommandPattern \$BridgeCommandPattern/u);
  assert.match(healthFunction, /Test-VerifiedPidAlive -PidValue \$appServerPid -CommandPattern \$AppServerCommandPattern/u);
  assert.match(healthFunction, /Test-VerifiedPidAlive -PidValue \$uiaPid -CommandPattern \$UiaCommandPattern/u);
});
