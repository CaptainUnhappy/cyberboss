// wx-cua-tree.js - dump WeChat's element tree in a form that is easy to grep.
//
//   node scripts/wx-cua-tree.js <pid> <window_id> [regex] [--all]
//
// The element array (not the markdown) is the source of truth: it carries
// element_token, role, label, value and `actions`, which is what tells you
// whether a control can be invoked, selected or written.
//
// The driver scopes a snapshot to a *session* and every CLI call is its own
// process, so the token from one process is stale in the next. This tool is for
// inspection only; anything that acts must snapshot and act in one run.

const { execFileSync } = require("node:child_process");

const DRIVER = process.env.CUA_DRIVER
  || "C:\\Users\\79388\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe";

const argv = process.argv.slice(2);
const showAll = argv.includes("--all");
const [pid, windowId, pattern] = argv.filter((a) => !a.startsWith("--"));
if (!pid || !windowId) {
  console.error("usage: wx-cua-tree.js <pid> <window_id> [regex] [--all]");
  process.exit(2);
}

const raw = execFileSync(DRIVER, ["call", "get_window_state"], {
  input: JSON.stringify({
    pid: Number(pid),
    window_id: Number(windowId),
    capture_mode: "ax",
    session: `cyberboss-tree-${process.pid}`,
  }),
  encoding: "utf8",
  windowsHide: true,
  maxBuffer: 128 * 1024 * 1024,
});
const snap = JSON.parse(raw);
const all = Array.isArray(snap.elements) ? snap.elements : [];
const re = pattern ? new RegExp(pattern, "i") : null;

console.log(`window="${snap.window_title}" elements=${all.length} (of ${snap.element_count}) complete=${snap.elements_complete}`);
const roleCounts = {};
for (const el of all) roleCounts[el.role] = (roleCounts[el.role] || 0) + 1;
console.log("roles:", Object.entries(roleCounts).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}:${n}`).join(" "));

const rows = re ? all.filter((el) => re.test(`${el.label || ""} ${el.role || ""} ${el.value ?? ""} ${(el.actions || []).join(",")}`)) : all;
console.log(`matched ${rows.length}${re ? ` for /${pattern}/i` : ""}`);
for (const el of rows.slice(0, showAll ? 400 : 60)) {
  const label = String(el.label || "").replace(/\s+/g, " ").slice(0, 46);
  const value = el.value === undefined || el.value === null ? "" : ` value=${JSON.stringify(String(el.value).slice(0, 30))}`;
  console.log(`  [${String(el.element_index).padStart(3)}] ${String(el.role).padEnd(11)} ${JSON.stringify(label).padEnd(50)} actions=${(el.actions || []).join("+") || "-"}${value}`);
}
