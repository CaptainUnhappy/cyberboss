#!/usr/bin/env node
/**
 * The db inbox source: baseline, dedup, echo suppression, and deferral.
 *
 * These are the behaviours that decide whether a real message is answered once,
 * twice, or never - so they are asserted against a fake worker rather than
 * against a live WeChat.
 *
 * Run: node --test test/wechat-db-inbox.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { WechatDbInboxSource } = require("../src/integrations/wechat-db/inbox");

function tempCursor() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxdb-inbox-"));
  return path.join(dir, "cursor.json");
}

function message(overrides = {}) {
  return {
    id: overrides.id || "m1",
    localId: overrides.localId ?? 1,
    timestamp: overrides.timestamp ?? 1_790_000_000,
    receivedAt: "2026-10-03T00:00:00+08:00",
    direction: overrides.direction || "incoming",
    kind: "text",
    title: "",
    text: overrides.text ?? "hello",
    url: "",
    senderId: overrides.senderId || "wxid_peer",
    isGroup: false,
    quotedContexts: [],
    ...overrides,
  };
}

function snapshot(messages, overrides = {}) {
  return {
    chat: "柳毓琳",
    chatUsername: "wxid_ubo0cy5xh4px22",
    talker: "wxid_ubo0cy5xh4px22",
    displayName: "柳毓琳",
    unread: 0,
    messages,
    failures: [],
    ...overrides,
  };
}

function fakeWorker(queue) {
  const calls = [];
  return {
    calls,
    async snapshots(request) {
      calls.push(request);
      const next = queue.shift();
      if (!next) {
        return { chats: [], failures: [] };
      }
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
  };
}

function quietLogger() {
  return { log() {}, warn() {}, error() {}, debug() {} };
}

test("the first poll only baselines: history is not replayed as new", async () => {
  const worker = fakeWorker([{ chats: [snapshot([message({ id: "old1" }), message({ id: "old2" })])], failures: [] }]);
  const delivered = [];
  const source = new WechatDbInboxSource({
    config: { wechatDbInboxCursorFile: tempCursor() },
    worker,
    chats: ["wxid_ubo0cy5xh4px22"],
    onMessage: async (msg) => { delivered.push(msg); return true; },
    logger: quietLogger(),
  });
  const result = await source.pollOnce();
  assert.equal(result.status, "baselined");
  assert.equal(delivered.length, 0, "a boot must not answer yesterday's conversation");
});

test("a message that arrives after the baseline is delivered once", async () => {
  const cursor = tempCursor();
  const worker = fakeWorker([
    { chats: [snapshot([message({ id: "a" })])], failures: [] },
    { chats: [snapshot([message({ id: "a" }), message({ id: "b", text: "second" })])], failures: [] },
    { chats: [snapshot([message({ id: "a" }), message({ id: "b", text: "second" })])], failures: [] },
  ]);
  const delivered = [];
  const source = new WechatDbInboxSource({
    config: { wechatDbInboxCursorFile: cursor },
    worker,
    chats: ["wxid_ubo0cy5xh4px22"],
    onMessage: async (msg) => { delivered.push(msg.id); return true; },
    logger: quietLogger(),
  });
  await source.pollOnce();
  assert.equal((await source.pollOnce()).processed, 1);
  assert.equal((await source.pollOnce()).processed, 0, "an unchanged row must not be re-delivered");
  assert.deepEqual(delivered, ["b"]);
});

test("the reply route carries the DISPLAY NAME, because that is what the writer opens", async () => {
  const worker = fakeWorker([
    { chats: [snapshot([])], failures: [] },
    { chats: [snapshot([message({ id: "x" })])], failures: [] },
  ]);
  const seen = [];
  const source = new WechatDbInboxSource({
    config: { wechatDbInboxCursorFile: tempCursor() },
    worker,
    chats: ["wxid_ubo0cy5xh4px22"],
    onMessage: async (msg, snap) => { seen.push({ msg, snap }); return true; },
    logger: quietLogger(),
  });
  await source.pollOnce();
  await source.pollOnce();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].snap.chatUsername, "柳毓琳");
  assert.equal(seen[0].snap.chatTalker, "wxid_ubo0cy5xh4px22");
  // ...and the envelope still carries the wxid, so the ledger and the logs can
  // tell conversations apart by identity instead of by a renameable label.
  assert.equal(seen[0].msg.talker, "wxid_ubo0cy5xh4px22");
  assert.equal(seen[0].msg.senderId, "wxid_peer");
  assert.equal(seen[0].msg.directionVerified, true);
});

test("an outgoing row we sent is suppressed by the echo ledger", async () => {
  const worker = fakeWorker([
    { chats: [snapshot([])], failures: [] },
    {
      chats: [snapshot([
        message({ id: "ours", direction: "outgoing", text: "reply text", senderId: "wxid_self" }),
      ])],
      failures: [],
    },
  ]);
  const delivered = [];
  const source = new WechatDbInboxSource({
    config: { wechatDbInboxCursorFile: tempCursor() },
    worker,
    chats: ["wxid_ubo0cy5xh4px22"],
    ledger: { matches: (peer, text) => peer === "柳毓琳" && text === "reply text" },
    onMessage: async (msg) => { delivered.push(msg); return true; },
    logger: quietLogger(),
  });
  await source.pollOnce();
  await source.pollOnce();
  assert.equal(delivered.length, 0, "the bot must not answer its own reply");
  assert.equal(source.stats.suppressed, 1);
});

test("an outgoing row the ledger does NOT know is the operator typing (self_manual)", async () => {
  const worker = fakeWorker([
    { chats: [snapshot([])], failures: [] },
    {
      chats: [snapshot([
        message({ id: "manual", direction: "outgoing", text: "我手打的", senderId: "wxid_self" }),
      ])],
      failures: [],
    },
  ]);
  const delivered = [];
  const source = new WechatDbInboxSource({
    config: { wechatDbInboxCursorFile: tempCursor() },
    worker,
    chats: ["wxid_ubo0cy5xh4px22"],
    ledger: { matches: () => false },
    onMessage: async (msg) => { delivered.push(msg); return true; },
    logger: quietLogger(),
  });
  await source.pollOnce();
  await source.pollOnce();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].direction, "outgoing");
  assert.equal(delivered[0].origin, "self_manual");
});

test("a refused message stays unseen so the next poll retries it", async () => {
  const cursor = tempCursor();
  const worker = fakeWorker([
    { chats: [snapshot([])], failures: [] },
    { chats: [snapshot([message({ id: "retry-me" })])], failures: [] },
    { chats: [snapshot([message({ id: "retry-me" })])], failures: [] },
  ]);
  let attempts = 0;
  const source = new WechatDbInboxSource({
    config: { wechatDbInboxCursorFile: cursor },
    worker,
    chats: ["wxid_ubo0cy5xh4px22"],
    onMessage: async () => { attempts += 1; return attempts > 1; },
    logger: quietLogger(),
  });
  await source.pollOnce();
  const deferred = await source.pollOnce();
  assert.equal(deferred.status, "deferred");
  const retried = await source.pollOnce();
  assert.equal(retried.processed, 1, "a message the app could not route yet must come back");
  assert.equal(attempts, 2);
});

test("the seen set survives a restart (a cursor file, not memory)", async () => {
  const cursor = tempCursor();
  const payload = { chats: [snapshot([message({ id: "seen-once" })])], failures: [] };
  const first = new WechatDbInboxSource({
    config: { wechatDbInboxCursorFile: cursor },
    worker: fakeWorker([payload]),
    chats: ["wxid_ubo0cy5xh4px22"],
    onMessage: async () => true,
    logger: quietLogger(),
  });
  await first.pollOnce();
  const delivered = [];
  const second = new WechatDbInboxSource({
    config: { wechatDbInboxCursorFile: cursor },
    worker: fakeWorker([payload]),
    chats: ["wxid_ubo0cy5xh4px22"],
    onMessage: async (msg) => { delivered.push(msg.id); return true; },
    logger: quietLogger(),
  });
  const result = await second.pollOnce();
  assert.equal(result.status, "ok", "a known baseline means the first poll is not a baseline again");
  assert.deepEqual(delivered, [], "a restart must not re-answer what the cursor already recorded");
});

test("isReady defers without touching the reader", async () => {
  const worker = fakeWorker([]);
  const source = new WechatDbInboxSource({
    config: { wechatDbInboxCursorFile: tempCursor() },
    worker,
    chats: ["wxid_ubo0cy5xh4px22"],
    isReady: () => false,
    onMessage: async () => true,
    logger: quietLogger(),
  });
  const result = await source.pollOnce();
  assert.equal(result.status, "waiting_for_reply_target");
  assert.equal(worker.calls.length, 0);
});

test("a dead reader is reported as an error, never as a quiet chat", async () => {
  const worker = fakeWorker([new Error("reader exited (code=1 signal=none)")]);
  const source = new WechatDbInboxSource({
    config: { wechatDbInboxCursorFile: tempCursor() },
    worker,
    chats: ["wxid_ubo0cy5xh4px22"],
    onMessage: async () => true,
    logger: quietLogger(),
  });
  const result = await source.runCycle();
  assert.equal(result.status, "error");
  assert.match(result.error, /reader exited/);
  assert.equal(source.describe().stats.errors, 1);
});

test("an image the reader decrypted travels with the message, not as [图片]", async () => {
  const worker = fakeWorker([
    { chats: [snapshot([])], failures: [] },
    {
      chats: [snapshot([
        message({ id: "pic", kind: "image", text: "", attachments: [
          { kind: "image", path: "C:\\cache\\media\\abc.jpg", origin: "direct", attachmentRef: "direct-7-1" },
        ] }),
      ])],
      failures: [],
    },
  ]);
  const delivered = [];
  const source = new WechatDbInboxSource({
    config: { wechatDbInboxCursorFile: tempCursor() },
    worker,
    chats: ["wxid_ubo0cy5xh4px22"],
    onMessage: async (msg) => { delivered.push(msg); return true; },
    logger: quietLogger(),
  });
  await source.pollOnce();
  await source.pollOnce();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].kind, "image");
  assert.equal(delivered[0].attachments.length, 1, "a dropped attachment is a picture the bot never sees");
  assert.equal(delivered[0].attachments[0].path, "C:\\cache\\media\\abc.jpg");
  assert.equal(delivered[0].attachments[0].fileName, "abc.jpg");
  assert.equal(delivered[0].attachments[0].kind, "image");
});

test("a picture that arrived as a preview is upgraded by opening the chat once", async () => {
  const thumbnail = snapshot([message({ id: "pic", kind: "image", imageQuality: "thumbnail", attachments: [
    { kind: "image", path: "C:\\cache\\media\\abc_thumb.jpg", origin: "direct" },
  ] })]);
  const upgraded = snapshot([message({ id: "pic", kind: "image", imageQuality: "original", attachments: [
    { kind: "image", path: "C:\\cache\\media\\abc.png", origin: "direct" },
  ] })]);
  let reads = 0;
  const worker = {
    async snapshots() {
      reads += 1;
      // This method is called directly here, so the FIRST read of the worker is
      // already the re-read after the chat was opened: it must show the original,
      // exactly as the client behaves once it has downloaded it.
      return { chats: [upgraded], failures: [] };
    },
  };
  const opened = [];
  const source = new WechatDbInboxSource({
    config: { wechatDbInboxCursorFile: tempCursor() },
    worker,
    chats: ["wxid_ubo0cy5xh4px22"],
    imageUpgrade: (peer) => { opened.push(peer); return true; },
    imageUpgradeWaitMs: 0,
    imageUpgradeCooldownMs: 0,
    onMessage: async () => true,
    logger: quietLogger(),
  });
  const result = await source.upgradeThumbnailImages([thumbnail]);
  assert.deepEqual(opened, ["柳毓琳"], "the chat is opened for a preview");
  assert.equal(result[0].messages[0].imageQuality, "original");
  assert.equal(result[0].messages[0].attachments[0].path, "C:\\cache\\media\\abc.png");
  assert.equal(source.stats.imageUpgraded, 1);

  // ...and a second pass inside the cooldown leaves the desktop alone.
  source.imageUpgradeCooldownMs = 60_000;
  const again = await source.upgradeThumbnailImages([thumbnail]);
  assert.equal(opened.length, 1, "the cooldown must stop a second foreground click");
  assert.equal(again[0].messages[0].imageQuality, "thumbnail");
});

test("a re-read that did not improve keeps the preview rather than losing it", async () => {
  const thumbnail = snapshot([message({ id: "pic", kind: "image", imageQuality: "thumbnail", attachments: [
    { kind: "image", path: "C:\\cache\\media\\abc_thumb.jpg", origin: "direct" },
  ] })]);
  const worker = {
    async snapshots() {
      // The client was opened but has not finished downloading: same preview.
      return { chats: [thumbnail], failures: [] };
    },
  };
  const source = new WechatDbInboxSource({
    config: { wechatDbInboxCursorFile: tempCursor() },
    worker,
    chats: ["wxid_ubo0cy5xh4px22"],
    imageUpgrade: () => true,
    imageUpgradeWaitMs: 0,
    imageUpgradeCooldownMs: 0,
    onMessage: async () => true,
    logger: quietLogger(),
  });
  const result = await source.upgradeThumbnailImages([thumbnail]);
  assert.equal(result[0].messages[0].attachments[0].path, "C:\\cache\\media\\abc_thumb.jpg",
    "a preview is still better than an empty attachment");
});

test("an original needs no upgrade, and a cooldown stops repeats", async () => {
  const withOriginal = snapshot([message({ id: "pic", kind: "image", imageQuality: "original", attachments: [
    { kind: "image", path: "C:\\cache\\media\\abc.png", origin: "direct" },
  ] })]);
  const worker = fakeWorker([{ chats: [withOriginal], failures: [] }]);
  const opened = [];
  const source = new WechatDbInboxSource({
    config: { wechatDbInboxCursorFile: tempCursor() },
    worker,
    chats: ["wxid_ubo0cy5xh4px22"],
    imageUpgrade: (peer) => { opened.push(peer); return true; },
    imageUpgradeWaitMs: 0,
    onMessage: async () => true,
    logger: quietLogger(),
  });
  await source.pollOnce();
  assert.deepEqual(opened, [], "a full-size picture must not steal the foreground");
});

test("replayOnStart delivers the most recent incoming rows exactly once", async () => {
  const worker = fakeWorker([
    {
      chats: [snapshot([
        message({ id: "r1", timestamp: 1 }),
        message({ id: "r2", timestamp: 2 }),
        message({ id: "r3", timestamp: 3, direction: "outgoing", text: "mine" }),
      ])],
      failures: [],
    },
  ]);
  const delivered = [];
  const source = new WechatDbInboxSource({
    config: { wechatDbInboxCursorFile: tempCursor() },
    worker,
    chats: ["wxid_ubo0cy5xh4px22"],
    replayOnStart: true,
    replayLimit: 2,
    ledger: { matches: () => true },
    onMessage: async (msg) => { delivered.push(msg.id); return true; },
    logger: quietLogger(),
  });
  const result = await source.pollOnce();
  assert.equal(result.status, "ok");
  assert.deepEqual(delivered, ["r1", "r2"], "replay is bounded to incoming rows, newest last");
});
