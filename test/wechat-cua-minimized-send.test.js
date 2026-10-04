#!/usr/bin/env node
/**
 * A minimized window must not strand a reply in the composer.
 *
 * Measured 2026-10-04 in production: a reply was typed into Azzy's chat, the Return
 * was refused with `window_minimized` (WeChat sat in the taskbar), and the text
 * stayed in the box as a WeChat DRAFT. The operator saw no answer for hours, and
 * every later send to that chat refused to type over the leftover - the channel went
 * mute for that person.
 *
 * The typing step has always restored a minimized window the quiet way
 * (SW_SHOWNOACTIVATE, no foreground change). The delivery step did not. These tests
 * drive the real `sendMessage` with an injected session, so they assert the ladder
 * itself.
 *
 * Run: node --test test/wechat-cua-minimized-send.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { sendMessage } = require("../src/integrations/wechat-cua/client");

const TARGET = { pid: 4321, window_id: 99 };
const CHAT = "Azzy";
const TEXT = "hello there";

function element(role, label, value = "", token = 1) {
  return { role, label, value, element_token: token, frame: { x: 0, y: 0, w: 400, h: 30 } };
}

/**
 * A conversation snapshot: one row (so the verdict can find the preview) and the
 * composer, whose LABEL is the peer's name - that is how the writer knows which
 * conversation is open.
 */
function snapshot({ boxValue = "", rowLabel = `${CHAT}\n${TEXT}\n12:00` } = {}) {
  return {
    elements: [
      element("ListItem", rowLabel, "", 10),
      element("Edit", CHAT, boxValue, 11),
    ],
  };
}

/**
 * A session whose Return is refused with `window_minimized` until `restoreMinimized`
 * succeeds - the production situation, with no desktop involved.
 */
function fakeSession({ refuseReturns = 1 } = {}) {
  const calls = [];
  let minimized = true;
  let refusalsLeft = refuseReturns;
  let boxValue = "";
  const session = {
    label: "test",
    calls,
    restoreCount: 0,
    raw() { return {}; },
    snapshot() {
      return snapshot({ boxValue });
    },
    call(tool, args = {}) {
      calls.push({ tool, args });
      if (tool === "type_text" && args.text === "\n") {
        if (minimized && refusalsLeft > 0) {
          refusalsLeft -= 1;
          return {
            __failed: true,
            payload: {
              refusal: {
                code: "window_minimized",
                message: "window 0x63 is minimized, so a foreground click would be posted off-screen",
              },
            },
          };
        }
        boxValue = "";
        return { effect: "confirmed" };
      }
      if (tool === "type_text") {
        boxValue = args.text;
        return { effect: "confirmed" };
      }
      if (tool === "set_value") {
        boxValue = String(args.value ?? "");
        return { effect: "confirmed" };
      }
      if (tool === "get_window_state") {
        return snapshot({ boxValue });
      }
      if (tool === "click") {
        return { effect: "confirmed" };
      }
      return { effect: "confirmed" };
    },
    restoreMinimized(pid) {
      session.restoreCount += 1;
      assert.equal(pid, TARGET.pid);
      minimized = false;
      return { ok: true };
    },
  };
  return session;
}

test("a Return refused because the window is minimized is retried after a quiet restore", () => {
  const session = fakeSession({ refuseReturns: 1 });
  const result = sendMessage(TARGET, CHAT, TEXT, { session, settleMs: 0 });

  assert.equal(session.restoreCount, 1, "the window has to be restored exactly once");
  assert.ok(result.steps.some((step) => step.step === "unminimize-send"),
    `expected an unminimize-send step, got ${JSON.stringify(result.steps.map((s) => s.step))}`);
  assert.equal(result.certainNotSent, false, "the reply went out, so it must not be reported as unsent");
});

test("a restore that cannot happen still refuses to claim the message was sent", () => {
  const session = fakeSession({ refuseReturns: 99 });
  session.restoreMinimized = (pid) => {
    session.restoreCount += 1;
    assert.equal(pid, TARGET.pid);
    return { ok: false, error: "no window handle" };
  };
  const result = sendMessage(TARGET, CHAT, TEXT, { session, settleMs: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.certainNotSent, true,
    "the text is still in the composer, and the caller needs that proof to retry instead of dropping the reply");
  assert.ok(result.steps.some((step) => step.step === "unminimize-send" && step.outcome.failed === true));
});
