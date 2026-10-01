// wx-cua-probe-input.js - which input path can actually reach WeChat's message box?
//
//   node scripts/wx-cua-probe-input.js <pid> <window_id> "<label regex>" "<text>" <mode>
//     mode: value      -> set_value (UIA ValuePattern)
//           background -> type_text with delivery_mode:background
//           auto       -> type_text, driver decides (may upgrade to real keyboard)
//           foreground -> type_text with delivery_mode:foreground (focus steal)
//
// Every step prints the driver's RAW response: `route`, `effect`, `verified`,
// `refusal.code`, `escalation`. Those fields are how you tell "the driver
// delivered something" apart from "the application changed" - a distinction this
// probe exists to keep visible, because a friendly summary hides it.
//
// The field is cleared afterwards unless --keep is passed.

const { execFileSync } = require("node:child_process");

const DRIVER = process.env.CUA_DRIVER
  || "C:\\Users\\79388\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe";
const SESSION = `cyberboss-input-${process.pid}`;

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
    return { __failed: true, raw: (stdout || error.message).trim() };
  }
}

function elements(snap) {
  return Array.isArray(snap.elements) ? snap.elements : [];
}

function labelOf(el) {
  return el.label || el.name || "";
}

function matchOne(snap, re) {
  return elements(snap).find((el) => re.test(`${labelOf(el)} ${el.automation_id || el.id || ""} ${el.role || ""}`));
}

function main() {
  const argv = process.argv.slice(2);
  const keep = argv.includes("--keep");
  const [pid, windowId, pattern, text, mode = "background"] = argv.filter((a) => !a.startsWith("--"));
  if (!pid || !windowId || !pattern || text === undefined) {
    console.error('usage: wx-cua-probe-input.js <pid> <window_id> "<regex>" "<text>" <value|background|auto|foreground>');
    process.exit(2);
  }
  const target = { pid: Number(pid), window_id: Number(windowId) };
  const re = new RegExp(pattern, "i");

  const before = call("get_window_state", { ...target, capture_mode: "ax" });
  const el = matchOne(before, re);
  if (!el) {
    console.log(`no element matches /${pattern}/i among ${elements(before).length}`);
    process.exit(1);
  }
  console.log(`target: role=${el.role} label=${JSON.stringify(labelOf(el))} value=${JSON.stringify(el.value ?? "")} actions=${JSON.stringify(el.actions || [])}`);

  if (mode === "value") {
    console.log("set_value ->", JSON.stringify(call("set_value", { ...target, element_token: el.element_token, value: text })));
  } else {
    const args = { ...target, element_token: el.element_token, text };
    if (mode === "background" || mode === "foreground") args.delivery_mode = mode;
    console.log(`type_text(${mode}) ->`, JSON.stringify(call("type_text", args)));
  }

  const after = call("get_window_state", { ...target, capture_mode: "ax" });
  const now = matchOne(after, re);
  console.log(`after: ${now ? `label=${JSON.stringify(labelOf(now))} value=${JSON.stringify(now.value ?? "")}` : "(target gone)"}`);

  if (!keep) {
    const cleared = call("set_value", { ...target, element_token: now?.element_token || el.element_token, value: "" });
    const final = call("get_window_state", { ...target, capture_mode: "ax" });
    const end = matchOne(final, re);
    console.log(`clear -> ${JSON.stringify(cleared).slice(0, 160)}`);
    console.log(`final: ${end ? `value=${JSON.stringify(end.value ?? "")}` : "(gone)"}`);
  }
}

main();
