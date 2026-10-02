// outbound.js - the bot's text sender on the Cua path.
//
// This is the drop-in counterpart of `sendWeFlowUiaText`: same request shape,
// same result vocabulary (`dispatched` / `verified` / `localId` / `uncertain` /
// `verificationError`), so the channel adapter can choose between them by
// provider without the ledger or the stream layer learning a second dialect.
//
// Where it differs from the bridge, and why:
//
//   * **Verification is a read-back, not a stability window.** The bridge polls
//     WeFlow's read API until the row is stable. Here the proof is that the sent
//     text appears in the open conversation's message list ("回读"). `verified`
//     therefore means "the conversation now carries this text", which is strong
//     evidence but a shorter observation than a stability window.
//   * **`localId` is derived from content**, because a UIA send has no server id.
//     It is a hash of `talker + text + attempt`, which makes replays of the same
//     content collide on purpose: the ledger then treats a repeated identical
//     send as already delivered rather than sending it twice.
//   * **Every send is recorded in the echo ledger** (loop.js `SentLedger`), so
//     the inbound reader cannot mistake our own output for a new message. That is
//     the guard that makes an unattended loop safe.
//
// The focus cost is real and reported: opening a conversation that is not already
// open costs one foreground click (see client.js). `sendWeChatCuaText` surfaces
// that in `focusCosts` so the caller can log or throttle it.

const crypto = require("node:crypto");

const { CuaSession, findWeChatWindow, sendMessage } = require("./client");
const { SentLedger } = require("./loop");

const DEFAULT_TARGET = "文件传输助手";

/** Process-wide echo ledger: one writer, so one ledger is enough. */
const sharedLedger = new SentLedger();

/**
 * Resolve the conversation label a bot send should go to.
 *
 * The bot addresses peers by wxid; WeChat's conversation rows are labelled with
 * the peer's DISPLAY NAME. Until a name/remark resolver exists, the mapping is
 * explicit configuration: `CYBERBOSS_CUA_CHAT_BY_TALKER="wxid_x=Name,wxid_y=Other"`.
 * A missing mapping is a hard error rather than a silent fallback to the wrong
 * conversation - sending to the wrong person is the worst failure available here.
 */
function resolveChatLabel(talker, { mapping = process.env.CYBERBOSS_CUA_CHAT_BY_TALKER, fallback = "" } = {}) {
  const pairs = String(mapping || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const index = item.indexOf("=");
      return index > 0 ? [item.slice(0, index).trim(), item.slice(index + 1).trim()] : null;
    })
    .filter(Boolean);
  const hit = pairs.find(([wxid]) => wxid === String(talker || "").trim());
  if (hit) {
    return hit[1];
  }
  if (fallback) {
    return fallback;
  }
  throw new Error(
    `no conversation label configured for talker ${JSON.stringify(talker)}; `
    + "set CYBERBOSS_CUA_CHAT_BY_TALKER=\"wxid=显示名,...\" (a wrong guess would message the wrong person)",
  );
}

function localIdFor({ talker, text, attempt = 1 }) {
  return crypto.createHash("sha256").update(`${talker}\u0000${text}\u0000${attempt}`, "utf8").digest("hex").slice(0, 16);
}

/**
 * Send one text message to `talker` through Cua.
 *
 * @returns {Promise<{dispatched:boolean, verified:boolean, localId:string, uncertain?:boolean, verificationError?:string, chat:string, focusCosts:string[], steps:Array}>}
 */
async function sendWeChatCuaText(config, {
  talker = "",
  text = "",
  contact = "",
  messageKind = "",
  idempotencyKey = "",
  messageLedger = null,
  session = null,
  target = null,
  chatLabel = "",
  noForegroundSwitch = null,
  attempt = 1,
  ledger = sharedLedger,
  resolveLabel = resolveChatLabel,
} = {}) {
  const content = String(text || "");
  if (!content.trim()) {
    throw new Error("sendWeChatCuaText needs non-empty text");
  }
  const resolvedTalker = String(talker || contact || "").trim();
  const chat = chatLabel || resolveLabel(resolvedTalker, { fallback: resolvedTalker === "" ? DEFAULT_TARGET : "" });

  const cua = session || new CuaSession(`cyberboss-out-${process.pid}`);
  let win;
  try {
    win = target || findWeChatWindow(cua);
  } catch (error) {
    // The same rule as the send ladder below: nothing has been typed when the window
    // cannot even be located, so this is a CERTAIN failure. Measured 2026-10-02: this
    // call sat OUTSIDE the try, so a transient "no WeChat window" threw untagged, the
    // acknowledgement was merely logged, and the reply was recorded as
    // `failed/delivery_uncertain` - the user got neither 处理中 nor an answer, and
    // nothing retried it. Tagged, the reply is deferred and arrives when the driver is
    // healthy again.
    if (error && error.deliveryUncertain === undefined) {
      error.deliveryUncertain = false;
    }
    throw error;
  }

  let claim = null;
  if (messageLedger && typeof messageLedger.planAndClaim === "function") {
    // Ledger integration is deliberately optional: the bot's ledger has its own
    // claim/verify lifecycle, and this module must not assume it is present.
    claim = await messageLedger.planAndClaim({ talker: resolvedTalker, text: content, messageKind, idempotencyKey });
  }

  let result;
  try {
    result = sendMessage(win, chat, content, {
      session: cua,
      allowForegroundSwitch: !config?.wechatCuaNoForegroundSwitch,
    });
  } catch (error) {
    // Anything thrown out of the send ladder before a single keystroke is a certain
    // failure; the deferral path only retries those, so the flag must survive this
    // seam even if the error was re-created on the way.
    if (error && error.deliveryUncertain === undefined) {
      error.deliveryUncertain = false;
    }
    throw error;
  }
  const focusCosts = result.steps.filter((s) => s.cost && s.cost !== "none").map((s) => `${s.step}:${s.cost}`);
  // A slow send is a bug report, not a mystery: measured 2026-10-02 an acknowledgement
  // took 9927ms and nothing in the log said where it went. Now the step offsets do.
  const slowestStepMs = result.steps.reduce((max, step) => Math.max(max, Number(step.ms) || 0), 0);
  if (slowestStepMs > 4000) {
    const breakdown = result.steps.map((step) => `${step.step}:${Number(step.ms) || 0}ms`).join(" ");
    console.warn(`[cyberboss] cua send slow chat=${chat} totalMs=${slowestStepMs} ${breakdown}`);
  }
  // A minimized client is the one case where sending makes the window VISIBLY come
  // back: the driver can only un-minimize with bring_to_front, which raises it and
  // leaves it in front (unlike a conversation switch, whose activation is transient,
  // measured 150-300ms). That behaviour is deliberate - it is how a reply reaches a
  // user who minimized WeChat - but it must never be invisible, because from the
  // outside it looks exactly like "the bot is stealing my screen". If this line gets
  // noisy, the alternative is to stop restoring and defer the reply instead.
  const restoredFromMinimized = result.steps.some((step) => step.firstAttempt?.reason === "window_minimized")
    || result.steps.some((step) => step.skippedRepress && step.firstAttempt?.reason === "window_minimized");
  if (restoredFromMinimized) {
    console.warn(`[cyberboss] cua send: WeChat was minimized and had to be brought forward to type (chat=${chat})`);
  }
  const localId = localIdFor({ talker: resolvedTalker, text: content, attempt });

  if (!result.ok) {
    // `uncertain` is the difference between "deferred and retried" and "dropped":
    // stream-delivery only defers a result that says `uncertain === false`. When the
    // client can prove nothing left (our text is still in the composer, or it never got
    // there), the honest answer is `uncertain: false` - and measured 2026-10-02 the
    // missing flag is why two replies were recorded as terminal failures with the user
    // seeing nothing at all.
    const certainNotSent = result.certainNotSent === true;
    if (!certainNotSent) {
      console.warn(`[cyberboss] cua send unconfirmed (treated as uncertain) chat=${chat}: ${String(result.verify).slice(0, 120)}`);
    }
    return {
      dispatched: false,
      verified: false,
      localId: "",
      chat,
      focusCosts,
      steps: result.steps,
      uncertain: !certainNotSent,
      verificationError: result.verify,
    };
  }

  // Record before returning: the inbound reader must already know this text is
  // ours by the time the next poll happens. This is not bookkeeping - without it the
  // reader sees our own message as an unexplained row change and answers it. Measured
  // 2026-10-02: a self-check message sent straight through the client (recording no
  // echo) made the bot reply 处理中 to itself in the operator's chat.
  ledger.record(chat, content);

  return {
    dispatched: true,
    // Honest split: `dispatched` came from the composer letting go, `verified` from the
    // preview row carrying the text. The caller decides what to do with an unverified
    // dispatch (it must not retry it - that would duplicate - and it must not claim the
    // receipt either).
    verified: result.verified === true,
    localId,
    chat,
    focusCosts,
    steps: result.steps,
    verification: result.verify,
    restoredFromMinimized,
    ...(claim ? { ledgerClaim: Boolean(claim) } : {}),
  };
}

module.exports = {
  sendWeChatCuaText,
  resolveChatLabel,
  localIdFor,
  sharedLedger,
  DEFAULT_TARGET,
};
