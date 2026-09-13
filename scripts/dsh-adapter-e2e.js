#!/usr/bin/env node
"use strict";

/**
 * Manual end-to-end check of the DSH runtime adapter: drive a real turn through
 * the adapter surface the same way src/core/app.js does, print every runtime
 * event, and exit deterministically (a live DSH child would otherwise keep the
 * event loop alive).
 *
 * Usage: node scripts/dsh-adapter-e2e.js [--prompt "..."] [--workspace <dir>]
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createDshRuntimeAdapter } = require("../src/adapters/runtime/dsh");

function parseArgs(argv) {
  const options = {
    prompt: "Reply with exactly: DSH_ADAPTER_OK",
    workspace: process.cwd(),
    model: process.env.CYBERBOSS_DSH_MODEL || "deepseek-flash",
    timeoutMs: 240_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--prompt") { options.prompt = argv[index + 1]; index += 1; }
    else if (argv[index] === "--workspace") { options.workspace = argv[index + 1]; index += 1; }
    else if (argv[index] === "--model") { options.model = argv[index + 1]; index += 1; }
    else if (argv[index] === "--timeout") { options.timeoutMs = Number(argv[index + 1]); index += 1; }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-dsh-e2e-"));
  const sessionsFile = path.join(stateDir, "dsh-sessions.json");
  const startedAt = Date.now();
  const stamp = () => `[${String(Date.now() - startedAt).padStart(6)}ms]`;

  const adapter = createDshRuntimeAdapter({
    workspaceRoot: options.workspace,
    sessionsFile,
    dshSessionsFile: sessionsFile,
    dshModel: options.model,
  });

  const events = [];
  adapter.onEvent((event) => {
    events.push(event);
    const payload = event.payload || {};
    let detail = "";
    if (event.type === "runtime.reply.completed") detail = JSON.stringify(payload.text);
    else if (event.type === "runtime.tool.started") detail = payload.command || payload.toolType || "";
    else if (event.type === "runtime.turn.failed") detail = payload.text || "";
    process.stdout.write(`${stamp()} event ${event.type} thread=${payload.threadId || ""} turn=${payload.turnId || ""} ${detail}\n`);
  });

  let exitCode = 0;
  try {
    process.stdout.write(`${stamp()} initialize\n`);
    const ready = await adapter.initialize();
    process.stdout.write(`${stamp()} ready serverInfo=${JSON.stringify(ready.serverInfo)}\n`);

    const bindingKey = adapter.getSessionStore().buildBindingKey({
      workspaceId: "e2e-workspace",
      accountId: "e2e-account",
      senderId: "e2e-sender",
    });

    process.stdout.write(`${stamp()} sendTurn\n`);
    const turn = await adapter.sendTurn({
      bindingKey,
      workspaceRoot: options.workspace,
      text: options.prompt,
      attachments: [],
    });
    process.stdout.write(`${stamp()} turn accepted thread=${turn.threadId} turn=${turn.turnId}\n`);

    const stored = adapter.getSessionStore().getThreadIdForWorkspace(bindingKey, options.workspace);
    process.stdout.write(`${stamp()} session store roundtrip: ${stored === turn.threadId ? "OK" : "MISMATCH"}\n`);

    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() < deadline) {
      if (events.some((event) => event.type === "runtime.turn.completed" || event.type === "runtime.turn.failed")) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const terminal = events.filter((event) => event.type === "runtime.turn.completed" || event.type === "runtime.turn.failed");
    const replies = events.filter((event) => event.type === "runtime.reply.completed");
    const started = events.filter((event) => event.type === "runtime.turn.started");

    process.stdout.write(`\n${stamp()} ---- summary ----\n`);
    process.stdout.write(`  events              : ${events.length}\n`);
    process.stdout.write(`  turn.started        : ${started.length}\n`);
    process.stdout.write(`  terminal            : ${terminal.map((event) => event.type).join(",") || "(none)"}\n`);
    process.stdout.write(`  replies             : ${replies.length}\n`);
    process.stdout.write(`  reply text          : ${JSON.stringify(replies.map((event) => event.payload.text).join("\n"))}\n`);
    const correlationOk = started.length > 0
      && started.every((event) => event.payload.turnId === turn.turnId)
      && terminal.every((event) => event.payload.turnId === turn.turnId);
    process.stdout.write(`  turnId correlation  : ${correlationOk ? "OK" : "MISMATCH"}\n`);

    const failed = terminal.filter((event) => event.type === "runtime.turn.failed");
    if (failed.length) {
      process.stdout.write(`  FAILURE             : ${failed[0].payload.text}\n`);
      exitCode = 1;
    }
    if (!started.length || !terminal.length) {
      process.stdout.write("  FAILURE             : turn never started or never terminated\n");
      exitCode = 1;
    }
    if (!correlationOk) exitCode = 1;
  } catch (error) {
    process.stdout.write(`${stamp()} ERROR ${error && error.stack ? error.stack : error}\n`);
    exitCode = 1;
  } finally {
    try { await adapter.close(); } catch {}
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
  }

  process.stdout.write(`${stamp()} exit=${exitCode}\n`);
  // A live child handle can keep the loop alive; exit deliberately.
  process.exit(exitCode);
}

main();
