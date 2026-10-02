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
  FOREGROUND_ACTIVATION_COST,
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
/** The composer's send button, as the real tree exposes it: Button "发送". */
const sendButton = (token = "tok-send") => ({ role: "Button", label: "发送", actions: ["invoke", "set_value"], element_token: token });

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
  assert.strictEqual(result.cost, FOREGROUND_ACTIVATION_COST, "the reported cost must be the measured one, not a vague claim");
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
    // Still the same conversation - this read is what makes rung 1 a failure.
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("Azzy")]) },
    // Rung 2 needs a token from a fresh snapshot.
    { tool: "get_window_state", reply: snapshot([row("文件传输助手", "tok-row-2"), box("Azzy")]) },
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
    // open: already on the right conversation (its snapshot also carries the composer)
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手"), searchBox()]) },
    // type
    { tool: "type_text", reply: { route: "accessibility", effect: "confirmed", summary: "✅ Wrote 18 char(s)" } },
    // read-back shows the text in the box
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text), searchBox()]) },
    // send
    { tool: "type_text", reply: { route: "synthetic_events", effect: "unverifiable", summary: "📨 Sent return" } },
    // verify
    { tool: "get_window_state", reply: snapshot([row(`文件传输助手 ${text} 13:21`), box("文件传输助手"), searchBox()]) },
  ]);
  const result = sendMessage(TARGET, "文件传输助手", text, { session });
  assert.strictEqual(result.ok, true, `expected ok, got ${result.verify}`);
  assert.match(result.verify, /preview row/);
  const steps = result.steps.map((s) => s.step);
  assert.deepStrictEqual(steps, ["open", "type", "send"]);
  assert.strictEqual(result.steps[0].cost, "none");
  const newline = calls.find((c) => c.tool === "type_text" && c.args.text === "\n");
  assert.ok(newline, "the send is the foreground newline call");
  assert.strictEqual(newline.args.delivery_mode, "foreground");
  console.log("ok   a send is confirmed from the conversation preview row");
}

function test_send_fails_when_the_text_never_lands() {
  const text = "never-lands";
  const { session, calls } = fakeDriver([
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手"), searchBox()]) },
    { tool: "type_text", reply: { route: "accessibility", effect: "unverifiable" } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手"), searchBox()]) },
    { tool: "type_text", reply: { route: "global_input", delivery: { mode: "foreground" } } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手"), searchBox()]) },
  ]);
  const result = sendMessage(TARGET, "文件传输助手", text, { session });
  assert.strictEqual(result.ok, false);
  assert.match(result.verify, /never reached/);
  assert.strictEqual(calls.some((c) => c.tool === "type_text" && c.args.text === "\n"), false, "never deliver a return when the text did not land");
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
test_a_send_uses_one_foreground_newline();
test_a_newline_that_did_not_send_falls_back_to_the_send_button();
test_without_a_send_button_the_retry_still_never_uses_a_mode_less_press();
test_an_unknown_draft_is_never_typed_over();
test_our_own_unsent_leftover_is_cleared_before_the_next_attempt();
test_a_minimized_window_is_restored_without_activation();
test_a_minimized_window_that_cannot_be_restored_still_fails_certainly();
test_the_no_foreground_switch_refuses_instead_of_clicking();

function test_a_minimized_window_is_restored_without_activation() {
  // Measured 2026-10-02 twice: the driver's only un-minimize is `bring_to_front`,
  // which raises WeChat AND leaves it in front, while `ShowWindow(SW_SHOWNOACTIVATE)`
  // restores it at its previous size with the foreground pid unchanged. Refusing
  // instead (the old policy) made the whole channel mute for as long as the operator
  // kept WeChat in the taskbar - no 处理中 and no reply could go out at all.
  const text = "MINIMIZED-RESTORE";
  const { session, calls } = fakeDriver([
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手"), searchBox()]) },
    { tool: "type_text", reply: { __failed: true, payload: { refusal: { code: "window_minimized", message: "the window is minimized" } } } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", "", "tok-box-2"), searchBox()]) },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", "", "tok-box-3"), searchBox()]) },
    { tool: "type_text", reply: { route: "global_input", delivery: { mode: "foreground" } } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-3"), searchBox()]) },
    { tool: "type_text", reply: { route: "synthetic_events", effect: "unverifiable" } },
    { tool: "get_window_state", reply: snapshot([row(`文件传输助手 ${text} 13:21`), box("文件传输助手"), searchBox()]) },
  ]);
  const restores = [];
  session.restoreMinimized = (pid) => { restores.push(pid); return { ok: true }; };

  const result = sendMessage(TARGET, "文件传输助手", text, { session });
  assert.deepStrictEqual(restores, [TARGET.pid], "the minimized window must be restored, by pid");
  assert.ok(result.steps.some((step) => step.step === "unminimize"), "the restore must be visible in the steps");
  assert.strictEqual(calls.some((c) => c.tool === "bring_to_front"), false, "the bot must NOT raise the user's window");
  assert.strictEqual(result.ok, true, `expected the send to go through after the restore, got ${result.verify}`);
  console.log("ok   a minimized window is restored without activation and the send continues");
}

function test_a_minimized_window_that_cannot_be_restored_still_fails_certainly() {
  const text = "MINIMIZED-UNRESTORABLE";
  const { session, calls } = fakeDriver([
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手"), searchBox()]) },
    { tool: "type_text", reply: { __failed: true, payload: { refusal: { code: "window_minimized", message: "the window is minimized" } } } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", "", "tok-box-2"), searchBox()]) },
  ]);
  session.restoreMinimized = () => ({ ok: false, error: "no such process" });

  const result = sendMessage(TARGET, "文件传输助手", text, { session });
  assert.strictEqual(result.ok, false, "a window that cannot be restored must not be reported as sent");
  assert.match(result.verify, /minimized/, "and the reason must name the actual condition");
  assert.strictEqual(calls.some((c) => c.tool === "press_key"), false, "nothing may be typed or sent into a hidden window");
  console.log("ok   a minimized window that cannot be restored fails certainly (the reply is deferred)");
}

function test_an_unknown_draft_is_never_typed_over() {
  // The operator may be typing in the bot's own account. The bot's composer is a
  // workspace with an owner: text we did not put there is never typed over and
  // never deleted - the send fails and quotes the text back instead.
  const { session, calls } = fakeDriver([
    // One snapshot: the composer comes from the read that opened the conversation.
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
    { tool: "type_text", reply: { route: "accessibility", effect: "confirmed" } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-1"), searchBox()]) },
    { tool: "type_text", reply: staleToken() },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-2"), searchBox()]) },
    { tool: "type_text", reply: staleToken() },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-2"), searchBox()]) },
    // The send-again rung has no 发送 button to click here, so it falls back to a
    // foreground press - refused as well, so the text really does stay unsent.
    { tool: "press_key", reply: staleToken() },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-2"), searchBox()]) },
    // Attempt 2: the same text is recognised as OURS, cleared, and sent. The opening
    // read already shows the leftover, because that read now carries the composer.
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-3"), searchBox()]) },
    { tool: "set_value", reply: { route: "accessibility", effect: "confirmed" } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", "", "tok-box-4"), searchBox()]) },
    { tool: "type_text", reply: { route: "accessibility", effect: "confirmed" } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-4"), searchBox()]) },
    { tool: "type_text", reply: { route: "synthetic_events", effect: "unverifiable" } },
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
    { tool: "type_text", reply: staleToken() },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", "", "tok-box-2"), searchBox()]) },
    { tool: "type_text", reply: { route: "accessibility", effect: "confirmed" } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-2"), searchBox()]) },
    { tool: "type_text", reply: { route: "synthetic_events", effect: "unverifiable" } },
    { tool: "get_window_state", reply: snapshot([row(`文件传输助手 ${text} 13:21`), box("文件传输助手"), searchBox()]) },
  ]);
  const result = sendMessage(TARGET, "文件传输助手", text, { session });
  // The typing calls only: the newline that delivers the return is also a type_text.
  const types = calls.filter((c) => c.tool === "type_text" && c.args.text !== "\n");
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
    { tool: "type_text", reply: { route: "accessibility", effect: "confirmed" } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-1"), searchBox()]) },
    { tool: "type_text", reply: staleToken() },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-2"), searchBox()]) },
    { tool: "type_text", reply: { route: "synthetic_events", effect: "unverifiable" } },
    { tool: "get_window_state", reply: snapshot([row(`文件传输助手 ${text} 13:21`), box("文件传输助手"), searchBox()]) },
  ]);
  const result = sendMessage(TARGET, "文件传输助手", text, { session });
  const presses = calls.filter((c) => c.tool === "type_text" && c.args.text === "\n");
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
    { tool: "type_text", reply: { route: "accessibility", effect: "confirmed" } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-1"), searchBox()]) },
    { tool: "type_text", reply: staleToken() },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", "", "tok-box-2"), searchBox()]) },
    { tool: "get_window_state", reply: snapshot([row(`文件传输助手 ${text} 13:21`), box("文件传输助手", "", "tok-box-3"), searchBox()]) },
  ]);
  const result = sendMessage(TARGET, "文件传输助手", text, { session });
  assert.strictEqual(calls.filter((c) => c.tool === "type_text" && c.args.text === "\n").length, 1, "an empty box must not be sent into again");
  assert.strictEqual(result.steps[2].skippedRepress, true, "the step must say that it deliberately did not press again");
  assert.strictEqual(result.ok, true, `expected the send to be confirmed by the preview row, got ${result.verify}`);
  console.log("ok   an empty box after a refused return is never pressed again");
}

function test_a_send_uses_one_foreground_newline() {
  // Measured live on 2026-10-02 with a 50ms foreground sampler and another window
  // parked in front: the four candidate routes are
  //   press_key (no mode)      -> WeChat ignores it, the text stays in the composer
  //   press_key (foreground)   -> sends, never gives the focus back (10.5s later WeChat
  //                               was still in front)
  //   click on 发送             -> sends, focus back after ~124ms, but the call costs ~1.9s
  //   type_text "\n" foreground -> sends, 146ms per call, WeChat in front for 125ms
  // so the newline is primary and the modes that lie or steal are not used.
  const text = "NEWLINE-SEND";
  const { session, calls } = fakeDriver([
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手"), searchBox()]) },
    { tool: "type_text", reply: { route: "accessibility", effect: "confirmed" } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-1"), searchBox()]) },
    { tool: "type_text", reply: { route: "global_input", delivery: { mode: "foreground" }, effect: "unverifiable", summary: "✅ Typed 1 char(s) via SendInput" } },
    { tool: "get_window_state", reply: snapshot([row(`文件传输助手 ${text} 13:21`), box("文件传输助手"), searchBox()]) },
  ]);
  const result = sendMessage(TARGET, "文件传输助手", text, { session });
  const newlines = calls.filter((c) => c.tool === "type_text" && c.args.text === "\n");
  assert.strictEqual(newlines.length, 1, "the send is exactly one newline");
  assert.strictEqual(newlines[0].args.delivery_mode, "foreground", "only the foreground newline was measured to send AND return the focus");
  assert.strictEqual(newlines[0].args.element_token, "tok-box-1", "the newline goes to the composer");
  assert.strictEqual(calls.some((c) => c.tool === "press_key"), false, "the modes that lie or steal must not be used");
  assert.strictEqual(result.steps.find((s) => s.step === "send").via, "foreground-newline");
  assert.strictEqual(result.ok, true, `expected the send to be confirmed, got ${result.verify}`);
  console.log("ok   a send is one foreground newline into the composer");
}

function test_a_newline_that_did_not_send_falls_back_to_the_send_button() {
  // WeChat can be configured to need Ctrl+Enter, in which case the newline only adds a
  // line break: the composer still holds the text, and the retry walks the ladder past
  // the newline rung and clicks 发送 instead.
  const text = "NEWLINE-THEN-BUTTON";
  const { session, calls } = fakeDriver([
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手"), searchBox()]) },
    { tool: "type_text", reply: { route: "accessibility", effect: "confirmed" } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-1"), searchBox(), sendButton("tok-send-1")]) },
    { tool: "type_text", reply: { route: "global_input", delivery: { mode: "foreground" } } },
    // The newline did nothing: the box still holds the text.
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", `${text}\n`, "tok-box-1"), searchBox(), sendButton("tok-send-1")]) },
    { tool: "click", reply: { route: "global_input", delivery: { mode: "foreground" } } },
    { tool: "get_window_state", reply: snapshot([row(`文件传输助手 ${text} 13:21`), box("文件传输助手"), searchBox()]) },
  ]);
  const result = sendMessage(TARGET, "文件传输助手", text, { session });
  const clicks = calls.filter((c) => c.tool === "click");
  assert.strictEqual(clicks.length, 1, "the retry must be exactly one click on 发送");
  assert.strictEqual(clicks[0].args.element_token, "tok-send-1");
  assert.strictEqual(clicks[0].args.delivery_mode, "foreground");
  const again = result.steps.find((s) => s.step === "send-again");
  assert.strictEqual(again.via, "send-button-click");
  assert.strictEqual(result.ok, true, `expected the retry to send, got ${result.verify}`);
  console.log("ok   a newline that only added a line break is retried through the 发送 button");
}

function test_without_a_send_button_the_retry_still_never_uses_a_mode_less_press() {
  const text = "NO-SEND-BUTTON";
  const { session, calls } = fakeDriver([
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手"), searchBox()]) },
    { tool: "type_text", reply: { route: "accessibility", effect: "confirmed" } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-1"), searchBox()]) },
    { tool: "type_text", reply: { route: "global_input", delivery: { mode: "foreground" } } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("文件传输助手", text, "tok-box-1"), searchBox()]) },
    { tool: "press_key", reply: { route: "global_input", delivery: { mode: "foreground" } } },
    { tool: "get_window_state", reply: snapshot([row(`文件传输助手 ${text} 13:21`), box("文件传输助手"), searchBox()]) },
  ]);
  const result = sendMessage(TARGET, "文件传输助手", text, { session });
  const presses = calls.filter((c) => c.tool === "press_key");
  assert.strictEqual(presses.length, 1);
  assert.strictEqual(presses[0].args.delivery_mode, "foreground", "the fallback press must be the mode that actually sends");
  assert.strictEqual(result.steps.find((s) => s.step === "send-again").via, "foreground-return");
  assert.strictEqual(result.ok, true);
  console.log("ok   without a 发送 button the retry falls back to a foreground press");
}

function test_the_no_foreground_switch_refuses_instead_of_clicking() {
  // The only remaining foreground cost is the switch rung. With the opt-in policy
  // (CYBERBOSS_WECHAT_CUA_NO_FOREGROUND_SWITCH) it must be refused outright: a
  // background/accessibility click is free and may still be attempted, but nothing
  // with delivery_mode "foreground" may ever be issued.
  const { session, calls } = fakeDriver([
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("Azzy"), searchBox()]) },
    { tool: "click", reply: { route: "accessibility", effect: "unverifiable" } },
    { tool: "get_window_state", reply: snapshot([row("文件传输助手"), box("Azzy"), searchBox()]) },
  ]);
  let refusal = null;
  try {
    sendMessage(TARGET, "文件传输助手", "hello", { session, allowForegroundSwitch: false });
  } catch (error) {
    refusal = error;
  }
  assert.ok(refusal, "the policy must refuse instead of switching");
  assert.match(refusal.message, /foreground switching is disabled/);
  // The delivery layer defers ONLY certain failures (deferSystemReply checks this
  // exact flag). Without it the reply is dropped rather than retried - measured on
  // the live channel 2026-10-02.
  assert.strictEqual(refusal.deliveryUncertain, false, "a policy refusal must be flagged as a certain failure");
  const foregroundClicks = calls.filter((c) => c.tool === "click" && c.args.delivery_mode === "foreground");
  assert.strictEqual(foregroundClicks.length, 0, "not one foreground click may be issued when the policy forbids it");
  console.log("ok   with the foreground switch disabled, a closed conversation is refused (zero foreground clicks)");
}
