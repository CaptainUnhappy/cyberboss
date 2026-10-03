#!/usr/bin/env node
/**
 * The session-lifecycle refusal must actually be recognised.
 *
 * Measured 2026-10-03 on production: the driver refuses an idle session with
 *
 *   session 'cyberboss-out-6780' has ended; call start_session with session
 *   'cyberboss-out-6780' to start it again, or use a new session label
 *
 * and the matcher only knew the older prose ("session has ended"), so `revive()`
 * never ran and every send failed until the process was restarted.
 *
 * Run: node --test test/cua-session-revive.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { CuaSession } = require("../src/integrations/wechat-cua/client");

/** The driver's refusal as it arrives: JSON on stderr, exit code 1. */
function refusalError(code, message) {
  const error = new Error("Command failed: cua-driver call list_windows");
  error.stdout = "";
  error.stderr = JSON.stringify({ refusal: { code, message }, status: "refused" });
  error.status = 1;
  return error;
}

function scriptedExec(sequence) {
  const calls = [];
  const exec = (driver, args, input) => {
    const tool = args[args.length - 1];
    const payload = JSON.parse(input);
    calls.push({ tool, session: payload.session });
    const next = sequence.shift();
    if (!next) return JSON.stringify({ windows: [] });
    if (next instanceof Error) throw next;
    return JSON.stringify(next);
  };
  exec.calls = calls;
  return exec;
}

test("the current build's wording triggers a revive and a retry", () => {
  const exec = scriptedExec([
    refusalError("session_ended", "session 'cyberboss-out-1' has ended; call start_session with session 'cyberboss-out-1' to start it again, or use a new session label"),
    { revived: true, session: "cyberboss-out-1" },
    { windows: [{ pid: 1, window_id: 2, title: "微信" }] },
  ]);
  const session = new CuaSession("cyberboss-out-1", { exec });
  const res = session.call("list_windows", { on_screen_only: false });
  assert.equal(res.__failed, undefined, "the retry must return the real answer");
  assert.equal(res.windows.length, 1);
  assert.equal(session.revivals, 1);
  assert.deepEqual(exec.calls.map((call) => call.tool), ["list_windows", "start_session", "list_windows"]);
});

test("the older wording still works", () => {
  const exec = scriptedExec([
    refusalError("refused", "session has ended; tool call 'list_windows' was rejected. Call start_session with session 'l' to start it again"),
    { revived: true },
    { windows: [] },
  ]);
  const session = new CuaSession("l", { exec });
  session.call("list_windows", {});
  assert.equal(session.revivals, 1);
});

test("a bare refusal code is enough, even with no prose", () => {
  const exec = scriptedExec([
    refusalError("session_ended", ""),
    { revived: true },
    { windows: [] },
  ]);
  const session = new CuaSession("l", { exec });
  session.call("list_windows", {});
  assert.equal(session.revivals, 1);
});

test("an unrelated refusal is passed through, not retried", () => {
  const exec = scriptedExec([
    refusalError("window_not_found", "no window with window_id 123"),
    { windows: [] },
  ]);
  const session = new CuaSession("l", { exec });
  const res = session.call("list_windows", {});
  assert.equal(res.__failed, true);
  assert.equal(session.revivals, 0);
  assert.equal(exec.calls.length, 1, "a genuine refusal must not be retried");
});
