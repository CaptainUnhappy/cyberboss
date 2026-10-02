#!/usr/bin/env node
/**
 * How long does an action hold the foreground? Measured, with a verdict.
 *
 * Why this exists: the first version of this guard sampled the foreground window
 * once before and once after an action and confidently reported "no steal". It was
 * wrong - the real sequence is
 *
 *   14:25:16.237  35688   (the user's window)
 *   14:25:25.699  20384   (WeChat - taken)
 *   14:25:25.850  35688   (given back 151ms later)
 *
 * and 151ms fits neatly between two samples. So the instrument samples every 50ms
 * from a separate PowerShell process (Node cannot call user32), runs one action in
 * this process, and then says what happened - including "the measurement was
 * vacuous" when the parked window never lost the foreground in the first place.
 *
 * Modes (all measured on this client, 2026-10-01):
 *   foreground  a `delivery_mode:"foreground"` click on a chat row
 *               -> switches, ~150ms activation, focus restored
 *   px          a pixel click carrying capture_id (background)
 *               -> does NOT switch, 0ms (the client ignores it)
 *   search      background write into the search box + Return posted to it
 *               -> does NOT switch, 0ms
 *
 * Usage: node scripts/cua-wechat-foreground-live.js <mode> ["<peer>"]
 * Exit code 0 always: this is a measurement, and "it did steal" is a result, not a
 * failure. The verdict line carries the assertion a test would make.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CuaSession, toTarget, findWeChatWindow, currentConversation, ensureConversation,
  elements, outcome, isStaleToken,
} = require("../src/integrations/wechat-cua/client");

const mode = (process.argv[2] || "foreground").toLowerCase();
const peer = process.argv[3] || "Azzy";
const SAMPLE_MS = 50;
const SAMPLE_COUNT = 240;
/** A background action must not touch the foreground at all; a foreground one may,
 *  but it must hand it back. Measured activations so far: 151ms and 313ms, so the
 *  ceiling is set well above the observed spread - the assertion that matters is
 *  "the focus came back", not a tight latency budget. */
const FOREGROUND_BUDGET_MS = 1_000;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Sample the foreground window from PowerShell, 50ms apart, into a file. */
function startSampler(file) {
  // Written to a file and run with -File: the same script as a `-Command` one-liner
  // silently produced zero samples (the `for` loop does not survive being joined
  // with semicolons), and a sampler that samples nothing looks exactly like "the
  // foreground never moved".
  const script = path.join(os.tmpdir(), `cua-foreground-sampler-${Date.now()}.ps1`);
  fs.writeFileSync(script, [
    "Add-Type -Namespace W -Name FG -MemberDefinition '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);'",
    "$lines = New-Object System.Collections.Generic.List[string]",
    `for ($i = 0; $i -lt ${SAMPLE_COUNT}; $i++) {`,
    "  $h = [W.FG]::GetForegroundWindow()",
    "  $p = 0",
    "  [void][W.FG]::GetWindowThreadProcessId($h, [ref]$p)",
    // Appended per tick on purpose: a sampler that only writes at the end loses
    // everything when the probe stops it, and "zero samples" then looks identical
    // to "the foreground never moved" - the exact confusion this file exists to end.
    "  Add-Content -Path $samplePath -Value \"$([DateTime]::Now.ToString('HH:mm:ss.fff')) $p\"",
    `  Start-Sleep -Milliseconds ${SAMPLE_MS}`,
    "}",
    "",
  ].join("\n").replace("$samplePath", `"${file}"`), "utf8");
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
    stdio: "ignore", windowsHide: true,
  });
  child.on("exit", () => fs.rmSync(script, { force: true }));
  return child;
}

/** Park a window that is NOT WeChat in front, so "no change" means something. */
function parkAnotherWindow(session, wechatPid) {
  const others = (session.call("list_windows", { on_screen_only: false }).windows || [])
    .filter((w) => w.pid !== wechatPid && w.is_on_screen && (w.bounds?.width || 0) > 600
      && !/cua-driver/i.test(w.app_name || ""));
  const pick = others.find((w) => /powershell|WindowsTerminal|explorer/i.test(w.app_name || "")) || others[0];
  if (!pick) return null;
  session.call("bring_to_front", { pid: pick.pid, window_id: pick.window_id });
  return pick;
}

function act(session, target, wechatPid) {
  const peerRow = (snap) => elements(snap).find((el) => el.role === "ListItem"
    && (el.frame?.w || 0) < 400 && String(el.label || "").startsWith(peer));
  if (mode === "search") {
    const box = (snap) => elements(snap).find((el) => el.role === "Edit" && /搜索/.test(String(el.label || "")));
    const wrote = session.call("set_value", { ...target, element_token: box(session.snapshot(target))?.element_token, value: peer });
    sleep(1200);
    const posted = session.call("press_key", { ...target, element_token: box(session.snapshot(target))?.element_token, key: "return" });
    sleep(1500);
    const left = box(session.snapshot(target));
    if (left && String(left.value || "")) session.call("set_value", { ...target, element_token: left.element_token, value: "" });
    return { wrote: outcome(wrote), posted: outcome(posted) };
  }
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const snap = session.snapshot(target);
    const row = peerRow(snap);
    if (!row) throw new Error(`no chat row for ${JSON.stringify(peer)}`);
    const res = mode === "px"
      ? session.call("click", { ...target, x: Math.round(row.frame.x + row.frame.w / 2), y: Math.round(row.frame.y + row.frame.h / 2), capture_id: snap.capture_id, delivery_mode: "background" })
      : session.call("click", { ...target, element_token: row.element_token, delivery_mode: "foreground" });
    if (!isStaleToken(res)) return outcome(res);
  }
  throw new Error("the row token kept going stale; the running bot polls the same window");
}

const session = new CuaSession(`foreground-${Date.now()}`);
const win = findWeChatWindow(session);
const target = toTarget(win);
console.log(`mode=${mode} peer=${JSON.stringify(peer)} wechat pid=${win.pid}`);

// Start from a different conversation so "did it switch" is observable.
if (currentConversation(session, win).label.startsWith(peer)) ensureConversation(session, target, "文件传输助手");
const parked = parkAnotherWindow(session, win.pid);
if (!parked) { console.log("no non-WeChat window to park; refusing to measure (the result would be vacuous)"); process.exit(0); }
sleep(800);
console.log(`parked: ${JSON.stringify(parked.title).slice(0, 40)} (pid ${parked.pid})`);

const file = path.join(os.tmpdir(), `cua-foreground-${Date.now()}.txt`);
const sampler = startSampler(file);
sleep(500);
const actionOutcome = act(session, target, win.pid);
sleep(2500);
if (!sampler.killed) sampler.kill();

const samples = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split(/\r?\n/) : [];
fs.rmSync(file, { force: true });
const sequence = [];
for (const line of samples) {
  const [at, proc] = line.split(" ");
  if (sequence[sequence.length - 1]?.pid !== proc) sequence.push({ at, pid: proc });
}
const switched = currentConversation(session, win).label.startsWith(peer);
/** "HH:MM:SS.mmm" -> milliseconds since midnight, so a duration is a subtraction
 *  and not a reading of the fractional seconds (which produced "0.31ms" for 313ms). */
const msOfDay = (stamp) => {
  const [h, m, rest] = stamp.split(":");
  return ((Number(h) * 60 + Number(m)) * 60 + Number(rest)) * 1000;
};
const tookMs = sequence.length >= 3 ? Math.round(msOfDay(sequence[2].at) - msOfDay(sequence[1].at)) : 0;

console.log(`action: ${JSON.stringify(actionOutcome)}`);
console.log(`switched: ${switched}`);
console.log(`foreground transitions (${samples.length} samples @${SAMPLE_MS}ms):`);
for (const step of sequence) console.log(`  ${step.at}  ${step.pid}${step.pid === String(win.pid) ? "  <- WeChat" : ""}`);

let verdict;
if (sequence.length === 1) {
  verdict = switched
    ? "MEASUREMENT VACUOUS: it switched, yet the parked window never lost the foreground - re-park and re-run"
    : `ZERO FOREGROUND: the foreground never left the parked window, and the conversation did not switch`;
} else if (sequence.length >= 3 && sequence[0].pid === sequence[sequence.length - 1].pid) {
  verdict = `FOREGROUND ACTIVATION ~${tookMs}ms, focus returned (budget ${FOREGROUND_BUDGET_MS}ms): ${switched ? "switched" : "did NOT switch"}`;
} else {
  verdict = `FOREGROUND LEFT AND DID NOT COME BACK (${sequence.map((s) => s.pid).join(" -> ")})`;
}
console.log(`VERDICT: ${verdict}`);
if (mode === "foreground" && !/ACTIVATION/.test(verdict)) {
  console.log("NOTE: the control case did not reproduce its known result - do not trust this run");
  process.exit(1);
}
if (mode !== "foreground" && !/ZERO FOREGROUND/.test(verdict)) {
  console.log("NOTE: a click-free mode took the foreground; that contradicts the earlier measurement");
  process.exit(1);
}
