#!/usr/bin/env node
"use strict";

/**
 * Reproduce: prompting a session id that already exists on disk, from a *fresh*
 * DSH process.
 *
 * The SDK JSON-RPC server keeps sessions in an in-memory map and, on a miss,
 * calls `ctx.agents.create({sessionId})`. `dsh-session` refuses to create an id
 * that already exists in its store, and the SDK protocol has no resume method,
 * so a process that did not itself create the session cannot prompt it.
 *
 * This matters because Cyberboss stores the session id durably and reuses it
 * across runtime restarts, which is exactly the scenario below.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DshRpcClient, defaultDshBin } = require("../src/adapters/runtime/dsh/rpc-client");

const sessionId = `cb-resume-probe-${Date.now()}`;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cb-dsh-resume-"));

function makeClient() {
  return new DshRpcClient({
    dshBin: defaultDshBin(),
    profile: "sdk",
    cwd: workspace,
    provider: "deepseek-official",
    model: "deepseek-flash",
    logger: { log() {}, warn() {}, error() {} },
    initializeTimeoutMs: 180_000,
  });
}

async function promptOnce(label) {
  const client = makeClient();
  try {
    await client.initialize();
    await client.prompt(sessionId, [{ type: "text", text: "Reply with exactly: RESUME_PROBE_OK" }]);
    console.log(`${label}: prompt accepted`);
    return "ok";
  } catch (error) {
    console.log(`${label}: FAILED -> ${error?.message || error}`);
    return "failed";
  } finally {
    try { await client.close(); } catch { /* teardown must not mask the result */ }
  }
}

(async () => {
  console.log(`sessionId = ${sessionId}`);
  console.log(`workspace = ${workspace}`);
  const first = await promptOnce("process #1 (creates the session)");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const second = await promptOnce("process #2 (same id, new process)");

  console.log("---- verdict ----");
  console.log(`first=${first} second=${second}`);
  if (first === "ok" && second === "failed") {
    console.log("REPRODUCED: a fresh DSH process cannot prompt an existing session id");
  } else {
    console.log("NOT reproduced: the assumption behind this probe is wrong");
  }

  // The adapter must survive exactly that situation. Two adapter instances over
  // one durable session store is what a bridge restart looks like: the second
  // one holds a session id whose owning process is gone.
  const { createDshRuntimeAdapter } = require("../src/adapters/runtime/dsh");
  const store = path.join(workspace, "sessions.json");
  const bindingKey = "probe-binding";
  const adapterOptions = {
    workspaceRoot: workspace,
    sessionsFile: store,
    dshSessionsFile: store,
    dshModel: "deepseek-flash",
    provider: "deepseek-official",
  };

  console.log("---- adapter recovery ----");
  const firstAdapter = createDshRuntimeAdapter(adapterOptions);
  try {
    const turn = await firstAdapter.sendTurn({
      bindingKey,
      workspaceRoot: workspace,
      text: "Reply with exactly: RECOVERY_PROBE_OK",
    });
    console.log(`adapter #1: turn accepted thread=${turn.threadId}`);
  } catch (error) {
    console.log(`adapter #1: FAILED -> ${error?.message || error}`);
  } finally {
    await firstAdapter.close();
  }

  await new Promise((resolve) => setTimeout(resolve, 1000));

  const secondAdapter = createDshRuntimeAdapter(adapterOptions);
  try {
    const turn = await secondAdapter.sendTurn({
      bindingKey,
      workspaceRoot: workspace,
      text: "Reply with exactly: RECOVERY_PROBE_OK",
    });
    console.log(`adapter #2: turn accepted thread=${turn.threadId}`);
    console.log("RECOVERY OK: the second adapter continued on a new session instead of failing");
  } catch (error) {
    console.log(`adapter #2: FAILED -> ${error?.message || error}`);
    console.log("RECOVERY FAILED: the conflict is still fatal");
  } finally {
    await secondAdapter.close();
  }

  try {
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch { /* best effort */ }
})();
