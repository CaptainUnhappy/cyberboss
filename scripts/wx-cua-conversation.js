// wx-cua-conversation.js - what does an OPEN conversation expose to UIA?
//
//   node scripts/wx-cua-conversation.js <pid> <window_id> [--json]
//
// The chat list only ever shows the LAST message, so a preview-level reader
// collapses "user sent three things quickly" into one event. This tool answers
// the question that decides whether that can be fixed without a database reader:
// inside an open conversation, are the individual bubbles addressable, and do
// they carry direction, order and text?

const { execFileSync } = require("node:child_process");

const DRIVER = process.env.CUA_DRIVER
  || "C:\\Users\\79388\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const [pid, windowId] = argv.filter((a) => !a.startsWith("--"));
if (!pid || !windowId) {
  console.error("usage: wx-cua-conversation.js <pid> <window_id> [--json]");
  process.exit(2);
}

const raw = execFileSync(DRIVER, ["call", "get_window_state"], {
  input: JSON.stringify({ pid: Number(pid), window_id: Number(windowId), capture_mode: "ax", session: `conv-${process.pid}` }),
  encoding: "utf8",
  windowsHide: true,
  maxBuffer: 128 * 1024 * 1024,
});
const snap = JSON.parse(raw);
const all = snap.elements || [];

// The message list is the wide column; its children are ListItems laid out
// vertically. Rows of the chat list are narrow. Frame geometry tells them apart
// without relying on labels.
const byWidth = all.filter((el) => el.frame && el.frame.w > 0);
const widest = [...byWidth].sort((a, b) => b.frame.w - a.frame.w)[0];
const bubbles = all.filter((el) => el.role === "ListItem" && el.frame && widest && el.frame.w > widest.frame.w * 0.4);

if (asJson) {
  console.log(JSON.stringify(bubbles.map((el) => ({
    label: el.label,
    value: el.value,
    frame: el.frame,
    actions: el.actions,
  })), null, 2));
} else {
  console.log(`window="${snap.window_title}" elements=${all.length} complete=${snap.elements_complete}`);
  console.log(`candidate bubbles (wide ListItems): ${bubbles.length}`);
  const ordered = bubbles.slice().sort((a, b) => (a.frame.y - b.frame.y));
  for (const el of ordered) {
    const text = String(el.label || "").replace(/\s+/g, " ").slice(0, 64);
    console.log(`  y=${String(el.frame.y).padStart(5)} x=${String(el.frame.x).padStart(5)} w=${String(el.frame.w).padStart(4)} h=${String(el.frame.h).padStart(3)} actions=${(el.actions || []).join("+") || "-"} ${JSON.stringify(text)}`);
  }
}
