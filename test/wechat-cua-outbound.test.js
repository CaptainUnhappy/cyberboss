#!/usr/bin/env node
/**
 * Offline tests for the Cua outbound sender.
 *
 * The contract that matters is not "does it call the driver" but:
 *   - the result vocabulary matches the WeFlow bridge, so the ledger and the
 *     stream layer do not need a second dialect
 *   - a talker with no configured conversation label is a HARD failure, because
 *     guessing would message the wrong person
 *   - a delivered send is recorded in the echo ledger before it returns, so the
 *     inbound reader cannot read our own output back as a new message
 *   - a failed send reports `dispatched:false` and never records an echo
 *
 * The fake client is STATEFUL: the composer fills on type, empties on return, and
 * the conversation row's preview changes only when the text is actually sent.
 * A stateless fake already produced one false pass in this repo (see the media
 * tests), so statefulness is a requirement, not a nicety.
 *
 * Run: node test/wechat-cua-outbound.test.js
 */

const assert = require("assert");

const { sendWeChatCuaText, resolveChatLabel, localIdFor } = require("../src/integrations/wechat-cua/outbound");
const { CuaSession } = require("../src/integrations/wechat-cua/client");
const { SentLedger } = require("../src/integrations/wechat-cua/loop");

const WIN = { pid: 11, window_id: 22 };
const TALKER = "wxid_example";
const CHAT = "文件传输助手";

/** A stateful fake driver: the composer and the conversation both change. */
function makeClient({ openChat = CHAT, sendLands = true } = {}) {
  const state = { open: openChat, box: "", preview: "an older message", sent: [] };
  const session = new CuaSession("test");
  const rows = () => [
    { role: "ListItem", label: `${CHAT}\n${state.open === CHAT ? state.preview : "old"}\n13:00\n`, element_token: "row-chat", element_index: 1, frame: { y: 90, w: 300, h: 78 } },
    { role: "ListItem", label: `Someone else\nhi\n12:00\n`, element_token: "row-other", element_index: 2, frame: { y: 180, w: 300, h: 78 } },
  ];
  session.snapshot = () => ({
    elements: [...rows(), { role: "Edit", label: state.open, value: state.box, element_token: "box" }],
    screenshot_width: 1102,
    screenshot_height: 800,
    window_title: "微信",
  });
  session.call = (tool, args) => {
    if (tool === "list_windows") {
      return { windows: [{ pid: WIN.pid, window_id: WIN.window_id, title: "微信", bounds: { x: 0, y: 0, width: 1102, height: 800 } }] };
    }
    if (tool === "get_window_state") {
      // The client reads the row list and the open conversation from the same call.
      return {
        elements: [
          ...rows(),
          { role: "Edit", label: state.open, value: state.box, element_token: "box" },
          ...state.sent.map((text, i) => ({ role: "ListItem", label: text, element_token: `b${i}`, frame: { y: 300 + i * 60, w: 722, h: 68 } })),
        ],
        screenshot_width: 1102,
        screenshot_height: 800,
      };
    }
    if (tool === "click") {
      state.open = CHAT; // the fixture only has one reachable conversation
      return { route: "global_input", delivery: { mode: "foreground" }, summary: "clicked" };
    }
    if (tool === "type_text") {
      state.box = String(args.text);
      return { route: "accessibility", effect: "confirmed", summary: "wrote" };
    }
    if (tool === "press_key" && args.key === "return") {
      if (sendLands) {
        state.sent = [...state.sent, state.box];
        state.preview = state.box;
      }
      state.box = ""; // what the real client does either way
      return { route: "synthetic_events", summary: "sent return" };
    }
    if (tool === "set_value") {
      state.box = String(args.value ?? "");
      return { route: "accessibility", summary: "Set AXValue" };
    }
    return { ok: true };
  };
  session.__state = state;
  return session;
}

function main() {
  a_talker_without_a_label_is_a_hard_failure();
  a_delivered_send_records_the_echo_before_returning();
  a_failed_send_is_not_recorded_as_an_echo();
  the_result_vocabulary_matches_the_bridge();
  console.log("all outbound tests passed");
}

function a_talker_without_a_label_is_a_hard_failure() {
  assert.throws(
    () => resolveChatLabel("wxid_unknown", { mapping: "wxid_other=Someone" }),
    /no conversation label configured/,
    "guessing a conversation would message the wrong person",
  );
  assert.strictEqual(resolveChatLabel("wxid_a", { mapping: "wxid_a=柳毓琳,wxid_b=Azzy" }), "柳毓琳");
  assert.strictEqual(resolveChatLabel("wxid_b", { mapping: " wxid_a = 柳毓琳 , wxid_b = Azzy " }), "Azzy", "mapping entries must tolerate spaces");
  console.log("ok   an unmapped talker is a hard failure, not a guess");
}

async function a_delivered_send_records_the_echo_before_returning() {
  const session = makeClient({ sendLands: true });
  const ledger = new SentLedger();
  const text = "hello from cua";
  const result = await sendWeChatCuaText({}, { talker: TALKER, text, chatLabel: CHAT, session, target: WIN, ledger });
  assert.strictEqual(result.dispatched, true, `expected dispatch, got ${JSON.stringify(result).slice(0, 240)}`);
  assert.strictEqual(result.verified, true);
  assert.ok(result.localId, "a verified send must carry a localId for the ledger");
  assert.deepStrictEqual(session.__state.sent, [text], "the fake client must have actually sent it");
  assert.strictEqual(ledger.matches(CHAT, text), true, "the echo must be recorded before the sender returns");
  console.log("ok   a delivered send records its echo before returning");
}

async function a_failed_send_is_not_recorded_as_an_echo() {
  const session = makeClient({ sendLands: false });
  const ledger = new SentLedger();
  const text = "this never lands";
  const result = await sendWeChatCuaText({}, { talker: TALKER, text, chatLabel: CHAT, session, target: WIN, ledger });
  assert.strictEqual(result.dispatched, false, "a send that cannot be verified is not dispatched");
  assert.strictEqual(result.verified, false);
  assert.strictEqual(result.localId, "", "no localId for a failed send");
  assert.ok(result.verificationError, "a failure must carry a reason");
  assert.strictEqual(ledger.matches(CHAT, text), false, "a failed send must not poison the echo ledger");
  console.log("ok   a failed send reports dispatched:false and records no echo");
}

async function the_result_vocabulary_matches_the_bridge() {
  const session = makeClient({ sendLands: true });
  const text = "vocabulary check";
  const result = await sendWeChatCuaText({}, { talker: TALKER, text, chatLabel: CHAT, session, target: WIN, ledger: new SentLedger() });
  for (const key of ["dispatched", "verified", "localId"]) {
    assert.ok(key in result, `the bridge contract requires ${key}`);
  }
  assert.strictEqual(result.localId, localIdFor({ talker: TALKER, text }));
  assert.ok(Array.isArray(result.focusCosts), "focus cost must be reported, not hidden");
  assert.strictEqual(result.chat, CHAT);
  console.log("ok   the result vocabulary matches the WeFlow bridge");
}

main();
