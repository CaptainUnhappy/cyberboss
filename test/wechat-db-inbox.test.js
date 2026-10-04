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

test("an upgrade attempt that does not improve says so instead of staying silent", async () => {
  // The failure this guards: every counter said "upgraded" while the turn ran with
  // a 180x102 preview, because "improved=0" went into a log line nobody read.
  const preview = snapshot([message({
    id: "pic",
    kind: "image",
    imageQuality: "thumbnail",
    imageSize: "180x102",
    imageSource: "abc_t.dat",
    attachments: [{ kind: "image", path: "C:\\cache\\media\\abc_thumb.jpg", origin: "direct" }],
  })]);
  const worker = { async snapshots() { return { chats: [preview], failures: [] }; } };
  const warnings = [];
  const source = new WechatDbInboxSource({
    config: { wechatDbInboxCursorFile: tempCursor() },
    worker,
    chats: ["wxid_ubo0cy5xh4px22"],
    imageUpgrade: () => true,
    imageUpgradeWaitMs: 0,
    imageUpgradeCooldownMs: 0,
    onMessage: async () => true,
    logger: { log() {}, warn: (line) => warnings.push(line), error() {}, debug() {} },
  });
  await source.upgradeThumbnailImages([preview]);
  assert.equal(source.stats.imageUpgrades, 1);
  assert.equal(source.stats.imageUpgraded, 0);
  assert.equal(warnings.length, 1, "a stuck preview has to be visible in the log");
  assert.match(warnings[0], /still a preview/);
  assert.match(warnings[0], /180x102/, "and it has to say how small the picture is");
});

test("what the model actually got is counted per picture, with its size", async () => {
  const worker = fakeWorker([
    { chats: [snapshot([])], failures: [] },
    {
      chats: [snapshot([
        message({
          id: "full",
          kind: "image",
          imageQuality: "original",
          imageSize: "1280x1356",
          imageSource: "abc_h.dat",
          attachments: [{ kind: "image", path: "C:\\cache\\media\\abc.png", origin: "direct" }],
        }),
        message({
          id: "small",
          kind: "image",
          imageQuality: "thumbnail",
          imageSize: "171x180",
          imageSource: "def_t.dat",
          attachments: [{ kind: "image", path: "C:\\cache\\media\\def_thumb.jpg", origin: "direct" }],
        }),
        message({
          id: "gone",
          kind: "image",
          imageQuality: "missing",
          text: "[图片]（本地文件未取到：no readable image file on disk）",
        }),
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
  assert.equal(delivered.length, 3);
  assert.equal(source.stats.imageOriginal, 1);
  assert.equal(source.stats.imageThumbnail, 1);
  assert.equal(source.stats.imageMissing, 1);
  // ...and the envelope carries the facts into the turn, not just the log.
  const full = delivered.find((item) => item.id === "full");
  assert.equal(full.imageQuality, "original");
  assert.equal(full.imageSize, "1280x1356");
  assert.equal(full.imageSource, "abc_h.dat");
  assert.equal(delivered.find((item) => item.id === "small").imageSize, "171x180");
});

test("a stale preview from the old reader (no size) still counts as a picture", async () => {
  // Compatibility: an older reader reports imageQuality and nothing else. The
  // counters must not read "unknown" as "the model got nothing".
  const worker = fakeWorker([
    { chats: [snapshot([])], failures: [] },
    {
      chats: [snapshot([
        message({ id: "old", kind: "image", imageQuality: "thumbnail", attachments: [
          { kind: "image", path: "C:\\cache\\media\\old_thumb.jpg", origin: "direct" },
        ] }),
        message({ id: "older-still", kind: "image", attachments: [
          { kind: "image", path: "C:\\cache\\media\\plain.jpg", origin: "direct" },
        ] }),
      ])],
      failures: [],
    },
  ]);
  const source = new WechatDbInboxSource({
    config: { wechatDbInboxCursorFile: tempCursor() },
    worker,
    chats: ["wxid_ubo0cy5xh4px22"],
    onMessage: async () => true,
    logger: quietLogger(),
  });
  await source.pollOnce();
  await source.pollOnce();
  assert.equal(source.stats.imageThumbnail, 1);
  assert.equal(source.stats.imageMissing, 1, "no quality reported and no file read is still a picture we cannot see");
});

test("a preview is delivered immediately, and the original is handed over later", async () => {
  // The shape of the real case (2026-10-03): the preview arrived 14 seconds
  // before the only copy of the original that would ever exist, and the turn has
  // to get the original WITHOUT a second delivery and WITHOUT the
  // acknowledgement having waited for it.
  let reads = 0;
  const previewMessage = message({
    id: "pic",
    kind: "image",
    imageQuality: "thumbnail",
    imageSize: "157x210",
    imageSource: "abc_t.dat",
    attachments: [{ kind: "image", path: "C:\\cache\\media\\abc_thumb.jpg", origin: "direct" }],
  });
  const originalMessage = message({
    id: "pic",
    kind: "image",
    imageQuality: "original",
    imageSize: "1280x1706",
    imageSource: "abc.dat",
    attachments: [{ kind: "image", path: "C:\\cache\\media\\abc.png", origin: "direct" }],
  });
  const worker = {
    async snapshots() {
      reads += 1;
      // Read 1 is the baseline (nothing new yet); reads 2-3 answer the first real
      // poll (the preview, then its "still a preview" re-read); from then on the
      // client has downloaded the original.
      if (reads === 1) {
        return { chats: [snapshot([])], failures: [] };
      }
      return { chats: [snapshot([reads <= 3 ? previewMessage : originalMessage])], failures: [] };
    },
  };
  const delivered = [];
  const upgraded = [];
  const source = new WechatDbInboxSource({
    config: { wechatDbInboxCursorFile: tempCursor() },
    worker,
    chats: ["wxid_ubo0cy5xh4px22"],
    onMessage: async (msg) => { delivered.push(msg); return true; },
    imageUpgrade: () => true,
    imageUpgradeWaitMs: 0,
    imageUpgradeNoticeMs: 0,
    imageUpgradeCooldownMs: 0,
    onImageUpgraded: (msg, info) => upgraded.push({ msg, info }),
    logger: quietLogger(),
  });

  // First poll is the baseline (a boot must not answer history), so the flow that
  // matters starts on the second.
  await source.pollOnce();
  await source.pollOnce();
  assert.equal(delivered.length, 1, "the preview must be delivered on the spot");
  assert.equal(delivered[0].imageQuality, "thumbnail");
  assert.equal(delivered[0].imageSize, "157x210");

  // Next poll: the original is on disk, so the app is told - and NOTHING is
  // delivered a second time.
  await source.pollOnce();
  assert.equal(upgraded.length, 1, "the app has to hear about the original");
  assert.equal(upgraded[0].msg.imageQuality, "original");
  assert.equal(upgraded[0].msg.imageSize, "1280x1706");
  assert.equal(upgraded[0].info.peer, "柳毓琳");
  assert.equal(delivered.length, 1, "an upgrade is a swap, not a second turn");
  assert.equal(source.stats.imageUpgraded, 1);
  assert.equal(source.pendingImageUpgrades.size, 0, "a settled picture stops being tracked");
});

test("a preview that never improves is given up on instead of tracked forever", async () => {
  const previewMessage = message({
    id: "stuck",
    kind: "image",
    imageQuality: "thumbnail",
    imageSize: "80x40",
    imageSource: "def_t.dat",
    attachments: [{ kind: "image", path: "C:\\cache\\media\\def_thumb.jpg", origin: "direct" }],
  });
  const worker = fakeWorker([
    { chats: [snapshot([])], failures: [] },
    { chats: [snapshot([previewMessage])], failures: [] },
    { chats: [snapshot([previewMessage])], failures: [] },
    { chats: [snapshot([previewMessage])], failures: [] },
  ]);
  const upgraded = [];
  const warnings = [];
  const source = new WechatDbInboxSource({
    config: { wechatDbInboxCursorFile: tempCursor() },
    worker,
    chats: ["wxid_ubo0cy5xh4px22"],
    onMessage: async () => true,
    imageUpgrade: () => true,
    imageUpgradeWaitMs: 0,
    imageUpgradeNoticeMs: 0,
    imageUpgradeDeadlineMs: -1,
    imageUpgradeCooldownMs: 0,
    onImageUpgraded: (msg) => upgraded.push(msg),
    logger: { log() {}, warn: (line) => warnings.push(line), error() {}, debug() {} },
  });
  await source.pollOnce();
  await source.pollOnce();
  assert.equal(upgraded.length, 0, "nothing to hand over while it is still a preview");
  assert.equal(source.pendingImageUpgrades.size, 0, "past the deadline the entry is dropped");
  assert.ok(warnings.some((line) => /gave up after/.test(line)),
    `expected a give-up line, got ${JSON.stringify(warnings)}`);
});

test("a preview seen at baseline is still upgraded when the original lands later", async () => {
  // Found on a live bot (2026-10-03): tracking previews only at delivery meant a
  // preview that arrived before the baseline - or an hour earlier - was never
  // watched again, so the original landing changed nothing at all.
  let reads = 0;
  let originalArrived = false;
  const previewMessage = message({
    id: "pic",
    kind: "image",
    imageQuality: "thumbnail",
    imageSize: "157x210",
    imageSource: "abc_t.dat",
    attachments: [{ kind: "image", path: "C:\\cache\\media\\abc_thumb.jpg", origin: "direct" }],
  });
  const originalMessage = message({
    id: "pic",
    kind: "image",
    imageQuality: "original",
    imageSize: "1280x1706",
    imageSource: "abc.dat",
    attachments: [{ kind: "image", path: "C:\\cache\\media\\abc.png", origin: "direct" }],
  });
  const worker = {
    async snapshots() {
      reads += 1;
      return { chats: [snapshot([originalArrived ? originalMessage : previewMessage])], failures: [] };
    },
  };
  const delivered = [];
  const upgraded = [];
  const source = new WechatDbInboxSource({
    config: { wechatDbInboxCursorFile: tempCursor() },
    worker,
    chats: ["wxid_ubo0cy5xh4px22"],
    onMessage: async (msg) => { delivered.push(msg); return true; },
    imageUpgrade: () => true,
    imageUpgradeWaitMs: 0,
    imageUpgradeNoticeMs: 0,
    imageUpgradeCooldownMs: 0,
    onImageUpgraded: (msg) => upgraded.push(msg),
    logger: quietLogger(),
  });

  // Poll 1 is the baseline: the preview is history, so nothing is delivered - but
  // it goes on the watch list.
  await source.pollOnce();
  assert.equal(delivered.length, 0);
  assert.equal(source.pendingImageUpgrades.size, 1, "a baseline preview must still be watched");

  // The original lands one poll later: the app is told, and what gets delivered
  // (if anything) carries the ORIGINAL - never the preview it replaced.
  originalArrived = true;
  await source.pollOnce();
  assert.equal(upgraded.length, 1, "the original has to reach the app");
  assert.equal(upgraded[0].imageQuality, "original");
  if (delivered.length) {
    assert.equal(delivered.at(-1).imageQuality, "original",
      "a delivered copy must never be the preview once the original is on disk");
  }
});

test("a preview is handed over exactly once per poll, even while it is watched", async () => {
  // Measured in production 2026-10-04: `localId=66 … early=preview` was delivered
  // TWICE in a single poll. The cause was an ordering one - the main loop's seen
  // set was snapshotted before the early handover marked the row seen - and the
  // symptom is two turns for one picture.
  const previewMessage = message({
    id: "pic-once",
    kind: "image",
    imageQuality: "thumbnail",
    imageSize: "171x180",
    imageSource: "abc_t.dat",
    attachments: [{ kind: "image", path: "C:\\cache\\media\\abc_thumb.jpg", origin: "direct" }],
  });
  const worker = fakeWorker([
    { chats: [snapshot([])], failures: [] },
    { chats: [snapshot([previewMessage])], failures: [] },
    { chats: [snapshot([previewMessage])], failures: [] },
    { chats: [snapshot([previewMessage])], failures: [] },
  ]);
  const delivered = [];
  const source = new WechatDbInboxSource({
    config: { wechatDbInboxCursorFile: tempCursor() },
    worker,
    chats: ["wxid_ubo0cy5xh4px22"],
    onMessage: async (msg) => { delivered.push(msg.id); return true; },
    imageUpgrade: () => true,
    imageUpgradeWaitMs: 0,
    imageUpgradeNoticeMs: 0,
    imageUpgradeCooldownMs: 0,
    onImageUpgraded: () => {},
    logger: quietLogger(),
  });
  await source.pollOnce();
  const result = await source.pollOnce();
  assert.deepEqual(delivered, ["pic-once"], "one picture, one handover");
  assert.equal(result.processed, 1, "and the poll must count it once");
  assert.equal(source.stats.delivered, 1);
  assert.equal(source.stats.imageThumbnail, 1);
  // The row is watched (not re-delivered) on the polls that follow.
  await source.pollOnce();
  assert.deepEqual(delivered, ["pic-once"], "a watched preview is not delivered again");
});

test("an unchanged preview is announced once, not on every poll", async () => {
  // Measured 2026-10-04: the watcher announced the same unchanged preview every
  // poll, the app persisted a fresh copy each time, and one day folder collected
  // 100 counter-suffixed duplicates (460KB) for two pictures.
  const previewMessage = message({
    id: "pic-same",
    kind: "image",
    imageQuality: "thumbnail",
    imageSize: "171x180",
    imageSource: "same_t.dat",
    attachments: [{ kind: "image", path: "C:\\cache\\media\\same_thumb.jpg", origin: "direct" }],
  });
  const worker = fakeWorker([
    { chats: [snapshot([])], failures: [] },
    { chats: [snapshot([previewMessage])], failures: [] },
    { chats: [snapshot([previewMessage])], failures: [] },
    { chats: [snapshot([previewMessage])], failures: [] },
    { chats: [snapshot([previewMessage])], failures: [] },
  ]);
  const announced = [];
  const source = new WechatDbInboxSource({
    config: { wechatDbInboxCursorFile: tempCursor() },
    worker,
    chats: ["wxid_ubo0cy5xh4px22"],
    onMessage: async () => true,
    imageUpgrade: () => true,
    imageUpgradeWaitMs: 0,
    imageUpgradeNoticeMs: 0,
    imageUpgradeCooldownMs: 0,
    onImageUpgraded: (msg) => announced.push(msg.imageSize),
    logger: quietLogger(),
  });
  await source.pollOnce();
  await source.pollOnce();
  await source.pollOnce();
  await source.pollOnce();
  assert.deepEqual(announced, [], "nothing may be handed over while the picture is unchanged");
});

test("with no upgrade callback configured, a preview is still delivered and never tracked", async () => {
  const worker = fakeWorker([
    { chats: [snapshot([])], failures: [] },
    {
      chats: [snapshot([
        message({ id: "pic", kind: "image", imageQuality: "thumbnail", imageSize: "80x40", attachments: [
          { kind: "image", path: "C:\\cache\\media\\def_thumb.jpg", origin: "direct" },
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
  assert.equal(delivered.length, 1, "no upgrade machinery must not mean no delivery");
  assert.equal(source.pendingImageUpgrades.size, 0);
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
