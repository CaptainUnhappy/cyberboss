// wx-cua-probe.js - decisive test: can Cua 0.31.0 write into WeChat's search box
// without taking the foreground?
//
//   node scripts/wx-cua-probe.js list
//   node scripts/wx-cua-probe.js snapshot <pid> <window_id>
//   node scripts/wx-cua-probe.js setvalue <pid> <window_id> <element_index> <text>
//
// Read the driver's own vocabulary instead of guessing: every call prints the
// raw JSON (minus screenshot blobs) so `effect`, `verified` and
// `background_unavailable` are visible rather than summarised away.

const { execFileSync } = require("node:child_process");

const DRIVER = process.env.CUA_DRIVER
  || "C:\\Users\\79388\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe";

function call(tool, args) {
  const out = execFileSync(DRIVER, ["call", tool], {
    input: JSON.stringify(args),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return { raw: out };
  }
  if (parsed && typeof parsed.screenshot_png_b64 === "string") {
    parsed.screenshot_png_b64 = `<omitted ${parsed.screenshot_png_b64.length} b64 chars>`;
  }
  return parsed;
}

function sessions(tree) {
  return [...String(tree || "").matchAll(/session_item_([^\s\\\]]+)/g)].map((m) => m[1]);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "list") {
    const w = call("list_windows", { on_screen_only: false });
    const all = w.windows || w._legacy_windows || [];
    for (const win of all) {
      if (/微信|Weixin|WeChat/i.test(win.title || "") || /Weixin/i.test(win.app_name || "")) {
        console.log(JSON.stringify({ pid: win.pid, window_id: win.window_id, title: win.title, bounds: win.bounds || { x: win.x, y: win.y, width: win.width, height: win.height }, is_on_screen: win.is_on_screen, minimized: win.minimized }));
      }
    }
    if (!all.length) console.log("(driver returned 0 windows)");
    return;
  }
  if (cmd === "snapshot") {
    const [pid, windowId, mode = "ax"] = rest;
    const snap = call("get_window_state", { pid: Number(pid), window_id: Number(windowId), capture_mode: mode });
    console.log(`element_count=${snap.element_count}`);
    console.log(`sessions before: ${JSON.stringify(sessions(snap.tree_markdown))}`);
    const line = String(snap.tree_markdown || "").split("\n").find((l) => l.includes("Edit"));
    console.log(`edit element   : ${(line || "(none)").trim()}`);
    return;
  }
  if (cmd === "setvalue") {
    const [pid, windowId, index, text] = rest;
    // INVARIANT: a snapshot in this turn populates the element_index cache.
    const before = call("get_window_state", { pid: Number(pid), window_id: Number(windowId), capture_mode: "ax" });
    console.log(`sessions before: ${JSON.stringify(sessions(before.tree_markdown))}`);
    const res = call("set_value", {
      pid: Number(pid),
      window_id: Number(windowId),
      element_index: Number(index),
      value: text,
      delivery_mode: "background",
    });
    console.log("set_value ->", JSON.stringify(res));
    const after = call("get_window_state", { pid: Number(pid), window_id: Number(windowId), capture_mode: "ax" });
    console.log(`sessions after : ${JSON.stringify(sessions(after.tree_markdown))}`);
    const edit = String(after.tree_markdown || "").split("\n").find((l) => l.includes("Edit"));
    console.log(`edit after     : ${(edit || "(none)").trim()}`);
    return;
  }
  console.error("usage: wx-cua-probe.js list | snapshot <pid> <wid> [mode] | setvalue <pid> <wid> <idx> <text>");
  process.exit(2);
}

main();
