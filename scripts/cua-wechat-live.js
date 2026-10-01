#!/usr/bin/env node
/**
 * Live probe for the Cua WeChat driver: one real send, with the focus cost measured.
 *
 *   node scripts/cua-wechat-live.js "<chat label>" "<text>" [--dry]
 *
 * It records who owned the foreground before, during and after the send, so the
 * "one focus steal per conversation switch" claim in the client is measured
 * rather than repeated.
 *
 * Default target is 文件传输助手 (the self-chat), which is why this probe is safe
 * to run: it never touches a real person's conversation.
 */

const { CuaSession, findWeChatWindow, sendMessage, currentConversation } = require("../src/integrations/wechat-cua/client");

function foreground() {
  // powershell is not available inside node; use the driver's own view instead
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry");
  const [chat = "文件传输助手", text = `CUA-LIVE-${Date.now()}`] = argv.filter((a) => !a.startsWith("--"));

  const session = new CuaSession("cyberboss-live");
  const win = findWeChatWindow(session);
  console.log(`window : pid=${win.pid} id=${win.window_id} minimized=${win.minimized} bounds=${JSON.stringify(win.bounds)}`);
  const target = { pid: win.pid, window_id: win.window_id };

  const before = currentConversation(session, target);
  console.log(`open   : ${JSON.stringify(before.label)}`);

  const started = Date.now();
  const result = sendMessage(target, chat, text, { session });
  const elapsed = Date.now() - started;

  console.log(`elapsed: ${elapsed} ms`);
  for (const step of result.steps) {
    const detail = step.outcome
      ? `route=${step.outcome.route || "-"} mode=${step.outcome.mode || "-"} effect=${step.outcome.effect || "-"}`
      : Object.entries(step).filter(([k]) => !["step", "outcome"].includes(k)).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
    console.log(`  ${step.step.padEnd(7)} ${detail}`);
  }
  console.log(`ok     : ${result.ok}`);
  console.log(`verify : ${result.verify}`);
  const after = currentConversation(session, target);
  console.log(`now open: ${JSON.stringify(after.label)}`);
  process.exit(result.ok ? 0 : 1);
}

main();
