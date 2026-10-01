#!/usr/bin/env node
/**
 * Offline tests for the `doctor` channel probes.
 *
 * These are the acceptance criteria from
 * `.agents/notes/proposed/feature/2026-09-30-dual-channel-first-class-contract.md`:
 * the "two channels, one of them silently dead" cases must be distinguishable
 * without sending a message. Everything runs against a fake fetch, so the suite
 * never touches the real bot, the real WeChat, or the real isolated session.
 *
 * Run: node test/doctor-probes.test.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  probeChannels,
  probeIlink,
  probeWeFlowUia,
  probeWeChatCua,
  readDeclaredChannels,
  summarizeChannels,
} = require("../src/core/doctor-probes");

/** Minimal config: only the fields the probes read. */
function makeConfig(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-doctor-"));
  return {
    stateDir: dir,
    accountsDir: path.join(dir, "accounts"),
    weixinBaseUrl: "https://ilink.example.invalid",
    weflowBaseUrl: "http://127.0.0.1:5051",
    weflowBridgeBaseUrl: "http://127.0.0.1:8776",
    weflowToken: "test-token",
    weflowInboxChat: "wxid_big",
    weflowInboxChats: ["wxid_big"],
    ...overrides,
  };
}

function pairAccount(config, { token = "bot-token", userId = "bot-user" } = {}) {
  fs.mkdirSync(config.accountsDir, { recursive: true });
  fs.writeFileSync(
    path.join(config.accountsDir, "27cd579d9604-im.bot.json"),
    JSON.stringify({ accountId: "27cd579d9604-im.bot", userId, token, baseUrl: config.weixinBaseUrl, savedAt: "2026-09-30T00:00:00.000Z" }),
    "utf8"
  );
}

function jsonResponse(body, status = 200) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

/** Route by URL fragment. Anything unrouted throws, so a probe that grows an
 *  unexpected call fails loudly instead of silently "passing". */
function makeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    calls.push({ url: target, method: options.method || "GET" });
    for (const [fragment, handler] of routes) {
      if (target.includes(fragment)) {
        return typeof handler === "function" ? handler(target, options) : handler;
      }
    }
    throw new Error(`unrouted fetch: ${target}`);
  };
  fetchImpl.calls = calls;
  fetchImpl.paths = () => calls.map((call) => call.url);
  return fetchImpl;
}

/**
 * The iLink branch goes through `api.js`, which binds `globalThis.fetch` at
 * module load, so an injected `fetchImpl` cannot reach it. Patching the global
 * for the duration of one call keeps the test on the production code path
 * instead of a re-implementation of it.
 */
async function withGlobalFetch(fetchImpl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const WEFLOW_OK = [
  ["/api/v1/health", jsonResponse({ status: "ok" })],
  ["/api/v1/messages", jsonResponse({ messages: [], hasMore: false })],
  ["/readyz", jsonResponse({ ready: true })],
  ["/api/probe", jsonResponse({ ok: true, foreground: 1115708, desktopIdleSeconds: 2327 })],
];

const enabledEnv = { CYBERBOSS_ENABLE_WEFLOW_INBOX: "true" };

async function testIlinkNotPaired() {
  const config = makeConfig();
  const fetchImpl = makeFetch([]);
  const result = await probeIlink(config, { fetchImpl });
  assert.strictEqual(result.enabled, false);
  assert.strictEqual(result.ready, false);
  assert.strictEqual(result.reason, "no-paired-account");
  assert.strictEqual(fetchImpl.calls.length, 0, "an unpaired channel must not call the network");
}

async function testIlinkReady() {
  const config = makeConfig();
  pairAccount(config);
  const fetchImpl = makeFetch([["ilink/bot/getconfig", jsonResponse({ ret: 0 })]]);
  const result = await withGlobalFetch(fetchImpl, () => probeIlink(config, { fetchImpl }));
  assert.strictEqual(result.enabled, true);
  assert.strictEqual(result.ready, true, `expected ready, got ${result.reason}: ${result.detail}`);
  assert.ok(fetchImpl.paths().every((url) => !url.includes("sendmessage")), "the probe must never send a message");
}

async function testIlinkStaleToken() {
  const config = makeConfig();
  pairAccount(config);
  const fetchImpl = makeFetch([["ilink/bot/getconfig", jsonResponse({ ret: -14, errmsg: "session timeout" })]]);
  const result = await withGlobalFetch(fetchImpl, () => probeIlink(config, { fetchImpl }));
  assert.strictEqual(result.ready, false);
  assert.strictEqual(result.reason, "stale-token");
  assert.match(result.detail, /login/, "the reason must tell the operator what to do");
}

async function testWeFlowUnconfigured() {
  const config = makeConfig({ weflowToken: "" });
  const fetchImpl = makeFetch([]);
  const result = await probeWeFlowUia(config, { fetchImpl, env: {} });
  assert.strictEqual(result.enabled, false);
  assert.strictEqual(result.ready, false);
  assert.strictEqual(result.reason, "disabled");
  assert.strictEqual(fetchImpl.calls.length, 0, "a disabled channel must not be probed");
}

async function testWeFlowReaderHealthOkButMessages500() {
  const config = makeConfig();
  const fetchImpl = makeFetch([
    ["/api/v1/health", jsonResponse({ status: "ok" })],
    ["/api/v1/messages", jsonResponse({ error: "错误码: -105" }, 500)],
  ]);
  const result = await probeWeFlowUia(config, { fetchImpl, env: enabledEnv });
  assert.strictEqual(result.ready, false);
  assert.strictEqual(result.reason, "reader-messages-failed");
  assert.match(result.detail, /-105/, "the -105 signature must survive into the report");
}

async function testWeFlowWriterDesktopLost() {
  const config = makeConfig();
  const fetchImpl = makeFetch([
    ["/api/v1/health", jsonResponse({ status: "ok" })],
    ["/api/v1/messages", jsonResponse({ messages: [] })],
    ["/readyz", jsonResponse({ ready: true })],
    ["/api/probe", jsonResponse({ ok: false, foreground: 0 })],
  ]);
  const result = await probeWeFlowUia(config, { fetchImpl, env: enabledEnv });
  assert.strictEqual(result.ready, false);
  assert.strictEqual(result.reason, "writer-desktop-unavailable");
  assert.ok(
    fetchImpl.paths().every((url) => !url.includes("move=1")),
    "the probe must use the read-only form of /api/probe"
  );
}

async function testWeFlowReady() {
  const config = makeConfig();
  const fetchImpl = makeFetch(WEFLOW_OK);
  const result = await probeWeFlowUia(config, { fetchImpl, env: enabledEnv });
  assert.strictEqual(result.enabled, true);
  assert.strictEqual(result.ready, true, `expected ready, got ${result.reason}: ${result.detail}`);
  assert.match(result.detail, /reader=ok writer=ready/);
}

async function testDeclaredChannelsFilter() {
  const config = makeConfig();
  // Read from the config object (the production path) and from the env fallback.
  assert.deepStrictEqual(readDeclaredChannels({ enabledChannels: ["ilink"] }).declared, ["ilink"]);
  assert.deepStrictEqual(readDeclaredChannels({}, { CYBERBOSS_ENABLED_CHANNELS: "ILINK, weflow-uia" }).declared, ["ilink", "weflow-uia"]);
  assert.deepStrictEqual(readDeclaredChannels({}).declared, []);
  assert.deepStrictEqual(readDeclaredChannels({}, { CYBERBOSS_ENABLED_CHANNELS: "ilink,bogus" }).invalid, ["bogus"]);

  const fetchImpl = makeFetch([["ilink/bot/getconfig", jsonResponse({ ret: 0 })]]);
  pairAccount(config);
  const scoped = { ...config, enabledChannels: ["ilink"] };
  const only = await withGlobalFetch(fetchImpl, () => probeChannels(scoped, { fetchImpl }));
  assert.strictEqual(only.length, 1);
  assert.strictEqual(only[0].channel, "ilink");
  assert.ok(fetchImpl.paths().every((url) => url.includes("getconfig")), "the filtered-out channel must not be probed");
}

async function testChannelsSummaryDrivesExitCode() {
  const config = makeConfig();
  pairAccount(config);
  const fetchImpl = makeFetch([
    ["ilink/bot/getconfig", jsonResponse({ ret: 0 })],
    ...WEFLOW_OK,
  ]);
  const results = await withGlobalFetch(fetchImpl, () => probeChannels(config, { fetchImpl, env: enabledEnv }));
  const summary = summarizeChannels(results);
  assert.deepStrictEqual(summary.enabled.sort(), ["ilink", "weflow-uia"]);
  assert.strictEqual(summary.ok, true, `expected all ready: ${JSON.stringify(results)}`);

  // A channel that is not configured must not make doctor fail.
  const partial = summarizeChannels([
    { channel: "ilink", enabled: false, ready: false, reason: "no-paired-account" },
    { channel: "weflow-uia", enabled: true, ready: true },
  ]);
  assert.strictEqual(partial.ok, true);
  assert.deepStrictEqual(partial.notReady, []);

  // An enabled-but-dead channel must.
  const broken = summarizeChannels([
    { channel: "ilink", enabled: true, ready: false, reason: "stale-token" },
    { channel: "weflow-uia", enabled: true, ready: true },
  ]);
  assert.strictEqual(broken.ok, false);
  assert.deepStrictEqual(broken.notReady, ["ilink"]);
}

/** The Cua channel's four ways of being silently mute, as doctor must report them. */
async function testCuaDriverDown() {
  const result = await probeWeChatCua(
    { wechatCuaEnabled: true, wechatCuaAllowPeers: "柳毓琳", wechatCuaChatByTalker: "柳毓琳=柳毓琳" },
    { exec: () => { throw Object.assign(new Error("exit 1"), { stderr: "Cua Driver daemon is not running" }); } }
  );
  assert.strictEqual(result.enabled, true);
  assert.strictEqual(result.ready, false);
  assert.strictEqual(result.reason, "driver-not-running");
  assert.match(result.detail, /cua-driver serve/, "the operator must be told how to fix it");
}

async function testCuaMissingMapping() {
  const result = await probeWeChatCua(
    { wechatCuaEnabled: true, wechatCuaAllowPeers: "柳毓琳,Azzy", wechatCuaChatByTalker: "柳毓琳=柳毓琳" },
    { exec: () => "Cua Driver daemon is running", findWindow: () => ({ pid: 1, title: "微信", minimized: false }) }
  );
  assert.strictEqual(result.ready, false);
  assert.strictEqual(result.reason, "missing-chat-mapping");
  assert.match(result.detail, /"Azzy"/);

  // A minimized window still reads but cannot be written to - a distinct answer.
  const minimized = await probeWeChatCua(
    { wechatCuaEnabled: true, wechatCuaAllowPeers: "柳毓琳", wechatCuaChatByTalker: "柳毓琳=柳毓琳" },
    { exec: () => "Cua Driver daemon is running", findWindow: () => ({ pid: 1, title: "微信", minimized: true }) }
  );
  assert.strictEqual(minimized.reason, "window-minimized");
}

async function testCuaReady() {
  const result = await probeWeChatCua(
    {
      wechatCuaEnabled: true,
      wechatCuaInboxEnabled: true,
      wechatCuaAllowPeers: "柳毓琳,Azzy",
      wechatCuaChatByTalker: "柳毓琳=柳毓琳,Azzy=Azzy",
    },
    { exec: () => "Cua Driver daemon is running", findWindow: () => ({ pid: 1, title: "微信", minimized: false }) }
  );
  assert.strictEqual(result.ready, true);
  assert.strictEqual(result.reason, "");
  assert.match(result.detail, /answers "柳毓琳", "Azzy"/);

  // An empty allow-list is fail-closed and must not look ready.
  const emptyList = await probeWeChatCua(
    { wechatCuaEnabled: true },
    { exec: () => "Cua Driver daemon is running", findWindow: () => ({ pid: 1, title: "微信", minimized: false }) }
  );
  assert.strictEqual(emptyList.reason, "allow-list-empty");

  // Not enabled at all is "disabled", which the summary does not count against us.
  const off = await probeWeChatCua({}, { exec: () => "Cua Driver daemon is running" });
  assert.strictEqual(off.enabled, false);
  assert.strictEqual(off.reason, "disabled");
}

async function main() {
  const cases = [
    ["unpaired ilink reports no-paired-account without network", testIlinkNotPaired],
    ["paired ilink reports ready and never sends", testIlinkReady],
    ["stale ilink token is actionable, not fatal", testIlinkStaleToken],
    ["unconfigured weflow-uia is disabled, not an error", testWeFlowUnconfigured],
    ["reader health 200 with messages 500 is NOT ready", testWeFlowReaderHealthOkButMessages500],
    ["lost input desktop is NOT ready and no cursor move", testWeFlowWriterDesktopLost],
    ["fully wired weflow-uia reports ready", testWeFlowReady],
    ["CYBERBOSS_ENABLED_CHANNELS filters probes", testDeclaredChannelsFilter],
    ["summary decides the doctor exit code", testChannelsSummaryDrivesExitCode],
    ["cua channel: daemon down is not ready, and says how to fix it", testCuaDriverDown],
    ["cua channel: a peer without a chat mapping is not ready", testCuaMissingMapping],
    ["cua channel: a wired setup reports ready", testCuaReady],
  ];
  let failures = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${name}: ${error.message}`);
    }
  }
  if (failures) {
    console.error(`${cases.length - failures}/${cases.length} passed`);
    process.exitCode = 1;
    return;
  }
  console.log(`${cases.length}/${cases.length} passed`);
}

if (require.main === module) {
  main();
}
