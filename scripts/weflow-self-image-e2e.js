#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(PROJECT_ROOT, ".env") });

const PROCESSING_TEXT = "处理中";
const PROMPT_TEXT = "图中有什么";
const DEFAULT_BRIDGE_BASE_URL = "http://127.0.0.1:8766";
const DEFAULT_WEFLOW_BASE_URL = "http://127.0.0.1:5031";
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_MS = 750;
const DEFAULT_QUIET_MS = 8_000;
const MESSAGE_LIMIT = 200;
const SOURCE_PAIR_MAX_SKEW_SECONDS = 15;

async function main() {
  const startedAtMs = Date.now();
  const config = readConfig();
  await assertPreconditions(config);
  const baseline = await fetchMessages(config);
  const baselineMax = maxLocalId(baseline);

  const runId = crypto.randomUUID();
  const imageToken = `IMG-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
  const runDir = path.join(config.stateDir, "self-image-e2e", runId);
  const imagePath = path.join(config.generatedImageRoot, `self-image-e2e-${runId}.png`);
  const manifestPath = path.join(runDir, "manifest.json");
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(config.generatedImageRoot, { recursive: true });
  createTokenImage({ imagePath, runId, imageToken });
  const imageSha256 = sha256File(imagePath);
  writeJsonAtomic(manifestPath, {
    version: 1,
    runId,
    state: "prepared",
    createdAt: new Date().toISOString(),
    promptText: PROMPT_TEXT,
    imageToken,
    imagePath,
    imageSha256,
    baselineLocalId: baselineMax.text,
  });

  let textResult;
  let imageResult;
  try {
    textResult = await requestJson(buildUrl(config.bridgeBaseUrl, "/api/send"), {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        contact: config.contact,
        talker: config.talker,
        text: PROMPT_TEXT,
        timeout: 1,
        exactContact: true,
        expectedContact: config.contact,
        expectedTalker: config.talker,
        requireDesktopIdleSeconds: config.desktopIdleSeconds,
      }),
    }, { label: "exact self text dispatch", timeoutMs: 20_000 });
    assertDispatched(textResult, "text");

    // Send immediately after the text request returns. The inbox holds this
    // explicit visual prompt while the adjacent image is exported.
    imageResult = await requestJson(buildUrl(config.bridgeBaseUrl, "/api/send-image"), {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        contact: config.contact,
        talker: config.talker,
        filePath: imagePath,
        sha256: imageSha256,
        timeout: 4,
      }),
    }, { label: "self image dispatch", timeoutMs: 25_000 });
    assertDispatched(imageResult, "image");
  } catch (error) {
    writeJsonAtomic(manifestPath, {
      ...readJsonFile(manifestPath),
      state: "dispatch_failed",
      failedAt: new Date().toISOString(),
      error: formatError(error),
    });
    throw error;
  }

  const pair = await waitForSourcePair(config, {
    baselineMax,
    textLocalId: optionalLocalId(textResult?.localId),
    imageLocalId: optionalLocalId(imageResult?.localId),
  });
  const sourceMessageIds = [
    `weflow:${pair.textServerId}`,
    `weflow:${pair.imageServerId}`,
  ];
  writeJsonAtomic(manifestPath, {
    ...readJsonFile(manifestPath),
    state: "source_pair_verified",
    sourcePairVerifiedAt: new Date().toISOString(),
    textLocalId: pair.textLocalId.text,
    imageLocalId: pair.imageLocalId.text,
    textServerId: pair.textServerId,
    imageServerId: pair.imageServerId,
    sourceMessageIds,
  });

  const replies = await waitForReplies(config, {
    imageToken,
    imageLocalId: pair.imageLocalId,
  });
  const proof = await waitForDurableProof(config, {
    sourceMessageIds,
    textServerId: pair.textServerId,
    imageServerId: pair.imageServerId,
    processingLocalId: replies.processing.localId,
    finalLocalId: replies.final.localId,
  });

  await sleep(config.quietMs);
  const quietMessages = await fetchMessages(config);
  const quietReplies = inspectReplies(quietMessages, {
    imageToken,
    imageLocalId: pair.imageLocalId,
  });
  assertExactlyOneReply(quietReplies);
  if (quietReplies.processing[0].localId.text !== replies.processing.localId.text
    || quietReplies.final[0].localId.text !== replies.final.localId.text) {
    throw new Error("reply identities changed during the quiet-window recheck");
  }
  await assertQueuesIdle(config);

  const summary = {
    ok: true,
    runId,
    imageToken,
    imagePath,
    imageSha256,
    sourceMessageIds,
    localIds: {
      text: pair.textLocalId.text,
      image: pair.imageLocalId.text,
      processing: replies.processing.localId.text,
      final: replies.final.localId.text,
    },
    checks: {
      exactSelfRoute: true,
      adjacentSourcePair: true,
      sourceSkewSeconds: pair.skewSeconds,
      attachmentParticipantsPersisted: true,
      replyObligationVerified: proof.obligationVerified,
      ledgerVerified: proof.ledgerVerified,
      cursorCommitted: proof.cursorCommitted,
      tokenReadFromCurrentImage: true,
      quietWindowMs: config.quietMs,
    },
    elapsedMs: Date.now() - startedAtMs,
    completedAt: new Date().toISOString(),
  };
  writeJsonAtomic(manifestPath, {
    ...readJsonFile(manifestPath),
    state: "verified",
    ...summary,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

async function reconcileExistingRun(runId) {
  const startedAtMs = Date.now();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
    throw new Error("--reconcile-run requires a UUIDv4 run id");
  }
  const config = readConfig();
  const runDir = path.join(config.stateDir, "self-image-e2e", runId);
  const manifestPath = path.join(runDir, "manifest.json");
  const manifest = readJsonFile(manifestPath);
  if (manifest?.version !== 1 || manifest?.runId !== runId) {
    throw new Error("self-image manifest identity is invalid");
  }
  if (!new Set(["source_pair_verified", "verified"]).has(manifest.state)) {
    throw new Error(`self-image run is not safe to reconcile from state=${manifest.state || "missing"}`);
  }
  if (manifest.promptText !== PROMPT_TEXT
    || !/^IMG-[A-F0-9]{12}$/.test(String(manifest.imageToken || ""))
    || !fs.existsSync(manifest.imagePath)
    || sha256File(manifest.imagePath) !== manifest.imageSha256) {
    throw new Error("self-image manifest payload proof is invalid");
  }
  const expectedSourceIds = [
    `weflow:${manifest.textServerId}`,
    `weflow:${manifest.imageServerId}`,
  ];
  if (JSON.stringify(manifest.sourceMessageIds) !== JSON.stringify(expectedSourceIds)) {
    throw new Error("self-image manifest source participants are invalid");
  }
  const baselineMax = optionalLocalId(manifest.baselineLocalId);
  const textLocalId = optionalLocalId(manifest.textLocalId);
  const imageLocalId = optionalLocalId(manifest.imageLocalId);
  if (!baselineMax || !textLocalId || !imageLocalId) {
    throw new Error("self-image manifest local ids are invalid");
  }
  const pair = await waitForSourcePair(config, { baselineMax, textLocalId, imageLocalId });
  if (pair.textServerId !== manifest.textServerId
    || pair.imageServerId !== manifest.imageServerId) {
    throw new Error("live source pair no longer matches the manifest");
  }
  const replies = await waitForReplies(config, {
    imageToken: manifest.imageToken,
    imageLocalId,
  });
  const proof = await waitForDurableProof(config, {
    sourceMessageIds: expectedSourceIds,
    textServerId: pair.textServerId,
    imageServerId: pair.imageServerId,
    processingLocalId: replies.processing.localId,
    finalLocalId: replies.final.localId,
  });
  await sleep(config.quietMs);
  const quietReplies = inspectReplies(await fetchMessages(config), {
    imageToken: manifest.imageToken,
    imageLocalId,
  });
  assertExactlyOneReply(quietReplies);
  if (quietReplies.processing[0].localId.text !== replies.processing.localId.text
    || quietReplies.final[0].localId.text !== replies.final.localId.text) {
    throw new Error("reply identities changed during reconciliation quiet-window recheck");
  }
  await assertQueuesIdle(config);
  const summary = {
    ok: true,
    runId,
    imageToken: manifest.imageToken,
    imagePath: manifest.imagePath,
    imageSha256: manifest.imageSha256,
    sourceMessageIds: expectedSourceIds,
    localIds: {
      text: textLocalId.text,
      image: imageLocalId.text,
      processing: replies.processing.localId.text,
      final: replies.final.localId.text,
    },
    checks: {
      exactSelfRoute: true,
      adjacentSourcePair: true,
      sourceSkewSeconds: pair.skewSeconds,
      attachmentParticipantsPersisted: true,
      replyObligationVerified: proof.obligationVerified,
      ledgerVerified: proof.ledgerVerified,
      cursorCommitted: proof.cursorCommitted,
      tokenReadFromCurrentImage: true,
      quietWindowMs: config.quietMs,
      reconciledWithoutDispatch: true,
    },
    elapsedMs: Date.now() - startedAtMs,
    completedAt: new Date().toISOString(),
  };
  writeJsonAtomic(manifestPath, {
    ...manifest,
    state: "verified",
    reconciledAt: summary.completedAt,
    ...summary,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function readConfig() {
  const stateDir = path.resolve(process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss"));
  const bridgeBaseUrl = normalizeLoopbackUrl(
    process.env.CYBERBOSS_WEFLOW_BRIDGE_BASE_URL || DEFAULT_BRIDGE_BASE_URL,
    "CYBERBOSS_WEFLOW_BRIDGE_BASE_URL",
    "8766",
  );
  const weflowBaseUrl = normalizeLoopbackUrl(
    process.env.CYBERBOSS_WEFLOW_BASE_URL || DEFAULT_WEFLOW_BASE_URL,
    "CYBERBOSS_WEFLOW_BASE_URL",
    "5031",
  );
  return {
    stateDir,
    bridgeBaseUrl,
    weflowBaseUrl,
    token: requiredEnv("CYBERBOSS_WEFLOW_TOKEN"),
    talker: requiredEnv("CYBERBOSS_WEFLOW_INBOX_CHAT"),
    contact: requiredEnv("CYBERBOSS_WEFLOW_INBOX_DISPLAY_NAME"),
    generatedImageRoot: path.join(stateDir, "generated-images-outbound"),
    timeoutMs: positiveIntegerEnv("CYBERBOSS_WEFLOW_IMAGE_E2E_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 30_000),
    pollMs: positiveIntegerEnv("CYBERBOSS_WEFLOW_E2E_POLL_INTERVAL_MS", DEFAULT_POLL_MS, 100),
    quietMs: positiveIntegerEnv("CYBERBOSS_WEFLOW_E2E_QUIET_WINDOW_MS", DEFAULT_QUIET_MS, 1_000),
    desktopIdleSeconds: positiveIntegerEnv("CYBERBOSS_WEFLOW_E2E_DESKTOP_IDLE_SECONDS", 300, 300),
  };
}

async function assertPreconditions(config) {
  const ready = await requestJson(buildUrl(config.bridgeBaseUrl, "/readyz"), {}, {
    label: "UIA readyz",
    timeoutMs: 5_000,
  });
  if (ready?.ok !== true || ready?.wechatWindow !== true) {
    throw new Error("UIA bridge did not confirm one desktop WeChat chat window");
  }
  const source = await requestJson(buildUrl(config.bridgeBaseUrl, "/api/send-source"), {}, {
    label: "UIA send source",
    timeoutMs: 5_000,
  });
  if (source?.ok !== true || String(source?.send_source || "").trim().toLowerCase() !== "azzy") {
    throw new Error("UIA send source is not azzy");
  }
  await fetchMessages(config);
  await assertQueuesIdle(config);
}

async function assertQueuesIdle(config) {
  const activity = readJsonFile(path.join(config.stateDir, "cyberboss-pipeline-activity.json"));
  for (const key of ["activeTurnCount", "turnGateCount", "activeDeliveryCount", "pendingInboundCount"]) {
    if (Number(activity?.[key]) !== 0) {
      throw new Error(`pipeline is not idle: ${key}=${activity?.[key]}`);
    }
  }
  const pending = readJsonFile(path.join(config.stateDir, "pending-inbound.json"));
  if ((pending?.scopes || []).length || (pending?.sharedScopes || []).length) {
    throw new Error("pending inbound queues are not empty");
  }
  const obligations = readJsonFile(path.join(config.stateDir, "reply-obligations.json"));
  if (Number(obligations?.summary?.openCount || 0) !== 0) {
    throw new Error(`reply obligations are still open: ${obligations?.summary?.openCount}`);
  }
  const cursor = readJsonFile(path.join(config.stateDir, "weflow-inbox-cursor.json"));
  if ((cursor?.pendingEvents || []).length) {
    throw new Error(`WeFlow cursor still has pending events: ${cursor.pendingEvents.length}`);
  }
}

function createTokenImage({ imagePath, runId, imageToken }) {
  const python = process.env.CYBERBOSS_PYTHON || "python";
  const source = [
    "import sys",
    "from PIL import Image, ImageDraw, ImageFont",
    "out, run_id, token = sys.argv[1:4]",
    "img = Image.new('RGB', (1400, 900), 'white')",
    "draw = ImageDraw.Draw(img)",
    "import os",
    // Fonts come from the running system, not from a literal path: this e2e has
    // to survive being run on a checkout that lives somewhere else.
    "font_dir = os.environ.get('CYBERBOSS_E2E_FONT_DIR') or os.path.join(os.environ.get('SystemRoot', 'C:\\\\Windows'), 'Fonts')",
    "font_path = os.path.join(font_dir, 'arial.ttf')",
    "bold_path = os.path.join(font_dir, 'arialbd.ttf')",
    "title = ImageFont.truetype(bold_path, 72)",
    "token_font = ImageFont.truetype(bold_path, 104)",
    "body = ImageFont.truetype(font_path, 44)",
    "draw.rectangle((20, 20, 1380, 880), outline=(10, 65, 160), width=14)",
    "draw.text((80, 80), 'CURRENT IMAGE E2E TEST', font=title, fill=(0, 0, 0))",
    "draw.text((80, 275), 'IMG_TOKEN:', font=body, fill=(0, 0, 0))",
    "draw.text((80, 345), token, font=token_font, fill=(190, 0, 0))",
    "draw.text((80, 560), 'Read this current image.', font=body, fill=(0, 0, 0))",
    "draw.text((80, 625), 'Include the exact IMG_TOKEN in your reply.', font=body, fill=(0, 0, 0))",
    "draw.text((80, 760), 'Run ' + run_id, font=body, fill=(55, 55, 55))",
    "img.save(out, format='PNG', optimize=False)",
  ].join("\n");
  try {
    execFileSync(python, ["-c", source, imagePath, runId, imageToken], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch (error) {
    throw new Error(`test image generation failed: ${formatError(error)}`);
  }
  if (!fs.existsSync(imagePath) || fs.statSync(imagePath).size < 1_000) {
    throw new Error("test image was not created correctly");
  }
}

async function waitForSourcePair(config, { baselineMax, textLocalId, imageLocalId }, dependencies = {}) {
  const fetchMessagesImpl = dependencies.fetchMessages || fetchMessages;
  const sleepImpl = dependencies.sleep || sleep;
  const timeoutMs = dependencies.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const messages = await fetchMessagesImpl(config);
    const textCandidates = messages.filter((message) => {
      const localId = optionalLocalId(readLocalId(message));
      return isOutgoingMessage(message)
        && localId?.value > baselineMax.value
        && readMessageText(message) === PROMPT_TEXT
        && (!textLocalId || localId.text === textLocalId.text);
    });
    if (textCandidates.length > 1) {
      throw new Error("duplicate prompt rows appeared after the baseline");
    }
    const text = textCandidates[0];
    const resolvedTextId = optionalLocalId(readLocalId(text));
    const imageCandidates = messages.filter((message) => {
      const localId = optionalLocalId(readLocalId(message));
      return isOutgoingMessage(message)
        && isImageMessage(message)
        && localId?.value > baselineMax.value
        && (!imageLocalId || localId.text === imageLocalId.text);
    });
    if (imageCandidates.length > 1 && imageLocalId) {
      throw new Error("duplicate image rows matched the bridge localId");
    }
    const image = imageCandidates.find((message) => {
      const localId = optionalLocalId(readLocalId(message));
      return resolvedTextId && localId?.value === resolvedTextId.value + 1n;
    });
    if (text && image && resolvedTextId) {
      const resolvedImageId = optionalLocalId(readLocalId(image));
      const textServerId = readServerId(text);
      const imageServerId = readServerId(image);
      const textTime = readMessageTime(text);
      const imageTime = readMessageTime(image);
      const skewSeconds = imageTime - textTime;
      if (!textServerId || !imageServerId || textServerId === imageServerId) {
        // WeFlow can expose the locally committed rows before WeChat has
        // assigned their final serverIds. Treat that state as eventual
        // consistency rather than a structural failure and keep polling the
        // same localIds until the bounded source-pair deadline.
        last = `text=${textCandidates.length} images=${imageCandidates.length} `
          + `serverIds=${textServerId || "pending"}/${imageServerId || "pending"}`;
        await sleepImpl(config.pollMs);
        continue;
      }
      if (resolvedImageId.value !== resolvedTextId.value + 1n) {
        throw new Error("source text and image localIds are not consecutive");
      }
      if (skewSeconds < 0 || skewSeconds > SOURCE_PAIR_MAX_SKEW_SECONDS) {
        throw new Error(
          `source text/image skew is outside the 0..${SOURCE_PAIR_MAX_SKEW_SECONDS} second contract: ${skewSeconds}`
        );
      }
      return {
        textLocalId: resolvedTextId,
        imageLocalId: resolvedImageId,
        textServerId,
        imageServerId,
        skewSeconds,
      };
    }
    last = `text=${textCandidates.length} images=${imageCandidates.length}`;
    await sleepImpl(config.pollMs);
  }
  throw new Error(`timed out locating the unique adjacent text/image pair (${last})`);
}

async function waitForReplies(config, { imageToken, imageLocalId }) {
  const deadline = Date.now() + config.timeoutMs;
  let lastCounts = "";
  while (Date.now() < deadline) {
    const messages = await fetchMessages(config);
    const observed = inspectReplies(messages, { imageToken, imageLocalId });
    if (observed.processing.length > 1 || observed.final.length > 1) {
      throw new Error(`duplicate replies detected: ack=${observed.processing.length} final=${observed.final.length}`);
    }
    if (observed.processing.length === 1 && observed.final.length === 1) {
      const processing = observed.processing[0];
      const final = observed.final[0];
      if (processing.localId.value <= imageLocalId.value || final.localId.value <= processing.localId.value) {
        throw new Error("reply localIds are not ordered after the source image");
      }
      return { processing, final };
    }
    lastCounts = `ack=${observed.processing.length} final=${observed.final.length}`;
    await sleep(config.pollMs);
  }
  throw new Error(`timed out waiting for the current-image token reply (${lastCounts})`);
}

function inspectReplies(messages, { imageToken, imageLocalId }) {
  const rows = messages.map((message) => ({
    raw: message,
    localId: optionalLocalId(readLocalId(message)),
    text: readMessageText(message),
  })).filter((item) => (
    item.localId
      && item.localId.value > imageLocalId.value
      && isOutgoingMessage(item.raw)
  ));
  return {
    processing: dedupeByLocalId(rows.filter((item) => item.text === PROCESSING_TEXT)),
    final: dedupeByLocalId(rows.filter((item) => item.text.includes(imageToken))),
  };
}

function assertExactlyOneReply(observed) {
  if (observed.processing.length !== 1 || observed.final.length !== 1) {
    throw new Error(
      `quiet-window expected exactly one acknowledgement and token reply; `
      + `ack=${observed.processing.length} final=${observed.final.length}`
    );
  }
}

async function waitForDurableProof(config, context) {
  const deadline = Date.now() + 90_000;
  const expectedSourceIds = [...context.sourceMessageIds].sort();
  let last = "";
  while (Date.now() < deadline) {
    const obligations = readJsonFile(path.join(config.stateDir, "reply-obligations.json"));
    const matches = (obligations?.obligations || []).filter((entry) => {
      const ids = Array.isArray(entry?.sourceMessageIds) ? [...entry.sourceMessageIds].sort() : [];
      return JSON.stringify(ids) === JSON.stringify(expectedSourceIds);
    });
    if (matches.length > 1) {
      throw new Error("multiple reply obligations claim the same source pair");
    }
    const obligation = matches[0];
    const ledger = readJsonFile(path.join(config.stateDir, "weflow-message-ledger.json"));
    const entries = Array.isArray(ledger?.entries) ? ledger.entries : [];
    const ackEntries = entries.filter((entry) => String(entry?.localId || "") === context.processingLocalId.text);
    const finalEntries = entries.filter((entry) => String(entry?.localId || "") === context.finalLocalId.text);
    const ackVerified = ackEntries.length === 1
      && ackEntries[0].status === "verified"
      && ackEntries[0].messageKind === "inbound_ack"
      && ackEntries[0].uncertain === false;
    const finalVerified = finalEntries.length === 1
      && finalEntries[0].status === "verified"
      && finalEntries[0].uncertain === false
      && Number(finalEntries[0].attemptCount) === 1;
    const cursor = readJsonFile(path.join(config.stateDir, "weflow-inbox-cursor.json"));
    const seen = new Set(Array.isArray(cursor?.seenIds) ? cursor.seenIds : []);
    const sourceKeys = [
      `message.new:${context.textServerId}`,
      `message.new:${context.imageServerId}`,
    ];
    const pendingKeys = new Set((cursor?.pendingEvents || []).map((item) => String(item?.key || "")));
    const deadKeys = new Set((cursor?.deadLetters || []).flatMap((item) => [
      String(item?.key || ""),
      ...(Array.isArray(item?.participantKeys) ? item.participantKeys.map(String) : []),
    ]));
    const cursorCommitted = sourceKeys.every((key) => seen.has(key) && !pendingKeys.has(key) && !deadKeys.has(key));
    const obligationVerified = Boolean(obligation)
      && obligation.terminal === true
      && obligation.terminalOutcome === "verified"
      && String(obligation.deliveryLocalId || "") === context.finalLocalId.text
      && Number(obligation.deliveryAttemptCount) === 1;
    if (obligationVerified && ackVerified && finalVerified && cursorCommitted) {
      return { obligationVerified: true, ledgerVerified: true, cursorCommitted: true };
    }
    last = `obligation=${obligation?.terminalOutcome || "missing"} ack=${ackVerified} final=${finalVerified} cursor=${cursorCommitted}`;
    await sleep(config.pollMs);
  }
  throw new Error(`durable proof did not converge (${last})`);
}

async function fetchMessages(config) {
  const url = buildUrl(config.weflowBaseUrl, "/api/v1/messages");
  url.searchParams.set("talker", config.talker);
  url.searchParams.set("limit", String(MESSAGE_LIMIT));
  const payload = await requestJson(url, {
    headers: { Authorization: `Bearer ${config.token}` },
  }, { label: "WeFlow messages", timeoutMs: 5_000 });
  return extractMessages(payload);
}

function extractMessages(payload) {
  if (Array.isArray(payload)) return payload.filter(isObject);
  for (const key of ["messages", "data", "items"]) {
    const candidate = payload?.[key];
    if (Array.isArray(candidate)) return candidate.filter(isObject);
    if (isObject(candidate)) {
      for (const nested of ["messages", "items", "list"]) {
        if (Array.isArray(candidate[nested])) return candidate[nested].filter(isObject);
      }
    }
  }
  throw new Error("WeFlow messages response did not contain a message list");
}

function maxLocalId(messages) {
  return messages.reduce((current, message) => {
    const candidate = optionalLocalId(readLocalId(message));
    return candidate && candidate.value > current.value ? candidate : current;
  }, { text: "0", value: 0n });
}

function isOutgoingMessage(message) {
  const value = message?.isSend ?? message?.is_send;
  return value === true || value === 1 || value === "1"
    || String(message?.direction || "").trim().toLowerCase() === "outgoing";
}

function isImageMessage(message) {
  return Number(message?.localType ?? message?.local_type ?? message?.type) === 3
    || String(message?.kind || message?.contentKind || "").trim().toLowerCase() === "image";
}

function readMessageText(message) {
  for (const key of ["parsedContent", "content", "text"]) {
    if (typeof message?.[key] === "string" && message[key].trim()) return message[key].trim();
  }
  return "";
}

function readLocalId(message) {
  for (const key of ["localId", "local_id", "id", "msgId", "msg_id"]) {
    const value = optionalLocalId(message?.[key]);
    if (value) return value.text;
  }
  return "";
}

function readServerId(message) {
  for (const key of ["serverId", "server_id", "msgSvrId", "msg_svr_id"]) {
    const text = String(message?.[key] ?? "").trim();
    if (/^\d+$/.test(text) && BigInt(text) > 0n) return BigInt(text).toString();
  }
  return "";
}

function readMessageTime(message) {
  const value = Number(message?.createTime ?? message?.create_time ?? message?.timestamp);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function optionalLocalId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const numeric = BigInt(text);
  return numeric > 0n ? { text: numeric.toString(), value: numeric } : null;
}

function dedupeByLocalId(rows) {
  return [...new Map(rows.map((item) => [item.localId.text, item])).values()]
    .sort((left, right) => left.localId.value < right.localId.value ? -1 : 1);
}

function assertDispatched(result, label) {
  if (result?.dispatched !== true) throw new Error(`${label} was not dispatched`);
  if (result?.verified !== true && !(result?.verified === false && result?.uncertain === true)) {
    throw new Error(`${label} returned an invalid verification state`);
  }
}

async function requestJson(url, init = {}, { label = "request", timeoutMs = 5_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`${label} timed out after ${timeoutMs}ms`);
    throw new Error(`${label} failed: ${formatError(error)}`);
  } finally {
    clearTimeout(timer);
  }
  let payload = null;
  try { payload = await response.json(); } catch {}
  if (!response.ok) {
    throw new Error(`${label} failed: ${payload?.code || response.status} ${payload?.error || ""}`.trim());
  }
  if (!isObject(payload)) throw new Error(`${label} returned invalid JSON`);
  return payload;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`could not read ${path.basename(filePath)}: ${formatError(error)}`);
  }
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, filePath);
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function normalizeLoopbackUrl(value, name, expectedPort) {
  const url = new URL(String(value || "").trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${name} must use HTTP(S)`);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname.toLowerCase())) {
    throw new Error(`${name} must be loopback`);
  }
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (port !== expectedPort) throw new Error(`${name} must use port ${expectedPort}`);
  return url.toString().replace(/\/$/, "");
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required in ${path.join(PROJECT_ROOT, ".env")}`);
  return value;
}

function positiveIntegerEnv(name, fallback, minimum) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be >= ${minimum}`);
  return value;
}

function buildUrl(baseUrl, pathname) {
  return new URL(pathname, `${baseUrl}/`);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatError(error) {
  if (error?.stderr) return String(error.stderr).trim() || error.message;
  return error instanceof Error ? error.message : String(error || "unknown error");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (require.main === module) {
  const reconcileIndex = process.argv.indexOf("--reconcile-run");
  const operation = reconcileIndex >= 0
    ? reconcileExistingRun(String(process.argv[reconcileIndex + 1] || ""))
    : main();
  operation.catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code || "SELF_IMAGE_E2E_FAILED",
      error: formatError(error),
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  waitForSourcePair,
};
