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
 * A conversation snapshot: one row per conversation (so the verdict can find the
 * preview and `ensureConversation` can find another chat's row) and the composer,
 * whose LABEL is the peer's name - that is how the writer knows which chat is open.
 */
function snapshot({
  boxValue = "",
  rowLabel = `${CHAT}\n${TEXT}\n12:00`,
  label = CHAT,
  otherRow = "",
} = {}) {
  const elements = [element("ListItem", rowLabel, "", 10)];
  if (otherRow) {
    elements.push(element("ListItem", otherRow, "", 12));
  }
  elements.push(element("Edit", label, boxValue, 11));
  return { elements };
}

/**
 * A session whose foreground clicks and Returns are refused with `window_minimized`
 * until `restoreMinimized` succeeds - the production situation, with no desktop
 * involved. `openLabel` is which conversation the window currently shows.
 */
function fakeSession({ refuseReturns = 1 } = {}) {
  const calls = [];
  let minimized = true;
  let refusalsLeft = refuseReturns;
  let boxValue = "";
  let rowLabel = `${CHAT}\n${TEXT}\n12:00`;
  let openLabel = CHAT;
  let otherRow = "柳毓琳\nhi\n11:00";
  const session = {
    label: "test",
    calls,
    restoreCount: 0,
    raw() { return {}; },
    setComposer(value) { boxValue = value; },
    setRow(label) { rowLabel = label; },
    setOpenLabel(label) { openLabel = label; },
    isMinimized() { return minimized; },
    snapshot() {
      return snapshot({
        boxValue,
        rowLabel: openLabel === CHAT ? rowLabel : `${CHAT}\n${TEXT}\n12:00`,
        label: openLabel,
        otherRow,
      });
    },
    call(tool, args = {}) {
      calls.push({ tool, args });
      if (tool === "click") {
        if (minimized) {
          return {
            __failed: true,
            payload: { refusal: { code: "window_minimized", message: "window is minimized" } },
          };
        }
        openLabel = CHAT;
        return { effect: "confirmed" };
      }
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
        return session.snapshot();
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

test("a stranded draft of ours is delivered instead of refusing to type over it", () => {
  // Measured 2026-10-04: this exact state - a reply stranded in Azzy's composer and
  // shown as `[草稿]` in the conversation list - kept the channel mute for hours,
  // because the old guard treated it as "someone may be typing" and refused forever.
  const session = fakeSession();
  session.setComposer("这条是全尺寸 800×300 原图，不是缩略图");
  session.setRow("Azzy\n[草稿]\n这条是全尺寸 800×300 原图，不是缩略图\n11:53");
  const result = sendMessage(TARGET, CHAT, TEXT, { session, settleMs: 0 });

  const step = result.steps.find((entry) => entry.step === "send-stranded-draft");
  assert.ok(step, `expected send-stranded-draft, got ${JSON.stringify(result.steps.map((s) => s.step))}`);
  assert.equal(step.sent, true, "the draft has to leave the composer");
});

test("text that is NOT a saved draft is still never typed over", () => {
  const session = fakeSession();
  session.setComposer("operator typing something");
  const result = sendMessage(TARGET, CHAT, TEXT, { session, settleMs: 0 });
  assert.equal(result.ok, false);
  assert.match(result.verify, /already holds unsent text/);
  assert.ok(!result.steps.some((entry) => entry.step === "send-stranded-draft"),
    "unknown text must not be sent");
});

test("opening ANOTHER conversation also recovers a minimized window", () => {
  // Measured 2026-10-04: the operator deliberately keeps WeChat minimized, and every
  // caller that had not grown its own restore step failed here - the ack bench died
  // with `could not open …` before it could type a single message.
  const session = fakeSession();
  session.setComposer("");
  session.setOpenLabel("柳毓琳");
  const { ensureConversation } = require("../src/integrations/wechat-cua/client");

  const opened = ensureConversation(session, TARGET, CHAT, { settleMs: 0 });
  assert.equal(session.restoreCount, 1, "the window has to be restored once");
  assert.equal(opened.label, CHAT, "…and then the conversation really opens");
});
