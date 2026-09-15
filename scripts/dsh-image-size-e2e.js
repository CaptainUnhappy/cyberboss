#!/usr/bin/env node
"use strict";

/**
 * Live before/after for the attachment size limit.
 *
 * Uses a real WeChat long screenshot (1260x8318) that production refused with
 * "Image exceeds the configured per-side pixel limit." - it exceeds DSH's
 * shipped 8192-per-side default by 126 px while using only 10.5 MP of a 64 MP
 * budget and 1.2 MB of a 20 MB budget.
 *
 *   raw DshRpcClient, no overlay  -> expect the size refusal (proves the cause)
 *   adapter (always applies the overlay) -> expect a real answer
 *
 * Usage: node scripts/dsh-image-size-e2e.js [--image <path>]
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DshRpcClient, defaultDshBin } = require("../src/adapters/runtime/dsh/rpc-client");
const { createDshRuntimeAdapter } = require("../src/adapters/runtime/dsh");

const DEFAULT_IMAGE = path.join(
  os.homedir(), ".cyberboss", "inbox", "2026-09-15", "3aa80de466812780bb1f86bfd1bbee85.jpg",
);

function parseArgs(argv) {
  const options = { image: DEFAULT_IMAGE, timeoutMs: 180_000 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--image") { options.image = argv[index + 1]; index += 1; }
    else if (argv[index] === "--timeout") { options.timeoutMs = Number(argv[index + 1]); index += 1; }
  }
  return options;
}

const startedAt = Date.now();
const log = (message) => console.log(`[${String(Date.now() - startedAt).padStart(6)}ms] ${message}`);

function jpegSize(file) {
  const buffer = fs.readFileSync(file);
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
    }
    offset += 2 + length;
  }
  return null;
}

async function collect(client, sessionId, blocks, timeoutMs) {
  let text = "";
  let ended = false;
  const unsubscribe = client.onNotification((method, params) => {
    if (method !== "session.event") return;
    const event = params?.event || {};
    if (event.type === "assistant/message") {
      for (const block of event.data?.message?.content || []) {
        if (block?.type === "text" && block.text) text += block.text;
      }
    }
    if (event.type === "turn/end") ended = true;
  });
  try {
    await client.prompt(sessionId, blocks);
    const deadline = Date.now() + timeoutMs;
    while (!ended && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { text, ended };
  } finally {
    unsubscribe?.();
  }
}

(async () => {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(options.image)) {
    console.error(`image not found: ${options.image}`);
    process.exit(1);
  }
  const size = jpegSize(options.image);
  const bytes = fs.statSync(options.image).size;
  log(`image ${path.basename(options.image)} ${size ? `${size.width}x${size.height}` : "?"} ${bytes} bytes`);
  if (!size) {
    console.error("could not read the image dimensions");
    process.exit(1);
  }

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cb-dsh-size-"));
  const base64 = fs.readFileSync(options.image).toString("base64");
  const blocks = [
    { type: "text", text: "Reply with exactly one word: the dominant colour of this image." },
    { type: "image", mimeType: "image/jpeg", data: base64 },
  ];

  log("---- phase 1: raw client, no overlay (expect the size refusal) ----");
  const raw = new DshRpcClient({
    dshBin: defaultDshBin(),
    profile: "sdk",
    cwd: workspace,
    provider: "deepseek-official",
    model: "deepseek-flash",
    logger: { log() {}, warn() {}, error() {} },
    initializeTimeoutMs: options.timeoutMs,
  });
  let rawOutcome = "unknown";
  try {
    await raw.initialize();
    const result = await collect(raw, `cb-size-raw-${Date.now()}`, blocks, options.timeoutMs);
    rawOutcome = result.text ? `replied: ${result.text.slice(0, 80)}` : "no reply";
  } catch (error) {
    rawOutcome = `refused: ${error?.message || error}`;
  } finally {
    try { await raw.close(); } catch { /* teardown must not mask the outcome */ }
  }
  log(`raw -> ${rawOutcome}`);

  log("---- phase 2: adapter, overlay applied (expect a real answer) ----");
  const adapter = createDshRuntimeAdapter({
    workspaceRoot: workspace,
    sessionsFile: path.join(workspace, "sessions.json"),
    dshSessionsFile: path.join(workspace, "sessions.json"),
    dshModel: "deepseek-flash",
    provider: "deepseek-official",
  });
  const replies = [];
  adapter.onEvent((event) => {
    if (event.type === "runtime.reply.completed") replies.push(event.payload?.text || "");
  });
  let adapterOutcome = "unknown";
  try {
    const bindingKey = adapter.getSessionStore().buildBindingKey({
      workspaceId: "size-e2e", accountId: "a", senderId: "s",
    });
    const turn = await adapter.sendTurn({
      bindingKey,
      workspaceRoot: workspace,
      text: "Reply with exactly one word: the dominant colour of this image.",
      attachments: [{ absolutePath: options.image }],
    });
    const deadline = Date.now() + options.timeoutMs;
    while (replies.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    adapterOutcome = replies.length ? `replied: ${replies.join(" ").slice(0, 80)}` : `no reply (turn ${turn.turnId})`;
  } catch (error) {
    adapterOutcome = `refused: ${error?.message || error}`;
  } finally {
    try { await adapter.close(); } catch { /* ignore */ }
  }
  log(`adapter -> ${adapterOutcome}`);

  log("---- verdict ----");
  const rawRefused = /per-side pixel limit|IMAGE_DIMENSION_TOO_LARGE/u.test(rawOutcome);
  const adapterWorked = /^replied:/u.test(adapterOutcome);
  log(`raw refused by the size limit : ${rawRefused}`);
  log(`adapter delivered a reply     : ${adapterWorked}`);

  try {
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch { /* best effort */ }

  if (rawRefused && adapterWorked) {
    console.log("PASS: the overlay makes a real long screenshot acceptable");
    process.exit(0);
  }
  console.error("FAIL: expected the raw client to refuse and the adapter to succeed");
  process.exit(1);
})();
