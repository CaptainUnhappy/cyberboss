// wx-cua-shot.js - capture one window through Cua into a PNG file.
//   node scripts/wx-cua-shot.js <pid> <window_id> <out.png> [session]
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const DRIVER = process.env.CUA_DRIVER
  || "C:\\Users\\79388\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe";

const [pid, windowId, out, session = `cyberboss-shot-${process.pid}`] = process.argv.slice(2);
if (!pid || !windowId || !out) {
  console.error("usage: wx-cua-shot.js <pid> <window_id> <out.png> [session]");
  process.exit(2);
}

const raw = execFileSync(DRIVER, ["call", "get_window_state"], {
  input: JSON.stringify({ pid: Number(pid), window_id: Number(windowId), capture_mode: "vision", session }),
  encoding: "utf8",
  windowsHide: true,
  maxBuffer: 128 * 1024 * 1024,
});
const parsed = JSON.parse(raw);
const b64 = parsed.screenshot_png_b64;
if (!b64) {
  console.error("no screenshot in the response:", Object.keys(parsed).join(","));
  process.exit(1);
}
fs.writeFileSync(out, Buffer.from(b64, "base64"));
const sessions = [...String(parsed.tree_markdown || "").matchAll(/session_item_([^\s\\\]]+)/g)].map((m) => m[1]);
console.log(`wrote ${out} (${fs.statSync(out).size} bytes) ${parsed.screenshot_width}x${parsed.screenshot_height}`);
if (sessions.length) console.log(`session rows in tree: ${JSON.stringify(sessions)}`);
