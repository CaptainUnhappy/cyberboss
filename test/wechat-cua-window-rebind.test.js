#!/usr/bin/env node
/**
 * A WeChat restart must not leave the channel deaf.
 *
 * Measured 2026-10-03: WeChat was restarted (a login) and the production inbox logged
 * `cua inbox poll failed: cua snapshot failed: No window with window_id 68300 exists`
 * on every single poll, forever. The driver and the daemon were healthy - only the
 * cached window handle was stale, and the recovery ladder was aimed at the daemon, so
 * nothing ever re-resolved the window.
 *
 * Run: node --test test/wechat-cua-window-rebind.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { PreviewInboundSource } = require("../src/integrations/wechat-cua/inbound");
const { WeChatCuaInboxSource } = require("../src/integrations/wechat-cua/inbox");

const STALE = 'cua snapshot failed: No window with window_id 68300 exists. Call `list_windows({"pid": 20384})`';
const NEW_WINDOW = { pid: 28704, window_id: 985510, title: "微信" };

test("a source can be re-pointed at the new window without replaying old messages", () => {
  const source = new PreviewInboundSource({ pid: 20384, window_id: 68300 }, { session: {} });
  source.primed = true;
  source.watermarks.set("文件传输助手", "older text");
  source.rebind(NEW_WINDOW);
  assert.equal(source.target.window_id, NEW_WINDOW.window_id);
  assert.equal(source.primed, true, "the baseline must survive: a restart is not 'everything is new'");
  assert.equal(source.watermarks.get("文件传输助手"), "older text");
});

test("a stale-window poll failure re-resolves the window immediately", () => {
  const inbox = new WeChatCuaInboxSource({
    config: { wechatCuaAllowPeers: "文件传输助手" },
    session: {},
    onMessage: async () => true,
    target: { pid: 20384, window_id: 68300 },
    recoverAfterFailures: 3,
    logger: { log() {}, warn() {}, error() {} },
    ensureDriver: () => ({ started: false }),
  });
  const calls = [];
  inbox.refreshTarget = () => { calls.push("refresh"); return NEW_WINDOW; };

  inbox.recoverFromFailure(new Error(STALE));
  assert.deepEqual(calls, ["refresh"], "a disappeared window must be re-resolved on the FIRST failure, not after a threshold");

  // A driver failure must still take the daemon ladder instead.
  const daemonCalls = [];
  inbox.ensureDriver = () => { daemonCalls.push("daemon"); return { started: false, how: "failed" }; };
  inbox.stats.consecutiveErrors = 99;                       // past the threshold
  inbox.recoverFromFailure(new Error("daemon is not running"));
  assert.deepEqual(daemonCalls, ["daemon"]);
});

test("re-resolving a window that is genuinely gone is reported, not thrown", () => {
  const warnings = [];
  const inbox = new WeChatCuaInboxSource({
    config: { wechatCuaAllowPeers: "文件传输助手" },
    session: {},
    onMessage: async () => true,
    target: { pid: 1, window_id: 2 },
    logger: { log() {}, warn: (message) => warnings.push(message), error() {} },
  });
  // The real implementation calls findWeChatWindow, which talks to the driver; with no
  // WeChat at all it throws, and the failure must be logged rather than escape.
  const result = inbox.refreshTarget();
  assert.equal(result, null);
  assert.ok(warnings.some((line) => /could not re-resolve/.test(line)), `expected a warning, got ${JSON.stringify(warnings)}`);
});
