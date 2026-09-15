#!/usr/bin/env node
"use strict";

/**
 * Does a live DSH turn actually produce commentary-phase replies?
 *
 * Cyberboss renders `phase: "commentary"` as a 【进度】 message. The adapter
 * derives that phase from "this assistant message also asks for a tool call".
 * This probe runs a turn that is certain to use a tool and prints every emitted
 * reply event with its phase, so "the feature is broken" can be told apart from
 * "the model never writes interim text".
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createDshRuntimeAdapter } = require("../src/adapters/runtime/dsh");

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cb-dsh-phase-"));

(async () => {
  const adapter = createDshRuntimeAdapter({
    workspaceRoot: workspace,
    sessionsFile: path.join(workspace, "sessions.json"),
    dshSessionsFile: path.join(workspace, "sessions.json"),
    dshModel: "deepseek-flash",
    provider: "deepseek-official",
  });

  const events = [];
  adapter.onEvent((event) => {
    events.push({ type: event.type, ...(event.payload || {}) });
    if (event.type === "runtime.reply.completed") {
      console.log(`reply.completed phase=${JSON.stringify(event.payload?.phase)} text=${JSON.stringify((event.payload?.text || "").slice(0, 90))}`);
    } else if (event.type === "runtime.tool.started") {
      console.log(`tool.started     ${event.payload?.toolType} ${JSON.stringify((event.payload?.command || "").slice(0, 60))}`);
    } else if (event.type === "runtime.turn.completed" || event.type === "runtime.turn.failed") {
      console.log(`${event.type}`);
    }
  });

  try {
    const bindingKey = adapter.getSessionStore().buildBindingKey({
      workspaceId: "phase-probe", accountId: "a", senderId: "s",
    });
    await adapter.sendTurn({
      bindingKey,
      workspaceRoot: workspace,
      text: "Run the pwsh command `Get-Date` to check the time, then tell me the date in one short sentence.",
      attachments: [],
    });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (events.some((e) => e.type === "runtime.turn.completed" || e.type === "runtime.turn.failed")) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } catch (error) {
    console.log(`FAILED: ${error?.message || error}`);
  } finally {
    await adapter.close();
  }

  const replies = events.filter((e) => e.type === "runtime.reply.completed");
  const commentary = replies.filter((e) => e.phase === "commentary");
  const finals = replies.filter((e) => e.phase === "final_answer");
  console.log("---- summary ----");
  console.log(`replies=${replies.length} commentary=${commentary.length} final_answer=${finals.length}`);
  console.log(`tools=${events.filter((e) => e.type === "runtime.tool.started").length}`);
  console.log(commentary.length > 0
    ? "OK: the runtime produced commentary, so 【进度】 should render"
    : "NO COMMENTARY: the model wrote no interim text before its tool call");

  try {
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch { /* best effort */ }
  process.exit(0);
})();
