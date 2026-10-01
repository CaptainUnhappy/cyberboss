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
