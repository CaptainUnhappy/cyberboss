#!/usr/bin/env node
/**
 * Media diagnostics: find out what a paste actually does, step by step.
 *
 *   node scripts/cua-wechat-media-diag.js [--chat "文件传输助手"] [--file <path>]
 *
 * The earlier attempt failed silently: the driver reported a successful Ctrl+V
 * while the composer stayed empty, and the only reason no junk was published is
 * the confirmation gate in media.js. This script stops guessing and captures
 * evidence at each step:
 *
 *   1. put the payload on the clipboard, then READ IT BACK through the driver
 *   2. paste, then screenshot the composer region and save it for inspection
 *   3. report the composer's UIA value (an object shows up as U+FFFC)
 *
 * It sends nothing: pressing Return is left to the caller once the evidence says
 * the composer actually holds the payload.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CuaSession, findWeChatWindow, toTarget, ensureConversation, currentConversation } = require("../src/integrations/wechat-cua/client");
const { readConversation } = require("../src/integrations/wechat-cua/inbound");

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const log = (line) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

function saveShot(session, target, file) {
  const snap = session.call("get_window_state", { ...toTarget(target), capture_mode: "vision" });
  if (!snap.screenshot_png_b64) return null;
  fs.writeFileSync(file, Buffer.from(snap.screenshot_png_b64, "base64"));
  return { file, width: snap.screenshot_width, height: snap.screenshot_height };
}

function main() {
  const argv = process.argv.slice(2);
  const chat = argv.includes("--chat") ? argv[argv.indexOf("--chat") + 1] : "文件传输助手";
  const fileArg = argv.includes("--file") ? argv[argv.indexOf("--file") + 1] : "";
  const payloadPath = fileArg || path.join(os.tmpdir(), `cua-diag-${Date.now()}.png`);
  if (!fileArg) {
    // A tiny valid PNG so the payload is real even without an input file.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAHElEQVRoge3BAQ0AAADCoPdPbQ8HFAAAAAAAAPBqHgAAAX8B9nkAAAAASUVORK5CYII=",
      "base64"
    );
    fs.writeFileSync(payloadPath, png);
  }
  log(`payload: ${payloadPath} (${fs.statSync(payloadPath).size} bytes)`);

  const session = new CuaSession("cyberboss-media-diag");
  const target = findWeChatWindow(session);
  const opened = ensureConversation(session, toTarget(target), chat);
  log(`open   : ${JSON.stringify(chat)} route=${opened.route} cost=${opened.cost}`);

  const isImage = /\.(png|jpe?g|gif|webp)$/iu.test(payloadPath);

  // --- 1) clipboard, with read-back -----------------------------------------
  const write = session.call("clipboard_write", isImage ? { image_path: payloadPath } : { file_path: payloadPath });
  log(`clipboard_write -> ${JSON.stringify(write).slice(0, 220)}`);
  sleep(600);
  const readBack = session.call("clipboard_read", {});
  const types = readBack?.types || readBack?.available_types || readBack?.formats || null;
  const text = typeof readBack?.text === "string" ? readBack.text : "";
  log(`clipboard_read  -> types=${JSON.stringify(types)} text=${JSON.stringify(text.slice(0, 60))}`);

  // --- 2) paste, then look at the composer ----------------------------------
  const boxBefore = String(currentConversation(session, toTarget(target)).box?.value ?? "");
  log(`box before      : ${JSON.stringify(boxBefore)}`);

  for (const mode of ["background", "foreground"]) {
    const res = session.call("hotkey", { ...toTarget(target), keys: ["ctrl", "v"], delivery_mode: mode });
    log(`paste(${mode}) -> ${JSON.stringify({ route: res.route, mode: res.delivery?.mode, summary: res.summary }).slice(0, 200)}`);
    sleep(2500);
    const box = currentConversation(session, toTarget(target)).box;
    const value = String(box?.value ?? "");
    const shot = saveShot(session, target, path.join(os.tmpdir(), `cua-diag-after-${mode}.png`));
    const messages = readConversation(session, toTarget(target));
    log(`  box value     : ${JSON.stringify(value)}  (U+FFFC present: ${value.includes("\uFFFC")})`);
    log(`  screenshot    : ${shot ? `${shot.file} ${shot.width}x${shot.height}` : "(none)"}`);
    log(`  newest bubbles: ${JSON.stringify(messages.slice(-3).map((m) => m.text.slice(0, 30)))}`);
    if (value.includes("\uFFFC") || value.trim()) {
      log(`  -> composer CHANGED with ${mode}; stopping here (nothing sent)`);
      return;
    }
    log(`  -> composer unchanged with ${mode}`);
  }
  log("VERDICT: neither paste mode put the payload into the composer");
}

main();
