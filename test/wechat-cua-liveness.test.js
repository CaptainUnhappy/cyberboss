#!/usr/bin/env node
/**
 * Offline tests for "the bot must not go quietly deaf".
 *
 * Measured 2026-10-01: the Cua daemon died while the bot was running, and because a
 * failed snapshot produced an empty element list, every poll looked like "a chat
 * list with no rows" - no error, no events, no output. The channel kept reporting
 * healthy while it could not hear a thing.
 *
 * Two rules come out of that, and both are pinned here:
 *   1. a failed snapshot is an error, never an empty chat list;
 *   2. after a few consecutive failures the channel tries to bring the daemon back,
 *      says so, and does not spam the log while doing it.
 *
 * Run: node test/wechat-cua-liveness.test.js
 */

const assert = require("assert");

const { readRows } = require("../src/integrations/wechat-cua/inbound");
const { WeChatCuaInboxSource } = require("../src/integrations/wechat-cua/inbox");
const { ensureDriverRunning, driverStatus, isDaemonDown } = require("../src/integrations/wechat-cua/daemon");
const { CuaSession } = require("../src/integrations/wechat-cua/client");

const TARGET = { pid: 1, window_id: 2 };
const DAEMON_DOWN = "Cua Driver daemon is not running on \\\\.\\pipe\\cua-driver.\n"
  + "Start it first with: cua-driver serve --socket \\\\.\\pipe\\cua-driver";

test_a_failed_snapshot_is_an_error_not_an_empty_chat_list();
test_recovery_runs_once_per_cooldown_and_reports_it();
test_a_failure_that_is_not_the_daemon_is_reported_without_restarting_it();
test_driver_status_reads_the_real_answer();
test_ensure_driver_running_prefers_the_registered_entry();
test_ensure_driver_running_falls_back_to_a_detached_serve();
console.log("all liveness tests passed");

function test_a_failed_snapshot_is_an_error_not_an_empty_chat_list() {
  const session = new CuaSession("test");
  session.snapshot = () => ({ __failed: true, payload: DAEMON_DOWN, exit: 1 });
  assert.throws(
    () => readRows(session, TARGET),
    /cua snapshot failed: Cua Driver daemon is not running/,
    "an unreadable chat list must not be indistinguishable from an empty one"
  );

  // And a snapshot that really is empty still reads as empty, not as an error.
  const empty = new CuaSession("test");
  empty.snapshot = () => ({ elements: [], element_count: 0 });
  assert.deepStrictEqual(readRows(empty, TARGET), []);
  console.log("ok   a failed snapshot throws instead of looking like an empty chat list");
}

function makeSource({ ensureDriver, logger = { warn() {}, error() {}, log() {} } } = {}) {
  const session = new CuaSession("test");
  session.snapshot = () => ({ __failed: true, payload: DAEMON_DOWN, exit: 1 });
  const source = new WeChatCuaInboxSource({
    config: { wechatCuaAllowPeers: "柳毓琳" },
    onMessage: async () => true,
    session,
    target: TARGET,
    ensureDriver,
    recoverAfterFailures: 2,
    recoveryCooldownMs: 60_000,
    logger,
  });
  return source;
}

async function test_recovery_runs_once_per_cooldown_and_reports_it() {
  const warnings = [];
  const errors = [];
  let recoveries = 0;
  const source = makeSource({
    ensureDriver: () => {
      recoveries += 1;
      return { wasRunning: false, started: true, how: "autostart-kick", detail: "started" };
    },
    logger: { warn: (m) => warnings.push(m), error: (m) => errors.push(m), log() {} },
  });
  // start() primes; the driver is down, so the priming poll already fails once.
  await source.start();
  assert.strictEqual(recoveries, 0, "one failure is not yet a pattern");
  await assert.rejects(() => source.pollOnce());
  assert.strictEqual(recoveries, 1, "the second consecutive failure starts recovery");
  assert.match(warnings.join("\n"), /started it again via autostart-kick/);
  assert.strictEqual(source.stats.consecutiveErrors, 2);

  // Further failures inside the cooldown must not restart the driver again.
  await assert.rejects(() => source.pollOnce());
  await assert.rejects(() => source.pollOnce());
  assert.strictEqual(recoveries, 1, "recovery is rate limited, not a restart loop");
  assert.strictEqual(errors.length, 0);
  source.stop();

  // A successful poll clears the streak, so the next outage is reported afresh.
  source.source.poll = () => [];
  await source.pollOnce();
  assert.strictEqual(source.stats.consecutiveErrors, 0);
  source.stop();
  console.log("ok   recovery runs at most once per cooldown and says what it did");
}

async function test_a_failure_that_is_not_the_daemon_is_reported_without_restarting_it() {
  const errors = [];
  let recoveries = 0;
  const session = new CuaSession("test");
  session.snapshot = () => ({ __failed: true, payload: { refusal: { code: "no_such_window", message: "no WeChat window" } } });
  const source = new WeChatCuaInboxSource({
    config: { wechatCuaAllowPeers: "柳毓琳" },
    onMessage: async () => true,
    session,
    target: TARGET,
    ensureDriver: () => { recoveries += 1; return { started: true, how: "test" }; },
    recoverAfterFailures: 1,
    recoveryCooldownMs: 0,
    logger: { warn() {}, error: (m) => errors.push(m), log() {} },
  });
  await source.start().catch(() => {});
  await assert.rejects(() => source.pollOnce());
  assert.strictEqual(recoveries, 0, "a missing window is not a dead daemon");
  assert.match(errors.join("\n"), /cannot read the chat list/);
  source.stop();
  console.log("ok   a non-daemon failure is reported loudly without restarting the driver");
}

function test_driver_status_reads_the_real_answer() {
  const up = driverStatus({ exec: () => "Cua Driver daemon is running\n  socket: \\\\.\\pipe\\cua-driver\n" });
  assert.strictEqual(up.running, true);
  const down = driverStatus({ exec: () => { throw Object.assign(new Error("exit 1"), { stderr: "Cua Driver daemon is not running\n" }); } });
  assert.strictEqual(down.running, false);
  assert.strictEqual(isDaemonDown(DAEMON_DOWN), true);
  assert.strictEqual(isDaemonDown("no WeChat window visible to the driver"), false);
  console.log("ok   driver status is read from the driver, not assumed");
}

function test_ensure_driver_running_prefers_the_registered_entry() {
  const calls = [];
  const statuses = ["Cua Driver daemon is not running\n", "Cua Driver daemon is not running\n", "Cua Driver daemon is running\n"];
  const outcome = ensureDriverRunning({
    exec: (driver, args) => {
      calls.push(args.join(" "));
      if (args[0] === "status") return statuses.shift() ?? "Cua Driver daemon is running\n";
      return "Started autostart entry 'cua-driver-serve' for the current session.\n";
    },
    spawnImpl: () => { throw new Error("must not spawn when the entry worked"); },
    sleep: () => {}, // the daemon needs a moment to listen; the probe must not care
  });
  assert.deepStrictEqual(calls, ["status", "autostart kick", "status", "status"]);
  assert.strictEqual(outcome.started, true);
  assert.strictEqual(outcome.how, "autostart-kick");
  console.log("ok   a dead daemon is restarted through its own autostart entry");
}

function test_ensure_driver_running_falls_back_to_a_detached_serve() {
  const spawned = [];
  const outcome = ensureDriverRunning({
    exec: (driver, args) => {
      if (args[0] === "status") throw Object.assign(new Error("exit 1"), { stderr: "not running" });
      throw Object.assign(new Error("exit 1"), { stderr: "no such task" });
    },
    spawnImpl: (driver, args) => {
      spawned.push(args.join(" "));
      return { unref() {} };
    },
    sleep: () => {},
    settleMs: 0,
  });
  assert.deepStrictEqual(spawned, ["serve"]);
  assert.strictEqual(outcome.started, true);
  assert.strictEqual(outcome.how, "serve-detached");
  console.log("ok   when the entry is unusable the driver is started detached instead");

  // A running daemon is never touched.
  const quiet = ensureDriverRunning({
    exec: () => "Cua Driver daemon is running\n",
    spawnImpl: () => { throw new Error("must not spawn when the daemon is up"); },
    sleep: () => {},
  });
  assert.strictEqual(quiet.wasRunning, true);
}
