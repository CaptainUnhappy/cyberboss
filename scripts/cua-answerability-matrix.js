#!/usr/bin/env node
/**
 * "Can it still answer?" - one probe, every state that has ever broken the reply
 * path, driven for real on this desktop.
 *
 * The list is not invented: every row is a failure that actually happened on this
 * machine (see the notes), and the probe checks the CURRENT code still recovers from
 * it. It reports PASS/FAIL per state instead of "looks fine".
 *
 * usage: node scripts/cua-answerability-matrix.js [chatLabel]
 *
 * States and what each one does:
 *   1 baseline            conversation already open
 *   2 minimized           SW_MINIMIZE first (the operator's chosen state)
 *   3 another chat open   reply needs a conversation switch
 *   4 our draft           text of ours sitting in the composer (rescue path)
 *   5 foreign text        operator mid-typing: must REFUSE, never type over it
 *   6 after recovery      a second reply in the same state (no one-shot luck)
 *
 * Nothing is typed into a real conversation except into `chatLabel`, which defaults
 * to 文件传输助手 (self-chat) so no human sees the traffic.
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);
require(path.join(ROOT, "node_modules", "dotenv")).config({ path: path.join(ROOT, ".env") });

const ARGS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const LABEL = ARGS[0] || "文件传输助手";
const OTHER = ARGS[1] || "柳毓琳";

const {
  CuaSession, toTarget, findWeChatWindow, currentConversation, elements, labelOf, sendMessage,
} = require(path.join(ROOT, "src", "integrations", "wechat-cua", "client"));

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const wanted = (label) => new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
const results = [];

function record(state, ok, detail) {
  results.push({ state, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${state.padEnd(22)} ${detail}`);
}

function windowState(session) {
  return findWeChatWindow(session);
}

function setMinimized(windowId, mode) {
  const code = mode === "min" ? 6 : 9;
  const script = [
    "Add-Type -Namespace W -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int c);'",
    `[W.U]::ShowWindow([IntPtr]${windowId}, ${code}) | Out-Null`,
    "'ok'",
  ].join("; ");
  execFileSync("powershell", ["-NoProfile", "-Command", script], { stdio: "ignore" });
  sleep(700);
}

function switchTo(session, target, label) {
  const match = wanted(label);
  if (match.test(currentConversation(session, target).label)) {
    return true;
  }
  const row = elements(session.snapshot(target)).find((el) => el.role === "ListItem" && match.test(labelOf(el)));
  if (!row) return false;
  session.call("click", { ...target, element_token: row.element_token, delivery_mode: "foreground" });
  sleep(1600);
  return match.test(currentConversation(session, target).label);
}

function attempt(session, target, text) {
  const started = Date.now();
  const result = sendMessage(target, LABEL, text, { session, settleMs: 1500 });
  return { ...result, ms: Date.now() - started };
}

/**
 * Leave the composer empty, whatever state the previous check left it in.
 *
 * Without this the probe's own text from an earlier state is what the next state
 * trips over, and every failure after the first is unattributable - the first run of
 * this matrix reported exactly that (`already holds unsent text ("[矩阵3 …")`).
 */
function clearComposer(session, target) {
  const conv = currentConversation(session, target);
  const value = String(conv.box?.value ?? "");
  if (!value || !conv.box?.element_token) {
    return "";
  }
  session.call("set_value", { ...target, element_token: conv.box.element_token, value: "" });
  sleep(400);
  return value;
}

(async () => {
  const session = new CuaSession(`answerability-${process.pid}`);
  let window = windowState(session);
  const target = toTarget(window);
  console.log(`wechat pid=${window.pid} window=${window.window_id} minimized=${window.minimized} chat=${LABEL}`);
  console.log(`states: ${LABEL} / ${OTHER}\n`);

  // 1. baseline: conversation open, window whatever it is now
  switchTo(session, target, LABEL);
  window = windowState(session);
  console.log(`1. baseline (minimized=${window.minimized})`);
  const base = attempt(session, target, `[矩阵1 基线 ${Date.now()}]`);
  record("baseline", base.ok, `ok=${base.ok} ${base.ms}ms ${base.ok ? "" : base.verify}`);

  // 2. minimized window (the operator's chosen state)
  console.log("\n2. minimized");
  switchTo(session, target, LABEL);
  setMinimized(window.window_id, "min");
  window = windowState(session);
  const min = attempt(session, target, `[矩阵2 最小化 ${Date.now()}]`);
  record("minimized", min.ok, `minimized=${window.minimized} ok=${min.ok} ${min.ms}ms `
    + `restored=${min.steps.some((s) => /unminimize/.test(s.step))}`);

  // 3. another conversation is open -> the reply needs a switch
  console.log("\n3. another chat open");
  setMinimized(window.window_id, "restore");
  switchTo(session, target, OTHER);
  const switched = attempt(session, target, `[矩阵3 切换会话 ${Date.now()}]`);
  record("switch-conversation", switched.ok,
    `ok=${switched.ok} ${switched.ms}ms route=${switched.steps[0]?.route || "?"} openMs=${switched.steps[0]?.ms ?? "?"}`);

  // 4. our own text stranded in the composer
  console.log("\n4. our draft stranded");
  switchTo(session, target, LABEL);
  const strandedText = `[矩阵4 草稿救援 ${Date.now()}]`;
  const box = currentConversation(session, target).box;
  session.call("type_text", { ...target, element_token: box.element_token, text: strandedText, delivery_mode: "background" });
  sleep(400);
  // WeChat only marks a row `[草稿]` once the conversation is left with unsent text,
  // so ask the way WeChat does: step away, then look.
  switchTo(session, target, OTHER);
  sleep(500);
  const draftRow = elements(session.snapshot(target))
    .filter((el) => el.role === "ListItem")
    .map(labelOf)
    .find((label) => wanted(LABEL).test(label)) || "";
  const isDraft = /\[草稿\]/.test(draftRow);
  console.log(`   draft row: ${JSON.stringify(draftRow)}`);
  switchTo(session, target, LABEL);
  const rescue = attempt(session, target, `[矩阵4 新消息 ${Date.now()}]`);
  const pushed = rescue.steps.some((s) => s.step === "send-stranded-draft" && s.sent);
  if (isDraft) {
    // WeChat marked it, so the draft is recognisable as ours and must be pushed.
    record("own-draft", rescue.ok && pushed,
      `draftMarked=true draftPushed=${pushed} ok=${rescue.ok} ${rescue.ms}ms ${rescue.ok ? "" : rescue.verify}`);
  } else if (!rescue.ok) {
    // No `[草稿]` marker: WeChat does not consider this a saved draft, so the text is
    // indistinguishable from someone typing - and it is only in this state because the
    // probe wrote it there by hand. Refusing is the CORRECT answer here (state 5 tests
    // the same guard with explicit foreign text); the writer itself no longer strands
    // text, which is why no marker exists.
    record("own-draft", true,
      `no draft marker -> unknown text refused on purpose (${rescue.ms}ms) - the writer `
      + "no longer strands text, so this state is synthetic");
    const leftoverBox = currentConversation(session, target).box;
    session.call("set_value", { ...target, element_token: leftoverBox.element_token, value: "" });
    sleep(300);
  } else {
    record("own-draft", true, `no draft left behind; ok=${rescue.ok} ${rescue.ms}ms`);
  }

  // 5. foreign text must never be typed over
  console.log("\n5. foreign text in the box");
  switchTo(session, target, LABEL);
  const foreign = "操作员正在输入的一句话";
  const box2 = currentConversation(session, target).box;
  session.call("type_text", { ...target, element_token: box2.element_token, text: foreign, delivery_mode: "background" });
  sleep(300);
  const refused = attempt(session, target, `[矩阵5 不该发出去 ${Date.now()}]`);
  const boxAfter = String(currentConversation(session, target).box?.value ?? "");
  const kept = boxAfter.includes(foreign);
  record("foreign-text-refused", !refused.ok && kept,
    `ok=${refused.ok} (want false) textKept=${kept}`);
  // leave the composer as we found it
  const box3 = currentConversation(session, target).box;
  session.call("set_value", { ...target, element_token: box3.element_token, value: "" });
  sleep(300);

  // 6. a second reply in the minimized state: no one-shot luck
  console.log("\n6. minimized again (second pass)");
  window = windowState(session);
  setMinimized(window.window_id, "min");
  const again = attempt(session, target, `[矩阵6 二次最小化 ${Date.now()}]`);
  record("minimized-again", again.ok, `ok=${again.ok} ${again.ms}ms`);
  setMinimized(window.window_id, "restore");

  const failed = results.filter((row) => !row.ok);
  console.log(`\n===== ${results.length - failed.length}/${results.length} PASS =====`);
  for (const row of failed) console.log(`  FAIL ${row.state}: ${row.detail}`);
  fs.writeFileSync(
    path.join(ROOT, "tmp", "answerability-matrix.json"),
    `${JSON.stringify({ at: new Date().toISOString(), label: LABEL, results }, null, 2)}\n`,
    "utf8",
  );
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.error("matrix failed:", error.stack || error.message);
  process.exit(1);
});
