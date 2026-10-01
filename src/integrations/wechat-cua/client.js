// wx-cua-client.js - the CUA driver of WeChat, as a module.
//
// This is the write-side seam: everything the bot needs in order to *send* on a
// personal WeChat account, expressed as a small interface over Cua Driver
// 0.31.0. It replaces the UIA bridge that required RDPWrap and a second Windows
// session; nothing here needs either.
//
// Measured behaviour on this client (2026-10-01, WeChat desktop, Windows 11):
//
//   read a chat list / message box      background, no focus change
//   write into the message box          UIA ValuePattern, background, verified
//   press return to send                PostMessage, background
//   open a different conversation       ONLY a foreground click works: UIA
//                                       Invoke and a posted return are both
//                                       accepted and then ignored by the client
//
// So the honest cost model is: **one brief foreground click per switched
// conversation**, and nothing at all when the wanted conversation is already
// open. `sendMessage` exploits that: it checks which conversation is open first
// and only clicks when it has to.
//
// Every 0.31.0 element token belongs to one snapshot AND one driver session, and
// each `cua-driver call` is its own process - so all calls for one operation run
// inside a single labeled session, and re-snapshot after anything that changes
// the view.
//
// A labeled session also has a *lifecycle*: it can be ended (`end_session`, the
// daemon restarting, the transport lease going away), and every later call is
// then refused with a plain-text message on stderr:
//
//   session has ended; tool call 'list_windows' was rejected. Call start_session
//   with session '<label>' to start it again, or use a new session label.
//
// Measured 2026-10-01 against 0.31.0: exit code 1, stdout empty, stderr carries
// that sentence, and `start_session` on the same label answers `revived: true`.
// Two consequences are baked into `CuaSession` below: a refusal must be *legible*
// (it arrives on stderr, not stdout), and a long-lived session must *heal itself*
// rather than leave the bot permanently mute.

const { execFileSync } = require("node:child_process");

const DRIVER = process.env.CUA_DRIVER
  || "C:\\Users\\79388\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe";

/** The driver's refusal when a call arrives for a session that is no longer live. */
const SESSION_ENDED = /session has ended/i;

/** One `cua-driver call` process. Returns stdout; throws Node's child error shape. */
function defaultExec(driver, args, input) {
  return execFileSync(driver, args, {
    input,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  });
}

/** Is this failure the "your session is gone" refusal (as opposed to a bad call)? */
function isSessionEnded(res) {
  if (!res?.__failed) return false;
  const text = typeof res.payload === "string"
    ? res.payload
    : res.payload?.refusal?.message || res.payload?.message || "";
  return SESSION_ENDED.test(String(text));
}

/** WeChat's desktop client window class is mmui; find it by title instead. */
const WECHAT_TITLE = /微信|Weixin|WeChat/i;

/**
 * The two fields every driver call accepts for addressing a window.
 *
 * This exists because the client rejects unknown arguments outright
 * (`invalid_arguments: type_text: unknown argument bounds`), and
 * `findWeChatWindow` returns a richer object for observability (`bounds`,
 * `title`, `minimized`). Spreading that object into a call breaks the call, so
 * every driver-facing argument set is built through here instead.
 */
function toTarget(win) {
  const pid = Number(win?.pid);
  const windowId = Number(win?.window_id);
  if (!pid || !windowId) {
    throw new Error(`toTarget needs {pid, window_id}, got ${JSON.stringify(win)}`);
  }
  return { pid, window_id: windowId };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

class CuaSession {
  /**
   * @param {string} [label] session label; stable labels are what make a session
   *   revivable rather than merely replaceable.
   * @param {{exec?: Function, driver?: string}} [options] `exec` is the process
   *   seam, injected by tests so the recovery logic runs without a desktop.
   */
  constructor(label, { exec = defaultExec, driver = DRIVER } = {}) {
    this.session = label || `cyberboss-${process.pid}-${Date.now()}`;
    this.exec = exec;
    this.driver = driver;
    this.revivals = 0;
  }

  /** One raw call. Never throws: failures come back as `{__failed, payload}`. */
  raw(tool, args) {
    try {
      const out = this.exec(this.driver, ["call", tool], JSON.stringify({ ...args, session: this.session }));
      return JSON.parse(out);
    } catch (error) {
      // stdout first (refusals are usually JSON there), then stderr - which is
      // where the session-ended sentence lives, and dropping it made the whole
      // class of failures indistinguishable from "the tool said nothing".
      const stdout = error.stdout ? String(error.stdout) : "";
      const stderr = error.stderr ? String(error.stderr) : "";
      let payload = stdout.trim() || stderr.trim();
      try { payload = JSON.parse(payload); } catch { /* keep raw text */ }
      return { __failed: true, payload, exit: error.status ?? null };
    }
  }

  /**
   * A call that heals the session first if it has to.
   *
   * Retrying is safe precisely because the driver *rejects* the call instead of
   * executing it - a refused `type_text` typed nothing - and it happens exactly
   * once, so a genuinely dead driver cannot turn into an unbounded retry loop.
   */
  call(tool, args) {
    const res = this.raw(tool, args);
    if (tool === "start_session" || !isSessionEnded(res)) return res;
    this.revive();
    return this.raw(tool, args);
  }

  /** Bring this label back to life (or create it). Returns the driver's answer. */
  revive() {
    const res = this.raw("start_session", { session: this.session });
    this.revivals += 1;
    this.revived = Boolean(res?.revived);
    return res;
  }

  snapshot(target, mode = "ax") {
    return this.call("get_window_state", { ...toTarget(target), capture_mode: mode });
  }
}

const elements = (snap) => (Array.isArray(snap?.elements) ? snap.elements : []);
const labelOf = (el) => el?.label || el?.name || "";
const isRow = (el) => el?.role === "ListItem";
const isEdit = (el) => el?.role === "Edit" && !/搜索/.test(labelOf(el));

/** Compact, non-flattering view of a driver response. */
function outcome(res) {
  if (!res) return { failed: true, reason: "no response" };
  if (res.__failed) {
    const text = typeof res.payload === "string" ? res.payload.trim() : "";
    return {
      failed: true,
      reason: res.payload?.refusal?.code
        || (text ? (SESSION_ENDED.test(text) ? "session-ended" : "driver-error") : "refused"),
      detail: text ? text.slice(0, 200) : res.payload?.refusal?.message,
      exit: res.exit ?? undefined,
    };
  }
  return {
    failed: false,
    route: res.route || "",
    mode: res.delivery?.mode || "",
    effect: res.effect || "",
    verified: res.verified,
    refusal: res.refusal?.code || "",
    escalation: res.escalation ? res.escalation.target || res.escalation : "",
  };
}

/** Locate the WeChat main window through the driver itself. */
function findWeChatWindow(session = new CuaSession()) {
  const res = session.call("list_windows", { on_screen_only: false });
  const all = res.windows || res._legacy_windows || [];
  const byTitle = all.filter((w) => WECHAT_TITLE.test(w.title || ""));
  // The client owns several windows (overlay/mini-program hosts). The main one is
  // the largest, which is stable no matter what the driver calls it.
  const area = (w) => (w.bounds ? w.bounds.width * w.bounds.height : (w.width || 0) * (w.height || 0));
  const hit = byTitle.sort((a, b) => area(b) - area(a))[0];
  if (!hit) {
    throw new Error("no WeChat window visible to the driver (is the client running on this desktop?)");
  }
  return {
    pid: hit.pid,
    window_id: hit.window_id,
    title: hit.title,
    minimized: hit.minimized,
    bounds: hit.bounds || { x: hit.x, y: hit.y, width: hit.width, height: hit.height },
  };
}

/**
 * Which conversation is open? The message box is labelled with the peer's name,
 * so this is a read, not a guess.
 */
function currentConversation(session, target) {
  const snap = session.snapshot(toTarget(target));
  const box = elements(snap).find(isEdit);
  return { label: box ? labelOf(box) : "", box, snapshot: snap };
}

/**
 * Open `chatLabel` if it is not already open.
 * Returns { switched, route, cost } where route names the rung that worked.
 */
function ensureConversation(session, target, chatLabel, { settleMs = 1800 } = {}) {
  const wanted = new RegExp(`^\\s*${chatLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
  const before = currentConversation(session, target);
  if (wanted.test(before.label)) {
    return { switched: false, route: "already-open", cost: "none", label: before.label };
  }

  const row = elements(before.snapshot).find((el) => isRow(el) && wanted.test(labelOf(el)));
  if (!row) {
    throw new Error(`no conversation row matching ${JSON.stringify(chatLabel)} in the chat list`);
  }

  // Rung 1: the accessibility route. Measured to be accepted and ignored by this
  // client, but it is free and it is the documented first attempt, so it stays.
  const attempt = session.call("click", { ...toTarget(target), element_token: row.element_token });
  sleep(settleMs);
  let now = currentConversation(session, target);
  if (wanted.test(now.label)) {
    return { switched: true, route: "accessibility", cost: "background", label: now.label, outcome: outcome(attempt) };
  }

  // Rung 2: explicit foreground click. This is the rung that actually switches.
  const fresh = elements(session.snapshot(target)).find((el) => isRow(el) && wanted.test(labelOf(el)));
  const forced = session.call("click", { ...toTarget(target), element_token: fresh?.element_token || row.element_token, delivery_mode: "foreground" });
  sleep(settleMs);
  now = currentConversation(session, target);
  if (!wanted.test(now.label)) {
    throw new Error(`could not open ${JSON.stringify(chatLabel)} (foreground click refused: ${JSON.stringify(outcome(forced))})`);
  }
  return { switched: true, route: "foreground-click", cost: "one focus steal", label: now.label, outcome: outcome(forced) };
}

/**
 * Send one text message to `chatLabel`.
 *
 * @returns {{ok: boolean, verify: string, steps: object[]}}
 *   `verify` is how the send was confirmed: the conversation's preview row must
 *   show the text. Returns ok:false rather than throwing when the send cannot be
 *   confirmed, because the caller (the bot) has to decide about retrying.
 */
function sendMessage(target, chatLabel, text, { session = new CuaSession(), settleMs = 1800, requireForegroundType = false } = {}) {
  const steps = [];
  const opened = ensureConversation(session, target, chatLabel, { settleMs });
  steps.push({ step: "open", ...opened });

  // Fresh snapshot: the message box element belongs to the conversation just opened.
  let conv = currentConversation(session, target);
  if (!conv.box) throw new Error("no message box after opening the conversation");

  const typeArgs = { ...toTarget(target), element_token: conv.box.element_token, text };
  let typed = session.call("type_text", { ...typeArgs, delivery_mode: requireForegroundType ? "foreground" : "background" });
  sleep(600);
  conv = currentConversation(session, target);
  const landed = String(conv.box?.value ?? "") === text;
  if (!landed) {
    // Background writes are refused by some surfaces; escalate once, explicitly.
    typed = session.call("type_text", { ...typeArgs, delivery_mode: "foreground" });
    sleep(600);
    conv = currentConversation(session, target);
  }
  steps.push({ step: "type", landed: String(conv.box?.value ?? "") === text, outcome: outcome(typed) });
  if (String(conv.box?.value ?? "") !== text) {
    return { ok: false, verify: "text never reached the message box", steps };
  }

  const sent = session.call("press_key", { ...toTarget(target), element_token: conv.box.element_token, key: "return" });
  steps.push({ step: "return", outcome: outcome(sent) });
  sleep(1500);

  const after = session.snapshot(toTarget(target));
  const rows = elements(after).filter(isRow).map(labelOf);
  const probe = text.slice(0, Math.min(16, text.length));
  const seen = rows.find((label) => label.includes(probe));
  const boxEmpty = !String(elements(after).find(isEdit)?.value ?? "");
  return {
    ok: Boolean(seen) && boxEmpty,
    verify: seen ? `preview row: ${JSON.stringify(seen.slice(0, 60))}` : "the text never appeared in any preview row",
    steps,
  };
}

module.exports = {
  CuaSession,
  toTarget,
  findWeChatWindow,
  currentConversation,
  ensureConversation,
  sendMessage,
  outcome,
  isSessionEnded,
  labelOf,
  elements,
};
