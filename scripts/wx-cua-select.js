// wx-cua-select.js - open a WeChat conversation and prove it actually switched.
//
//   node scripts/wx-cua-select.js <pid> <window_id> "<row regex>" [--settle-ms N]
//
// Selecting a chat decides *who receives the next keystroke*, so this verifies
// rather than assumes: WeChat's message box is labelled with the peer's name,
// which is an independent read-back of "which conversation is open".
//
// Ladder (each rung is attempted only after the previous one is verified to have
// failed, and every rung re-snapshots first because 0.31.0 invalidates element
// tokens whenever a newer snapshot supersedes them):
//   1. UIA Invoke on the row            (accessibility, background)
//   2. keyboard: select the row, press return  (PostMessage, background)
//   3. foreground click on the row      (explicit escalation, steals focus)
//
// Measured 2026-10-01 on this client: rung 1 reports success and changes
// nothing, which is why the ladder exists at all.

const { execFileSync } = require("node:child_process");

const DRIVER = process.env.CUA_DRIVER
  || "C:\\Users\\79388\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe";
const SESSION = `cyberboss-select-${process.pid}`;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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
    let payload = stdout.trim();
    try { payload = JSON.parse(payload); } catch { /* raw */ }
    return { __failed: true, payload };
  }
}

function brief(res) {
  if (res.__failed) return `FAILED ${JSON.stringify(res.payload).slice(0, 200)}`;
  const parts = [];
  if (res.route) parts.push(`route=${res.route}`);
  if (res.delivery?.mode) parts.push(`mode=${res.delivery.mode}`);
  if (res.effect) parts.push(`effect=${res.effect}`);
  if (res.refusal?.code) parts.push(`refusal=${res.refusal.code}`);
  if (res.summary) parts.push(String(res.summary).slice(0, 130));
  return parts.join(" ");
}

const elements = (snap) => (Array.isArray(snap.elements) ? snap.elements : []);
const labelOf = (el) => el.label || el.name || "";
const snapshot = (pid, wid) => call("get_window_state", { pid, window_id: wid, capture_mode: "ax" });
const findRow = (snap, re) => elements(snap).find((el) => el.role === "ListItem" && re.test(labelOf(el)));
/** The message box is named after the open peer; the search box says 搜索. */
const findBox = (snap) => elements(snap).filter((el) => el.role === "Edit").find((el) => !/搜索/.test(labelOf(el)));
const boxLabel = (snap) => labelOf(findBox(snap) || {});

function main() {
  const argv = process.argv.slice(2);
  const positional = [];
  let settleMs = 2500;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--settle-ms") {
      settleMs = Number(argv[i + 1]);
      i += 1;
    } else if (!argv[i].startsWith("--")) {
      positional.push(argv[i]);
    }
  }
  const [pidArg, widArg, pattern] = positional;
  const pid = Number(pidArg);
  const wid = Number(widArg);
  if (!pid || !wid || !pattern) {
    console.error('usage: wx-cua-select.js <pid> <window_id> "<row regex>" [--settle-ms N]');
    process.exit(2);
  }
  const re = new RegExp(pattern, "i");
  const target = { pid, window_id: wid };

  console.log(`box before : ${JSON.stringify(boxLabel(snapshot(pid, wid)))}`);
  console.log(`want       : /${pattern}/i`);

  const attempts = [
    {
      name: "1 accessibility invoke",
      run: () => {
        const row = findRow(snapshot(pid, wid), re);
        if (!row) return { skip: `row not found` };
        return call("click", { ...target, element_token: row.element_token });
      },
    },
    {
      name: "2 keyboard select+return",
      run: () => {
        const row = findRow(snapshot(pid, wid), re);
        if (!row) return { skip: `row not found` };
        const picked = call("click", { ...target, element_token: row.element_token, action: "select" });
        if (picked.__failed) return picked;
        return call("press_key", { ...target, element_token: row.element_token, key: "return" });
      },
    },
    {
      name: "3 foreground click",
      run: () => {
        const row = findRow(snapshot(pid, wid), re);
        if (!row) return { skip: `row not found` };
        return call("click", { ...target, element_token: row.element_token, delivery_mode: "foreground" });
      },
    },
  ];

  for (const attempt of attempts) {
    const res = attempt.run();
    if (res && res.skip) {
      console.log(`attempt ${attempt.name}: skipped (${res.skip})`);
      continue;
    }
    console.log(`attempt ${attempt.name}: ${brief(res)}`);
    sleep(settleMs);
    const label = boxLabel(snapshot(pid, wid));
    console.log(`   box now : ${JSON.stringify(label)}`);
    if (re.test(label)) {
      console.log(`VERDICT: switched via ${attempt.name}`);
      process.exit(0);
    }
  }
  console.log("VERDICT: could not switch conversation with any rung");
  process.exit(1);
}

main();
