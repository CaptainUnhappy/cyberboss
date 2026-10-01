// wx-cua-type.js - type into a WeChat control through Cua, then verify and undo.
//
//   node scripts/wx-cua-type.js <pid> <window_id> <regex> <text> [--foreground] [--keep]
//
// Why a single process: 0.31.0 scopes both the element cache and the snapshot to
// a *session*, and every `cua-driver call` is its own process. Doing
// snapshot -> type -> snapshot inside one run is what makes the element token
// valid and the read-back meaningful.
//
// Default is `delivery_mode: background` (the driver's mandatory first attempt).
// `--foreground` is the explicit escalation; it is never implied.
//
// [--keep] leaves the typed text in place. Without it the script clears the
// field again, so probing a real chat never leaves a sendable message behind.

const { execFileSync } = require("node:child_process");

const DRIVER = process.env.CUA_DRIVER
  || "C:\\Users\\79388\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe";
const SESSION = `cyberboss-type-${process.pid}`;

function call(tool, args) {
  try {
    const out = execFileSync(DRIVER, ["call", tool], {
      input: JSON.stringify({ ...args, session: SESSION }),
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 128 * 1024 * 1024,
    });
    return JSON.parse(out);
  } catch (error) {
    const stdout = error.stdout ? String(error.stdout) : "";
    throw new Error(`${tool}: ${stdout.trim() || error.message}`);
  }
}

function elements(snap) {
  if (Array.isArray(snap.elements)) return snap.elements;
  const sc = snap.structuredContent;
  if (sc && Array.isArray(sc.elements)) return sc.elements;
  if (sc) for (const v of Object.values(sc)) if (Array.isArray(v) && v.length && typeof v[0] === "object") return v;
  return [];
}

// 0.31.0 elements carry `label` (0.3.x used `name`); accept both everywhere.
function labelOf(el) {
  return el.label || el.name || "";
}

function idOf(el) {
  return el.automation_id || el.id || "";
}

function matches(el, re) {
  return re.test(`${labelOf(el)} ${idOf(el)} ${el.role || el.control_type || ""}`);
}

function describe(el) {
  return `role=${el.role || el.control_type} label=${JSON.stringify(labelOf(el))} value=${JSON.stringify(el.value ?? "")}`;
}

function main() {
  const argv = process.argv.slice(2);
  const keep = argv.includes("--keep");
  const foreground = argv.includes("--foreground");
  const [pid, windowId, pattern, text] = argv.filter((a) => !a.startsWith("--"));
  if (!pid || !windowId || !pattern || text === undefined) {
    console.error("usage: wx-cua-type.js <pid> <window_id> <regex> <text> [--foreground] [--keep]");
    process.exit(2);
  }
  const target = { pid: Number(pid), window_id: Number(windowId) };

  const before = call("get_window_state", { ...target, capture_mode: "ax" });
  const re = new RegExp(pattern, "i");
  const hits = elements(before).filter((el) => matches(el, re));
  console.log(`before: ${hits.length} match(es) for /${pattern}/i`);
  if (!hits.length) process.exit(1);
  const el = hits[0];
  console.log(`target: ${describe(el)}`);

  const typed = call("type_text", {
    ...target,
    element_token: el.element_token,
    text,
    delivery_mode: foreground ? "foreground" : "background",
  });
  console.log(`type_text(${foreground ? "foreground" : "background"}) -> ${JSON.stringify(typed)}`);

  const after = call("get_window_state", { ...target, capture_mode: "ax" });
  const landed = elements(after).filter((x) => matches(x, re))[0];
  console.log(`after : ${landed ? describe(landed) : "(target gone)"}`);

  if (!keep) {
    // Clear it again: a probe must not leave a sendable message in a real chat.
    const cleared = call("set_value", { ...target, element_token: landed?.element_token || el.element_token, value: "", delivery_mode: "background" });
    const final = call("get_window_state", { ...target, capture_mode: "ax" });
    const now = elements(final).filter((x) => matches(x, re))[0];
    console.log(`clear -> ${JSON.stringify(cleared)}`);
    console.log(`final : ${now ? describe(now) : "(target gone)"}`);
  }
}

main();
