#!/usr/bin/env node
"use strict";

/**
 * Wake the fixed repair session (维修工) with one fault report.
 *
 * Channel: the `acp` profile - the same surface Cyberboss itself drives - because
 * it advertises `session/list` + `session/resume` and keeps sessions in the shared
 * `~/.dsh/sessions` store. A one-shot `dsh --profile acp` process prompts the
 * durable repair session and exits; nothing stays resident.
 *
 * The session id lives in the deployment state dir, not in the repo, so a fresh
 * checkout can still talk to the same repair worker. Pass `--ensure-session` to
 * mint one when it is missing.
 *
 * Usage:
 *   node scripts/repair-dispatch.js --fault <snapshot.json> [--reason "..."]
 *   node scripts/repair-dispatch.js --ensure-session
 */

const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(PROJECT_ROOT, ".env") });

const { AcpRpcClient } = require("../src/adapters/runtime/dsh-acp/rpc-client");
const { defaultDshBin } = require("../src/adapters/runtime/dsh/rpc-client");

const STATE_DIR = process.env.CYBERBOSS_REPAIR_STATE_DIR || "C:\\ProgramData\\cwin-probe\\repair";
const SESSION_FILE = path.join(STATE_DIR, "session.json");
const LOCK_FILE = path.join(STATE_DIR, "in-progress.json");
const LOG_FILE = path.join(STATE_DIR, "dispatch.log");
const PROFILE = (process.env.CYBERBOSS_REPAIR_PROFILE || "acp").trim();
const REPAIR_CWD = (process.env.CYBERBOSS_REPAIR_CWD || PROJECT_ROOT).trim();
/** A repair may restart services and wait for a verification round trip. */
const PROMPT_TIMEOUT_MS = Number(process.env.CYBERBOSS_REPAIR_PROMPT_TIMEOUT_MS) || 45 * 60_000;

const BOOTSTRAP_TEXT = [
  "你是本项目的固定维修工（repair session），职责是收到故障报告后修复这台机器上的 Cyberboss 服务。",
  "工作方式：",
  "1. 诊断：先看故障报告里的组件与时间，再读证据（C:\\ProgramData\\cwin-probe\\ 下的日志、tmp\\cwin-lab\\ 的观测文件、账本与义务存储）。",
  "2. 修复：优先使用 scripts/isolated-session/ 下已入库的配方（weflow-restart.ps1 / bridge-restart.ps1 / rdp-keepalive.py / rdp-autologin.py），并遵守笔记 .agents/notes/implemented/process/2026-09-18-rdpwrap-isolated-session-deployment.md 里的硬约束。",
  "3. 验证：修复后运行 `node scripts/repair-verify.js`；它用 test-session 向大号发一条重启消息并等机器人回复唯一标记，退出码 0 才算通过。",
  "4. 汇报：把结论写进 C:\\ProgramData\\cwin-probe\\repair\\report-<时间戳>.json（字段 ok / actions / verify.ok / verify.marker / verify.detail），并在本会话里简短说明。",
  "边界：不要改 .env 里的端口与账号身份；不要重启属于用户会话（session 1）的程序；一次只修一个故障，修完就停。",
  "现在先只回复 READY，不要做任何操作。",
].join("\n");

function parseArgs(argv) {
  const args = { fault: "", reason: "", ensureSession: false, text: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--fault") args.fault = argv[++index] || "";
    else if (flag === "--reason") args.reason = argv[++index] || "";
    else if (flag === "--text") args.text = argv[++index] || "";
    else if (flag === "--ensure-session") args.ensureSession = true;
  }
  return args;
}

function appendLog(line) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`, "utf8");
}

function readSessionId() {
  const fromEnv = (process.env.CYBERBOSS_REPAIR_SESSION_ID || "").trim();
  if (fromEnv) return { sessionId: fromEnv, source: "env" };
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
    const sessionId = String(parsed.sessionId || "").trim();
    if (sessionId) return { sessionId, source: SESSION_FILE };
  } catch {
    // No session recorded yet.
  }
  return { sessionId: "", source: "" };
}

function writeSessionId(sessionId) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(
    SESSION_FILE,
    `${JSON.stringify({ sessionId, cwd: REPAIR_CWD, profile: PROFILE, at: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

function buildRequestText(args) {
  const lines = [
    "【故障报告】",
    `时间：${new Date().toISOString()}`,
    `主机：${process.env.COMPUTERNAME || "unknown"}，触发方：心跳看门狗（scripts/repair-dispatch.js）`,
  ];
  if (args.reason) lines.push(`原因摘要：${args.reason}`);
  if (args.fault) {
    try {
      const raw = fs.readFileSync(args.fault, "utf8");
      lines.push("快照：", "```json", raw.trim().slice(0, 4000), "```");
    } catch (error) {
      lines.push(`快照读取失败：${error.message}（路径 ${args.fault}）`);
    }
  }
  lines.push(
    "请按你的职责处理：诊断 → 修复 → 运行 `node scripts/repair-verify.js` 验证 → 写 report-<时间戳>.json → 简短回复结论。",
  );
  return lines.join("\n");
}

function extractAssistantText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const parts = blocks
    .map((block) => (block && block.type === "text" ? String(block.text || "") : ""))
    .filter(Boolean);
  if (parts.length) return parts.join("\n").trim();
  if (typeof result?.text === "string") return result.text.trim();
  return "";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(STATE_DIR, { recursive: true });

  if (fs.existsSync(LOCK_FILE)) {
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    if (lock?.pid && lock.pid !== process.pid) {
      try {
        process.kill(lock.pid, 0);
        appendLog(`skip: repair already in progress pid=${lock.pid} since ${lock.startedAt}`);
        console.log(JSON.stringify({ dispatched: false, reason: "repair_in_progress", pid: lock.pid }));
        return 0;
      } catch {
        appendLog(`stale lock from pid=${lock.pid}; taking over`);
      }
    }
  }
  fs.writeFileSync(
    LOCK_FILE,
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), reason: args.reason }, null, 2)}\n`,
    "utf8",
  );

  const client = new AcpRpcClient({
    dshBin: defaultDshBin(),
    profile: PROFILE,
    cwd: REPAIR_CWD,
    promptTimeoutMs: PROMPT_TIMEOUT_MS,
  });

  // The repair worker has to act on its own: nobody is sitting in front of the ACP
  // session to approve a tool call, and an unanswered permission request would stall
  // the turn until its timeout. Approve the offered allow-option and log it.
  client.onRequest("session/request_permission", (params) => {
    const options = Array.isArray(params?.options) ? params.options : [];
    const allow = options.find((option) => /allow|approve/i.test(String(option?.kind || "")))
      || options.find((option) => /allow|approve|同意|允许/i.test(String(option?.name || "")))
      || options[0];
    const optionId = allow?.optionId || allow?.id || "";
    appendLog(`permission auto-approved: tool=${params?.toolCall?.title || params?.toolCall?.kind || "?"} option=${optionId} of ${options.length}`);
    return { outcome: { outcome: "selected", optionId } };
  });

  let exitCode = 0;
  const summary = { dispatched: false, createdSession: false, sessionId: "", cwd: REPAIR_CWD, profile: PROFILE };
  try {
    await client.initialize();
    const existing = readSessionId();
    let sessionId = existing.sessionId;
    if (!sessionId) {
      if (!args.ensureSession && !args.fault && !args.reason && !args.text) {
        throw new Error("no repair session recorded; run with --ensure-session once");
      }
      sessionId = await client.newSession({ cwd: REPAIR_CWD });
      writeSessionId(sessionId);
      summary.createdSession = true;
      appendLog(`created repair session id=${sessionId} profile=${PROFILE} cwd=${REPAIR_CWD}`);
      const bootstrap = await client.prompt(sessionId, [{ type: "text", text: BOOTSTRAP_TEXT }]);
      appendLog(`bootstrap reply: ${extractAssistantText(bootstrap).slice(0, 300)}`);
      if (!args.fault && !args.reason && !args.text) {
        summary.sessionId = sessionId;
        summary.dispatched = true;
        console.log(JSON.stringify(summary, null, 2));
        return 0;
      }
    }
    summary.sessionId = sessionId;
    appendLog(`resume repair session id=${sessionId} (from ${existing.source || "new"})`);

    // A stored id can outlive the session: the DSH store drops sessions, and then
    // every wake failed with "unknown session" instead of repairing anything
    // (measured 2026-09-22: the watchdog woke the worker and it died on the id).
    // Recover by minting a replacement rather than reporting a dead repair path.
    if (!summary.createdSession) {
      try {
        await client.resumeSession(sessionId, { cwd: REPAIR_CWD });
      } catch (error) {
      if (!/unknown session/i.test(String(error && error.message))) throw error;
      appendLog(`stored repair session ${sessionId} no longer exists; creating a replacement`);
      try {
        fs.renameSync(SESSION_FILE, `${SESSION_FILE}.stale-${Date.now()}`);
      } catch {
        // No stored file to archive.
      }
      sessionId = await client.newSession({ cwd: REPAIR_CWD });
      writeSessionId(sessionId);
      summary.sessionId = sessionId;
      summary.createdSession = true;
      appendLog(`replacement repair session id=${sessionId}; bootstrapping`);
      await client.prompt(sessionId, [{ type: "text", text: BOOTSTRAP_TEXT }]);
      }
    }

    const requestText = args.text || buildRequestText(args);
    const startedAt = Date.now();
    const result = await client.prompt(sessionId, [{ type: "text", text: requestText }]);
    const reply = extractAssistantText(result);
    const elapsedMs = Date.now() - startedAt;
    summary.dispatched = true;
    summary.elapsedMs = elapsedMs;
    summary.reply = reply.slice(0, 2000);
    appendLog(`repair turn finished in ${Math.round(elapsedMs / 1000)}s: ${reply.slice(0, 400)}`);

    const reportPath = path.join(STATE_DIR, `dispatch-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(reportPath, `${JSON.stringify({ ...summary, request: requestText.slice(0, 2000) }, null, 2)}\n`, "utf8");
    summary.report = reportPath;
  } catch (error) {
    exitCode = 1;
    summary.error = error.message;
    appendLog(`dispatch failed: ${error.message}`);
  } finally {
    try {
      await client.shutdown();
    } catch {
      // The turn result is what matters.
    }
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {
      // Already gone.
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    appendLog(`fatal: ${error && error.message ? error.message : error}`);
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  },
);
