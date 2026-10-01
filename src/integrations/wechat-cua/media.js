// media.js - send a FILE through Cua, the way WeChat accepts it.
//
// WeChat has no "attach" API: an attachment gets in through the clipboard and
// Ctrl+V, then Return - the same two-step the RDP-era bridge used.
//
// ## What actually works on this client
//
// Measured 2026-10-01 on WeChat desktop with Cua Driver 0.31.0:
//
//   clipboard_write({ file_path })   -> CF_HDROP, supported, paste lands
//   clipboard_write({ image_path })  -> REFUSED: error_code `clipboard_unavailable`,
//                                       supported:false. The image never reaches the
//                                       clipboard, so no paste can ever succeed.
//   clipboard_write({ text })        -> CF_UNICODETEXT, supported
//   hotkey ["ctrl","v"] background   -> PostMessage; the modifier is LOST and a
//                                       literal "v" is typed into the composer
//   hotkey ["ctrl","v"] foreground   -> SendInput; the payload really pastes
//
// Three rules follow, and they are the whole point of this file:
//
//  1. **Paste is always foreground.** The background route is not a weaker paste,
//     it is a different action that types the letter "v".
//  2. **An unconfirmed paste is never sent.** A pasted file/image leaves an object
//     in the composer, which the UIA value reports as U+FFFC; text lands as text.
//     Anything else means the paste failed, so the composer is wiped instead of
//     pressing Return.
//  3. **Verification is by content, not by counting.** The conversation list
//     scrolls: a real file send was observed while the list length *dropped* by
//     one ("文件\ncua-file-probe.txt\n29B" replaced an older item in the window).
//     Counting would have called that a failure.
//
// Known limit: **images cannot be sent through this path at all** on this build,
// because the driver refuses to put an image on the clipboard.

const path = require("node:path");
const { CuaSession, toTarget, ensureConversation, currentConversation } = require("./client");
const { readConversation } = require("./inbound");

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function brief(res) {
  if (!res) return "no response";
  if (res.__failed) return `FAILED ${JSON.stringify(res.payload).slice(0, 200)}`;
  const parts = [];
  if (res.route) parts.push(`route=${res.route}`);
  if (res.delivery?.mode) parts.push(`mode=${res.delivery.mode}`);
  if (res.effect) parts.push(`effect=${res.effect}`);
  if (res.refusal?.code) parts.push(`refusal=${res.refusal.code}`);
  if (res.escalation) parts.push(`escalation=${JSON.stringify(res.escalation)}`);
  if (res.summary) parts.push(String(res.summary).slice(0, 140));
  return parts.join(" ");
}

/**
 * Paste a file (or a text payload) into `chatLabel` and optionally send it.
 *
 * @param {object} options
 * @param {string} [options.filePath]  absolute path to the file to attach (works)
 * @param {string} [options.imagePath] absolute path to an image (refused today)
 * @param {boolean} [options.send]     press Return after a CONFIRMED paste (default true)
 * @returns {{ok:boolean, sent:boolean, verify:string, steps:Array, focusCosts:string[]}}
 */
function sendMedia(target, chatLabel, {
  filePath = "",
  imagePath = "",
  session = new CuaSession(),
  send = true,
  settleMs = 2500,
} = {}) {
  const steps = [];
  const focusCosts = [];
  if (!filePath && !imagePath) {
    throw new Error("sendMedia needs filePath or imagePath");
  }
  const opened = ensureConversation(session, toTarget(target), chatLabel, { settleMs: 1800 });
  steps.push({ step: "open", ...opened });
  if (opened.cost && opened.cost !== "none") focusCosts.push(`open:${opened.cost}`);

  const payloadName = path.basename(filePath || imagePath);
  const clipped = session.call("clipboard_write", filePath ? { file_path: filePath } : { image_path: imagePath });
  steps.push({ step: "clipboard", outcome: clipped });
  if (clipped.__failed || clipped.supported === false) {
    return {
      ok: false,
      sent: false,
      verify: imagePath
        ? `clipboard_write refused the image (${clipped?.error_code || "unknown"}); images are not supported on this build - pass filePath instead`
        : `clipboard_write refused the payload (${clipped?.error_code || "unknown"})`,
      steps,
      focusCosts,
    };
  }
  sleep(500);

  // Foreground is mandatory: the background route types a literal "v".
  const pasted = session.call("hotkey", { ...toTarget(target), keys: ["ctrl", "v"], delivery_mode: "foreground" });
  steps.push({ step: "paste", outcome: pasted });
  focusCosts.push("paste:foreground");
  sleep(settleMs);

  // --- confirmation gate -----------------------------------------------------
  const box = currentConversation(session, toTarget(target)).box;
  const boxValue = String(box?.value ?? "");
  const objectPasted = boxValue.includes("\uFFFC");
  const textPasted = !filePath && boxValue.trim().length > 0;
  if (!objectPasted && !textPasted) {
    const junk = boxValue.trim();
    if (junk && box.element_token) {
      session.call("set_value", { ...toTarget(target), element_token: box.element_token, value: "" });
    }
    return {
      ok: false,
      sent: false,
      verify: `paste not confirmed (composer held ${JSON.stringify(junk.slice(0, 40))}); cleared it and sent nothing`,
      steps,
      focusCosts,
    };
  }

  if (!send) {
    return {
      ok: true,
      sent: false,
      verify: `paste confirmed in the composer (${objectPasted ? "object" : "text"}), not sent (--no-send)`,
      steps,
      focusCosts,
    };
  }

  const sent = session.call("press_key", { ...toTarget(target), element_token: box.element_token, key: "return" });
  steps.push({ step: "return", outcome: sent });
  sleep(3000);

  const conversation = readConversation(session, toTarget(target));
  const composerNow = String(currentConversation(session, toTarget(target)).box?.value ?? "");
  const appeared = conversation.some((m) => m.text.includes(payloadName));
  return {
    ok: appeared && !composerNow.includes("\uFFFC"),
    sent: true,
    verify: appeared
      ? `conversation now carries ${JSON.stringify(payloadName)}; composer ${composerNow.trim() ? "still holds something" : "empty"}`
      : `no bubble mentioning ${JSON.stringify(payloadName)} appeared (newest: ${JSON.stringify((conversation.at(-1)?.text || "").slice(0, 40))})`,
    steps,
    focusCosts,
  };
}

module.exports = { sendMedia, brief };
