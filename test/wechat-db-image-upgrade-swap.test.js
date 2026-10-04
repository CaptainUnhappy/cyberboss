#!/usr/bin/env node
/**
 * A picture that arrives as a preview must reach the turn as the ORIGINAL once it
 * lands - without a second answer, and without the acknowledgement waiting.
 *
 * Two separate things are checked here, because both were broken:
 *
 *   1. `persistIncomingWeixinAttachments` (the weixin adapter) could only download
 *      from a URL. The database reader hands over a LOCAL file, so every picture
 *      from that channel was dropped with "attachment did not include a supported
 *      download reference" - measured 2026-10-03, with a real 900x1400 PNG sitting
 *      on disk while the turn got nothing.
 *   2. the swap itself: the app has to replace the queued message's attachment
 *      (the turn has not started yet) rather than start anything new.
 *
 * Run: node --test test/wechat-db-image-upgrade-swap.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CyberbossApp } = require("../src/core/app");
const { PendingInboundStore } = require("../src/core/pending-inbound-store");
const { persistIncomingWeixinAttachments } = require(
  "../src/adapters/channel/weixin/media-receive");

const ROOT = path.resolve(__dirname, "..");
const REAL_PREVIEW = path.join(ROOT, "tmp", "thumb-scenario", "6022aac9fdf9501da780cca0fd72b6e4_t.dat");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writePng(filePath, size = 1024) {
  // A real PNG header plus padding: enough for the persistence layer, which only
  // cares that the bytes came from the file it was told to read.
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(filePath, Buffer.concat([header, Buffer.alloc(size, 7)]));
  return filePath;
}

test("an attachment that is a local file is persisted, not dropped", async () => {
  const stateDir = tempDir("cb-att-local-");
  const source = writePng(path.join(tempDir("cb-src-"), "original.png"), 2048);
  const result = await persistIncomingWeixinAttachments({
    attachments: [{
      kind: "image",
      path: source,
      fileName: "original.png",
      origin: "direct",
      attachmentRef: "direct-7-1",
    }],
    stateDir,
    cdnBaseUrl: "https://example.invalid",
    messageId: "weflow:301",
    receivedAt: "2026-10-03T23:54:35.000+08:00",
  });
  assert.equal(result.failed.length, 0, JSON.stringify(result.failed));
  assert.equal(result.saved.length, 1);
  assert.equal(result.saved[0].contentType, "image/png");
  assert.ok(fs.existsSync(result.saved[0].absolutePath), "the file has to land in the inbox");
  assert.equal(result.saved[0].sizeBytes, fs.statSync(source).size);
  assert.ok(result.saved[0].absolutePath.startsWith(path.join(stateDir, "inbox")));
});

test("a file that is not there still fails loudly instead of inventing bytes", async () => {
  const stateDir = tempDir("cb-att-missing-");
  const result = await persistIncomingWeixinAttachments({
    attachments: [{ kind: "image", path: "D:/nowhere/ghost.png", fileName: "ghost.png", origin: "direct" }],
    stateDir,
    cdnBaseUrl: "https://example.invalid",
    messageId: "weflow:302",
    receivedAt: "2026-10-03T23:54:35.000+08:00",
  });
  assert.equal(result.saved.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].reason, /download reference|ENOENT|no such file/i);
});

test("the late original replaces the queued preview without starting a second turn", async () => {
  const stateDir = tempDir("cb-swap-state-");
  const store = new PendingInboundStore({ filePath: path.join(stateDir, "pending-inbound.json") });
  const original = writePng(path.join(tempDir("cb-swap-src-"), "original.png"), 4096);
  const queuedMessage = {
    pendingId: "weflow:pic-1",
    messageId: "weflow:pic-1",
    workspaceId: "default",
    accountId: "account-1",
    senderId: "Azzy",
    provider: "wechat-db",
    chatId: "weflow:Azzy",
    contentKind: "image",
    sharedContent: true,
    direction: "incoming",
    directionVerified: true,
    originalText: "[图片]（微信只下载了缩略图 157x210，原图尚未到达）",
    text: "[图片]（微信只下载了缩略图 157x210，原图尚未到达）",
    quotedContexts: [],
    attachments: [{ kind: "image", absolutePath: "D:/inbox/preview.jpg", origin: "direct" }],
    attachmentFailures: [],
    receivedAt: "2026-10-03T23:54:21.000+08:00",
  };
  const enqueued = store.enqueueSharedContent({
    bindingKey: "default:account",
    workspaceRoot: "D:/ws",
    chatId: queuedMessage.chatId,
    message: queuedMessage,
    lastContentAtMs: Date.parse(queuedMessage.receivedAt),
  });
  assert.equal(enqueued.added, true);
  const scopeKey = enqueued.scopeKey;

  const app = {
    config: { stateDir, weixinCdnBaseUrl: "https://example.invalid", pendingInboundQuietWindowMs: 15_000 },
    pendingInboundStore: store,
    pendingSharedContentInboundByScope: store.snapshotSharedMap(),
    defaultBindingKey: "default:account",
  };
  // The real method, on a hand-built app: this asserts the production code path,
  // not a copy of it.
  const result = await CyberbossApp.prototype.handleWechatDbImageUpgraded.call(app, {
    id: "weflow:pic-1",
    pendingId: "weflow:pic-1",
    messageId: "weflow:pic-1",
    chatId: "weflow:Azzy",
    receivedAt: "2026-10-03T23:54:21.000+08:00",
    attachments: [{
      kind: "image",
      path: original,
      fileName: "original.png",
      origin: "direct",
      attachmentRef: "direct-193-1",
    }],
  }, { peer: "Azzy", talker: "wxid_s3178hwvzsl922", waitedMs: 14_000, quality: "original", size: "1280x1706" });

  assert.equal(result.updated, true, JSON.stringify(result));
  const scopes = store.snapshotSharedMap();
  const scope = scopes.get(scopeKey);
  assert.equal(scope.messages.length, 1, "an upgrade must not add a message");
  const swapped = scope.messages[0];
  assert.ok(swapped.attachments[0].absolutePath.startsWith(path.join(stateDir, "inbox")),
    "the original must be persisted into the inbox");
  assert.equal(swapped.attachments[0].sizeBytes, fs.statSync(original).size);
  // The reader always writes `[图片]` for a picture and appends the notice to it,
  // so removing the notice leaves the honest placeholder behind - what must NOT
  // survive is the claim that the original has not arrived.
  assert.equal(swapped.text, "[图片]", "the 'only a preview' note stops being true");
  assert.equal(swapped.originalText, "[图片]");
  assert.doesNotMatch(swapped.text, /缩略图|尚未到达/u);
  assert.equal(scope.lastContentAtMs, enqueued.draft.lastContentAtMs,
    "an upgrade is not new activity, so the quiet window must not move");
});

test("an upgrade for a turn that already started changes nothing", async () => {
  const stateDir = tempDir("cb-swap-late-");
  const store = new PendingInboundStore({ filePath: path.join(stateDir, "pending-inbound.json") });
  const original = writePng(path.join(tempDir("cb-swap-late-src-"), "original.png"), 512);
  const app = {
    config: { stateDir, weixinCdnBaseUrl: "https://example.invalid" },
    pendingInboundStore: store,
    pendingSharedContentInboundByScope: store.snapshotSharedMap(),
    defaultBindingKey: "default:account",
  };
  const result = await CyberbossApp.prototype.handleWechatDbImageUpgraded.call(app, {
    id: "weflow:never-queued",
    pendingId: "weflow:never-queued",
    messageId: "weflow:never-queued",
    chatId: "weflow:Azzy",
    receivedAt: "2026-10-03T23:55:00.000+08:00",
    attachments: [{ kind: "image", path: original, fileName: "original.png", origin: "direct" }],
  }, { peer: "Azzy", waitedMs: 30_000, quality: "original", size: "1280x1706" });

  assert.equal(result.updated, false);
  assert.equal(result.reason, "turn already started");
  assert.equal(store.snapshotSharedMap().size, 0, "nothing may be created by an upgrade");
});

test("the real preview file from this machine can be persisted as an attachment", { skip: !fs.existsSync(REAL_PREVIEW) }, async () => {
  // `tmp/thumb-scenario/…_t.dat` is the actual WeChat preview that arrived 14
  // seconds before its original on 2026-10-03. It is not an image *file* format,
  // but it is a file, and the point here is that the persistence layer takes a
  // local path at all instead of refusing it.
  const stateDir = tempDir("cb-real-preview-");
  const result = await persistIncomingWeixinAttachments({
    attachments: [{
      kind: "image",
      path: REAL_PREVIEW,
      fileName: path.basename(REAL_PREVIEW),
      origin: "direct",
    }],
    stateDir,
    cdnBaseUrl: "https://example.invalid",
    messageId: "weflow:190",
    receivedAt: "2026-10-03T16:39:38.000+08:00",
  });
  assert.equal(result.failed.length, 0, JSON.stringify(result.failed));
  assert.equal(result.saved[0].sizeBytes, fs.statSync(REAL_PREVIEW).size);
});
