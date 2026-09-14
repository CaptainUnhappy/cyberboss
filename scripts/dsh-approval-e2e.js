#!/usr/bin/env node
"use strict";

/**
 * End-to-end acceptance for the DSH collaborative approval path.
 *
 * Proves the whole chain against a real DSH process, not a stub:
 *
 *   live escalation -> answerer inside DSH -> HTTP -> ApprovalEndpoint
 *                   -> verdict -> DSH `approval/decided`
 *
 * The endpoint is real; only the *verdict source* is canned, so both directions
 * can be asserted deterministically. Run with `--verdict rejected` and
 * `--verdict allowed-once` to prove the outcome actually follows the decision
 * rather than always failing closed.
 *
 * Usage:
 *   node scripts/dsh-approval-e2e.js [--verdict rejected|allowed-once]
 *                                    [--timeout <ms>] [--keep]
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DshRpcClient, defaultDshBin } = require("../src/adapters/runtime/dsh/rpc-client");
const { ApprovalEndpoint } = require("../src/core/approval-endpoint");
const { resolveApprovalPatchPath } = require("../src/adapters/runtime/dsh");

function parseArgs(argv) {
  const options = {
    verdict: "rejected",
    timeoutMs: 180_000,
    keep: false,
    provider: "deepseek-official",
    model: "deepseek-flash",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--verdict") { options.verdict = argv[index + 1]; index += 1; }
    else if (token === "--timeout") { options.timeoutMs = Number(argv[index + 1]); index += 1; }
    else if (token === "--provider") { options.provider = argv[index + 1]; index += 1; }
    else if (token === "--model") { options.model = argv[index + 1]; index += 1; }
    else if (token === "--keep") { options.keep = true; }
  }
  return options;
}

/** Best-effort cleanup: a still-exiting child can hold the scratch directory. */
function removeQuietly(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Leaving a scratch directory behind must never turn a verdict into an error.
  }
}

const startedAt = Date.now();
function log(message) {
  console.log(`[${String(Date.now() - startedAt).padStart(6)}ms] ${message}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!["rejected", "allowed-once", "unavailable", "cancelled"].includes(options.verdict)) {
    throw new Error(`unsupported verdict: ${options.verdict}`);
  }

  const patchPath = resolveApprovalPatchPath();
  if (!fs.existsSync(patchPath)) {
    throw new Error(`approval overlay is missing, which would make DSH exit 5: ${patchPath}`);
  }

  // A scratch workspace, so the escalation target is genuinely outside it and the
  // repository is never the subject of the probe.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cb-dsh-approval-"));
  const outsideTarget = path.join(workspace, "..", `cb-dsh-approval-outside-${process.pid}.txt`);
  const received = [];

  const endpoint = new ApprovalEndpoint({
    logger: { warn: (m) => log(`endpoint warn: ${m}`), error: (m) => log(`endpoint error: ${m}`) },
    decide: async (request) => {
      received.push(request);
      log(`endpoint received toolName=${request.toolName} callId=${request.callId}`);
      return options.verdict;
    },
  });
  await endpoint.start();
  log(`approval endpoint listening at ${endpoint.endpoint}`);

  const decided = [];
  const asked = [];
  const client = new DshRpcClient({
    dshBin: defaultDshBin(),
    profile: "sdk",
    cwd: workspace,
    provider: options.provider,
    model: options.model,
    patchPaths: [patchPath],
    env: {
      CYBERBOSS_DSH_APPROVAL_ENDPOINT: endpoint.endpoint,
      CYBERBOSS_DSH_APPROVAL_TOKEN: endpoint.token,
    },
    logger: { log() {}, warn: (m) => log(`dsh warn: ${m}`), error: (m) => log(`dsh error: ${m}`) },
    initializeTimeoutMs: options.timeoutMs,
  });

  let failure = null;
  try {
    client.onNotification((method, params) => {
      if (method !== "session.event") return;
      const event = params?.event || {};
      if (event.type === "approval/asked") asked.push(event.data);
      if (event.type === "approval/decided") {
        decided.push(event.data);
        log(`approval/decided outcome=${event.data?.outcome}`);
      }
    });

    await client.initialize();
    log("initialized");

    const sessionId = `cb-approval-e2e-${Date.now()}`;
    const prompt = [
      `Use the pwsh tool to create the file '${outsideTarget}' with the exact content PROBE.`,
      "That absolute path is OUTSIDE your working directory, so the sandbox will refuse it",
      "and ask you to request an escalation: request the escalation instead of giving up,",
      "then report the outcome in one line.",
    ].join(" ");
    await client.prompt(sessionId, [{ type: "text", text: prompt }]);
    log("prompt accepted");

    const deadline = Date.now() + options.timeoutMs;
    while (decided.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } catch (error) {
    failure = error;
    log(`FAILED: ${error?.message || error}`);
  } finally {
    try { await client.close(); } catch { /* teardown must not mask a verdict */ }
    await endpoint.close();
    if (!options.keep) {
      removeQuietly(workspace);
      removeQuietly(outsideTarget);
    }
  }

  log("---- summary ----");
  log(`  approval/asked    : ${asked.length}`);
  log(`  approval/decided  : ${decided.length}`);
  log(`  endpoint calls    : ${received.length}`);
  log(`  decided outcome   : ${decided.map((item) => item.outcome).join(", ") || "(none)"}`);
  log(`  requested verdict : ${options.verdict}`);

  if (failure) {
    console.error(`FAIL: ${failure.message}`);
    return 1;
  }
  if (asked.length !== 1) {
    console.error(`FAIL: expected exactly one approval request, saw ${asked.length}`);
    return 1;
  }
  if (received.length !== 1) {
    console.error("FAIL: the endpoint was not consulted exactly once, so the answerer did not transport the request");
    return 1;
  }
  if (decided.length !== 1 || decided[0].outcome !== options.verdict) {
    console.error(`FAIL: the decided outcome did not follow the requested verdict`);
    return 1;
  }
  // The plugin must send the callId so the endpoint can resolve the arguments.
  if (!received[0].callId) {
    console.error("FAIL: the transported request carried no callId");
    return 1;
  }
  if (received[0].callId !== asked[0].callId) {
    console.error("FAIL: the transported callId does not match the escalated one");
    return 1;
  }
  console.log(`PASS: ${options.verdict} was transported end to end`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
  },
);
