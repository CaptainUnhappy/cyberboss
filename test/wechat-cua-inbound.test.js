#!/usr/bin/env node
/**
 * Offline tests for the preview-level inbound source.
 *
 * The rules that matter are the ones that stop a bot from talking to itself or
 * from answering a conversation it was never told to watch:
 *   - the first poll primes the baseline instead of replaying the whole list
 *   - our own send must not come back as an inbound message
 *   - a peer outside the allow-list is ignored
 *   - an unread badge is treated as a stronger signal than a text change
 *
 * Run: node test/wechat-cua-inbound.test.js
 */

const assert = require("assert");

const { PreviewInboundSource, parseRow, rowDigest } = require("../src/integrations/wechat-cua/inbound");
const { SentLedger } = require("../src/integrations/wechat-cua/loop");
const { CuaSession } = require("../src/integrations/wechat-cua/client");

const TARGET = { pid: 1, window_id: 2 };

/** A session whose snapshots come from a scripted list of row-label arrays. */
function fakeSession(labelSets) {
  const session = new CuaSession("test");
  let call = 0;
  session.snapshot = () => {
    const labels = labelSets[Math.min(call, labelSets.length - 1)];
    call += 1;
    return { elements: labels.map((label, i) => ({ role: "ListItem", label, element_index: 100 + i, element_token: `tok-${i}` })) };
  };
  return session;
}

const rowText = (peer, preview, time = "13:00", badge = "") =>
  `${peer}\n${badge}${preview}\n${time}\n`;

function main() {
  parse_cases();
  baseline_is_not_replayed();
  our_own_send_is_not_inbound();
  peers_outside_the_allow_list_are_ignored();
  unread_badge_marks_a_stronger_signal();
  reorder_alone_is_not_a_new_message();
  the_sent_ledger_stops_the_bot_answering_itself();
  console.log("all inbound tests passed");
}

function parse_cases() {
  const withBadge = parseRow("服务号\n[1条] \n你好\n09/16\n");
  assert.deepStrictEqual(withBadge, { peer: "服务号", preview: "你好", time: "09/16", unread: 1, raw: "服务号\n[1条] \n你好\n09/16\n" });
  const plain = parseRow("柳毓琳\nhi\n09/17\n");
  assert.strictEqual(plain.peer, "柳毓琳");
  assert.strictEqual(plain.preview, "hi");
  assert.strictEqual(plain.time, "09/17");
  assert.strictEqual(plain.unread, 0);
  const noTime = parseRow("微信团队\n\n\n");
  assert.strictEqual(noTime.peer, "微信团队");
  assert.strictEqual(noTime.preview, "");
  const yesterday = parseRow("小窝\n晚安\n昨天\n");
  assert.strictEqual(yesterday.time, "昨天");
  console.log("ok   rows parse into peer / preview / time / unread");
}

function baseline_is_not_replayed() {
  const session = fakeSession([[rowText("柳毓琳", "hi"), rowText("Azzy", "ok")]]);
  const source = new PreviewInboundSource(TARGET, { session });
  const first = source.poll();
  assert.deepStrictEqual(first, [], "the first poll establishes the baseline; it must not emit the whole history");
  const second = source.poll();
  assert.deepStrictEqual(second, [], "an unchanged list produces no events");
  console.log("ok   the first poll primes instead of replaying");
}

function our_own_send_is_not_inbound() {
  const session = fakeSession([
    [rowText("柳毓琳", "hi")],
    [rowText("柳毓琳", "机器人刚发的回复"), rowText("Azzy", "旧消息")],
  ]);
  const source = new PreviewInboundSource(TARGET, { session });
  source.poll(); // baseline
  const events = source.poll({ isOwnEcho: (row) => row.preview === "机器人刚发的回复" });
  assert.deepStrictEqual(events, [], "a row we just wrote must not be treated as inbound");
  assert.strictEqual(source.stats.skippedOwnEcho, 1);
  console.log("ok   our own send is filtered out as an echo");
}

function peers_outside_the_allow_list_are_ignored() {
  const session = fakeSession([
    [rowText("柳毓琳", "hi"), rowText("陌生人", "在吗")],
    [rowText("柳毓琳", "hi"), rowText("陌生人", "在吗？")],
  ]);
  const source = new PreviewInboundSource(TARGET, { session, allowPeers: ["柳毓琳"] });
  source.poll();
  const events = source.poll();
  assert.deepStrictEqual(events, [], "only allowed peers may produce inbound events");
  assert.strictEqual(source.stats.skippedNotAllowed, 1);
  console.log("ok   non-allowlisted peers never produce events");
}

function unread_badge_marks_a_stronger_signal() {
  const session = fakeSession([
    [rowText("柳毓琳", "hi")],
    [rowText("柳毓琳", "在吗", "13:01", "[2条] ")],
  ]);
  const source = new PreviewInboundSource(TARGET, { session });
  source.poll();
  const [event] = source.poll();
  assert.ok(event, "a changed row with an unread badge must produce an event");
  assert.strictEqual(event.peer, "柳毓琳");
  assert.strictEqual(event.text, "在吗");
  assert.strictEqual(event.unread, 2);
  assert.strictEqual(event.confidence, "unread-badge");
  assert.strictEqual(event.replyTarget, "柳毓琳", "the row is the only reply handle a UIA writer has");
  assert.strictEqual(event.direction, "incoming");
  console.log("ok   an unread badge is reported as the stronger signal");
}

function reorder_alone_is_not_a_new_message() {
  const session = fakeSession([
    [rowText("A", "one"), rowText("B", "two")],
    [rowText("B", "two"), rowText("A", "one")],
  ]);
  const source = new PreviewInboundSource(TARGET, { session });
  source.poll();
  const events = source.poll();
  assert.deepStrictEqual(events, [], "reordering rows is not a new message: identity is per peer, not per position");
  console.log("ok   a pure reorder produces no events");
  assert.strictEqual(rowDigest(parseRow(rowText("A", "one"))).startsWith("A"), true);
}

/**
 * The failure this guards against is the worst one available to this design: the
 * loop's own send changes the row, the row change is the inbound signal, and the
 * bot spends the rest of the day talking to itself.
 */
function the_sent_ledger_stops_the_bot_answering_itself() {
  const ledger = new SentLedger();
  ledger.record("柳毓琳", "机器人刚发的回复");
  assert.strictEqual(ledger.matches("柳毓琳", "机器人刚发的回复"), true, "exact preview must be recognised as ours");
  assert.strictEqual(ledger.matches("柳毓琳", "机器人刚发的回复（截断"), true, "a truncated preview still starts with our text");
  assert.strictEqual(ledger.matches("柳毓琳", "在吗"), false, "a genuinely different preview is not ours");
  assert.strictEqual(ledger.matches("别人", "机器人刚发的回复"), false, "the ledger is per peer");

  const session = fakeSession([
    [rowText("柳毓琳", "在吗")],
    [rowText("柳毓琳", "echo: 在吗")],
    [rowText("柳毓琳", "在吗？")],
  ]);
  const source = new PreviewInboundSource(TARGET, { session });
  source.poll();
  // The loop records what it sends *before* the next poll - that is what runOnce
  // does, and it is the only reason the echo below can be recognised as ours.
  ledger.record("柳毓琳", "echo: 在吗");
  const own = source.poll({ isOwnEcho: (row) => ledger.matches(row.peer, row.preview) });
  assert.deepStrictEqual(own, [], "our own reply must not come back as inbound");
  const theirs = source.poll({ isOwnEcho: (row) => ledger.matches(row.peer, row.preview) });
  assert.strictEqual(theirs.length, 1, "a real follow-up still gets through");
  assert.strictEqual(theirs[0].text, "在吗？");
  console.log("ok   the sent ledger stops the bot from answering its own replies");
}

main();