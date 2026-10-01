#!/usr/bin/env node
/**
 * Offline tests for the Cua WeChat driver.
 *
 * The interesting behaviour is not "does it call the driver" but *which rung of
 * the ladder it uses and whether it believes a lie*. Cua's responses distinguish
 * delivery from effect (`effect`, `verified`, `refusal.code`), and this client
 * has to keep that distinction: a rung that reports success and changes nothing
 * must not be treated as success.
 *
 * The driver is injected, so this suite never touches the real WeChat client.
 *
 * Run: node test/wechat-cua-client.test.js
 */

const assert = require("assert");
const path = require("path");

const {
  CuaSession,
  ensureConversation,
  sendMessage,
  outcome,
  currentConversation,
} = require("../src/integrations/wechat-cua/client");

const TARGET = { pid: 4242, window_id: 999 };

/** A scripted driver: each entry answers one tool call, in order. */
function fakeDriver(script) {
  const calls = [];
  const session = new CuaSession("test");
  session.call = (tool, args) => {
    calls.push({ tool, args });
    const next = script.shift();
    if (!next) throw new Error(`unexpected call: ${tool}`);
    assert.strictEqual(tool, next.tool, `expected ${next.tool}, got ${tool}`);
    return next.reply;
  };
  return { session, calls };
}

const snapshot = (elements) => ({ elements, element_count: elements.length });
const row = (label, token = "tok-row") => ({ role: "ListItem", label, element_token: token });
const box = (label, value = "", token = "tok-box") => ({ role: "Edit", label, value, element_token: token });
const searchBox = (value = "") => ({ role: "Edit", label: "搜索", value, element_token: "tok-search" });

/** A refusal shaped like the driver's real `stale_element_token` answer. */
const staleToken = () => ({
  __failed: true,
  payload: {
    refusal: { code: "stale_element_token", message: "element_token is stale; call get_window_state again to refresh" },
    current_snapshots: [{ snapshot_id: "s0000013e", window_id: 999 }],
  },
});

test_conversation_already_open();
test_switches_only_after_background_fails();
test_refuses_to_claim_success_when_the_row_never_appears();
test_send_reports_success_from_the_preview_row();

function test_conversation_already_open() {
  const { session, calls } = fakeDriver([
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手"), searchBox()]) },
  ]);
  const result = ensureConversation(session, TARGET, "文件传输助手");
  assert.strictEqual(result.switched, false);
  assert.strictEqual(result.route, "already-open");
  assert.strictEqual(result.cost, "none", "an open conversation must cost nothing");
  assert.strictEqual(calls.length, 1, "no click should be issued when the conversation is already open");
  console.log("ok   an open conversation costs nothing");
}

function test_switches_only_after_background_fails() {
  const { session, calls } = fakeDriver([
    // 1) who is open now?
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("Azzy"), searchBox()]) },
    // 2) rung 1: accessibility invoke, accepted and ignored
    { tool: "click", reply: { route: "accessibility", effect: "unverifiable", summary: "✅ Performed UIA Invoke" } },
    // 3) still the same conversation
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("Azzy"), searchBox()]) },
    // 4) rung 2 needs a fresh token
    { tool: "get_window_state", reply: snapshot([row("文件传输助手", "tok-row-2"), box("Azzy"), searchBox()]) },
    { tool: "click", reply: { route: "global_input", delivery: { mode: "foreground" }, effect: "unverifiable" } },
    // 5) switched
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手"), searchBox()]) },
  ]);
  const result = ensureConversation(session, TARGET, "文件传输助手");
  assert.strictEqual(result.switched, true);
  assert.strictEqual(result.route, "foreground-click");
  assert.strictEqual(result.cost, "one focus steal");
  const clicks = calls.filter((c) => c.tool === "click");
  assert.strictEqual(clicks.length, 2, "the escalation must happen exactly once");
  assert.strictEqual(clicks[0].args.delivery_mode, undefined, "rung 1 must stay in the background");
  assert.strictEqual(clicks[1].args.delivery_mode, "foreground", "rung 2 is the explicit escalation");
  assert.strictEqual(clicks[1].args.element_token, "tok-row-2", "the escalation must use a token from the freshest snapshot");
  console.log("ok   escalation happens only after the background rung fails, with a fresh token");
}

function test_refuses_to_claim_success_when_the_row_never_appears() {
  const { session } = fakeDriver([
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("Azzy")]) },
    { tool: "click", reply: { route: "accessibility", effect: "unverifiable" } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("Azzy")]) },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("Azzy")]) },
    { tool: "click", reply: { route: "global_input", delivery: { mode: "foreground" } } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("Azzy")]) },
  ]);
  assert.throws(
    () => ensureConversation(session, TARGET, "文件传输助手"),
    /could not open/,
    "a click that changes nothing must not be reported as a switch"
  );
  console.log("ok   a no-op click is not mistaken for a switch");
}

function test_send_reports_success_from_the_preview_row() {
  const text = "CUA-CLOSED-LOOP-OK";
  const { session, calls } = fakeDriver([
    // open: already on the right conversation
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手"), searchBox()]) },
    // type
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手"), searchBox()]) },
    { tool: "type_text", reply: { route: "accessibility", effect: "confirmed", summary: "✅ Wrote 18 char(s)" } },
    // read-back shows the text in the box
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text), searchBox()]) },
    // send
    { tool: "press_key", reply: { route: "synthetic_events", effect: "unverifiable", summary: "📨 Sent return" } },
    // verify
    { tool: "get_window_state", reply: snapshot([row(`文件传输助手 ${text} 13:21`), box("文件传输助手"), searchBox()]) },
  ]);
  const result = sendMessage(TARGET, "文件传输助手", text, { session });
  assert.strictEqual(result.ok, true, `expected ok, got ${result.verify}`);
  assert.match(result.verify, /preview row/);
  const steps = result.steps.map((s) => s.step);
  assert.deepStrictEqual(steps, ["open", "type", "return"]);
  assert.strictEqual(result.steps[0].cost, "none");
  const pressed = calls.find((c) => c.tool === "press_key");
  assert.strictEqual(pressed.args.key, "return");
  console.log("ok   a send is confirmed from the conversation preview row");
}

function test_send_fails_when_the_text_never_lands() {
  const text = "never-lands";
  const { session, calls } = fakeDriver([
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手"), searchBox()]) },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手"), searchBox()]) },
    { tool: "type_text", reply: { route: "accessibility", effect: "unverifiable" } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手"), searchBox()]) },
    { tool: "type_text", reply: { route: "global_input", delivery: { mode: "foreground" } } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手"), searchBox()]) },
  ]);
  const result = sendMessage(TARGET, "文件传输助手", text, { session });
  assert.strictEqual(result.ok, false);
  assert.match(result.verify, /never reached/);
  assert.strictEqual(calls.some((c) => c.tool === "press_key"), false, "never press return when the text did not land");
  console.log("ok   return is not pressed when the text never landed");
}

function test_outcome_keeps_delivery_apart_from_effect() {
  const delivered = outcome({ route: "accessibility", effect: "unverifiable", summary: "✅ Accepted" });
  assert.strictEqual(delivered.failed, false);
  assert.strictEqual(delivered.effect, "unverifiable", "delivery is not effect and must not be laundered into one");
  const refused = outcome({ __failed: true, payload: { refusal: { code: "stale_element_token", message: "x" } } });
  assert.strictEqual(refused.failed, true);
  assert.strictEqual(refused.reason, "stale_element_token");
  console.log("ok   delivery and effect stay distinct in the reported outcome");
}

function test_current_conversation_reads_the_box_label() {
  const { session } = fakeDriver([
    { tool: "get_window_state", reply: snapshot([searchBox("Azzy"), box("柳毓琳")]) },
  ]);
  const conv = currentConversation(session, TARGET);
  assert.strictEqual(conv.label, "柳毓琳", "the search box must not be mistaken for the message box");
  console.log("ok   the open conversation is read from the message box, not the search box");
}

test_outcome_keeps_delivery_apart_from_effect();
test_send_fails_when_the_text_never_lands();
test_current_conversation_reads_the_box_label();
test_a_refused_write_is_retried_from_a_new_snapshot();
test_a_refused_return_is_re_pressed_only_while_the_text_is_still_there();
test_a_refused_return_with_an_empty_box_is_not_pressed_again();
test_an_unknown_draft_is_never_typed_over();
test_our_own_unsent_leftover_is_cleared_before_the_next_attempt();
test_a_minimized_window_is_restored_before_the_write_is_retried();

function test_a_minimized_window_is_restored_before_the_write_is_retried() {
  // Measured 2026-10-01: WeChat sat in the taskbar and every write failed - the
  // reads kept working, the refusals said `window_minimized`, and the tokens died
  // so fast that `stale_element_token` looked like the cause. Restoring the window
  // costs one foreground activation and only after a refusal.
  const text = "AFTER-RESTORE";
  const { session, calls } = fakeDriver([
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手"), searchBox()]) },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", "", "tok-box-1"), searchBox()]) },
    { tool: "type_text", reply: { __failed: true, payload: { refusal: { code: "window_minimized", message: "the window is minimized" } } } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", "", "tok-box-2"), searchBox()]) },
    { tool: "bring_to_front", reply: { route: "global_input", effect: "confirmed" } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", "", "tok-box-3"), searchBox()]) },
    { tool: "type_text", reply: { route: "global_input", effect: "confirmed" } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-3"), searchBox()]) },
    { tool: "press_key", reply: { route: "synthetic_events", effect: "unverifiable" } },
    { tool: "get_window_state", reply: snapshot([row(`文件传输助手 ${text} 13:21`), box("文件传输助手"), searchBox()]) },
  ]);
  const result = sendMessage(TARGET, "文件传输助手", text, { session });
  const restored = calls.filter((c) => c.tool === "bring_to_front");
  assert.strictEqual(restored.length, 1, "a minimized window must be restored once");
  assert.strictEqual(restored[0].args.pid, TARGET.pid);
  const types = calls.filter((c) => c.tool === "type_text");
  assert.strictEqual(types.length, 2);
  assert.strictEqual(types[1].args.element_token, "tok-box-3", "the retry must use a token taken AFTER the restore");
  assert.strictEqual(result.steps[1].firstAttempt.reason, "window_minimized");
  assert.strictEqual(result.ok, true, `expected the send to be confirmed, got ${result.verify}`);
  console.log("ok   a minimized window is restored once, then the write is retried from a fresh snapshot");
}

function test_an_unknown_draft_is_never_typed_over() {
  // The operator may be typing in the bot's own account. The bot's composer is a
  // workspace with an owner: text we did not put there is never typed over and
  // never deleted - the send fails and quotes the text back instead.
  const { session, calls } = fakeDriver([
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手"), searchBox()]) },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", "手动打字中", "tok-box-1"), searchBox()]) },
  ]);
  const result = sendMessage(TARGET, "文件传输助手", "bot reply", { session });
  assert.strictEqual(result.ok, false);
  assert.match(result.verify, /already holds unsent text/);
  assert.strictEqual(calls.some((c) => c.tool === "type_text"), false, "an unknown draft must not be typed over");
  assert.strictEqual(calls.some((c) => c.tool === "set_value"), false, "an unknown draft must not be deleted either");
  console.log("ok   a draft the bot did not write is reported, never overwritten or deleted");
}

function test_our_own_unsent_leftover_is_cleared_before_the_next_attempt() {
  // Measured live on 2026-10-01: a refused `press_key` left the bot's own text in
  // the composer. Without this, every later send would either glue itself to that
  // text or refuse forever, and the bot would be mute with no way back.
  const text = "LEFTOVER-RECOVERY";
  const { session, calls } = fakeDriver([
    // Attempt 1: the write lands, the press is refused twice, the text stays unsent.
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手"), searchBox()]) },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", "", "tok-box-1"), searchBox()]) },
    { tool: "type_text", reply: { route: "accessibility", effect: "confirmed" } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-1"), searchBox()]) },
    { tool: "press_key", reply: staleToken() },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-2"), searchBox()]) },
    { tool: "press_key", reply: staleToken() },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-2"), searchBox()]) },
    // Attempt 2: the same text is recognised as OURS, cleared, and sent.
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手"), searchBox()]) },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-3"), searchBox()]) },
    { tool: "set_value", reply: { route: "accessibility", effect: "confirmed" } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", "", "tok-box-4"), searchBox()]) },
    { tool: "type_text", reply: { route: "accessibility", effect: "confirmed" } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-4"), searchBox()]) },
    { tool: "press_key", reply: { route: "synthetic_events", effect: "unverifiable" } },
    { tool: "get_window_state", reply: snapshot([row(`文件传输助手 ${text} 13:21`), box("文件传输助手"), searchBox()]) },
  ]);

  const first = sendMessage(TARGET, "文件传输助手", text, { session });
  assert.strictEqual(first.ok, false, "a send whose press was refused is not a success");
  assert.match(first.verify, /never appeared/);

  const second = sendMessage(TARGET, "文件传输助手", text, { session });
  const cleared = second.steps.find((s) => s.step === "clear-leftover");
  assert.ok(cleared, "our own unsent text must be cleared before typing again");
  assert.strictEqual(cleared.text, text);
  const sets = calls.filter((c) => c.tool === "set_value");
  assert.strictEqual(sets.length, 1);
  assert.strictEqual(sets[0].args.value, "", "clearing means setting the box to empty");
  assert.strictEqual(sets[0].args.element_token, "tok-box-3", "the clear uses a token from the current snapshot");
  assert.strictEqual(second.ok, true, `expected the second attempt to send, got ${second.verify}`);
  console.log("ok   the bot's own unsent text is cleared on the next attempt, and the send then succeeds");
}

function test_a_refused_write_is_retried_from_a_new_snapshot() {
  // Measured on 0.31.0: a token is invalidated by ANY later read of the window -
  // another process, another session, or the operator's own clicking. Retrying
  // with the refused token is a guaranteed second refusal, so the retry has to be
  // built from a fresh snapshot.
  const text = "RETRY-AFTER-STALE";
  const { session, calls } = fakeDriver([
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", "", "tok-box-1"), searchBox()]) },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", "", "tok-box-1"), searchBox()]) },
    { tool: "type_text", reply: staleToken() },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", "", "tok-box-2"), searchBox()]) },
    { tool: "type_text", reply: { route: "accessibility", effect: "confirmed" } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-2"), searchBox()]) },
    { tool: "press_key", reply: { route: "synthetic_events", effect: "unverifiable" } },
    { tool: "get_window_state", reply: snapshot([row(`文件传输助手 ${text} 13:21`), box("文件传输助手"), searchBox()]) },
  ]);
  const result = sendMessage(TARGET, "文件传输助手", text, { session });
  const types = calls.filter((c) => c.tool === "type_text");
  assert.strictEqual(types.length, 2, "a refused write must be attempted again");
  assert.strictEqual(types[0].args.element_token, "tok-box-1");
  assert.strictEqual(types[1].args.element_token, "tok-box-2", "the retry must use a token from the NEW snapshot");
  assert.notStrictEqual(types[0].args.element_token, types[1].args.element_token);
  assert.strictEqual(result.steps[1].firstAttempt.reason, "stale_element_token", "the step must report why it had to retry");
  assert.strictEqual(result.ok, true, `expected the retry to send, got ${result.verify}`);
  console.log("ok   a write refused as stale is retried with a token from a fresh snapshot");
}

function test_a_refused_return_is_re_pressed_only_while_the_text_is_still_there() {
  const text = "PRESS-AGAIN";
  const { session, calls } = fakeDriver([
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手"), searchBox()]) },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", "", "tok-box-1"), searchBox()]) },
    { tool: "type_text", reply: { route: "accessibility", effect: "confirmed" } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-1"), searchBox()]) },
    { tool: "press_key", reply: staleToken() },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-2"), searchBox()]) },
    { tool: "press_key", reply: { route: "synthetic_events", effect: "unverifiable" } },
    { tool: "get_window_state", reply: snapshot([row(`文件传输助手 ${text} 13:21`), box("文件传输助手"), searchBox()]) },
  ]);
  const result = sendMessage(TARGET, "文件传输助手", text, { session });
  const presses = calls.filter((c) => c.tool === "press_key");
  assert.strictEqual(presses.length, 2, "the refused press did not happen, so it must be repeated");
  assert.strictEqual(presses[1].args.element_token, "tok-box-2", "the repeated press must use a fresh token");
  assert.strictEqual(result.steps[2].firstAttempt.reason, "stale_element_token", "the step must record the refused press");
  assert.strictEqual(result.ok, true, `expected the send to be confirmed, got ${result.verify}`);
  console.log("ok   a refused return is pressed again, from a fresh token, while the text is still unsent");
}

function test_a_refused_return_with_an_empty_box_is_not_pressed_again() {
  // The safety half: if the box is already empty, something DID leave it. Pressing
  // again blind would send a second copy (or an empty message), so the decision is
  // left to verification instead.
  const text = "PRESS-ONCE";
  const { session, calls } = fakeDriver([
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手"), searchBox()]) },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", "", "tok-box-1"), searchBox()]) },
    { tool: "type_text", reply: { route: "accessibility", effect: "confirmed" } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-1"), searchBox()]) },
    { tool: "press_key", reply: staleToken() },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", "", "tok-box-2"), searchBox()]) },
    { tool: "get_window_state", reply: snapshot([row(`文件传输助手 ${text} 13:21`), box("文件传输助手", "", "tok-box-3"), searchBox()]) },
  ]);
  const result = sendMessage(TARGET, "文件传输助手", text, { session });
  assert.strictEqual(calls.filter((c) => c.tool === "press_key").length, 1, "an empty box must not be pressed again");
  assert.strictEqual(result.steps[2].skippedRepress, true, "the step must say that it deliberately did not press again");
  assert.strictEqual(result.ok, true, `expected the send to be confirmed by the preview row, got ${result.verify}`);
  console.log("ok   an empty box after a refused return is never pressed again");
}
