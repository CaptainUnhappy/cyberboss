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
// daemon restarting, the transport lease going away, an idle timeout), and every
// later call is then refused. The wording has changed between builds:
//
//   session has ended; tool call 'list_windows' was rejected. Call start_session
//   with session '<label>' to start it again, or use a new session label.
//
//   session '<label>' has ended; call start_session with session '<label>' to
//   start it again, or use a new session label      (0.31.0, measured 2026-10-03)
//
// The first pattern only matched the first wording, so on the current build the
// refusal was never recognised, `revive()` never ran, and a bot that had been
// idle for a while silently lost the ability to send anything: measured
// 2026-10-03, `deferred retry failed ... session 'cyberboss-out-6780' has ended`
// on repeat while the driver was perfectly healthy. Both the refusal CODE and
// both wordings are matched now.
//
// Measured 2026-10-01 against 0.31.0: exit code 1, stdout empty, stderr carries
// that sentence, and `start_session` on the same label answers `revived: true`.
// Two consequences are baked into `CuaSession` below: a refusal must be *legible*
// (it arrives on stderr, not stdout), and a long-lived session must *heal itself*
// rather than leave the bot permanently mute.

const { execFileSync } = require("node:child_process");
const { createMcpTransport } = require("./mcp-transport");

const DRIVER = process.env.CUA_DRIVER
  || "C:\\Users\\79388\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe";

/** The driver's refusal when a call arrives for a session that is no longer live. */
const SESSION_ENDED = /session (?:'[^']*' )?has ended|session_ended/i;

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

/** One tool call. Fast path: the long-lived MCP child; fallback: a CLI process. */
function defaultExec(driver, args, input) {
  return MCP_TRANSPORT(driver, args, input);
}

/**
 * The transport used by every session in this module.
 *
 * `cua-driver call` costs 1.5-2.0s of process spawn per call, and this client makes
 * 4-6 calls per send and ~5 per conversation switch - which is why the "处理中"
 * acknowledgement arrived seconds late and why a switch held the foreground that
 * long. The MCP transport answers the same calls in ~150ms and falls back to the CLI
 * on any problem (see mcp-transport.js for the measurements).
 */
const MCP_TRANSPORT = createMcpTransport();

/** Text of a failed response, whichever shape it arrived in. */
function failureText(res) {
  if (!res?.__failed) return "";
  return typeof res.payload === "string"
    ? res.payload
    : res.payload?.refusal?.message || res.payload?.message || "";
}

/** Is this failure the "your session is gone" refusal (as opposed to a bad call)? */
function isSessionEnded(res) {
  if (!res?.__failed) return false;
  // The structured code is the durable signal; the prose is the fallback.
  if (res.payload?.refusal?.code === "session_ended") return true;
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

  /**
   * Bring a minimized window back WITHOUT activating it.
   *
   * The driver has no tool for this: `bring_to_front` is its only un-minimize, and it
   * raises the window and leaves it in front. `ShowWindow(hwnd, SW_SHOWNOACTIVATE)`
   * does the same restore and leaves the foreground alone (measured 2026-10-02: the
   * foreground pid is unchanged), which is the difference between "the bot works in
   * the background" and "the bot keeps grabbing my screen". Stubbable for tests.
   */
  restoreMinimized(pid) {
    return defaultRestoreMinimized(pid);
  }
}

/** `SW_SHOWNOACTIVATE` = 4: show the window at its previous size, do not activate it. */
function defaultRestoreMinimized(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return { ok: false, error: `restoreMinimized needs a pid, got ${JSON.stringify(pid)}` };
  }
  const script = [
    "Add-Type -Namespace W -Name SW -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);'",
    `[void][W.SW]::ShowWindow((Get-Process -Id ${numericPid}).MainWindowHandle, 4)`,
  ].join("; ");
  try {
    execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
      timeout: 15_000,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
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
  // A FAILED list is not an empty list. Measured 2026-10-02: one transient failure of
  // this call surfaced as "no WeChat window visible to the driver (is the client
  // running on this desktop?)", which sent the whole investigation after a window that
  // was on screen the entire time. So: retry a failed call once (this is a read - a
  // repetition can never double-execute anything) and then say what actually happened.
  let res = session.call("list_windows", { on_screen_only: false });
  if (res?.__failed) {
    sleep(400);
    res = session.call("list_windows", { on_screen_only: false });
  }
  if (res?.__failed) {
    const error = new Error(`driver call list_windows failed: ${JSON.stringify(res.payload).slice(0, 200)}`);
    // Nothing has been typed at this point, anywhere. Saying so is what lets the caller
    // defer a reply instead of marking it uncertain and dropping it.
    error.deliveryUncertain = false;
    throw error;
  }
  const all = res.windows || res._legacy_windows || [];
  const byTitle = all.filter((w) => WECHAT_TITLE.test(w.title || ""));
  const area = (w) => (w.bounds ? w.bounds.width * w.bounds.height : (w.width || 0) * (w.height || 0));
  const scored = byTitle.map((w) => ({ w, score: chatWindowScore(session, w) }));
  const structural = scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score)[0];
  const hit = (structural ? structural.w : null) || byTitle.sort((a, b) => area(b) - area(a))[0];
  if (!hit) {
    const error = new Error(
      `no WeChat window in the driver's window list (${all.length} window(s) visible, none titled like WeChat)`
    );
    error.deliveryUncertain = false;
    throw error;
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
 *
 * Returns { switched, route, cost, label, box, snapshot }: the last two come from the
 * very snapshot this rung already read, so a caller that needs the composer does not
 * have to read the window again (one driver call, ~200ms - which is 200ms of the
 * "处理中" being late, and reading again also invalidates the tokens it just got).
 */
function ensureConversation(session, target, chatLabel, { settleMs = 1800, allowForegroundSwitch = true } = {}) {
  const wanted = new RegExp(`^\\s*${chatLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
  const before = currentConversation(session, target);
  if (wanted.test(before.label)) {
    return { switched: false, route: "already-open", cost: "none", label: before.label, box: before.box, snapshot: before.snapshot };
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
    return { switched: true, route: "accessibility", cost: "background", label: now.label, box: now.box, snapshot: now.snapshot, outcome: outcome(attempt) };
  }

  // Rung 2: explicit foreground click. This is the rung that actually switches -
  // and it is the ONLY remaining foreground cost in the whole path (150-300ms,
  // measured). With the switch disabled this rung is refused instead: the caller
  // gets a certain failure, and deferring it is safe because nothing was typed.
  if (!allowForegroundSwitch) {
    const refusal = new Error(
      `${JSON.stringify(chatLabel)} is not the open conversation and foreground switching is disabled `
      + "(CYBERBOSS_WECHAT_CUA_NO_FOREGROUND_SWITCH); the reply should be deferred rather than stealing the foreground"
    );
    // Nothing was typed and nothing was sent, so this is a CERTAIN failure - and
    // that flag is the exact condition the delivery layer checks before deferring
    // (deferSystemReply requires deliveryUncertain === false). Measured
    // 2026-10-02: without it the refusal was not deferred and the reply was simply
    // dropped - the window was not stolen, but the user never got an answer.
    refusal.deliveryUncertain = false;
    throw refusal;
  }
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
  return { switched: true, route: "foreground-click", cost: FOREGROUND_ACTIVATION_COST, label: now.label, box: now.box, snapshot: now.snapshot, outcome: outcome(forced) };
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
function sendMessage(target, chatLabel, text, { session = new CuaSession(), settleMs = 1800, requireForegroundType = false, allowForegroundSwitch = true } = {}) {
  const steps = [];
  // Every step carries its own wall-clock offset: without it, a 7-second send looks
  // like one opaque number and the only way to find the cost is to guess (which is
  // how the MCP transport, the fixed settles and the send route were all found).
  const startedAtMs = Date.now();
  const pushStep = (entry) => { steps.push({ ...entry, ms: Date.now() - startedAtMs }); };
  const opened = ensureConversation(session, target, chatLabel, { settleMs, allowForegroundSwitch });
  steps.push({ step: "open", ...opened });

  // The composer comes from the snapshot `ensureConversation` already read: reading the
  // window again costs a driver call AND invalidates the token we are about to use.
  let conv = opened.box
    ? { label: opened.label, box: opened.box, snapshot: opened.snapshot }
    : currentConversation(session, target);
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
  // A settle, not a wait for the text to travel: the UIA write is confirmed
  // synchronously (`effect: confirmed` + `value_readback`), so every millisecond here
  // is a millisecond of the 处理中 being late (measured 2026-10-02).
  sleep(80);
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
      // A minimized window has to be restored before it can be typed into, and there
      // ARE two ways to do it - they differ in exactly the thing the operator cares
      // about:
      //
      //   bring_to_front          raises WeChat AND leaves it in front (the "the bot
      //                           popped my window up" complaint)
      //   ShowWindow(SW_SHOWNOACTIVATE)
      //                           restores the window at its previous size without
      //                           touching the foreground. Measured 2026-10-02 twice:
      //                           the foreground pid is identical before and after.
      //
      // So the policy is no longer "refuse and defer": the window is restored the
      // quiet way and the send continues. Refusing used to make the whole channel
      // mute for as long as the user kept WeChat in the taskbar (measured
      // 2026-10-02: the operator minimized it and no reply or 处理中 could go out).
      const restored = session.restoreMinimized(target.pid);
      pushStep({ step: "unminimize", outcome: { failed: !restored.ok, reason: restored.ok ? "no-activate-restore" : "restore-failed", detail: restored.error || "" } });
      if (!restored.ok) {
        pushStep({ step: "type", landed: false, outcome: outcome(typed), firstAttempt });
        return {
          ok: false,
          verify: "the WeChat window is minimized and could not be restored without stealing focus (the reply will be retried)",
          steps,
        };
      }
      conv = currentConversation(session, target);
      if (conv.box) {
        typed = typeInto(session, target, conv.box, text, "foreground");
        sleep(250);
        conv = currentConversation(session, target);
      }
    } else if (conv.box) {
      typed = typeInto(session, target, conv.box, text, "foreground");
      sleep(250);
      conv = currentConversation(session, target);
    }
  }
  const landed = String(conv.box?.value ?? "") === text;
  pushStep({ step: "type", landed, outcome: outcome(typed), ...(firstAttempt ? { firstAttempt } : {}) });
  if (!landed) {
    // Nothing was typed, so nothing can have been sent: say so, because the caller's
    // deferral logic keys on this flag and otherwise drops the reply as "uncertain".
    return { ok: false, verify: "text never reached the message box", steps, certainNotSent: true };
  }

  /**
   * Deliver the RETURN for a composer that already holds our text.
   *
   * Four routes were measured on 2026-10-02 (50ms foreground sampling, another window
   * parked in front), and they differ in exactly what the operator complained about:
   *
   *   press_key (no delivery mode)   PostMessage(WM_KEYDOWN) to the window. WeChat
   *                                  ignores it: the driver answers "✅ sent", the text
   *                                  stays in the composer.
   *   press_key (foreground)         SendInput: it DOES send, and it never gives the
   *                                  foreground back - WeChat was still in front 10.5s
   *                                  later, with the user's window behind it.
   *   click on the composer's 发送    sends, and the driver returns the focus after
   *                                  ~124ms - but the call itself costs ~1.9s.
   *   type_text "\n" (foreground)    SendInput of one newline: sends, 146ms per call,
   *                                  and WeChat held the foreground for 125ms.
   *
   * So the newline is primary, the button is the retry route for a client whose Enter
   * does not send (WeChat can be configured to need Ctrl+Enter, in which case the box
   * keeps the text and `send-again` walks this ladder with the newline skipped), and
   * the mode-less press is never used because "reported sent, still in the box" is the
   * worst of the four.
   */
  function deliverReturn(snapshotForButton, { skipNewline = false } = {}) {
    const box = elements(snapshotForButton).find(isEdit);
    // The newline is one rung, and a refusal is reported as-is so the caller retries
    // it from a NEW snapshot (dead tokens kill the button rung too, so falling through
    // inside this call would only burn the retry).
    if (!skipNewline && box) {
      return {
        via: "foreground-newline",
        res: session.call("type_text", {
          ...toTarget(target), element_token: box.element_token, text: "\n", delivery_mode: "foreground",
        }),
      };
    }
    const button = elements(snapshotForButton).find((el) => labelOf(el) === "发送");
    if (button) {
      let res = session.call("click", {
        ...toTarget(target), element_token: button.element_token, delivery_mode: "foreground",
      });
      if (isStaleToken(res)) {
        const fresh = currentConversation(session, target);
        const retryButton = elements(fresh.snapshot).find((el) => labelOf(el) === "发送");
        if (retryButton) {
          res = session.call("click", {
            ...toTarget(target), element_token: retryButton.element_token, delivery_mode: "foreground",
          });
        }
      }
      return { via: "send-button-click", res };
    }
    return {
      via: "foreground-return",
      res: session.call("press_key", {
        ...toTarget(target), element_token: box?.element_token, key: "return", delivery_mode: "foreground",
      }),
    };
  }

  let sent = deliverReturn(conv.snapshot);
  let pressRetryFrom = null;
  let skippedRepress = false;
  const pressRefusal = outcome(sent.res);
  // A minimized window refuses the delivery for the same reason it refuses the
  // typing - and the cure is the same one the typing step already uses: restore it
  // with SW_SHOWNOACTIVATE (no foreground change) and deliver again. Missing here,
  // this was not a near-miss: measured 2026-10-04, a reply was typed into Azzy's
  // composer, the Return was refused because the window sat in the taskbar, and the
  // text stayed there as a WeChat DRAFT. The operator saw no answer for hours, and
  // every later send to that chat refused to type over the leftover, so the channel
  // went mute for that person.
  if (pressRefusal.failed && isWindowMinimized(sent.res)) {
    pressRetryFrom = pressRefusal;
    const restored = session.restoreMinimized(target.pid);
    pushStep({
      step: "unminimize-send",
      outcome: { failed: !restored.ok, reason: restored.ok ? "no-activate-restore" : "restore-failed", detail: restored.error || "" },
    });
    if (restored.ok) {
      sleep(250);
      conv = currentConversation(session, target);
      if (conv.box && String(conv.box.value ?? "") === text) {
        sent = deliverReturn(conv.snapshot);
      } else {
        // The text left the composer while the window was coming back: it either went
        // out after all (a re-press would duplicate it) or it vanished. The verdict
        // below decides; this only stops the blind re-press.
        skippedRepress = true;
      }
    }
  }
  if (!skippedRepress && outcome(sent.res).failed
    && (isStaleToken(sent.res) || isWindowMinimized(sent.res))) {
    // The delivery was refused, so the message did not go out. Whether to try again
    // depends on the box, not on optimism: text still there = nothing was sent, empty
    // box = it went out and only our view is stale, so sending again would duplicate
    // it. Verification below decides, not this branch.
    pressRetryFrom = pressRetryFrom || pressRefusal;
    conv = currentConversation(session, target);
    if (conv.box && String(conv.box.value ?? "") === text) {
      sent = deliverReturn(conv.snapshot);
    } else {
      skippedRepress = true;
    }
  }
  pushStep({
    step: "send",
    via: sent.via,
    outcome: outcome(sent.res),
    ...(pressRetryFrom ? { firstAttempt: pressRetryFrom } : {}),
    ...(skippedRepress ? { skippedRepress } : {}),
  });
  // SendInput sends synchronously and the composer empties the moment it returns, but
  // the chat-list preview repaints a moment later. Poll for it instead of judging on one
  // read: measured 2026-10-02 a delivered reply came back "unverified" because the single
  // check ran before the repaint, and an unverified send is exactly what the caller must
  // not record as delivered... nor may it retry it (that would duplicate).
  sleep(250);
  let after = session.snapshot(toTarget(target));
  let verdict = sendVerdict(after, text);
  const verdictDeadline = Date.now() + 1500;
  while (!verdict.ok && !verdict.boxHoldsText && Date.now() < verdictDeadline) {
    sleep(180);
    after = session.snapshot(toTarget(target));
    verdict = sendVerdict(after, text);
  }
  if (!verdict.ok && verdict.boxHoldsText) {
    // Whatever route ran, the box is the judge: text still in it means nothing was
    // sent, so trying once more cannot duplicate anything. This is also the path that
    // saved the old mode-less press, which reported success and sent nothing.
    const again = deliverReturn(after, { skipNewline: true });
    pushStep({ step: "send-again", via: again.via, outcome: outcome(again.res) });
    sleep(400);
    after = session.snapshot(toTarget(target));
    verdict = sendVerdict(after, text);
  }
  const ok = verdict.ok;
  // Remember our own unsent text so the next attempt may clear it; forget it once
  // the message is really out, so a later identical message is not "cleared" preemptively.
  if (ok) {
    forgetLeftover(chatLabel);
  } else if (!verdict.boxEmpty) {
    rememberLeftover(chatLabel, text);
  }
  return {
    ok,
    // `verified` is the STRONGER claim (the preview row showed our text); `ok` only says
    // the composer let go of it, which is what WeChat does when it sends. (`seen` is the
    // row label, not a boolean - comparing it to `true` silently reported every delivery
    // as unverified.)
    verified: Boolean(verdict.seen),
    // `certainNotSent` is the proof the deferral path needs: our text is still sitting
    // in the composer, so it never left. Without it the caller sees an unconfirmed send,
    // calls it uncertain, and drops the reply instead of retrying it - measured twice on
    // 2026-10-02 (`failed / delivery_uncertain`, user got nothing, and no log line).
    certainNotSent: verdict.boxHoldsText === true,
    verify: verdict.seen ? `preview row: ${JSON.stringify(verdict.seen.slice(0, 60))}` : "the text never appeared in any preview row",
    steps,
  };
}

/** What the window says about a send: the row that proves it, and the composer. */
function sendVerdict(snap, text) {
  const rows = elements(snap).filter(isRow).map(labelOf);
  const probe = text.slice(0, Math.min(16, text.length));
  const seen = rows.find((label) => label.includes(probe));
  const boxValue = String(elements(snap).find(isEdit)?.value ?? "");
  // Trailing newlines are ignored on purpose: when Enter is configured not to send,
  // the composer holds `text\n` and that is exactly the state the retry exists for.
  const held = boxValue.replace(/[\r\n]+$/, "");
  return {
    seen,
    boxEmpty: !boxValue,
    boxHoldsText: held === text,
    ok: Boolean(seen) && !boxValue,
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
