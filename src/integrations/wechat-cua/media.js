// media.js - send an image or a file through Cua, the way WeChat accepts it.
//
// WeChat has no "attach" API: an image or a file gets in through the clipboard
// and Ctrl+V, then Return - the same two-step the RDP-era bridge used.
//
// Measured interface facts that shape this file (Cua Driver 0.31.0):
//
//   clipboard_write  takes text, image_path (an image), or file_path (a file URL)
//   hotkey           with modifiers does NOT use PostMessage: it does a brief
//                    SetForegroundWindow + SendInput, because PostMessage cannot
//                    update the OS-wide modifier state a Win32 app reads via
//                    GetKeyState/TranslateAccelerator. So a paste costs a
//                    foreground swap, and the driver says so.
//
// Therefore a media send costs one focus steal for the conversation switch plus
// one for the paste. That is the price of not having RDP; it is measured, not
// assumed (scripts/cua-wechat-media-live.js reports both).

const { CuaSession, toTarget, ensureConversation, currentConversation } = require("./client");
const { readConversation } = require("./inbound");
const path = require("node:path");

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
 * Put an image or a file on the clipboard and paste it into `chatLabel`.
 *
 * ## The rule this function exists to enforce
 *
 * A paste can fail while Return still succeeds - and then the chat receives
 * whatever the keys actually were. Measured 2026-10-01: `hotkey ["ctrl","v"]`
 * was reported as "Pressed ctrl+v via PostMessage", the modifier did not take
 * effect, and a literal `v` was typed; pressing Return published that `v` into a
 * real conversation. So this function never presses Return until the paste is
 * confirmed, and it reports `ok: false` with the box contents when it is not.
 *
 * Confirmation means one of:
 *   - the paste produced a message-bubble placeholder in the conversation
 *     (`[图片]` / `[文件]` / ...), or
 *   - the message box now shows the expected text (a file path, which WeChat
 *     pastes as text before sending).
 * Anything else is a failed paste: the box is left wiped and nothing is sent.
 *
 * @param {object} options
 * @param {string} [options.imagePath] absolute path to an image
 * @param {string} [options.filePath]  absolute path to any file
 * @param {boolean} [options.send]     press Return after a CONFIRMED paste (default true)
 * @param {boolean} [options.foregroundPaste] accept a focus steal for the paste
 * @returns {{ok:boolean, verify:string, sent:boolean, steps:Array}}
 */
function sendMedia(target, chatLabel, {
  imagePath = "",
  filePath = "",
  session = new CuaSession(),
  send = true,
  settleMs = 2500,
  foregroundPaste = false,
} = {}) {
  const steps = [];
  if (!imagePath && !filePath) {
    throw new Error("sendMedia needs imagePath or filePath");
  }
  const focusCosts = [];
  const opened = ensureConversation(session, toTarget(target), chatLabel, { settleMs: 1800 });
  steps.push({ step: "open", ...opened });
  if (opened.cost && opened.cost !== "none") focusCosts.push(`open:${opened.cost}`);

  const clipArgs = imagePath ? { image_path: imagePath } : { file_path: filePath };
  const clipped = session.call("clipboard_write", clipArgs);
  steps.push({ step: "clipboard", outcome: clipped });
  if (clipped.__failed) {
    return { ok: false, sent: false, verify: "could not put the payload on the clipboard", steps, focusCosts };
  }
  sleep(500);

  const beforeMessages = readConversation(session, toTarget(target)).length;

  // Ctrl+V. On this client the driver reaches it via a foreground swap; the
  // background route is known to lose the modifier, which is why the paste is
  // verified instead of trusted.
  const pasteArgs = { ...toTarget(target), keys: ["ctrl", "v"] };
  if (foregroundPaste) pasteArgs.delivery_mode = "foreground";
  const pasted = session.call("hotkey", pasteArgs);
  steps.push({ step: "paste", outcome: pasted, focusCosts: [...focusCosts] });
  if (pasted.route === "global_input" || pasted.delivery?.mode === "foreground") {
    focusCosts.push("paste:foreground");
  }
  sleep(settleMs);

  // --- confirmation gate -----------------------------------------------------
  const afterPaste = readConversation(session, toTarget(target));
  const grew = afterPaste.length > beforeMessages;
  const newest = afterPaste.at(-1)?.text || "";
  const mediaBubble = /\[(图片|视频|文件|动画表情|语音|位置|链接)\]/u.test(newest);
  const box = currentConversation(session, toTarget(target)).box;
  const boxValue = String(box?.value ?? "");
  const expectedEcho = filePath || "";
  const pastedAsText = Boolean(expectedEcho) && boxValue.includes(path.basename(expectedEcho));

  if (!grew && !mediaBubble && !pastedAsText) {
    // Never send on an unconfirmed paste: wipe whatever the keys produced.
    const junk = boxValue.trim();
    if (junk) {
      session.call("set_value", { ...toTarget(target), element_token: box.element_token, value: "" });
    }
    return {
      ok: false,
      sent: false,
      verify: `paste not confirmed (box held ${JSON.stringify(junk.slice(0, 40))}); cleared it and sent nothing`,
      steps,
      focusCosts,
    };
  }

  if (!send) {
    return { ok: true, sent: false, verify: `paste confirmed (${mediaBubble ? "media bubble" : "box text"}), not sent (--no-send)`, steps, focusCosts };
  }

  const sent = session.call("press_key", { ...toTarget(target), key: "return" });
  steps.push({ step: "return", outcome: sent });
  sleep(2000);

  const final = readConversation(session, toTarget(target));
  const last = final.at(-1)?.text || "";
  const finalBox = currentConversation(session, toTarget(target)).box;
  const boxEmpty = !String(finalBox?.value ?? "").trim();
  const ok = boxEmpty && (final.length >= afterPaste.length);
  return {
    ok,
    sent: true,
    verify: `newest conversation item = ${JSON.stringify(last.slice(0, 40))}; box ${boxEmpty ? "empty" : "still holds text"}`,
    steps,
    focusCosts,
  };
}

module.exports = { sendMedia, brief };
