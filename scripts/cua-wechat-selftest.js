#!/usr/bin/env node
/**
 * Wiring self-test for the Cua path, without starting the bot.
 *
 *   node scripts/cua-wechat-selftest.js [--peer <display name>] [--json]
 *
 * The final acceptance step for this design needs a real inbound message, which
 * only a human can send. Everything *around* that message can be proven without
 * one, and this script proves it:
 *
 *   1. the driver daemon is reachable and WeChat is visible to it
 *   2. the config keys the Cua path reads are actually set (and which ones)
 *   3. the inbound source constructs, primes, and polls - and the FIRST poll
 *      emits nothing, i.e. starting the bot cannot replay the whole chat list
 *   4. our own recent send is suppressed by the echo ledger
 *   5. the peer allow-list is non-empty (an empty list means "answer nobody",
 *      which is the safe default and worth seeing in the output)
 *
 * It never clicks, types, or sends: read-only apart from the echo ledger, which
 * is in-process.
 */

const { CuaSession, findWeChatWindow } = require("../src/integrations/wechat-cua/client");
const { WeChatCuaInboxSource } = require("../src/integrations/wechat-cua/inbox");
const { SentLedger } = require("../src/integrations/wechat-cua/loop");
const { readRows } = require("../src/integrations/wechat-cua/inbound");

const pass = (ok) => (ok ? "PASS" : "FAIL");

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const peer = argv.includes("--peer") ? argv[argv.indexOf("--peer") + 1] : "文件传输助手";
  const checks = [];
  const record = (name, ok, detail) => checks.push({ name, ok, detail });

  // --- 1) driver + window ----------------------------------------------------
  const session = new CuaSession("cyberboss-selftest");
  // The driver only exposes reviewed tools; `status` is a CLI subcommand, not a
  // callable tool (calling it returns `no reviewed risk classification`). The
  // honest reachability probe is the smallest real call.
  const probe = session.call("list_windows", { on_screen_only: false });
  const daemonUp = !probe.__failed;
  const windowCount = (probe.windows || probe._legacy_windows || []).length;
  record("driver daemon reachable", daemonUp, daemonUp ? `${windowCount} window(s) visible` : JSON.stringify(probe.payload).slice(0, 160));

  let win = null;
  try {
    win = findWeChatWindow(session);
    record("WeChat window visible to the driver", true, `pid=${win.pid} id=${win.window_id} minimized=${win.minimized}`);
  } catch (error) {
    record("WeChat window visible to the driver", false, error.message);
  }

  // --- 2) configuration ------------------------------------------------------
  const env = process.env;
  const config = {
    wechatCuaEnabled: ["1", "true", "yes", "on"].includes(String(env.CYBERBOSS_ENABLE_WECHAT_CUA || "").toLowerCase()),
    wechatCuaInboxEnabled: ["1", "true", "yes", "on"].includes(String(env.CYBERBOSS_ENABLE_WECHAT_CUA_INBOX || "").toLowerCase()),
    wechatCuaInboxDeepRead: ["1", "true", "yes", "on"].includes(String(env.CYBERBOSS_WECHAT_CUA_INBOX_DEEP_READ || "").toLowerCase()),
    wechatCuaAllowPeers: String(env.CYBERBOSS_WECHAT_CUA_ALLOW_PEERS || "").trim(),
    wechatCuaChatByTalker: String(env.CYBERBOSS_CUA_CHAT_BY_TALKER || "").trim(),
    weflowWindowLabels: {},
  };
  record("outbound switch read", true, `CYBERBOSS_ENABLE_WECHAT_CUA=${config.wechatCuaEnabled}`);
  record("inbound switch read", true, `CYBERBOSS_ENABLE_WECHAT_CUA_INBOX=${config.wechatCuaInboxEnabled}`);
  record(
    "talker -> conversation mapping present",
    Boolean(config.wechatCuaChatByTalker) || !config.wechatCuaEnabled,
    config.wechatCuaChatByTalker ? "set" : "empty (a send would refuse rather than guess)",
  );

  // --- 3) the source constructs, primes, and polls ---------------------------
  if (!win) {
    finish(checks, asJson);
  }
  const ledger = new SentLedger();
  const delivered = [];
  const source = new WeChatCuaInboxSource({
    config,
    session,
    target: win,
    ledger,
    onMessage: (message) => {
      delivered.push(message);
      return true;
    },
    logger: { log() {}, warn() {} },
  });

  const rows = readRows(session, win);
  record("chat list readable", rows.length > 0, `${rows.length} conversation row(s)`);

  return source.start().then(async () => {
    const afterStart = delivered.length;
    record(
      "starting the source does not replay history",
      afterStart === 0,
      afterStart === 0 ? "0 messages delivered on prime" : `${afterStart} delivered on prime (WRONG: history would be answered)`,
    );

    // 4) our own recent send must be suppressed.
    const ownRow = rows.find((r) => r.peer === peer);
    if (ownRow && ownRow.preview) {
      // Assert the mechanism, not a coincidence: a row whose preview is what we
      // last sent must be recognised as ours, otherwise the loop answers itself.
      ledger.record(peer, ownRow.preview);
      const recognised = ledger.matches(peer, ownRow.preview);
      record(
        "our own last send is recognised by the echo ledger",
        recognised,
        recognised ? `would suppress ${JSON.stringify(ownRow.preview.slice(0, 30))}` : "NOT recognised - the loop could answer itself",
      );
    } else {
      record("our own last send is recognised by the echo ledger", true, `no row for ${JSON.stringify(peer)} yet`);
    }

    // 5) the allow-list is what decides who may be answered.
    const allow = source.allowPeers();
    record(
      "peer allow-list",
      allow.length > 0,
      allow.length ? JSON.stringify(allow) : "EMPTY - the bot would answer nobody (safe, but check this is intended)",
    );

    source.stop();
    finish(checks, asJson);
  });
}

function finish(checks, asJson) {
  const failed = checks.filter((c) => !c.ok);
  if (asJson) {
    console.log(JSON.stringify({ checks, ok: failed.length === 0 }, null, 2));
  } else {
    for (const check of checks) {
      console.log(`[${pass(check.ok)}] ${check.name}${check.detail ? ` - ${check.detail}` : ""}`);
    }
    console.log(failed.length ? `VERDICT: ${failed.length} check(s) failed` : "VERDICT: wiring OK");
  }
  process.exit(failed.length ? 1 : 0);
}

main();
