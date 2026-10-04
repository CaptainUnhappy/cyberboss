#!/usr/bin/env node
/**
 * Rescue a reply that is stuck unsent in WeChat's composer.
 *
 * Measured 2026-10-04: a reply had been typed into Azzy's chat and the Return was
 * refused (`window_minimized`), so the text stayed in the box as a WeChat *draft*,
 * the operator saw no answer, and every later send to that chat refused to type
 * over it. This script is the operator-side cure: restore the window without
 * stealing focus (SW_SHOWNOACTIVATE), read the composer, and either send what is
 * there or clear it.
 *
 * usage:
 *   node scripts/cua-rescue-draft.js <chatLabel> [--send] [--clear] [--text "..."]
 *
 * With neither --send nor --clear and no --text it only reports what it found.
 */
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);
require(path.join(ROOT, "node_modules", "dotenv")).config({ path: path.join(ROOT, ".env") });

const { CuaSession, toTarget, findWeChatWindow, currentConversation, elements, labelOf } = require(
  path.join(ROOT, "src", "integrations", "wechat-cua", "client"));

const ARGS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const FLAGS = process.argv.slice(2).filter((a) => a.startsWith("--"));
const flagValue = (name, fallback) => {
  const inline = FLAGS.find((entry) => entry.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1) || fallback;
  const index = FLAGS.indexOf(name);
  return index >= 0 && FLAGS[index + 1] && !FLAGS[index + 1].startsWith("--")
    ? FLAGS[index + 1]
    : fallback;
};
const LABEL = ARGS[0] || "Azzy";
const SEND = FLAGS.includes("--send");
const CLEAR = FLAGS.includes("--clear");
const TEXT = flagValue("--text", "");

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function openChat(session, target, label) {
  const wanted = new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  let conv = currentConversation(session, target);
  if (wanted.test(conv.label)) {
    return { switchMs: 0, route: "already-open", conv };
  }
  const row = elements(session.snapshot(target)).find((el) => el.role === "ListItem" && wanted.test(labelOf(el)));
  if (!row) {
    throw new Error(`no conversation row for ${JSON.stringify(label)}`);
  }
  const started = Date.now();
  let res = session.call("click", { ...target, element_token: row.element_token, delivery_mode: "foreground" });
  if (res?.payload?.refusal?.code === "window_minimized") {
    const restored = session.restoreMinimized(target.pid);
    console.log(`window was minimized; restored without activation: ${JSON.stringify(restored)}`);
    if (!restored?.ok) {
      throw new Error(`could not restore the window: ${restored?.error || "unknown"}`);
    }
    sleep(600);
    const fresh = elements(session.snapshot(target)).find((el) => el.role === "ListItem" && wanted.test(labelOf(el)));
    res = session.call("click", { ...target, element_token: fresh?.element_token || row.element_token, delivery_mode: "foreground" });
  }
  sleep(1500);
  conv = currentConversation(session, target);
  if (!wanted.test(conv.label)) {
    throw new Error(`could not open ${label} (refusal: ${JSON.stringify(res?.payload?.refusal?.code || "none")})`);
  }
  return { switchMs: Date.now() - started, route: "foreground-click", conv };
}

(async () => {
  const session = new CuaSession(`cua-rescue-${process.pid}`);
  const window = findWeChatWindow(session);
  const target = toTarget(window);
  console.log(`wechat pid=${window.pid} window=${window.window_id} minimized=${window.minimized}`);

  const opened = openChat(session, target, LABEL);
  console.log(`opened ${LABEL} via ${opened.route} in ${opened.switchMs}ms`);

  const box = opened.conv.box;
  const draft = String(box?.value ?? "");
  console.log(`composer holds (${draft.length} chars): ${JSON.stringify(draft.slice(0, 200))}`);

  if (TEXT) {
    if (draft) {
      console.log("clearing the existing draft first");
      session.call("set_value", { ...target, element_token: box.element_token, value: "" });
      sleep(400);
    }
    const freshBox = currentConversation(session, target).box;
    const typed = session.call("type_text", {
      ...target, element_token: freshBox.element_token, text: TEXT, delivery_mode: "foreground",
    });
    sleep(300);
    console.log(`typed replacement: ok=${!typed.__failed}`);
  }

  if (SEND) {
    const now = currentConversation(session, target);
    const value = String(now.box?.value ?? "");
    if (!value) {
      console.log("nothing to send: the composer is empty");
      process.exit(0);
    }
    const sent = session.call("type_text", {
      ...target, element_token: now.box.element_token, text: "\n", delivery_mode: "foreground",
    });
    sleep(1200);
    const after = currentConversation(session, target);
    const stillThere = String(after.box?.value ?? "") === value;
    console.log(`newline delivered: ok=${!sent.__failed} refusal=${sent?.payload?.refusal?.code || "none"} `
      + `| composer now ${stillThere ? "STILL HOLDS THE TEXT" : "empty (sent)"}`);
    if (stillThere) {
      const button = elements(after.snapshot).find((el) => labelOf(el) === "发送");
      if (button) {
        const clicked = session.call("click", { ...target, element_token: button.element_token, delivery_mode: "foreground" });
        sleep(1200);
        const finalBox = currentConversation(session, target).box;
        console.log(`send-button fallback: refusal=${clicked?.payload?.refusal?.code || "none"} `
          + `| composer now ${String(finalBox?.value ?? "") ? "STILL HOLDS THE TEXT" : "empty (sent)"}`);
      } else {
        console.log("no 发送 button found for the fallback");
      }
    }
  } else if (CLEAR) {
    if (!draft) {
      console.log("nothing to clear");
    } else {
      const cleared = session.call("set_value", { ...target, element_token: box.element_token, value: "" });
      sleep(400);
      const after = currentConversation(session, target);
      console.log(`cleared: refusal=${cleared?.payload?.refusal?.code || "none"} `
        + `| composer now ${JSON.stringify(String(after.box?.value ?? ""))}`);
    }
  }
  process.exit(0);
})().catch((error) => {
  console.error("rescue failed:", error.stack || error.message);
  process.exit(1);
});
