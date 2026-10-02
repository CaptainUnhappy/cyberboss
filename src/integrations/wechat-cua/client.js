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

/**
 * The driver's refusal when the token came from a snapshot that has been
 * superseded. Measured 2026-10-01 against 0.31.0 (`scripts/cua-wechat-token-live.js`):
 *
 *   - a token never expires with time (8s idle, still accepted);
 *   - a token dies the moment ANY later snapshot of that window is taken, by the
 *     same session or by a different one.
 *
 * The driver keeps **one current snapshot per window**, and says so in the refusal
 * (`current_snapshots: [{snapshot_id, window_id}]`). So a token is only good until
 * the next read of that window - including a read by another process, an operator
 * script, or the user clicking around. A writer that reuses a token across a
 * refusal is guaranteed to be refused again; the only cure is to snapshot again.
 */
const STALE_TOKEN = /stale_element_token/;

/**
 * The driver's transport-level refusal, measured repeatedly on 2026-10-01:
 *
 *   Cua Driver daemon is not running on \\.\pipe\cua-driver.
 *   Start it first with: cua-driver serve --socket \\.\pipe\cua-driver
 *
 * It is reported *while the daemon is alive and answering other callers* when two
 * `cua-driver call` processes race for the pipe - so it is not proof of anything,
 * and it definitely did not execute the request. That makes a bounded retry the
 * right response rather than a hard failure the caller has to interpret.
 */
const DRIVER_UNAVAILABLE = /daemon is not running/i;

/** The window is minimized, so nothing can be written to it until it is restored. */
const WINDOW_MINIMIZED = /window_minimized|window is minimized/i;

/**
 * What a conversation switch actually costs, measured rather than assumed.
 *
 * 2026-10-01, sampling `GetForegroundWindow` every 50ms around the switch:
 *
 *   14:25:16.237  35688   (the user's window)
 *   14:25:25.699  20384   (WeChat - the foreground was taken)
 *   14:25:25.850  35688   (given back 151ms later)
 *
 * Three runs measured 151ms, 313ms and 252ms, so the honest figure is a short
 * activation in the 150-300ms range, not a fixed number.
 *
 * So the old label "one focus steal" was wrong in both directions: the foreground
 * IS taken (a two-point before/after check misses it entirely), but it is handed
 * back automatically, so it is not a lasting steal either. The honest number is a
 * brief activation, and callers can decide whether a ~150ms interruption is worth
 * answering into a different conversation.
 *
 * The two click-free candidates were measured too, and both are dead ends on this
 * client: a background/accessibility click on a chat row (including a pixel click
 * carrying a capture_id) never switches, and neither does writing the search box
 * through UIA plus posting Return to it. `scripts/cua-wechat-bg-switch-live.js`
 * re-runs the search-box measurement.
 */
const FOREGROUND_ACTIVATION_COST = "foreground-activation 150-300ms";

/** One `cua-driver call` process. Returns stdout; throws Node's child error shape. */
function defaultExec(driver, args, input) {
  return execFileSync(driver, args, {
    input,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
    // Capture stderr explicitly. The sync variants otherwise forward a child's
    // stderr to the parent's, so a driver outage printed three lines of
    // "daemon is not running" per poll and drowned the one line that mattered
    // (the recovery message). It is still available as `error.stderr`.
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Text of a failed response, whichever shape it arrived in. */
function failureText(res) {
  if (!res?.__failed) return "";
  return typeof res.payload === "string"
    ? res.payload
    : res.payload?.refusal?.message || res.payload?.message || "";
}

/** Is this failure the "your session is gone" refusal (as opposed to a bad call)? */
function isSessionEnded(res) {
  return SESSION_ENDED.test(String(failureText(res)));
}

/** Is this failure the "that token is from a superseded snapshot" refusal? */
function isStaleToken(res) {
  if (!res?.__failed) return false;
  return res.payload?.refusal?.code === "stale_element_token" || STALE_TOKEN.test(String(failureText(res)));
}

/** Is this failure the transport complaining, rather than the daemon refusing? */
function isDriverUnavailable(res) {
  return Boolean(res?.__failed) && DRIVER_UNAVAILABLE.test(String(failureText(res)));
}

/** Is this failure "the window is minimized, so there is nothing to write to"? */
function isWindowMinimized(res) {
  if (!res?.__failed) return false;
  return res.payload?.refusal?.code === "window_minimized" || WINDOW_MINIMIZED.test(String(failureText(res)));
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
    if (tool === "start_session") return res;
    if (isSessionEnded(res)) {
      this.revive();
      return this.raw(tool, args);
    }
    if (isDriverUnavailable(res)) {
      // A transport failure means the daemon never saw the request, so repeating it
      // cannot double-execute anything. Worth one retry: this is what two racing
      // `cua-driver call` processes get, and it went away on its own every time.
      sleep(500);
      return this.raw(tool, args);
    }
    return res;
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

/**
 * How much does this window look like the chat client itself?
 *
 * "Biggest window wins" was measured wrong on 2026-10-01: WeChat's own "新版本"
 * promo dialog is 690x564 while the minimized main window collapses to 183x26, so
 * the promo won - it has no conversation rows and no composer, meaning the bot read
 * an empty chat list (deaf) and would have typed a reply into an advertisement.
 *
 * The client's identity is structural, not geometric: the chat window owns a
 * conversation list (narrow multi-line ListItems) and a message box (an Edit).
 * Score those, and only fall back to size when nothing scores.
 */
function chatWindowScore(session, win) {
  let snap;
  try {
    snap = session.call("get_window_state", { pid: win.pid, window_id: win.window_id, max_elements: 400 });
  } catch {
    return 0;
  }
  if (snap?.__failed) return 0;
  const els = elements(snap);
  const rows = els.filter((el) => el.role === "ListItem" && (el.frame?.w || 0) > 0 && el.frame.w < 400
    && String(el.label || "").includes("\n")).length;
  const composer = els.some((el) => el.role === "Edit" && !/搜索/.test(labelOf(el)));
  return (rows >= 2 ? 2 : 0) + (composer ? 2 : 0) + (rows >= 2 && composer ? 1 : 0);
}

/** Locate the WeChat main window through the driver itself. */
function findWeChatWindow(session = new CuaSession()) {
  const res = session.call("list_windows", { on_screen_only: false });
  const all = res.windows || res._legacy_windows || [];
  const byTitle = all.filter((w) => WECHAT_TITLE.test(w.title || ""));
  const area = (w) => (w.bounds ? w.bounds.width * w.bounds.height : (w.width || 0) * (w.height || 0));
  const scored = byTitle.map((w) => ({ w, score: chatWindowScore(session, w) }));
  const structural = scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score)[0];
  const hit = (structural ? structural.w : null) || byTitle.sort((a, b) => area(b) - area(a))[0];
  if (!hit) {
    throw new Error("no WeChat window visible to the driver (is the client running on this desktop?)");
  }
  return {
    pid: hit.pid,
    window_id: hit.window_id,
    title: hit.title,
    minimized: hit.minimized,
    bounds: hit.bounds || { x: hit.x, y: hit.y, width: hit.width, height: hit.height },
    // Which window this is, and whether it looked like the client: the difference
    // between "the chat window" and "a popup of the same title" is worth logging.
    matchedBy: structural ? "chat-structure" : "largest-window",
    candidates: byTitle.length,
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
 * Re-find a conversation row in a NEW snapshot and click it.
 *
 * Only used after a `stale_element_token` refusal: the driver rejected the call,
 * so nothing was clicked, and the cure is a token from the current snapshot rather
 * than a retry with the one that was just refused. Returns null if the row is gone.
 */
function reclickRow(session, target, wanted, deliveryMode = "") {
  const row = elements(session.snapshot(target)).find((el) => isRow(el) && wanted.test(labelOf(el)));
  if (!row) return null;
  const args = { ...toTarget(target), element_token: row.element_token };
  if (deliveryMode) args.delivery_mode = deliveryMode;
  return session.call("click", args);
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
  let attempt = session.call("click", { ...toTarget(target), element_token: row.element_token });
  if (isStaleToken(attempt)) {
    attempt = reclickRow(session, target, wanted) || attempt;
  }
  sleep(settleMs);
  let now = currentConversation(session, target);
  if (wanted.test(now.label)) {
    return { switched: true, route: "accessibility", cost: "background", label: now.label, outcome: outcome(attempt) };
  }

  // Rung 2: explicit foreground click. This is the rung that actually switches.
  const fresh = elements(session.snapshot(target)).find((el) => isRow(el) && wanted.test(labelOf(el)));
  let forced = session.call("click", { ...toTarget(target), element_token: fresh?.element_token || row.element_token, delivery_mode: "foreground" });
  if (isStaleToken(forced)) {
    forced = reclickRow(session, target, wanted, "foreground") || forced;
  }
  sleep(settleMs);
  now = currentConversation(session, target);
  if (!wanted.test(now.label)) {
    throw new Error(`could not open ${JSON.stringify(chatLabel)} (foreground click refused: ${JSON.stringify(outcome(forced))})`);
  }
  return { switched: true, route: "foreground-click", cost: FOREGROUND_ACTIVATION_COST, label: now.label, outcome: outcome(forced) };
}

/**
 * Type `text` into the message box identified by `box`.
 *
 * The token comes from the caller's most recent snapshot on purpose: a token is
 * only valid until that window is read again (see STALE_TOKEN above), so every
 * attempt is built from the freshest read available at that moment.
 */
function typeInto(session, target, box, text, mode) {
  return session.call("type_text", {
    ...toTarget(target),
    element_token: box.element_token,
    text,
    delivery_mode: mode,
  });
}

/**
 * Bring the window back if Windows has it minimized.
 *
 * A minimized window is not writable: the driver refuses foreground delivery with
 * `window_minimized`, and its snapshots go stale immediately, so the reader still
 * works while every write fails (measured 2026-10-01 - WeChat sat in the taskbar
 * and the whole write path stopped, with `stale_element_token` as the only clue).
 * Restoring costs one foreground activation, and it is only paid after a refusal,
 * never on the happy path.
 */
function bringWindowForward(session, target) {
  return outcome(session.call("bring_to_front", toTarget(target)));
}

/** The message box from a fresh snapshot, or null if this view has none. */
function boxNow(session, target) {
  return currentConversation(session, target).box || null;
}

/**
 * Text this process typed into a conversation's message box but could not confirm
 * sending (chat label -> text).
 *
 * Why this exists: the send ladder can end with our own text still sitting unsent
 * in the composer - measured 2026-10-01, when a `press_key` refusal on a busy
 * window left the injected text in the box. The next send then finds a non-empty
 * box, and the honest choices are "type over it" (mangles the message) or "refuse
 * forever" (the bot goes mute after one bad press). Neither is acceptable, so the
 * box is treated as a workspace with an owner:
 *
 *   - text WE left behind: cleared, because we know exactly what it is;
 *   - any other text: never touched - the operator may be typing - and the send
 *     fails with the text quoted back, so it is visible instead of silent.
 *
 * This is process-local on purpose: what another process left behind is *unknown*
 * text, and unknown text is exactly what must not be destroyed.
 */
const leftovers = new Map();

function leftoverFor(chatLabel) {
  return leftovers.get(chatLabel) || "";
}

function rememberLeftover(chatLabel, text) {
  leftovers.set(chatLabel, text);
}

function forgetLeftover(chatLabel) {
  leftovers.delete(chatLabel);
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

  const draft = String(conv.box.value ?? "");
  if (draft && draft !== leftoverFor(chatLabel)) {
    return {
      ok: false,
      verify: `the message box already holds unsent text (${JSON.stringify(draft.slice(0, 60))}); refusing to type over it`,
      steps,
    };
  }
  if (draft) {
    const cleared = session.call("set_value", { ...toTarget(target), element_token: conv.box.element_token, value: "" });
    steps.push({ step: "clear-leftover", text: draft.slice(0, 60), outcome: outcome(cleared) });
    sleep(300);
    conv = currentConversation(session, target);
    if (!conv.box) throw new Error("the message box disappeared while clearing our own unsent text");
  }

  let typed = typeInto(session, target, conv.box, text, requireForegroundType ? "foreground" : "background");
  let firstAttempt = null;
  sleep(600);
  conv = currentConversation(session, target);
  if (String(conv.box?.value ?? "") !== text) {
    // Two different failures land here and both want the same cure - a NEW token:
    // the write was refused (typically `stale_element_token`, since anything that
    // read this window in the meantime invalidated ours), or the surface ignored a
    // background write. Retrying with the token we already know is dead would just
    // reproduce the refusal, so the retry is built from a snapshot taken after the
    // refusal - and if the window is minimized, it is restored first.
    firstAttempt = outcome(typed);
    if (firstAttempt.reason === "window_minimized") {
      bringWindowForward(session, target);
      sleep(600);
      conv = currentConversation(session, target);
    }
    if (conv.box) {
      typed = typeInto(session, target, conv.box, text, "foreground");
      sleep(600);
      conv = currentConversation(session, target);
    }
  }
  const landed = String(conv.box?.value ?? "") === text;
  steps.push({ step: "type", landed, outcome: outcome(typed), ...(firstAttempt ? { firstAttempt } : {}) });
  if (!landed) {
    return { ok: false, verify: "text never reached the message box", steps };
  }

  let sent = session.call("press_key", { ...toTarget(target), element_token: conv.box.element_token, key: "return" });
  let pressRetryFrom = null;
  let skippedRepress = false;
  const pressRefusal = outcome(sent);
  if (pressRefusal.failed && (isStaleToken(sent) || isWindowMinimized(sent))) {
    // The press was refused, so it did not happen. Whether to press again depends
    // on the box, not on optimism: text still there = nothing was sent, empty box
    // = the message went out and only our view of it is stale, so pressing again
    // would send a second copy. Verification below decides, not this branch.
    pressRetryFrom = pressRefusal;
    if (isWindowMinimized(sent)) {
      bringWindowForward(session, target);
      sleep(600);
    }
    conv = currentConversation(session, target);
    if (conv.box && String(conv.box.value ?? "") === text) {
      sent = session.call("press_key", { ...toTarget(target), element_token: conv.box.element_token, key: "return" });
    } else {
      skippedRepress = true;
    }
  }
  steps.push({
    step: "return",
    outcome: outcome(sent),
    ...(pressRetryFrom ? { firstAttempt: pressRetryFrom } : {}),
    ...(skippedRepress ? { skippedRepress } : {}),
  });
  sleep(1500);

  const after = session.snapshot(toTarget(target));
  const rows = elements(after).filter(isRow).map(labelOf);
  const probe = text.slice(0, Math.min(16, text.length));
  const seen = rows.find((label) => label.includes(probe));
  const boxEmpty = !String(elements(after).find(isEdit)?.value ?? "");
  const ok = Boolean(seen) && boxEmpty;
  // Remember our own unsent text so the next attempt may clear it; forget it once
  // the message is really out, so a later identical message is not "cleared" preemptively.
  if (ok) {
    forgetLeftover(chatLabel);
  } else if (!boxEmpty) {
    rememberLeftover(chatLabel, text);
  }
  return {
    ok,
    verify: seen ? `preview row: ${JSON.stringify(seen.slice(0, 60))}` : "the text never appeared in any preview row",
    steps,
  };
}

module.exports = {
  CuaSession,
  toTarget,
  FOREGROUND_ACTIVATION_COST,
  findWeChatWindow,
  currentConversation,
  ensureConversation,
  sendMessage,
  outcome,
  isSessionEnded,
  isStaleToken,
  isDriverUnavailable,
  isWindowMinimized,
  labelOf,
  elements,
};
