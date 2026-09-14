const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// The shared Codex app-server is started only by the codex runtime. Every
// watchdog prerequisite that demands `appServer.ready` therefore has to be
// runtime-aware: under dsh the app-server is absent by design, and a
// permanently unsatisfiable gate parks the transport canary (and behind it the
// model canary) forever, so `healthy` can never become true again.
const projectRoot = path.resolve(__dirname, "..");
const watchdogPath = path.join(projectRoot, "scripts", "cyberboss-watchdog.ps1");

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function tempDir(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-watchdog-runtime-"));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

function invokeLibrary(command, { stateDir, runtime }) {
  const source = [
    "$ErrorActionPreference='Stop'",
    "$env:CYBERBOSS_WATCHDOG_LIBRARY_ONLY='1'",
    `$env:CYBERBOSS_STATE_DIR=${psQuote(stateDir)}`,
    `$env:CYBERBOSS_RUNTIME=${psQuote(runtime)}`,
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
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

// A stack whose only fault is the intentionally absent shared app-server.
function healthySnapshotWithoutAppServer(overrides = {}) {
  return {
    cyberboss: { pid: 4184, alive: true, identityVerified: true },
    appServer: { pid: 0, alive: false, processAlive: false, identityVerified: false, ready: false },
    weflow: { ready: true, healthReady: true, messagesReady: true },
    uiaBridge: { pid: 30532, alive: true, identityVerified: true, health: true, ready: true },
    weixin: { alive: true },
    sendSource: "azzy",
    inboxQueue: {
      healthy: true,
      pendingCount: 0,
      cursorPresent: true,
      outgoingPoll: { ready: true, healthy: true, lagSeconds: 0, cursorAgeSeconds: 0, staleAfterSeconds: 30 },
    },
    pendingInbound: { healthy: true, pendingCount: 0, queuePresent: true },
    deferredReplies: { healthy: true, pendingCount: 0, queuePresent: true },
    replyObligations: { healthy: true, ready: true, openCount: 0, pendingCount: 0 },
    mainDelivery: { healthy: true, ready: true },
    activity: {
      ready: true,
      healthy: true,
      idle: true,
      busy: false,
      activeTurnCount: 0,
      turnGateCount: 0,
      activeDeliveryCount: 0,
      pendingInboundCount: 0,
      userIdleSeconds: 9000,
    },
    desktopInput: { ready: true, idle: true, desktopIdleSeconds: 9000 },
    canary: { healthy: true, status: "verified", action: "verified" },
    transportE2E: { healthy: true, status: "verified", action: "verified" },
    ...overrides,
  };
}

// PowerShell 5.1 renders an empty array property as `{}` and unrolls a single
// element, so every probe below projects its result to an unambiguous scalar.
function evaluate(command, { runtime, overrides = {} }) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-watchdog-runtime-state-"));
  try {
    const payload = JSON.stringify(healthySnapshotWithoutAppServer(overrides));
    const script = [
      `$snapshot = ${psQuote(payload)} | ConvertFrom-Json`,
      command,
    ].join("; ");
    return invokeLibrary(script, { stateDir, runtime });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

function evaluateFlag(expression, options) {
  const raw = evaluate(`$value = ${expression}; Write-Output "FLAG=$value"`, options);
  const match = /FLAG=(True|False)/iu.exec(raw);
  assert.ok(match, `expected a boolean flag, received ${JSON.stringify(raw)}`);
  return match[1].toLowerCase() === "true";
}

function evaluateBlockers(options) {
  const raw = evaluate(
    "$items = @(Get-CanaryIdleGateBlockers -Snapshot $snapshot); Write-Output \"ITEMS=$($items.Count):$($items -join ',')\"",
    options,
  );
  const match = /ITEMS=(\d+):(.*)$/u.exec(raw.trim());
  assert.ok(match, `expected a blocker list, received ${JSON.stringify(raw)}`);
  return match[2] ? match[2].split(",") : [];
}

test("the canary prerequisite drops the app-server requirement only for non-codex runtimes", () => {
  assert.equal(
    evaluateFlag("Test-CanaryPrerequisites -Snapshot $snapshot", { runtime: "dsh" }),
    true,
    "a dsh stack must not be blocked by the intentionally absent codex app-server",
  );
  assert.equal(
    evaluateFlag("Test-CanaryPrerequisites -Snapshot $snapshot", { runtime: "codex" }),
    false,
    "the codex runtime still requires a ready app-server",
  );
});

test("the infrastructure predicate drops the app-server requirement only for non-codex runtimes", () => {
  assert.equal(
    evaluateFlag("Test-SnapshotInfrastructureHealthy -Snapshot $snapshot", { runtime: "dsh" }),
    true,
  );
  assert.equal(
    evaluateFlag("Test-SnapshotInfrastructureHealthy -Snapshot $snapshot", { runtime: "codex" }),
    false,
  );
});

test("the UIA-waiting predicate drops the app-server requirement only for non-codex runtimes", () => {
  const overrides = { uiaBridge: { pid: 30532, alive: true, health: true, ready: false } };
  assert.equal(
    evaluateFlag("Test-UiAWaitingForWeixinSnapshot -Snapshot $snapshot", { runtime: "dsh", overrides }),
    true,
  );
  assert.equal(
    evaluateFlag("Test-UiAWaitingForWeixinSnapshot -Snapshot $snapshot", { runtime: "codex", overrides }),
    false,
  );
});

test("the canary idle-gate blocker detail reports app_server_unavailable only when it is required", () => {
  assert.deepEqual(
    evaluateBlockers({ runtime: "dsh" }),
    [],
    "a dsh stack must report no idle-gate blockers",
  );
  assert.ok(
    evaluateBlockers({ runtime: "codex" }).includes("app_server_unavailable"),
    "the codex runtime must still report the absent app-server",
  );
});

test("a held turn gate is not excused by the absent app-server under a non-codex runtime", () => {
  // turnGateCount>0 with no active turn/delivery/pending work is the stranded-gate
  // shape. Under codex a dead app-server explains it; under dsh the app-server is
  // absent by design, so the gate must still read as busy rather than as idle.
  const overrides = {
    activity: {
      ready: true,
      healthy: true,
      idle: false,
      busy: true,
      activeTurnCount: 0,
      turnGateCount: 1,
      activeDeliveryCount: 0,
      pendingInboundCount: 0,
      userIdleSeconds: 9000,
    },
  };
  assert.equal(
    evaluateFlag("Test-PipelineRepairIdleGate -Snapshot $snapshot", { runtime: "codex", overrides }),
    true,
    "under codex a dead app-server still explains a stranded gate",
  );
  assert.equal(
    evaluateFlag("Test-PipelineRepairIdleGate -Snapshot $snapshot", { runtime: "dsh", overrides }),
    false,
    "under dsh the absent app-server must not excuse a genuinely held gate",
  );
});

test("a healthy idle dsh stack keeps the pipeline repair gate open", () => {
  assert.equal(
    evaluateFlag("Test-PipelineRepairIdleGate -Snapshot $snapshot", { runtime: "dsh" }),
    true,
  );
});

/**
 * The snapshot's own `healthy` aggregate drives the scheduler's top-level
 * outcome. It has to agree with Get-WatchdogFailedComponents, which is
 * runtime-aware: while it demanded a live shared app-server unconditionally, a
 * non-codex stack could never be healthy AND no component was ever attributed,
 * so the scheduler fell through to "snapshot is unhealthy but no restartable
 * component was attributed" and reported pipeline_blocked forever.
 */
test("the top-level healthy aggregate never demands an absent app-server", () => {
  const source = fs.readFileSync(watchdogPath, "utf8");
  const aggregate = /\$healthy = \$bridgeAlive[\s\S]*?\r?\n\r?\n/u.exec(source);
  assert.ok(aggregate, "the healthy aggregate must still be where this test expects it");

  // The aggregate tests the shared app-server twice: its process and its readyz
  // probe. Both have to be runtime-guarded, and finding only one of them is how
  // this stayed broken - `$appReady` is the app-server's readyz, not the UIAs.
  for (const term of ["appServerAlive", "appReady\\.Ok"]) {
    assert.match(
      aggregate[0],
      new RegExp(`-and \\(-not \\$AppServerRequired -or \\$${term}\\)`, "u"),
      `the ${term} term must be guarded by the runtime switch`,
    );
    assert.doesNotMatch(
      aggregate[0],
      new RegExp(`-and \\$${term}(?!\\))`, "u"),
      `an unguarded ${term} term makes healthy=true impossible off codex`,
    );
  }
  // The guard must not remove the codex-path probes, only make them conditional.
  assert.match(aggregate[0], /-and \$uiaProcess\.Ok/u);
  assert.match(aggregate[0], /-and \$uiaReady\.Ok/u);

  // Every other app-server prerequisite in this script must consult the switch.
  const guardUsers = [...source.matchAll(/-and \$Snapshot\.appServer\.ready/gu)];
  assert.equal(
    guardUsers.length,
    0,
    "every snapshot-level app-server prerequisite must be runtime-guarded",
  );
});
