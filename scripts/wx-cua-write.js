// wx-cua-write.js - write into WeChat through Cua 0.31.0 without the foreground.
//
// 0.31.0 replaced element indices with opaque `element_token`s, so a write is a
// two-step: snapshot (structured elements) -> pick a token -> set_value.
//
//   node scripts/wx-cua-write.js find <pid> <window_id> <regex>
//   node scripts/wx-cua-write.js write <pid> <window_id> <regex> <text>
//
// `find` is read-only. `write` only sets a value: it types nothing into a chat,
// presses no key, and never escalates to the foreground on its own.

const { execFileSync } = require("node:child_process");

const DRIVER = process.env.CUA_DRIVER
  || "C:\\Users\\79388\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe";

function call(tool, args) {
  let out;
  try {
    out = execFileSync(DRIVER, ["call", tool], {
      input: JSON.stringify(args),
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // execFileSync throws on a refusal/error: the driver's JSON is the useful part.
    const stdout = error.stdout ? String(error.stdout) : "";
    const stderr = error.stderr ? String(error.stderr) : "";
    throw new Error(`${tool} failed (status ${error.status}): ${stdout.trim() || stderr.trim() || error.message}`);
  }
  const parsed = JSON.parse(out);
  if (parsed && typeof parsed.screenshot_png_b64 === "string") {
    parsed.screenshot_png_b64 = `<omitted>`;
  }
  return parsed;
}

/** The structured element array lives in structuredContent (0.31.0) or elements (older). */
function elements(snapshot) {
  const direct = snapshot.elements;
  if (Array.isArray(direct)) return direct;
  const sc = snapshot.structuredContent;
  if (sc && Array.isArray(sc.elements)) return sc.elements;
  if (sc && typeof sc === "object") {
    for (const value of Object.values(sc)) {
      if (Array.isArray(value) && value.length && typeof value[0] === "object") return value;
    }
  }
  return [];
}

function pick(snapshot, pattern) {
  const re = new RegExp(pattern, "i");
  const all = elements(snapshot);
  return all.filter((el) => re.test(`${el.name || el.label || ""} ${el.automation_id || el.id || ""} ${el.role || el.control_type || ""} ${el.value || ""}`));
}

function snapshot(pid, windowId, session) {
  return call("get_window_state", { pid: Number(pid), window_id: Number(windowId), capture_mode: "ax", session });
}

// 0.31.0 scopes a snapshot to the *session* that took it. Every `cua-driver call`
// is its own process, so without an explicit label the first call's snapshot is
// torn down when that process exits and the next call sees `stale_element_token`.
// One label for the whole run is what makes snapshot -> set_value legal.
const SESSION = process.env.CUA_SESSION || `cyberboss-wx-${process.pid}`;

function main() {
  const [cmd, pid, windowId, pattern, ...rest] = process.argv.slice(2);
  if (cmd !== "find" && cmd !== "write") {
    console.error("usage: wx-cua-write.js find|write <pid> <window_id> <regex> [text]");
    process.exit(2);
  }
  const snap = snapshot(pid, windowId, SESSION);
  const all = elements(snap);
  console.log(`session=${SESSION} element_count=${snap.element_count} structured_elements=${all.length}`);
  if (!all.length) {
    console.log("no structured elements array in the response; keys:", Object.keys(snap).join(","));
    return;
  }
  const hits = pick(snap, pattern);
  console.log(`matches for /${pattern}/i : ${hits.length}`);
  for (const el of hits.slice(0, 5)) {
    console.log(`  token=${String(el.element_token || "").slice(0, 18)}… role=${el.role || el.control_type} name=${JSON.stringify(el.name || el.label || "")} id=${el.automation_id || el.id || ""}`);
  }
  if (cmd === "find" || !hits.length) {
    return;
  }
  const target = hits[0];
  const res = call("set_value", {
    pid: Number(pid),
    window_id: Number(windowId),
    element_token: target.element_token,
    value: rest.join(" "),
    delivery_mode: "background",
    session: SESSION,
  });
  console.log("set_value ->", JSON.stringify(res));
  const after = snapshot(pid, windowId, SESSION);
  const value = pick(after, pattern)[0];
  console.log(`after: matches for /${pattern}/i = ${pick(after, pattern).length}`);
  if (value) console.log(`after: name=${JSON.stringify(value.name || value.label || "")} value=${JSON.stringify(value.value || "")}`);
}

main();
