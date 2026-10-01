// wx-cua-send.js - the write half of the CUA loop, end to end.
//
//   node scripts/wx-cua-send.js <pid> <window_id> "<session row regex>" "<text>" [--dry]
//
// Steps, all inside ONE driver session (0.31.0 invalidates element tokens per
// session, and every CLI call is its own process):
//   1. snapshot            -> find the chat row
//   2. select the row      -> the chat view switches to that conversation
//   3. snapshot again      -> the message box element is re-read for the new chat
//   4. type the text       -> type_text; background first, foreground if refused
//   5. press return        -> the actual send
//   6. verify              -> the session row's preview must now carry the text
//
// `--dry` stops after step 4 and clears the box again: use it to prove typing
// works without sending anything.
//
// Nothing here presses return unless a real send is intended, because in WeChat
// return *is* the send.

const { execFileSync } = require("node:child_process");

/** Synchronous pause: this script keeps one driver session, so it cannot go async. */
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

const DRIVER = process.env.CUA_DRIVER
  || "C:\\Users\\79388\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe";
const SESSION = `cyberboss-send-${process.pid}`;

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
    try {
      payload = JSON.parse(payload);
    } catch {
      /* keep the raw text */
    }
    return { __failed: true, payload };
  }
}

function elements(snap) {
  return Array.isArray(snap.elements) ? snap.elements : [];
}

function labelOf(el) {
  return el.label || el.name || "";
}

/** Short, stable rendering of a driver response: route + effect + refusal code. */
function brief(res) {
  if (res.__failed) return `FAILED ${JSON.stringify(res.payload).slice(0, 200)}`;
  const parts = [];
  if (res.route) parts.push(`route=${res.route}`);
  if (res.delivery?.mode) parts.push(`mode=${res.delivery.mode}`);
  if (res.effect) parts.push(`effect=${res.effect}`);
  if (res.verified !== undefined) parts.push(`verified=${res.verified}`);
  if (res.refusal?.code) parts.push(`refusal=${res.refusal.code}`);
  if (res.escalation) parts.push(`escalation=${JSON.stringify(res.escalation)}`);
  if (res.summary) parts.push(String(res.summary).slice(0, 150));
  return parts.join(" ");
}

function snapshot(pid, windowId) {
  return call("get_window_state", { pid: Number(pid), window_id: Number(windowId), capture_mode: "ax" });
}

/** The chat row for a given conversation, by its session_item_* automation id or preview text. */
function findRow(snap, re) {
  return elements(snap).find((el) => el.role === "ListItem" && re.test(labelOf(el)));
}

/** The message box of the currently open chat (WeChat names it after the peer). */
function findMessageBox(snap) {
  return elements(snap).filter((el) => el.role === "Edit").find((el) => !/搜索/.test(labelOf(el)));
}

function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry");
  const [pid, windowId, rowPattern, text] = argv.filter((a) => !a.startsWith("--"));
  if (!pid || !windowId || !rowPattern || text === undefined) {
    console.error('usage: wx-cua-send.js <pid> <window_id> "<row regex>" "<text>" [--dry]');
    process.exit(2);
  }
  const target = { pid: Number(pid), window_id: Number(windowId) };

  // 1) find the conversation
  let snap = snapshot(target.pid, target.window_id);
  const row = findRow(snap, new RegExp(rowPattern, "i"));
  if (!row) {
    console.log(`row /${rowPattern}/i not found; rows seen:`);
    for (const el of elements(snap).filter((e) => e.role === "ListItem")) console.log(`   ${JSON.stringify(labelOf(el).slice(0, 60))}`);
    process.exit(1);
  }
  console.log(`row   : [${row.element_index}] ${JSON.stringify(labelOf(row).slice(0, 50))}`);

  // 2) open it
  const selected = call("click", { ...target, element_token: row.element_token });
  console.log(`select: ${brief(selected)}`);
  sleep(2500); // let WeChat paint the conversation

  // 3) re-read: the message box belongs to the newly opened chat
  snap = snapshot(target.pid, target.window_id);
  const box = findMessageBox(snap);
  if (!box) {
    console.log("no message box found after selecting the chat");
    process.exit(1);
  }
  console.log(`box   : [${box.element_index}] ${JSON.stringify(labelOf(box))} value=${JSON.stringify(box.value ?? "")}`);

  // 4) type
  let typed = call("type_text", { ...target, element_token: box.element_token, text, delivery_mode: "background" });
  console.log(`type  : ${brief(typed)}`);
  snap = snapshot(target.pid, target.window_id);
  let now = findMessageBox(snap);
  if (!now || String(now.value || "") !== text) {
    console.log(`background did not land (value=${JSON.stringify(now?.value ?? null)}); escalating to foreground`);
    typed = call("type_text", { ...target, element_token: box.element_token, text, delivery_mode: "foreground" });
    console.log(`typeFG: ${brief(typed)}`);
    snap = snapshot(target.pid, target.window_id);
    now = findMessageBox(snap);
  }
  console.log(`after : ${now ? `value=${JSON.stringify(now.value ?? "")}` : "(box gone)"}`);

  if (dry) {
    const cleared = call("set_value", { ...target, element_token: now?.element_token || box.element_token, value: "" });
    console.log(`dry run: cleared (${brief(cleared)}) - nothing was sent`);
    return;
  }

  // 5) send
  const sent = call("press_key", { ...target, element_token: now?.element_token || box.element_token, key: "return" });
  console.log(`send  : ${brief(sent)}`);
  sleep(3000); // let the outgoing message commit

  // 6) verify: the conversation's preview row must now show the text
  snap = snapshot(target.pid, target.window_id);
  const after = elements(snap).filter((el) => el.role === "ListItem").map((el) => labelOf(el));
  const hit = after.find((label) => label.includes(text.slice(0, 12)));
  console.log("--- verification ---");
  console.log(`rows containing the text: ${hit ? 1 : 0}`);
  if (hit) console.log(`  ${JSON.stringify(hit.slice(0, 80))}`);
  const stillTyped = findMessageBox(snap);
  console.log(`message box after send : ${JSON.stringify(stillTyped?.value ?? "(gone)")}`);
  process.exit(hit ? 0 : 1);
}

main();
