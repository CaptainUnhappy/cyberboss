#!/usr/bin/env node
/**
 * Offline tests for the Cua inbound source.
 *
 * What matters here is not that it polls, but that it is *safe to leave running*:
 *
 *   - the first poll establishes a baseline and never replays the chat list
 *   - our own sends are suppressed through the echo ledger, because direction is
 *     not readable on this path
 *   - peers outside the allow list are never handed to the turn pipeline
 *   - a handler that throws does not kill the loop
 *   - deep reads are rate-limited: opening a conversation costs the foreground
 *
 * Run: node test/wechat-cua-inbox-source.test.js
 */

const assert = require("assert");

const { WeChatCuaInboxSource, synthesizeId } = require("../src/integrations/wechat-cua/inbox");
const { CuaSession } = require("../src/integrations/wechat-cua/client");
const { SentLedger } = require("../src/integrations/wechat-cua/loop");

const TARGET = { pid: 3, window_id: 4 };
const row = (peer, preview, time = "13:00", badge = "") => `${peer}\n${badge}${preview}\n${time}\n`;

function fakeSession(rowSets) {
  const session = new CuaSession("test");
  let call = 0;
  session.snapshot = () => {
    const labels = rowSets[Math.min(call, rowSets.length - 1)];
    call += 1;
    return {
      elements: labels.map((label, i) => ({
        role: "ListItem",
        label,
        element_token: `tok-${i}`,
        element_index: 100 + i,
        frame: { y: 100 + i * 80, w: 300, h: 78 },
      })),
    };
  };
  return session;
}

async function main() {
  await baseline_is_not_replayed();
  await our_own_send_is_suppressed_by_the_ledger();
  await peers_outside_the_allow_list_are_never_delivered();
  await a_throwing_handler_does_not_kill_the_poll();
  await deep_reads_are_rate_limited();
  await an_empty_allow_list_means_nobody();
  console.log("all cua inbox tests passed");
}

async function baseline_is_not_replayed() {
  const delivered = [];
  const source = new WeChatCuaInboxSource({
    config: { wechatCuaAllowPeers: "柳毓琳" },
    session: fakeSession([[row("柳毓琳", "hi"), row("Azzy", "ok")]]),
    target: TARGET,
    onMessage: (m) => delivered.push(m),
    logger: { log() {}, warn() {} },
  });
  // start() primes; then one explicit poll with no change.
  await source.start();
  source.stop();
  assert.deepStrictEqual(delivered, [], "starting the source must not replay the existing chat list");
  assert.strictEqual(await source.pollOnce(), 0);
  console.log("ok   the first poll primes instead of replaying");
}

async function our_own_send_is_suppressed_by_the_ledger() {
  const delivered = [];
  const ledger = new SentLedger();
  ledger.record("柳毓琳", "机器人刚发的回复");
  const source = new WeChatCuaInboxSource({
    config: { wechatCuaAllowPeers: "柳毓琳" },
    session: fakeSession([
      [row("柳毓琳", "hi")],
      [row("柳毓琳", "机器人刚发的回复")],
    ]),
    target: TARGET,
    ledger,
    onMessage: (m) => delivered.push(m),
    logger: { log() {}, warn() {} },
  });
  await source.start();
  source.stop();
  const n = await source.pollOnce();
  assert.strictEqual(n, 0, "a row carrying our own text must not be delivered");
  assert.deepStrictEqual(delivered, []);
  assert.strictEqual(source.stats.suppressed, 1, "the suppression must be counted, not silent");
  console.log("ok   our own send is suppressed through the echo ledger");
}

async function peers_outside_the_allow_list_are_never_delivered() {
  const delivered = [];
  const source = new WeChatCuaInboxSource({
    config: { wechatCuaAllowPeers: "柳毓琳" },
    session: fakeSession([
      [row("柳毓琳", "hi")],
      [row("陌生人", "在吗")],
    ]),
    target: TARGET,
    onMessage: (m) => delivered.push(m),
    logger: { log() {}, warn() {} },
  });
  await source.start();
  source.stop();
  assert.strictEqual(await source.pollOnce(), 0);
  assert.deepStrictEqual(delivered, [], "a bot with a real account must not answer strangers by default");
  console.log("ok   non-allowlisted peers never reach the pipeline");
}

async function a_throwing_handler_does_not_kill_the_poll() {
  let calls = 0;
  const source = new WeChatCuaInboxSource({
    config: { wechatCuaAllowPeers: "柳毓琳" },
    session: fakeSession([
      [row("柳毓琳", "hi")],
      [row("柳毓琳", "在吗")],
    ]),
    target: TARGET,
    onMessage: () => {
      calls += 1;
      throw new Error("pipeline exploded");
    },
    logger: { log() {}, warn() {} },
  });
  await source.start();
  source.stop();
  const n = await source.pollOnce();
  assert.strictEqual(calls, 1, "the handler must be invoked");
  assert.strictEqual(n, 0, "a throwing handler delivers nothing");
  assert.strictEqual(source.stats.errors, 1, "the error is counted");
  console.log("ok   a throwing handler is contained and counted");
}

async function deep_reads_are_rate_limited() {
  let opened = 0;
  let openedSpy = 0;
  const source = new WeChatCuaInboxSource({
    config: { wechatCuaAllowPeers: "柳毓琳" },
    session: fakeSession([
      [row("柳毓琳", "hi")],
      [row("柳毓琳", "在吗")],
      [row("柳毓琳", "还在吗")],
    ]),
    target: TARGET,
    deepRead: true,
    deepReadCooldownMs: 60_000,
    conversationOpener: () => { openedSpy += 1; return true; },
    onMessage: () => true,
    logger: { log() {}, warn() {} },
  });
  await source.start();
  const injected = source.source.openConversation;
  assert.strictEqual(typeof injected, "function", "deepRead must supply the opener");
  // The opener is what takes the foreground; it must refuse during the cooldown.
  const first = injected({}, TARGET, "柳毓琳");
  const second = injected({}, TARGET, "柳毓琳");
  opened += Number(first) + Number(second);
  assert.strictEqual(openedSpy, 1, "the opener must be called exactly once inside the cooldown");
  source.stop();
  assert.strictEqual(opened, 1, "a second deep read inside the cooldown must be refused");
  console.log("ok   deep reads are rate-limited so the desktop cannot become a slideshow");
}

void synthesizeId;
main();

/**
 * The dangerous default: with no peer list configured, `PreviewInboundSource`
 * treats `null` as "unrestricted". A bot holding a real WeChat account must not
 * start answering strangers because a variable was left unset.
 */
async function an_empty_allow_list_means_nobody() {
  const delivered = [];
  const source = new WeChatCuaInboxSource({
    config: {}, // no allow-list at all
    session: fakeSession([
      [row("柳毓琳", "hi")],
      [row("柳毓琳", "在吗")],
    ]),
    target: TARGET,
    onMessage: (m) => delivered.push(m),
    logger: { log() {}, warn() {} },
  });
  await source.start();
  source.stop();
  const n = await source.pollOnce();
  assert.strictEqual(n, 0, "an unconfigured allow-list must not deliver anything");
  assert.deepStrictEqual(delivered, [], "nobody may be answered when nobody is allowed");
  console.log("ok   an empty allow-list means nobody, not everybody");
}