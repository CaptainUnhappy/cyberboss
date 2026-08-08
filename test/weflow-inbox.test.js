const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");

const {
  WeFlowInboxSource,
  consumeSseStream,
  fetchMessageDetails,
  normalizeWeFlowMessage,
  parseCombinedForward,
  parseSseBlock,
} = require("../src/integrations/weflow-inbox");
const { CyberbossApp } = require("../src/core/app");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-weflow-inbox-"));
}

function createMediaFile(dir, name, bytes = "media") {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

function detail(extra = {}) {
  return {
    localId: 1,
    serverId: "server-1",
    localType: 1,
    createTime: 1_786_069_214,
    isSend: 0,
    senderUsername: "wxid_main",
    content: "hello",
    rawContent: "hello",
    parsedContent: "hello",
    ...extra,
  };
}

test("WeFlow SSE parser handles comments, JSON data, CRLF, and fragmented chunks", async () => {
  const parsed = parseSseBlock([
    ": heartbeat",
    "event: message.new",
    "data: {\"sessionId\":\"wxid_main\",",
    "data: \"rawid\":\"42\"}",
  ].join("\n"));
  assert.equal(parsed.event, "message.new");
  assert.deepEqual(parsed.data, { sessionId: "wxid_main", rawid: "42" });

  const events = [];
  await consumeSseStream(Readable.from([
    Buffer.from("event: message.new\r\nda"),
    Buffer.from("ta: {\"rawid\":\"1\"}\r\n\r\n:event ping\n\n"),
    Buffer.from("event: message.new\ndata: {\"rawid\":\"2\"}\n\n"),
  ]), async (event) => events.push(event));
  assert.deepEqual(events.map((event) => event.data.rawid), ["1", "2"]);
});

test("WeFlow normalizes plain links without exposing raw protocol fields", () => {
  const message = normalizeWeFlowMessage(detail({
    content: "资料 https://example.com/report?a=1",
    rawContent: "资料 https://example.com/report?a=1",
    parsedContent: "资料 https://example.com/report?a=1",
    downloadKey: "secret",
  }));

  assert.equal(message.kind, "link");
  assert.equal(message.isLinkCard, false);
  assert.equal(message.url, "https://example.com/report?a=1");
  assert.equal(message.text, "资料 https://example.com/report?a=1");
  assert.equal("downloadKey" in message, false);
  assert.equal("rawContent" in message, false);
});

test("WeFlow identifies structured link cards for the follow-up prompt window", () => {
  const message = normalizeWeFlowMessage(detail({
    content: "[链接]",
    parsedContent: "[链接]",
    rawContent: [
      "<msg><appmsg><title>文章标题</title><des>文章摘要</des><type>5</type>",
      "<url>https://example.com/card</url></appmsg></msg>",
    ].join(""),
  }));

  assert.equal(message.kind, "link");
  assert.equal(message.isLinkCard, true);
  assert.equal(message.url, "https://example.com/card");
  assert.equal(message.title, "文章标题");
});

test("WeFlow expands merged-forward records into an ordered readable transcript", () => {
  const xml = [
    "<msg><appmsg><title>项目群聊天记录</title><type>19</type>",
    "<recorditem><![CDATA[<recordinfo><datalist>",
    "<dataitem><sourcetime>2026-08-07 10:00</sourcetime><sourcename>A</sourcename><datadesc>第一条</datadesc></dataitem>",
    "<dataitem><sourcetime>2026-08-07 10:01</sourcetime><sourcename>B</sourcename><datatitle>方案</datatitle><datadesc>第二条</datadesc></dataitem>",
    "</datalist></recordinfo>]]></recorditem></appmsg></msg>",
  ].join("");
  const parsed = parseCombinedForward(xml);
  assert.equal(parsed.title, "项目群聊天记录");
  assert.match(parsed.text, /A: 第一条/);
  assert.match(parsed.text, /B: 方案 — 第二条/);

  const message = normalizeWeFlowMessage(detail({
    localType: 81604378673,
    content: "[聊天记录]",
    parsedContent: "[聊天记录]",
    rawContent: xml,
  }));
  assert.equal(message.kind, "text");
  assert.match(message.text, /^\[合并转发\]/);
});

test("WeFlow expands a quoted merged-forward record instead of exposing its placeholder URL", () => {
  const quotedXml = [
    "<msg><appmsg><title>群聊的聊天记录</title><des>A: 摘要第一条&#x0A;B: 摘要第二条</des><type>19</type>",
    "<url>https://support.weixin.qq.com/cgi-bin/mmsupport-bin/readtemplate?t=page/favorite_record__w_unsupport</url>",
    "<recorditem><![CDATA[<recordinfo><datalist>",
    "<dataitem><sourcetime>2026-08-07&#x20;10:00</sourcetime><sourcename>A</sourcename><datadesc>第一条</datadesc></dataitem>",
    "<dataitem><sourcetime>2026-08-07&#x20;10:01</sourcetime><sourcename>B</sourcename><datadesc>第二条</datadesc></dataitem>",
    "</datalist></recordinfo>]]></recorditem></appmsg></msg>",
  ].join("");
  const quoteMessage = detail({
    serverId: "quoted-record",
    localType: 81604378673,
    content: "[聊天记录]",
    parsedContent: "[聊天记录]",
    rawContent: quotedXml,
  });
  const message = normalizeWeFlowMessage(detail({
    serverId: "reply-to-record",
    localType: 244813135921,
    content: "如何回复",
    parsedContent: "如何回复",
    replyToMessageId: "quoted-record",
    quote: {
      platformMessageId: "quoted-record",
      accountName: "yourself",
      content: "[聊天记录]",
    },
    rawContent: "<msg><appmsg><title>如何回复</title><type>57</type></appmsg></msg>",
  }), { quoteMessage });

  assert.equal(message.kind, "text");
  assert.equal(message.quotedContexts[0].kind, "text");
  assert.equal(message.quotedContexts[0].title, "群聊的聊天记录");
  assert.match(message.quotedContexts[0].text, /\[2026-08-07 10:00\] A: 第一条/);
  assert.match(message.quotedContexts[0].text, /\[2026-08-07 10:01\] B: 第二条/);
  assert.equal(message.quotedContexts[0].url, "");
});

test("WeFlow uses the embedded merged-forward summary when the old quoted row is unavailable", () => {
  const embedded = [
    "&lt;msg&gt;&lt;appmsg&gt;&lt;title&gt;项目讨论的聊天记录&lt;/title&gt;",
    "&lt;des&gt;A: 第一条&#x0A;B: 第二条&lt;/des&gt;&lt;type&gt;19&lt;/type&gt;",
    "&lt;url&gt;https://support.weixin.qq.com/cgi-bin/mmsupport-bin/readtemplate?t=page/favorite_record__w_unsupport&lt;/url&gt;",
    "&lt;recorditem /&gt;&lt;/appmsg&gt;&lt;/msg&gt;",
  ].join("");
  const message = normalizeWeFlowMessage(detail({
    serverId: "reply-with-embedded-record",
    localType: 244813135921,
    content: "总结一下",
    parsedContent: "总结一下",
    replyToMessageId: "missing-record",
    quote: {
      platformMessageId: "missing-record",
      accountName: "yourself",
      content: "[聊天记录]",
    },
    rawContent: [
      "<msg><appmsg><title>总结一下</title><type>57</type><refermsg>",
      `<type>49</type><svrid>missing-record</svrid><content>${embedded}</content>`,
      "</refermsg></appmsg></msg>",
    ].join(""),
  }));

  assert.equal(message.quotedContexts[0].kind, "text");
  assert.equal(message.quotedContexts[0].title, "项目讨论的聊天记录");
  assert.match(message.quotedContexts[0].text, /A: 第一条/);
  assert.match(message.quotedContexts[0].text, /B: 第二条/);
  assert.equal(message.quotedContexts[0].url, "");
});

test("WeFlow uses exported direct image, audio, video, and file paths", () => {
  const dir = createTempDir();
  const fixtures = [
    ["image", "photo.jpg"],
    ["voice", "voice.wav"],
    ["video", "clip.mp4"],
    ["file", "brief.pdf"],
  ];
  for (const [kind, name] of fixtures) {
    const mediaLocalPath = createMediaFile(dir, name);
    const message = normalizeWeFlowMessage(detail({
      serverId: `server-${kind}`,
      mediaType: kind,
      mediaFileName: name,
      mediaLocalPath,
      content: `[${kind}]`,
      parsedContent: `[${kind}]`,
    }));
    assert.equal(message.kind, kind);
    assert.equal(message.attachments.length, 1);
    assert.equal(message.attachments[0].path, mediaLocalPath);
    assert.equal(message.attachments[0].origin, "direct");
  }
});

test("WeFlow resolves quoted image media to the quoted context and prefers non-thumbnail candidates", () => {
  const dir = createTempDir();
  const thumbnail = createMediaFile(dir, "quoted_t.jpg", "tiny");
  const fullImage = createMediaFile(dir, "quoted-full.jpg", "full-resolution");
  const quoteMessage = detail({
    serverId: "quoted-server",
    localType: 3,
    mediaType: "image",
    mediaFileName: "quoted-full.jpg",
    mediaLocalPath: [thumbnail, fullImage],
    content: "[图片]",
    parsedContent: "[图片]",
  });
  const message = normalizeWeFlowMessage(detail({
    serverId: "reply-server",
    localType: 244813135921,
    content: "总结图中内容",
    parsedContent: "总结图中内容",
    rawContent: "<msg><appmsg><title>总结图中内容</title><type>57</type></appmsg></msg>",
    replyToMessageId: "quoted-server",
    quote: {
      platformMessageId: "quoted-server",
      accountName: "yourself",
      content: "[图片]",
    },
  }), { quoteMessage });

  assert.equal(message.text, "总结图中内容");
  assert.equal(message.quotedContexts[0].kind, "image");
  assert.deepEqual(message.quotedContexts[0].attachmentRefs, ["weflow:reply-server:quoted:1"]);
  assert.equal(message.attachments[0].path, fullImage);
  assert.equal(message.attachments[0].origin, "quoted");
});

test("WeFlow performs a second time-centered lookup for an old quoted image", async () => {
  const dir = createTempDir();
  const oldImage = createMediaFile(dir, "old-image.jpg", "old-image-content");
  const current = detail({
    serverId: "reply-new",
    localId: 82,
    createTime: 1_786_070_570,
    content: "图中有什么",
    parsedContent: "图中有什么",
    rawContent: [
      "<msg><appmsg><title>图中有什么</title><type>57</type><refermsg>",
      "<type>3</type><svrid>quoted-old</svrid><displayname>yourself</displayname>",
      "<content>&lt;msg&gt;&lt;img /&gt;&lt;/msg&gt;</content><createtime>1786067183</createtime>",
      "</refermsg></appmsg></msg>",
    ].join(""),
    replyToMessageId: "quoted-old",
    quote: { platformMessageId: "quoted-old", accountName: "yourself", content: "[图片]" },
  });
  const old = detail({
    serverId: "quoted-old",
    localId: 75,
    createTime: 1_786_067_183,
    localType: 3,
    content: "[图片]",
    parsedContent: "[图片]",
    mediaType: "image",
    mediaFileName: "old-image.jpg",
    mediaLocalPath: oldImage,
  });
  const requestedStarts = [];
  const source = new WeFlowInboxSource({
    config: {
      weflowBaseUrl: "http://127.0.0.1:5031",
      weflowToken: "test-token",
      weflowInboxChat: "wxid_main",
    },
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const start = Number(parsed.searchParams.get("start"));
      requestedStarts.push(start);
      return {
        ok: true,
        async json() {
          return { messages: start < 1_786_067_500 ? [old] : [current] };
        },
      };
    },
  });

  const resolved = await source.resolvePushMessage({
    sessionId: "wxid_main",
    timestamp: current.createTime,
    rawid: current.serverId,
  });
  assert.equal(requestedStarts.length, 2);
  assert.equal(requestedStarts[0], current.createTime - 300);
  assert.equal(requestedStarts[1], old.createTime - 300);
  assert.equal(resolved.message.attachments[0].path, oldImage);
  assert.equal(resolved.message.attachments[0].origin, "quoted");
  assert.deepEqual(resolved.message.quotedContexts[0].attachmentRefs, ["weflow:reply-new:quoted:1"]);
});

test("WeFlow marks unresolved quoted media so a prior image is not reused", () => {
  const message = normalizeWeFlowMessage(detail({
    serverId: "reply-without-media",
    content: "分析一下",
    parsedContent: "分析一下",
    replyToMessageId: "missing-image",
    quote: { platformMessageId: "missing-image", accountName: "yourself", content: "[图片]" },
  }));
  assert.equal(message.quotedContexts[0].kind, "image");
  assert.match(message.quotedContexts[0].text, /请勿使用当前线程中的其他附件代替/);
  assert.deepEqual(message.quotedContexts[0].attachmentRefs, []);
});

test("WeFlow tolerates malformed quote and unknown message payloads", () => {
  const message = normalizeWeFlowMessage({
    serverId: "unknown-1",
    createTime: 1_786_069_214,
    isSend: 0,
    quote: "broken",
    rawContent: "<broken",
  });
  assert.equal(message.kind, "unknown");
  assert.deepEqual(message.quotedContexts, []);
  assert.deepEqual(message.attachments, []);
});

test("WeFlow detail request uses bearer auth and requests all supported media exports", async () => {
  const calls = [];
  const rows = await fetchMessageDetails({
    weflowBaseUrl: "http://127.0.0.1:5031",
    weflowToken: "test-token",
    weflowInboxChat: "wxid_main",
  }, {
    sessionId: "wxid_main",
    timestamp: 1_786_069_214,
  }, async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      async json() {
        return { messages: [detail()] };
      },
    };
  });
  assert.equal(rows.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("talker"), "wxid_main");
  assert.equal(url.searchParams.get("media"), "1");
  assert.equal(url.searchParams.get("image"), "1");
  assert.equal(url.searchParams.get("voice"), "1");
  assert.equal(url.searchParams.get("video"), "1");
  assert.equal(calls[0].options.headers.authorization, "Bearer test-token");
});

test("WeFlow source filters chat, retries deferred delivery, and persists event/rawid dedupe", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  let accepted = false;
  let attempts = 0;
  const source = new WeFlowInboxSource({
    config: {
      weflowInboxChat: "wxid_main",
      weflowInboxCursorFile: cursorFile,
    },
    onMessage: async () => {
      attempts += 1;
      return accepted;
    },
  });
  source.resolvePushMessage = async (push) => ({
    message: normalizeWeFlowMessage(detail({ serverId: push.rawid })),
    snapshot: { chat: "yourself", chatUsername: "wxid_main" },
  });

  assert.equal((await source.handleSseEvent({
    event: "message.new",
    data: { sessionId: "other", rawid: "skip" },
  })).status, "ignored_chat");
  assert.equal((await source.handleSseEvent({
    event: "message.new",
    data: { sessionId: "wxid_main", rawid: "42" },
  })).status, "deferred");
  accepted = true;
  assert.equal((await source.drainPendingEvents()).processed, 1);
  assert.equal(attempts, 2);
  assert.match(fs.readFileSync(cursorFile, "utf8"), /message\.new:42/);
  assert.equal((await source.handleSseEvent({
    event: "message.new",
    data: { sessionId: "wxid_main", rawid: "42" },
  })).status, "duplicate");
});

test("Cyberboss maps a WeFlow item onto the existing ClawBot reply binding", async () => {
  const received = [];
  const appLike = {
    activeAccountId: "account-1",
    config: {
      stateDir: createTempDir(),
      workspaceId: "default",
      weflowInboxChat: "wxid_main",
      weflowInboxDisplayName: "yourself",
    },
    resolveWeFlowInboxReplyTarget() {
      return { userId: "bot-user", contextToken: "ctx-1", provider: "weixin" };
    },
    async resolveWeFlowReplySource() {
      return "bot";
    },
    async handlePreparedMessage(normalized, options) {
      received.push({ normalized, options });
    },
  };

  const accepted = await CyberbossApp.prototype.handleWeFlowInboxMessage.call(
    appLike,
    normalizeWeFlowMessage(detail({
      content: "总结 https://example.com",
      parsedContent: "总结 https://example.com",
    })),
    { chat: "yourself", chatUsername: "wxid_main" }
  );
  assert.equal(accepted, true);
  assert.equal(received[0].normalized.provider, "weixin");
  assert.equal(received[0].normalized.chatId, "weflow:wxid_main");
  assert.match(received[0].normalized.text, /WeFlow 微信入站/);
  assert.equal(received[0].normalized.sharedContent, false);
  assert.equal(received[0].normalized.explicitPrompt, true);
  assert.deepEqual(received[0].options, { allowCommands: false });
});

test("Cyberboss freezes an azzy WeFlow turn onto the UIA-only reply provider", async () => {
  const received = [];
  const appLike = {
    activeAccountId: "account-1",
    config: {
      stateDir: createTempDir(),
      workspaceId: "default",
      weflowInboxChat: "wxid_main",
      weflowInboxDisplayName: "yourself",
    },
    resolveWeFlowInboxReplyTarget() {
      return { userId: "bot-user", contextToken: "ctx-1", provider: "weixin" };
    },
    async resolveWeFlowReplySource() {
      return "azzy";
    },
    async handlePreparedMessage(normalized) {
      received.push(normalized);
    },
  };

  const accepted = await CyberbossApp.prototype.handleWeFlowInboxMessage.call(
    appLike,
    normalizeWeFlowMessage(detail({ content: "single route", parsedContent: "single route" })),
    { chat: "yourself", chatUsername: "wxid_main" }
  );
  assert.equal(accepted, true);
  assert.equal(received.length, 1);
  assert.equal(received[0].provider, "weflow-uia");
});

test("Cyberboss consumes WeFlow source commands without creating a model turn", async () => {
  let routed = false;
  const appLike = {
    activeAccountId: "account-1",
    config: {
      stateDir: createTempDir(),
      workspaceId: "default",
      weflowInboxChat: "wxid_main",
      weflowInboxDisplayName: "yourself",
    },
    resolveWeFlowInboxReplyTarget() {
      return { userId: "bot-user", contextToken: "ctx-1", provider: "weixin" };
    },
    async resolveWeFlowReplySource() {
      throw new Error("control commands must not query the reply route");
    },
    async handlePreparedMessage() {
      routed = true;
    },
  };

  const accepted = await CyberbossApp.prototype.handleWeFlowInboxMessage.call(
    appLike,
    normalizeWeFlowMessage(detail({ content: "/azzy", parsedContent: "/azzy" })),
    { chat: "yourself", chatUsername: "wxid_main" }
  );
  assert.equal(accepted, true);
  assert.equal(routed, false);
});

test("Cyberboss native channel routes source commands before ordinary slash commands", async () => {
  const handled = [];
  let prepared = false;
  const normalized = {
    provider: "weixin",
    accountId: "account-1",
    workspaceId: "default",
    senderId: "small-account",
    contextToken: "fresh-context",
    text: "/bot",
  };
  const appLike = {
    channelAdapter: {
      normalizeIncomingMessage() {
        return normalized;
      },
    },
    async handleWeFlowControlCommand(message) {
      handled.push(message);
    },
    primeDeferredRepliesForSender() {
      throw new Error("control command must be handled first");
    },
    async handlePreparedMessage() {
      prepared = true;
    },
  };

  await CyberbossApp.prototype.handleIncomingMessage.call(appLike, {});
  assert.deepEqual(handled, [normalized]);
  assert.equal(prepared, false);
});

test("Cyberboss native channel consumes source confirmations without a model turn", async () => {
  let routed = false;
  const appLike = {
    channelAdapter: {
      normalizeIncomingMessage() {
        return {
          provider: "weixin",
          senderId: "small-account",
          text: "✅ 当前发信源：小号 UIA",
        };
      },
    },
    async handleWeFlowControlCommand() {
      routed = true;
    },
    primeDeferredRepliesForSender() {
      routed = true;
    },
    async handlePreparedMessage() {
      routed = true;
    },
  };

  await CyberbossApp.prototype.handleIncomingMessage.call(appLike, {});
  assert.equal(routed, false);
});

test("Cyberboss keeps the configured WeFlow reply target when no context token is cached", () => {
  const target = CyberbossApp.prototype.resolveLocalWechatReplyTarget.call({
    activeAccountId: "account-1",
    config: {
      workspaceId: "default",
      allowedUserIds: [],
    },
    channelAdapter: {
      getKnownContextTokens() {
        return {};
      },
    },
    runtimeAdapter: {
      getSessionStore() {
        return { state: { bindings: {} } };
      },
    },
  }, "platform-user@im.wechat");

  assert.deepEqual(target, {
    userId: "platform-user@im.wechat",
    contextToken: "",
    provider: "weixin",
  });
});

test("Cyberboss transcribes direct WeFlow WAV before task routing", async () => {
  const stateDir = createTempDir();
  const wavPath = path.join(stateDir, "voice.wav");
  fs.writeFileSync(wavPath, Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.alloc(4),
    Buffer.from("WAVE"),
    Buffer.from("fixture-audio"),
  ]));
  const received = [];
  const appLike = {
    activeAccountId: "account-1",
    config: {
      stateDir,
      workspaceId: "default",
      weflowInboxChat: "wxid_main",
      weflowInboxDisplayName: "yourself",
    },
    voiceTranscriptionService: {
      async transcribeAttachment(attachment) {
        assert.equal(attachment.kind, "voice");
        assert.equal(attachment.contentType, "audio/wav");
        return { text: "请回复这条语音", language: "zh", duration: 2.5 };
      },
    },
    resolveWeFlowInboxReplyTarget() {
      return { userId: "bot-user", contextToken: "ctx-1", provider: "weixin" };
    },
    async resolveWeFlowReplySource() {
      return "bot";
    },
    async handlePreparedMessage(normalized) {
      received.push(normalized);
    },
  };

  await CyberbossApp.prototype.handleWeFlowInboxMessage.call(appLike, normalizeWeFlowMessage(detail({
    serverId: "voice-server",
    localType: 34,
    content: "[语音消息]",
    parsedContent: "[语音消息]",
    mediaType: "voice",
    mediaLocalPath: wavPath,
    mediaFileName: "voice.wav",
  })), { chat: "yourself", chatUsername: "wxid_main" });

  assert.match(received[0].text, /\[语音转写\]\n请回复这条语音/);
  assert.equal(received[0].persistedAttachments[0].contentType, "audio/wav");
  assert.equal(received[0].persistedAttachmentFailures.length, 0);
  assert.equal(received[0].sharedContent, true);
  assert.equal(received[0].explicitPrompt, false);
});
