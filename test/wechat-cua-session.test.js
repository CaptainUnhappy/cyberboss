#!/usr/bin/env node
/**
 * Offline tests for driver-session lifecycle handling.
 *
 * Why this file exists: a Cua session is not a permanent handle. It can end
 * (explicit `end_session`, a daemon restart, a dropped transport lease), and from
 * then on every call for that label is refused with a sentence on **stderr**:
 *
 *   session has ended; tool call 'list_windows' was rejected. Call start_session
 *   with session '<label>' to start it again, or use a new session label.
 *
 * The bot holds long-lived sessions (the inbox polls for hours, the outbound
 * client keeps one per send), so a session that ends must not turn into a bot
 * that silently stops answering. These tests pin the two halves of the fix:
 * the refusal is *legible*, and it is *healed* - exactly once.
 *
 * The process seam (`CuaSession`'s `exec`) is injected, so this suite never runs
 * the real driver: it reproduces the exact contract measured against 0.31.0 -
 * exit code 1, empty stdout, the sentence on stderr.
 *
 * Run: node test/wechat-cua-session.test.js
 */

const assert = require("assert");

const { CuaSession, outcome, isSessionEnded, isDriverUnavailable } = require("../src/integrations/wechat-cua/client");

const ENDED = (tool, label) =>
  `session has ended; tool call '${tool}' was rejected. Call start_session with session '${label}' to start it again, or use a new session label.`;

/** The transport complaint, measured while the daemon was alive and serving others. */
const DRIVER_DOWN = "Cua Driver daemon is not running on \\\\.\\pipe\\cua-driver.\n"
  + "Start it first with: cua-driver serve --socket \\\\.\\pipe\\cua-driver\n";

/** Node's child-process failure shape, as measured from the real driver. */
function childError({ stdout = "", stderr = "", status = 1 }) {
  const error = new Error(`Command failed with exit code ${status}`);
  error.stdout = stdout;
  error.stderr = stderr;
  error.status = status;
  return error;
}

/**
 * A scripted process seam. `script` answers one `cua-driver call` each, in order,
 * and records the argv plus the parsed stdin so tests can assert on the real wire
 * shape (`call <tool>` + `{...args, session}`).
 */
function scriptedExec(script) {
  const seen = [];
  const exec = (driver, args, input) => {
    seen.push({ driver, args, body: JSON.parse(input) });
    const next = script.shift();
    if (!next) throw new Error(`unexpected driver call: ${args.join(" ")}`);
    assert.strictEqual(args[0], "call");
    assert.strictEqual(args[1], next.tool, `expected ${next.tool}, got ${args[1]}`);
    if (next.fail) throw childError(next.fail);
    return JSON.stringify(next.reply);
  };
  return { exec, seen };
}

const windows = (titles) => ({ windows: titles.map((title, i) => ({ pid: 100 + i, window_id: 900 + i, title })) });

test_a_live_session_is_not_touched();
test_a_dead_session_is_revived_and_the_call_retried_once();
test_a_session_that_ends_again_is_not_retried_forever();
test_other_refusals_are_not_mistaken_for_a_dead_session();
test_start_session_itself_never_recurses();
test_the_refusal_is_legible_in_the_outcome();
test_a_transport_failure_is_retried_once_and_not_blamed_on_the_session();

function test_a_transport_failure_is_retried_once_and_not_blamed_on_the_session() {
  // Seen repeatedly on 2026-10-01 while two `cua-driver call` processes raced for
  // the pipe: the daemon was alive and answering the other caller the whole time.
  // The request never reached it, so one retry is free - and it is NOT a dead
  // session, so it must not consume a revival.
  const { exec, seen } = scriptedExec([
    { tool: "list_windows", fail: { stderr: DRIVER_DOWN, status: 1 } },
    { tool: "list_windows", reply: windows(["微信"]) },
  ]);
  const session = new CuaSession("inbox", { exec });
  const res = session.call("list_windows", { on_screen_only: false });
  assert.strictEqual(isDriverUnavailable({ __failed: true, payload: DRIVER_DOWN }), true);
  assert.strictEqual(res.windows.length, 1, "the retry must return the real answer");
  assert.strictEqual(session.revivals, 0, "a transport failure is not a dead session");
  assert.deepStrictEqual(seen.map((s) => s.args[1]), ["list_windows", "list_windows"]);

  // And it is bounded: a driver that stays unreachable is reported, not hammered.
  const stuck = scriptedExec([
    { tool: "list_windows", fail: { stderr: DRIVER_DOWN } },
    { tool: "list_windows", fail: { stderr: DRIVER_DOWN } },
  ]);
  const stuckSession = new CuaSession("inbox", { exec: stuck.exec });
  const failed = stuckSession.call("list_windows", {});
  assert.strictEqual(failed.__failed, true);
  assert.deepStrictEqual(stuck.seen.map((s) => s.args[1]), ["list_windows", "list_windows"], "exactly one retry");
  console.log("ok   a transport failure is retried exactly once and does not count as a dead session");
}

function test_a_live_session_is_not_touched() {
  const { exec, seen } = scriptedExec([{ tool: "list_windows", reply: windows(["微信"]) }]);
  const session = new CuaSession("inbox", { exec });
  const res = session.call("list_windows", { on_screen_only: false });
  assert.strictEqual(res.windows.length, 1);
  assert.strictEqual(session.revivals, 0, "a live session must not be revived");
  assert.deepStrictEqual(seen.map((s) => s.args[1]), ["list_windows"]);
  assert.strictEqual(seen[0].body.session, "inbox", "every call must carry the session label");
  assert.strictEqual(seen[0].body.on_screen_only, false, "arguments must survive the seam unchanged");
  console.log("ok   a live session costs no revive and no extra call");
}

function test_a_dead_session_is_revived_and_the_call_retried_once() {
  const { exec, seen } = scriptedExec([
    { tool: "list_windows", fail: { stderr: `${ENDED("list_windows", "inbox")}\n`, status: 1 } },
    { tool: "start_session", reply: { active: true, session: "inbox", revived: true } },
    { tool: "list_windows", reply: windows(["微信"]) },
  ]);
  const session = new CuaSession("inbox", { exec });
  const res = session.call("list_windows", { on_screen_only: false });
  assert.strictEqual(res.windows.length, 1, "the retried call must return the real answer");
  assert.strictEqual(session.revivals, 1);
  assert.strictEqual(session.revived, true, "the driver distinguishes a revive from a create; keep it");
  assert.deepStrictEqual(
    seen.map((s) => s.args[1]),
    ["list_windows", "start_session", "list_windows"],
    "the order must be: failed call, revive, the same call again"
  );
  assert.deepStrictEqual(seen[2].body, seen[0].body, "the retry must repeat the original arguments verbatim");
  console.log("ok   an ended session is revived and the refused call is retried exactly once");
}

function test_a_session_that_ends_again_is_not_retried_forever() {
  const { exec, seen } = scriptedExec([
    { tool: "type_text", fail: { stderr: ENDED("type_text", "out") } },
    { tool: "start_session", reply: { active: true, session: "out", revived: true } },
    { tool: "type_text", fail: { stderr: ENDED("type_text", "out") } },
  ]);
  const session = new CuaSession("out", { exec });
  const res = session.call("type_text", { text: "hello" });
  assert.strictEqual(res.__failed, true);
  assert.strictEqual(isSessionEnded(res), true);
  assert.deepStrictEqual(seen.map((s) => s.args[1]), ["type_text", "start_session", "type_text"]);
  console.log("ok   a retry that ends again gives up instead of looping");
}

function test_other_refusals_are_not_mistaken_for_a_dead_session() {
  const refusal = {
    __failed: true,
    payload: { refusal: { code: "invalid_arguments", message: "type_text: unknown argument bounds" } },
  };
  assert.strictEqual(isSessionEnded(refusal), false, "a bad argument is not a dead session");

  const { exec, seen } = scriptedExec([
    { tool: "type_text", fail: { stdout: JSON.stringify({ refusal: { code: "invalid_arguments", message: "unknown argument bounds" } }) } },
  ]);
  const session = new CuaSession("out", { exec });
  const res = session.call("type_text", { bounds: { x: 1 } });
  assert.strictEqual(session.revivals, 0, "nothing to heal: the call itself was wrong");
  assert.strictEqual(res.payload.refusal.code, "invalid_arguments");
  assert.deepStrictEqual(seen.map((s) => s.args[1]), ["type_text"], "a rejected argument set must not be retried");
  console.log("ok   a bad call is reported, not blamed on the session");
}

function test_start_session_itself_never_recurses() {
  const { exec, seen } = scriptedExec([
    { tool: "start_session", fail: { stderr: ENDED("start_session", "inbox") } },
  ]);
  const session = new CuaSession("inbox", { exec });
  const res = session.call("start_session", {});
  assert.strictEqual(res.__failed, true);
  assert.deepStrictEqual(seen.map((s) => s.args[1]), ["start_session"], "reviving must not itself try to revive");
  console.log("ok   start_session cannot recurse into itself");
}

function test_the_refusal_is_legible_in_the_outcome() {
  const { exec } = scriptedExec([
    { tool: "list_windows", fail: { stderr: `${ENDED("list_windows", "inbox")}\n` } },
    { tool: "start_session", reply: { active: true, session: "inbox", revived: true } },
    { tool: "list_windows", fail: { stderr: `${ENDED("list_windows", "inbox")}\n` } },
  ]);
  const session = new CuaSession("inbox", { exec });
  const report = outcome(session.call("list_windows", {}));
  assert.strictEqual(report.failed, true);
  assert.strictEqual(report.reason, "session-ended", "the reason must name the actual failure");
  assert.match(report.detail, /session has ended/, "the driver's own sentence must survive into the log");
  assert.strictEqual(report.exit, 1, "the exit code is part of the evidence");
  console.log("ok   a stderr-only refusal is reported with its own words, not as an empty 'refused'");
}
