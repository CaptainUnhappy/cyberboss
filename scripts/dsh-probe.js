#!/usr/bin/env node
"use strict";

/**
 * Phase 0 probe: speak the raw DSH SDK protocol by hand and dump what the
 * runtime actually sends, so the adapter is written against observed behaviour
 * instead of the README.
 *
 * Usage: node scripts/dsh-probe.js [--dsh <path-to-bin.js>] [--cwd <dir>]
 *                                  [--prompt "<text>"] [--timeout <ms>]
 *                                  [--patch <path> ...]
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_DSH_BIN = path.join(
  process.env.LOCALAPPDATA || "",
  "npm-cache",
  "_npx",
  "1e7f6d9597241db0",
  "node_modules",
  "@deepseek-ai",
  "dsh",
  "lib",
  "bin.js",
);

function parseArgs(argv) {
  const options = {
    dshBin: DEFAULT_DSH_BIN,
    cwd: process.cwd(),
    prompt: "Reply with exactly: DSH_PROBE_OK",
    timeoutMs: 180_000,
    profile: "sdk",
    model: "deepseek-flash",
    provider: "deepseek-official",
    dump: path.join(os.tmpdir(), "dsh-probe-events.jsonl"),
    patchPaths: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === "--dsh") { options.dshBin = value; index += 1; }
    else if (token === "--cwd") { options.cwd = value; index += 1; }
    else if (token === "--prompt") { options.prompt = value; index += 1; }
    else if (token === "--timeout") { options.timeoutMs = Number(value); index += 1; }
    else if (token === "--profile") { options.profile = value; index += 1; }
    else if (token === "--model") { options.model = value; index += 1; }
    else if (token === "--provider") { options.provider = value; index += 1; }
    else if (token === "--dump") { options.dump = value; index += 1; }
    else if (token === "--patch") { options.patchPaths.push(value); index += 1; }
  }
  return options;
}

/**
 * This shell carries case-insensitive duplicate environment keys (Path/PATH,
 * NO_PROXY/no_proxy, https_proxy/HTTPS_PROXY). Windows rejects process creation
 * when the environment block contains them, so collapse each group to one key.
 */
function sanitizedEnv(source) {
  const groups = new Map();
  for (const [key, value] of Object.entries(source)) {
    const folded = key.toUpperCase();
    if (!groups.has(folded)) groups.set(folded, []);
    groups.get(folded).push([key, value]);
  }
  const out = {};
  for (const entries of groups.values()) {
    if (entries.length === 1) {
      const [key, value] = entries[0];
      out[key] = value;
      continue;
    }
    const preferred = entries.find(([, value]) => typeof value === "string" && value.length)
      || entries[0];
    out[preferred[0]] = preferred[1];
  }
  return out;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(options.dshBin)) {
    process.stderr.write(`dsh launcher not found: ${options.dshBin}\n`);
    process.exit(2);
  }

  const events = [];
  const dumpStream = fs.createWriteStream(options.dump, { flags: "w" });
  const startedAt = Date.now();

  // Frames whose full payload is worth preserving verbatim for adapter mapping.
  const INTERESTING_EVENT_TYPES = new Set([
    "turn/start", "turn/end", "step/start", "step/end",
    "assistant/message", "assistant/attempt", "user/message",
    "tool/call", "tool/result", "session/title",
    "approval/asked", "approval/decided", "deliverables/presented",
  ]);
  // These carry enormous system context; record only their shape.
  const SHAPE_ONLY_EVENT_TYPES = new Set([
    "request/context", "request/header", "system/message", "agent/inbox/spliced",
    "permission/preset", "sandbox/mode", "approval/policy", "model/selection",
  ]);

  const log = (label, payload) => {
    const line = `[${String(Date.now() - startedAt).padStart(6)}ms] ${label} `
      + `${typeof payload === "string" ? payload : JSON.stringify(payload)}`;
    process.stdout.write(`${line}\n`);
    dumpStream.write(`${JSON.stringify({ label, atMs: Date.now() - startedAt, payload })}\n`);
  };

  const dumpEvent = (sessionId, event) => {
    const type = event && event.type;
    if (INTERESTING_EVENT_TYPES.has(type)) {
      dumpStream.write(`${JSON.stringify({ label: `event:${type}`, sessionId, full: event })}\n`);
      return;
    }
    if (SHAPE_ONLY_EVENT_TYPES.has(type)) {
      dumpStream.write(`${JSON.stringify({
        label: `shape:${type}`,
        sessionId,
        envelopeKeys: Object.keys(event),
        dataKeys: event && event.data && typeof event.data === "object"
          ? Object.keys(event.data)
          : typeof (event && event.data),
      })}\n`);
    }
  };

  const spawnArgs = [options.dshBin, "--profile", options.profile];
  for (const patchPath of options.patchPaths) {
    spawnArgs.push("--patch", patchPath);
  }

  log("spawn", {
    command: process.execPath,
    args: spawnArgs,
    cwd: options.cwd,
  });

  const child = spawn(
    process.execPath,
    spawnArgs,
    {
      cwd: options.cwd,
      env: sanitizedEnv(process.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  let nextId = 1;
  const pending = new Map();
  const sessionIds = new Set();
  let stderrText = "";
  let settled = false;

  function send(method, params) {
    const id = nextId;
    nextId += 1;
    const frame = { jsonrpc: "2.0", id, method };
    if (params !== undefined) frame.params = params;
    child.stdin.write(`${JSON.stringify(frame)}\n`);
    log("send", frame);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  }

  function finish(code, reason) {
    if (settled) return;
    settled = true;
    log("finish", { reason, exitCode: code, stderr: stderrText.slice(-2000) });
    dumpStream.end();
    try { child.kill(); } catch {}
    setTimeout(() => process.exit(code), 50);
  }

  const timer = setTimeout(() => {
    log("timeout", `no completion within ${options.timeoutMs}ms`);
    finish(3, "timeout");
  }, options.timeoutMs);

  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) handleFrame(line);
      newlineIndex = buffer.indexOf("\n");
    }
  });

  child.stderr.on("data", (chunk) => {
    stderrText += chunk.toString("utf8");
    process.stderr.write(`[dsh stderr] ${chunk.toString("utf8")}`);
  });

  child.on("error", (error) => {
    log("spawn-error", String(error && error.message));
    clearTimeout(timer);
    finish(4, "spawn-error");
  });

  child.on("exit", (code, signal) => {
    log("exit", { code, signal });
    clearTimeout(timer);
    finish(code === 0 ? 0 : 5, "exited");
  });

  function handleFrame(line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      log("unparsed", line.slice(0, 400));
      return;
    }
    if (frame.id != null && frame.method == null) {
      const waiter = pending.get(frame.id);
      if (waiter) {
        pending.delete(frame.id);
        log("response", frame);
        waiter.resolve(frame);
      } else {
        log("orphan-response", frame);
      }
      return;
    }
    if (frame.method) {
      const params = frame.params || {};
      events.push(frame);
      if (frame.method === "session.event" && params.sessionId) {
        sessionIds.add(params.sessionId);
        const event = params.event || {};
        const type = event.type;
        const data = event.data;
        dumpEvent(params.sessionId, event);
        // Keep the interesting vocabulary visible without dumping every frame.
        if (type === "turn/start" || type === "turn/end" || type === "assistant/message"
          || type === "tool/call" || type === "session/title" || type === "user/message") {
          log(`notify:${frame.method}:${type}`, {
            sessionId: params.sessionId,
            dataKeys: data && typeof data === "object" ? Object.keys(data) : typeof data,
            summary: summarizeEvent(type, data),
          });
        } else {
          log(`notify:${frame.method}:${type || "(no type)"}`, {
            sessionId: params.sessionId,
          });
        }
      } else {
        log(`notify:${frame.method}`, params);
      }
      return;
    }
    log("unknown-frame", frame);
  }

  function summarizeEvent(type, data) {
    if (!data || typeof data !== "object") return null;
    if (type === "assistant/message") {
      const blocks = Array.isArray(data.content)
        ? data.content
        : (data.message && Array.isArray(data.message.content) ? data.message.content : null);
      if (!blocks) return { shape: "no-content-array", dataKeys: Object.keys(data) };
      return blocks.map((block) => {
        if (block && block.type === "text") return `text:${String(block.text).slice(0, 120)}`;
        return block && block.type ? block.type : "unknown";
      });
    }
    if (type === "tool/call") {
      return { name: data.name, callId: data.callId, argKeys: safeKeys(data.arguments) };
    }
    if (type === "turn/end") return { reason: data.reason };
    if (type === "turn/start") return { keys: Object.keys(data) };
    if (type === "session/title") return { title: data.title };
    return null;
  }

  function safeKeys(value) {
    if (typeof value !== "string") return typeof value;
    try { return Object.keys(JSON.parse(value)); } catch { return "unparsable"; }
  }

  (async () => {
    try {
      const init = await send("initialize", {
        cwd: options.cwd,
        provider: options.provider,
        model: options.model,
      });
      log("handshake", init.result || init.error);

      const sessionId = `cb-probe-${Date.now()}`;
      const promptResult = await send("session/prompt", {
        sessionId,
        contentBlocks: [{ type: "text", text: options.prompt }],
      });
      log("prompt-accepted", promptResult.result || promptResult.error);

      // Wait until the session reports idle again, or the turn ends.
      const deadline = Date.now() + Math.min(options.timeoutMs, 120_000);
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const ended = events.some((frame) => {
          const params = frame.params || {};
          if (frame.method !== "session.event") return false;
          if (params.sessionId !== sessionId) return false;
          return params.event && params.event.type === "turn/end";
        });
        if (ended) break;
      }

      log("summary", {
        totalNotifications: events.length,
        sessions: [...sessionIds],
        methods: countBy(events.map((frame) => frame.method)),
        eventTypes: countBy(events
          .filter((frame) => frame.method === "session.event")
          .map((frame) => frame.params && frame.params.event && frame.params.event.type)),
      });

      await send("shutdown").catch(() => {});
      clearTimeout(timer);
      finish(0, "ok");
    } catch (error) {
      log("probe-error", String(error && error.message));
      clearTimeout(timer);
      finish(6, "error");
    }
  })();
}

function countBy(values) {
  const out = {};
  for (const value of values) {
    const key = String(value);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

main();
