const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  WechatCliInboxSource,
  decodeWechatDatImage,
  persistLocalWechatAttachments,
} = require("../src/integrations/wechat-cli-inbox");
const { CyberbossApp } = require("../src/core/app");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-wechat-cli-inbox-"));
}

function message(id, direction, timestamp, extra = {}) {
  return {
    id,
    localId: timestamp,
    timestamp,
    receivedAt: new Date(timestamp * 1000).toISOString(),
    direction,
    kind: "text",
    text: id,
    quotedContexts: [],
    attachments: [],
    ...extra,
  };
}

function snapshot(messages) {
  return {
    chat: "main-account",
    chatUsername: "wxid_main",
    messages,
    failures: [],
  };
}

test("wechat-cli inbox baselines existing history then dispatches only new incoming messages", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const delivered = [];
  let current = snapshot([
    message("old-incoming", "incoming", 1),
    message("old-outgoing", "outgoing", 2),
  ]);
  const source = new WechatCliInboxSource({
    config: { wechatCliInboxCursorFile: cursorFile },
    reader: async () => current,
    onMessage: async (item) => {
      delivered.push(item.id);
      return true;
    },
  });

  assert.equal((await source.pollOnce()).status, "baselined");
  assert.deepEqual(delivered, []);

  current = snapshot([
    message("old-incoming", "incoming", 1),
    message("old-outgoing", "outgoing", 2),
    message("new-incoming", "incoming", 3),
    message("new-outgoing", "outgoing", 4),
  ]);
  assert.equal((await source.pollOnce()).processed, 1);
  assert.deepEqual(delivered, ["new-incoming"]);
  assert.equal((await source.pollOnce()).processed, 0);
  assert.deepEqual(delivered, ["new-incoming"]);

  const restarted = new WechatCliInboxSource({
    config: { wechatCliInboxCursorFile: cursorFile },
    reader: async () => current,
    onMessage: async (item) => delivered.push(item.id),
  });
  assert.equal((await restarted.pollOnce()).processed, 0);
  assert.deepEqual(delivered, ["new-incoming"]);
});

test("wechat-cli inbox waits for a reply target without reading or advancing", async () => {
  let reads = 0;
  const source = new WechatCliInboxSource({
    config: {},
    isReady: () => false,
    reader: async () => {
      reads += 1;
      return snapshot([]);
    },
  });
  assert.deepEqual(await source.pollOnce(), {
    status: "waiting_for_reply_target",
    processed: 0,
  });
  assert.equal(reads, 0);
});

test("wechat-cli inbox leaves a rejected incoming message uncommitted for retry", async () => {
  const dir = createTempDir();
  let current = snapshot([]);
  let accept = false;
  let attempts = 0;
  const source = new WechatCliInboxSource({
    config: { wechatCliInboxCursorFile: path.join(dir, "cursor.json") },
    reader: async () => current,
    onMessage: async () => {
      attempts += 1;
      return accept;
    },
  });
  await source.pollOnce();
  current = snapshot([message("retry-me", "incoming", 10)]);
  assert.equal((await source.pollOnce()).status, "deferred");
  accept = true;
  assert.equal((await source.pollOnce()).processed, 1);
  assert.equal(attempts, 2);
});

test("wechat-cli inbox can replay a bounded tail on its first snapshot", async () => {
  const delivered = [];
  const source = new WechatCliInboxSource({
    config: {
      wechatCliInboxReplayOnStart: true,
      wechatCliInboxReplayLimit: 2,
    },
    reader: async () => snapshot([
      message("first", "incoming", 1),
      message("second", "incoming", 2),
      message("third", "incoming", 3),
    ]),
    onMessage: async (item) => delivered.push(item.id),
  });
  assert.equal((await source.pollOnce()).processed, 2);
  assert.deepEqual(delivered, ["second", "third"]);
});

test("local WeChat XOR image data is decoded and copied into the Cyberboss inbox", async () => {
  const dir = createTempDir();
  const sourcePath = path.join(dir, "source.dat");
  const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]);
  const key = 0x73;
  fs.writeFileSync(sourcePath, Buffer.from(jpeg.map((byte) => byte ^ key)));

  const persisted = await persistLocalWechatAttachments({
    attachments: [{
      kind: "image",
      path: sourcePath,
      fileName: "photo.dat",
      origin: "quoted",
      attachmentRef: "quoted-1",
    }],
    stateDir: dir,
    messageId: "message-1",
    receivedAt: "2026-08-06T12:00:00+08:00",
  });

  assert.equal(persisted.failed.length, 0);
  assert.equal(persisted.saved.length, 1);
  assert.equal(path.extname(persisted.saved[0].absolutePath), ".jpg");
  assert.equal(persisted.saved[0].origin, "quoted");
  assert.equal(persisted.saved[0].attachmentRef, "quoted-1");
  assert.deepEqual(fs.readFileSync(persisted.saved[0].absolutePath), jpeg);
});

test("WeChat V2 AES and XOR image regions are decoded with cached local keys", () => {
  const aesKey = "a1b2c3d4e5f6g7h8";
  const xorKey = 0x37;
  const aesPlain = Buffer.concat([
    Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]),
    Buffer.alloc(24, 0x21),
  ]);
  const tailPlain = Buffer.from([0x10, 0x20, 0x30, 0xFF, 0xD9]);
  const cipher = crypto.createCipheriv("aes-128-ecb", Buffer.from(aesKey), null);
  cipher.setAutoPadding(true);
  const aesEncrypted = Buffer.concat([cipher.update(aesPlain), cipher.final()]);
  const tailEncrypted = Buffer.from(tailPlain.map((byte) => byte ^ xorKey));
  const header = Buffer.alloc(15);
  Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]).copy(header);
  header.writeUInt32LE(aesPlain.length, 6);
  header.writeUInt32LE(tailPlain.length, 10);
  header[14] = 1;

  const decoded = decodeWechatDatImage(
    Buffer.concat([header, aesEncrypted, tailEncrypted]),
    ".dat",
    { aesKey, xorKey }
  );
  assert.equal(decoded.decoded, true);
  assert.equal(decoded.extension, ".jpg");
  assert.deepEqual(decoded.bytes, Buffer.concat([aesPlain, tailPlain]));
});

test("Cyberboss maps a local WeChat inbox item onto the existing Weixin reply binding", async () => {
  const received = [];
  const appLike = {
    activeAccountId: "account-1",
    config: {
      stateDir: createTempDir(),
      workspaceId: "default",
      wechatCliInboxChat: "main-account",
    },
    resolveWechatCliInboxReplyTarget() {
      return { userId: "bot-user", contextToken: "ctx-1", provider: "weixin" };
    },
    async handlePreparedMessage(normalized, options) {
      received.push({ normalized, options });
    },
  };

  const accepted = await CyberbossApp.prototype.handleWechatCliInboxMessage.call(
    appLike,
    message("local-1", "incoming", 20, {
      text: "总结一下",
      quotedContexts: [{
        kind: "link",
        title: "资料",
        text: "",
        url: "https://example.com/source",
        attachmentRefs: [],
      }],
    }),
    { chat: "main-account", chatUsername: "wxid_main" }
  );

  assert.equal(accepted, true);
  assert.equal(received.length, 1);
  assert.equal(received[0].normalized.provider, "weixin");
  assert.equal(received[0].normalized.senderId, "bot-user");
  assert.match(received[0].normalized.text, /本地微信入站/);
  assert.match(received[0].normalized.text, /总结一下/);
  assert.equal(received[0].normalized.quotedContexts[0].url, "https://example.com/source");
  assert.deepEqual(received[0].options, { allowCommands: false });
});
