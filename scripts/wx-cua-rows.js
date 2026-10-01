// wx-cua-rows.js - inspect WeChat's conversation rows as structured data.
//
//   node scripts/wx-cua-rows.js <pid> <window_id> [--json]
//
// The chat list is the only inbound signal a pure-UIA reader can use: message
// bubbles are self-drawn and absent from the tree, but each row carries the
// peer, the last-message preview, the time and (for unread chats) a count.
// Those are exactly the fields an inbound event needs, so this tool exists to
// show them raw before anything is built on top.

const { execFileSync } = require("node:child_process");

const DRIVER = process.env.CUA_DRIVER
  || "C:\\Users\\79388\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const [pid, windowId] = argv.filter((a) => !a.startsWith("--"));
if (!pid || !windowId) {
  console.error("usage: wx-cua-rows.js <pid> <window_id> [--json]");
  process.exit(2);
}

const raw = execFileSync(DRIVER, ["call", "get_window_state"], {
  input: JSON.stringify({
    pid: Number(pid),
    window_id: Number(windowId),
    capture_mode: "ax",
    session: `cyberboss-rows-${process.pid}`,
  }),
  encoding: "utf8",
  windowsHide: true,
  maxBuffer: 128 * 1024 * 1024,
});
const snap = JSON.parse(raw);
const rows = (snap.elements || []).filter((el) => el.role === "ListItem");

if (asJson) {
  console.log(JSON.stringify(rows.map((el) => ({
    index: el.element_index,
    label: el.label || "",
    value: el.value,
    automation_id: el.automation_id || null,
    actions: el.actions || [],
    frame: el.frame || null,
  })), null, 2));
} else {
  console.log(`rows: ${rows.length} (window "${snap.window_title}")`);
  for (const el of rows) {
    console.log(`  [${String(el.element_index).padStart(3)}] ${JSON.stringify((el.label || "").slice(0, 70))}`);
    console.log(`        id=${el.automation_id ?? "-"} value=${el.value === undefined ? "-" : JSON.stringify(el.value)} actions=${(el.actions || []).join("+") || "-"}`);
  }
}
