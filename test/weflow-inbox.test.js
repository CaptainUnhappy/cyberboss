const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const { spawnSync } = require("child_process");

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
  const deferred = await source.handleSseEvent({
    event: "message.new",
    data: { sessionId: "wxid_main", rawid: "42" },
  });
  assert.equal(deferred.status, "deferred");
  assert.equal(source.pendingRetryAttempt, 1);
  assert.ok(source.pendingRetryNotBeforeMs > Date.now());
  accepted = true;
  assert.equal((await source.drainPendingEvents()).status, "cooldown");
  assert.equal(attempts, 1);
  source.pendingRetryNotBeforeMs = 0;
  assert.equal((await source.drainPendingEvents()).processed, 1);
  assert.equal(attempts, 2);
  assert.match(fs.readFileSync(cursorFile, "utf8"), /message\.new:42/);
  assert.equal((await source.handleSseEvent({
    event: "message.new",
    data: { sessionId: "wxid_main", rawid: "42" },
  })).status, "duplicate");
});

test("WeFlow source delivers an outgoing message once and persists its event cursor", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const delivered = [];
  const createSource = () => {
    const source = new WeFlowInboxSource({
      config: {
        weflowInboxChat: "wxid_main",
        weflowInboxCursorFile: cursorFile,
      },
      onMessage: async (message, snapshot) => {
        delivered.push({ message, snapshot });
        return true;
      },
    });
    source.resolvePushMessage = async (push) => ({
      message: normalizeWeFlowMessage(detail({
        serverId: push.rawid,
        localId: 73,
        isSend: 1,
        content: "手机发送的指令",
        parsedContent: "手机发送的指令",
      })),
      snapshot: { chat: "yourself", chatUsername: "wxid_main" },
    });
    return source;
  };
  const event = {
    event: "message.new",
    data: { sessionId: "wxid_main", rawid: "outgoing-73" },
  };

  const source = createSource();
  const first = await source.handleSseEvent(event);
  assert.equal(first.status, "ok");
  assert.equal(first.processed, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].message.direction, "outgoing");
  assert.equal(delivered[0].message.localId, 73);
  assert.deepEqual(delivered[0].snapshot, { chat: "yourself", chatUsername: "wxid_main" });

  const persisted = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.deepEqual(persisted.seenIds, ["message.new:outgoing-73"]);
  assert.ok(persisted.lastEventAt);
  assert.equal((await source.handleSseEvent(event)).status, "duplicate");

  const restartedSource = createSource();
  assert.equal((await restartedSource.handleSseEvent(event)).status, "duplicate");
  assert.equal(delivered.length, 1);
});

test("WeFlow outgoing poll queues recent rows in timestamp and localId order", async () => {
  const dir = createTempDir();
  const nowMs = 1_800_000_000_000;
  const delivered = [];
  const source = new WeFlowInboxSource({
    config: {
      weflowBaseUrl: "http://127.0.0.1:5031",
      weflowToken: "test-token",
      weflowInboxChat: "wxid_main",
      weflowInboxCursorFile: path.join(dir, "cursor.json"),
      weflowOutgoingReplayWindowMs: 10 * 60_000,
    },
    now: () => nowMs,
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, "/api/v1/messages");
      assert.equal(parsed.searchParams.get("talker"), "wxid_main");
      assert.equal(parsed.searchParams.get("start"), String(Math.floor(nowMs / 1_000) - 600));
      assert.equal(options.headers.authorization, "Bearer test-token");
      return {
        ok: true,
        async json() {
          return {
            messages: [
              detail({ serverId: "poll-3", localId: 3, isSend: 1, createTime: nowMs / 1_000 - 2 }),
              detail({ serverId: "poll-2", localId: 2, isSend: 1, createTime: nowMs / 1_000 - 5 }),
              detail({ serverId: "poll-1", localId: 1, isSend: 1, createTime: nowMs / 1_000 - 5 }),
            ],
          };
        },
      };
    },
    onMessage: async (message) => {
      delivered.push(message.id);
      return true;
    },
  });
  source.resolvePushMessage = async (push) => ({
    message: normalizeWeFlowMessage(detail({
      serverId: push.serverId,
      localId: push.localId,
      isSend: 1,
      createTime: push.timestamp,
    })),
    snapshot: { chat: "yourself", chatUsername: "wxid_main" },
  });

  const result = await source.pollOutgoingMessagesOnce();
  assert.equal(result.status, "ok");
  assert.equal(result.queued, 3);
  assert.equal(result.processed, 3);
  assert.deepEqual(delivered, ["poll-1", "poll-2", "poll-3"]);
  assert.deepEqual(source.state.seenIds, [
    "message.new:poll-1",
    "message.new:poll-2",
    "message.new:poll-3",
  ]);
});

test("WeFlow poll recovers incoming rows while ignoring expired and wrong-talker rows", async () => {
  const nowMs = 1_800_000_000_000;
  const delivered = [];
  const source = new WeFlowInboxSource({
    config: {
      weflowInboxChat: "wxid_main",
      weflowOutgoingReplayWindowMs: 10 * 60_000,
    },
    now: () => nowMs,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          messages: [
            detail({ serverId: "incoming", isSend: 0, createTime: nowMs / 1_000 - 1 }),
            detail({ serverId: "expired", isSend: 1, createTime: nowMs / 1_000 - 601 }),
            detail({ serverId: "wrong-chat", talker: "wxid_other", isSend: 1, createTime: nowMs / 1_000 - 1 }),
          ],
        };
      },
    }),
    onMessage: async (message) => {
      delivered.push(message);
      return true;
    },
  });

  const result = await source.pollOutgoingMessagesOnce();
  assert.equal(result.fetched, 3);
  assert.equal(result.queued, 1);
  assert.equal(result.processed, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, "incoming");
  assert.equal(delivered[0].direction, "incoming");
  assert.equal(source.pendingEvents.size, 0);
});

test("WeFlow outgoing poll and SSE share the persisted serverId dedupe key", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const nowMs = 1_800_000_000_000;
  let delivered = 0;
  const createSource = () => {
    const source = new WeFlowInboxSource({
      config: {
        weflowInboxChat: "wxid_main",
        weflowInboxCursorFile: cursorFile,
      },
      now: () => nowMs,
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            messages: [detail({
              serverId: "shared-server-id",
              localId: 88,
              isSend: 1,
              createTime: nowMs / 1_000 - 1,
            })],
          };
        },
      }),
      onMessage: async () => {
        delivered += 1;
        return true;
      },
    });
    source.resolvePushMessage = async (push) => ({
      message: normalizeWeFlowMessage(detail({
        serverId: push.serverId || push.rawid,
        localId: 88,
        isSend: 1,
        createTime: nowMs / 1_000 - 1,
      })),
      snapshot: { chat: "yourself", chatUsername: "wxid_main" },
    });
    return source;
  };

  const source = createSource();
  assert.equal((await source.pollOutgoingMessagesOnce()).processed, 1);
  assert.equal((await source.pollOutgoingMessagesOnce()).processed, 0);
  assert.equal((await source.handleSseEvent({
    event: "message.new",
    data: { sessionId: "wxid_main", rawid: "shared-server-id" },
  })).status, "duplicate");

  const restarted = createSource();
  assert.equal((await restarted.pollOutgoingMessagesOnce()).processed, 0);
  assert.equal(delivered, 1);
  assert.deepEqual(restarted.state.seenIds, ["message.new:shared-server-id"]);
});

test("WeFlow outgoing poll resumes from its durable high-water after a long outage", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const previousPollSeconds = 1_800_000_000;
  const nowSeconds = previousPollSeconds + (2 * 60 * 60);
  fs.writeFileSync(cursorFile, `${JSON.stringify({
    version: 2,
    seenIds: [],
    lastEventAt: "",
    pendingEvents: [],
    outgoingPollCursor: {
      chat: "wxid_main",
      polledThrough: previousPollSeconds,
      latestTimestamp: previousPollSeconds - 1,
      latestLocalId: 10,
      latestServerId: "before-outage",
    },
  })}\n`, "utf8");
  const delivered = [];
  const source = new WeFlowInboxSource({
    config: {
      weflowInboxChat: "wxid_main",
      weflowInboxCursorFile: cursorFile,
      weflowOutgoingReplayWindowMs: 10 * 60_000,
    },
    now: () => nowSeconds * 1_000,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("start"), String(previousPollSeconds - 600));
      assert.equal(parsed.searchParams.get("end"), String(nowSeconds));
      return {
        ok: true,
        async json() {
          return {
            hasMore: false,
            messages: [detail({
              serverId: "during-outage",
              localId: 11,
              isSend: 1,
              createTime: previousPollSeconds + 3_600,
            })],
          };
        },
      };
    },
    onMessage: async (message) => {
      delivered.push(message.id);
      return true;
    },
  });
  source.resolvePushMessage = async (push) => ({
    message: normalizeWeFlowMessage(detail({
      serverId: push.serverId,
      localId: push.localId,
      isSend: 1,
      createTime: push.timestamp,
    })),
    snapshot: { chat: "yourself", chatUsername: "wxid_main" },
  });

  const result = await source.pollOutgoingMessagesOnce();
  assert.equal(result.processed, 1);
  assert.deepEqual(delivered, ["during-outage"]);
  const persisted = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.equal(persisted.outgoingPollCursor.polledThrough, nowSeconds);
  assert.equal(persisted.outgoingPollCursor.latestServerId, "during-outage");
});

test("WeFlow migrates a version one lastEventAt cursor and backfills the full upgrade outage", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const lastEventSeconds = 1_800_000_000;
  const nowSeconds = lastEventSeconds + (6 * 60 * 60);
  fs.writeFileSync(cursorFile, `${JSON.stringify({
    version: 1,
    seenIds: ["message.new:already-seen"],
    lastEventAt: new Date(lastEventSeconds * 1_000).toISOString(),
    pendingEvents: [],
  })}\n`, "utf8");
  const delivered = [];
  const requestedStarts = [];
  const source = new WeFlowInboxSource({
    config: {
      weflowInboxChat: "wxid_main",
      weflowInboxCursorFile: cursorFile,
      weflowOutgoingReplayWindowMs: 10 * 60_000,
    },
    now: () => nowSeconds * 1_000,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      requestedStarts.push(Number(parsed.searchParams.get("start")));
      return {
        ok: true,
        async json() {
          return {
            hasMore: false,
            messages: [
              detail({
                serverId: "already-seen",
                localId: 10,
                isSend: 1,
                createTime: lastEventSeconds,
              }),
              detail({
                serverId: "missed-during-upgrade",
                localId: 11,
                isSend: 1,
                createTime: lastEventSeconds + 3_600,
              }),
            ],
          };
        },
      };
    },
    onMessage: async (message) => {
      delivered.push(message.id);
      return true;
    },
  });
  source.resolvePushMessage = async (push) => ({
    message: normalizeWeFlowMessage(detail({
      serverId: push.serverId,
      localId: push.localId,
      isSend: push.isSend,
      createTime: push.timestamp,
    })),
    snapshot: { chat: "yourself", chatUsername: "wxid_main" },
  });

  assert.equal(source.state.outgoingPollCursor.chat, "wxid_main");
  assert.equal(source.state.outgoingPollCursor.polledThrough, lastEventSeconds - 1);
  assert.equal(source.state.outgoingPollCursor.backfillActive, true);
  const result = await source.pollOutgoingMessagesOnce();
  assert.equal(result.processed, 1);
  assert.deepEqual(requestedStarts, [lastEventSeconds]);
  assert.deepEqual(delivered, ["missed-during-upgrade"]);
  assert.equal(source.state.outgoingPollCursor.polledThrough, nowSeconds);
  assert.equal(source.state.outgoingPollCursor.backfillActive, false);
  const persisted = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.equal(persisted.version, 2);
  assert.ok(persisted.seenIds.includes("message.new:already-seen"));
  assert.ok(persisted.seenIds.includes("message.new:missed-during-upgrade"));
});

test("WeFlow outgoing backfill splits full time ranges and preserves chronological delivery", async () => {
  const rows = [100, 200, 300, 400, 500].map((timestamp, index) => detail({
    serverId: `page-${index + 1}`,
    localId: index + 1,
    isSend: 1,
    createTime: timestamp,
  }));
  const delivered = [];
  let requestCount = 0;
  const source = new WeFlowInboxSource({
    config: {
      weflowInboxChat: "wxid_main",
      weflowMessageLimit: 2,
      weflowOutgoingReplayWindowMs: 500_000,
      weflowOutgoingPollMaxRequests: 32,
    },
    now: () => 500_000,
    fetchImpl: async (url) => {
      requestCount += 1;
      const parsed = new URL(url);
      const start = Number(parsed.searchParams.get("start"));
      const end = Number(parsed.searchParams.get("end"));
      const inRange = rows
        .filter((row) => row.createTime >= start && row.createTime <= end)
        .sort((left, right) => right.createTime - left.createTime);
      return {
        ok: true,
        async json() {
          return { hasMore: inRange.length > 2, messages: inRange.slice(0, 2) };
        },
      };
    },
    onMessage: async (message) => {
      delivered.push(message.id);
      return true;
    },
  });
  source.resolvePushMessage = async (push) => ({
    message: normalizeWeFlowMessage(detail({
      serverId: push.serverId,
      localId: push.localId,
      isSend: 1,
      createTime: push.timestamp,
    })),
    snapshot: { chat: "yourself", chatUsername: "wxid_main" },
  });

  const result = await source.pollOutgoingMessagesOnce();
  assert.deepEqual(delivered, ["page-1", "page-2", "page-3", "page-4", "page-5"]);
  assert.equal(result.processed, 5);
  assert.ok(requestCount > 1);
  assert.equal(result.requestCount, requestCount);
});

test("WeFlow outgoing backfill commits a safe prefix when the request budget is exhausted", async () => {
  const rows = Array.from({ length: 33 }, (_value, index) => detail({
    serverId: `dense-${index + 1}`,
    localId: index + 1,
    isSend: 1,
    createTime: index + 1,
  }));
  const delivered = [];
  const source = new WeFlowInboxSource({
    config: {
      weflowInboxChat: "wxid_main",
      weflowMessageLimit: 1,
      weflowOutgoingReplayWindowMs: 33_000,
      weflowOutgoingPollMaxRequests: 64,
    },
    now: () => 33_000,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const start = Number(parsed.searchParams.get("start"));
      const end = Number(parsed.searchParams.get("end"));
      const inRange = rows
        .filter((row) => row.createTime >= start && row.createTime <= end)
        .sort((left, right) => right.createTime - left.createTime);
      return {
        ok: true,
        async json() {
          return { hasMore: inRange.length > 1, messages: inRange.slice(0, 1) };
        },
      };
    },
    onMessage: async (message) => {
      delivered.push(message.id);
      return true;
    },
  });
  source.resolvePushMessage = async (push) => ({
    message: normalizeWeFlowMessage(detail({
      serverId: push.serverId,
      localId: push.localId,
      isSend: 1,
      createTime: push.timestamp,
    })),
    snapshot: { chat: "yourself", chatUsername: "wxid_main" },
  });

  const first = await source.pollOutgoingMessagesOnce();
  assert.equal(first.backfillActive, true);
  assert.ok(source.state.outgoingPollCursor.polledThrough > 0);
  const firstThrough = source.state.outgoingPollCursor.polledThrough;
  for (let attempt = 0; attempt < 5 && source.state.outgoingPollCursor.backfillActive; attempt += 1) {
    await source.pollOutgoingMessagesOnce();
  }

  assert.ok(source.state.outgoingPollCursor.polledThrough >= firstThrough);
  assert.equal(source.state.outgoingPollCursor.backfillActive, false);
  assert.deepEqual(delivered, rows.map((row) => row.serverId));
});

test("WeFlow outgoing backfill leaves overlap mode after a bounded scan cannot reach the old cursor", async () => {
  const requestedStarts = [];
  const source = new WeFlowInboxSource({
    config: {
      weflowInboxChat: "wxid_main",
      weflowMessageLimit: 1,
      weflowOutgoingReplayWindowMs: 600_000,
      weflowOutgoingPollMaxRequests: 1,
    },
    now: () => 2_000_000,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      requestedStarts.push(Number(parsed.searchParams.get("start")));
      return {
        ok: true,
        async json() {
          return {
            hasMore: true,
            messages: [detail({
              serverId: `overlap-${requestedStarts.length}`,
              localId: requestedStarts.length,
              isSend: 1,
              createTime: 1_500,
            })],
          };
        },
      };
    },
  });
  source.state.outgoingPollCursor = {
    chat: "wxid_main",
    polledThrough: 1_000,
    backfillActive: false,
    latestTimestamp: 999,
    latestLocalId: 1,
    latestServerId: "old-cursor",
  };

  const first = await source.pollOutgoingMessagesOnce();
  assert.equal(first.backfillActive, true);
  assert.equal(source.state.outgoingPollCursor.polledThrough, 1_000);
  assert.equal(source.state.outgoingPollCursor.backfillActive, true);

  source.state.outgoingPollCursor.retryNotBefore = "";
  await source.pollOutgoingMessagesOnce();
  assert.deepEqual(requestedStarts, [400, 1_001]);
});

test("WeFlow outgoing backfill persists a cooldown when a bounded scan makes no cursor progress", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  let fetchCalls = 0;
  const source = new WeFlowInboxSource({
    config: {
      weflowInboxChat: "wxid_main",
      weflowInboxCursorFile: cursorFile,
      weflowMessageLimit: 1,
      weflowOutgoingReplayWindowMs: 600_000,
      weflowOutgoingPollMaxRequests: 1,
    },
    now: () => 2_000_000,
    fetchImpl: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        async json() {
          return {
            hasMore: true,
            messages: [detail({
              serverId: "stalled-row",
              localId: 1,
              isSend: 1,
              createTime: 1_500,
            })],
          };
        },
      };
    },
  });
  source.state.outgoingPollCursor = {
    chat: "wxid_main",
    polledThrough: 1_000,
    backfillActive: true,
    latestTimestamp: 999,
    latestLocalId: 1,
    latestServerId: "old-cursor",
  };

  const first = await source.pollOutgoingMessagesOnce();
  assert.equal(first.status, "stalled");
  assert.equal(first.requestCount, 1);
  assert.ok(Date.parse(first.nextRetryAt) > Date.now());
  assert.equal(source.state.outgoingPollCursor.polledThrough, 1_000);
  assert.equal(source.state.outgoingPollCursor.stallAttempt, 1);
  assert.ok(source.state.outgoingPollCursor.retryNotBefore);

  const second = await source.pollOutgoingMessagesOnce();
  assert.equal(second.status, "cooldown");
  assert.equal(second.requestCount, 0);
  assert.equal(fetchCalls, 1);

  const restarted = new WeFlowInboxSource({
    config: {
      weflowInboxChat: "wxid_main",
      weflowInboxCursorFile: cursorFile,
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("persisted cooldown must prevent an immediate rescan");
    },
  });
  const afterRestart = await restarted.pollOutgoingMessagesOnce();
  assert.equal(afterRestart.status, "cooldown");
  assert.equal(afterRestart.requestCount, 0);
  assert.equal(fetchCalls, 1);
});

test("WeFlow outgoing backfill paginates more than limit rows from one second", async () => {
  const rows = Array.from({ length: 5 }, (_value, index) => detail({
    serverId: `same-second-${index + 1}`,
    localId: index + 1,
    isSend: 1,
    createTime: 500,
  }));
  const delivered = [];
  const source = new WeFlowInboxSource({
    config: {
      weflowInboxChat: "wxid_main",
      weflowMessageLimit: 2,
      weflowOutgoingReplayWindowMs: 1_000,
      weflowOutgoingPollMaxRequests: 16,
    },
    now: () => 500_000,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const start = Number(parsed.searchParams.get("start"));
      const end = Number(parsed.searchParams.get("end"));
      const offset = Number(parsed.searchParams.get("offset") || 0);
      const inRange = rows
        .filter((row) => row.createTime >= start && row.createTime <= end)
        .sort((left, right) => right.localId - left.localId);
      return {
        ok: true,
        async json() {
          return {
            hasMore: offset + 2 < inRange.length,
            messages: inRange.slice(offset, offset + 2),
          };
        },
      };
    },
    onMessage: async (message) => {
      delivered.push(message.id);
      return true;
    },
  });
  source.resolvePushMessage = async (push) => ({
    message: normalizeWeFlowMessage(detail({
      serverId: push.serverId,
      localId: push.localId,
      isSend: 1,
      createTime: push.timestamp,
    })),
    snapshot: { chat: "yourself", chatUsername: "wxid_main" },
  });

  const result = await source.pollOutgoingMessagesOnce();
  assert.equal(result.processed, 5);
  assert.deepEqual(delivered, rows.map((row) => row.serverId));
});

test("WeFlow outgoing poll retries an already-persisted pending event when no row is newly queued", async () => {
  let attempts = 0;
  const nowSeconds = 1_800_000_000;
  const source = new WeFlowInboxSource({
    config: { weflowInboxChat: "wxid_main" },
    now: () => nowSeconds * 1_000,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          messages: [detail({
            serverId: "pending-poll-retry",
            localId: 91,
            isSend: 1,
            createTime: nowSeconds - 1,
          })],
        };
      },
    }),
    onMessage: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("fixture transient handler error");
      return true;
    },
  });
  source.resolvePushMessage = async (push) => ({
    message: normalizeWeFlowMessage(detail({
      serverId: push.serverId,
      localId: push.localId,
      isSend: 1,
      createTime: push.timestamp,
    })),
    snapshot: { chat: "yourself", chatUsername: "wxid_main" },
  });

  await assert.rejects(source.pollOutgoingMessagesOnce(), /transient handler error/);
  assert.equal(source.pendingEvents.size, 1);
  assert.equal(source.pendingRetryAttempt, 1);
  assert.equal((await source.pollOutgoingMessagesOnce()).status, "cooldown");
  assert.equal(attempts, 1);
  source.pendingRetryNotBeforeMs = 0;
  const retried = await source.pollOutgoingMessagesOnce();
  assert.equal(retried.queued, 0);
  assert.equal(retried.processed, 1);
  assert.equal(source.pendingEvents.size, 0);
});

test("WeFlow SSE applies backpressure instead of growing the pending map beyond its durable cap", async () => {
  let aborted = false;
  const errors = [];
  const source = new WeFlowInboxSource({
    config: { weflowInboxChat: "wxid_main" },
    logger: { error(message) { errors.push(message); } },
  });
  for (let index = 0; index < 1_000; index += 1) {
    source.pendingEvents.set(`message.new:existing-${index}`, {
      eventType: "message.new",
      push: { sessionId: "wxid_main", rawid: `existing-${index}` },
    });
  }
  source.abortController = { abort() { aborted = true; } };

  const result = await source.handleSseEvent({
    event: "message.new",
    data: { sessionId: "wxid_main", rawid: "overflow-event" },
  });
  assert.equal(result.status, "backpressure");
  assert.equal(source.pendingEvents.size, 1_000);
  assert.equal(aborted, true);
  assert.equal(errors.length, 1);
});

test("WeFlow push loop stays disconnected while a full durable queue is cooling down", async () => {
  let streamConnections = 0;
  const source = new WeFlowInboxSource({
    config: {
      weflowInboxChat: "wxid_main",
      weflowReconnectDelayMs: 100,
    },
  });
  for (let index = 0; index < 1_000; index += 1) {
    source.pendingEvents.set(`message.new:cooldown-${index}`, {
      eventType: "message.new",
      push: { sessionId: "wxid_main", rawid: `cooldown-${index}` },
    });
  }
  source.pendingRetryNotBeforeMs = Date.now() + 10_000;
  source.consumePushStream = async () => {
    streamConnections += 1;
  };
  source.running = true;

  const loop = source.runLoop();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(streamConnections, 0);
  source.running = false;
  source.abortController?.abort();
  await loop;
  assert.equal(source.pendingEvents.size, 1_000);
});

test("WeFlow poll loop does not rescan REST while a full durable queue is cooling down", async () => {
  let fetchCalls = 0;
  const source = new WeFlowInboxSource({
    config: {
      weflowInboxChat: "wxid_main",
      weflowOutgoingPollIntervalMs: 250,
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("REST must stay idle during pending cooldown");
    },
  });
  for (let index = 0; index < 1_000; index += 1) {
    source.pendingEvents.set(`message.new:poll-cooldown-${index}`, {
      eventType: "message.new",
      push: { sessionId: "wxid_main", rawid: `poll-cooldown-${index}` },
    });
  }
  source.pendingRetryNotBeforeMs = Date.now() + 10_000;
  source.running = true;
  const controller = new AbortController();

  const loop = source.runOutgoingPollLoop(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(fetchCalls, 0);
  source.running = false;
  controller.abort();
  await loop;
  assert.equal(fetchCalls, 0);
});

test("WeFlow source restores an uncommitted pending event after restart", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const config = {
    weflowInboxChat: "wxid_main",
    weflowInboxCursorFile: cursorFile,
  };
  const event = {
    event: "message.new",
    data: { sessionId: "wxid_main", rawid: "pending-restart-1", timestamp: 1_777_000_000 },
  };
  const resolvePushMessage = async (push) => ({
    message: normalizeWeFlowMessage(detail({
      serverId: push.rawid,
      localId: 75,
      isSend: 1,
      content: "重启后继续处理",
      parsedContent: "重启后继续处理",
    })),
    snapshot: { chat: "yourself", chatUsername: "wxid_main" },
  });

  const first = new WeFlowInboxSource({
    config,
    onMessage: async () => false,
  });
  first.resolvePushMessage = resolvePushMessage;
  const deferred = await first.handleSseEvent(event);
  assert.equal(deferred.status, "deferred");
  assert.equal(first.pendingEvents.size, 1);
  let persisted = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.deepEqual(persisted.seenIds, []);
  assert.equal(persisted.pendingEvents.length, 1);
  assert.equal(persisted.pendingEvents[0].key, "message.new:pending-restart-1");

  const delivered = [];
  const restarted = new WeFlowInboxSource({
    config,
    onMessage: async (message) => {
      delivered.push(message);
      return true;
    },
  });
  restarted.resolvePushMessage = resolvePushMessage;
  assert.equal(restarted.pendingEvents.size, 1);
  const recovered = await restarted.drainPendingEvents();
  assert.equal(recovered.processed, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].text, "重启后继续处理");
  persisted = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.deepEqual(persisted.seenIds, ["message.new:pending-restart-1"]);
  assert.deepEqual(persisted.pendingEvents, []);
});

test("WeFlow serializes timer and SSE drains so one event reaches onMessage once", async () => {
  let releaseResolution;
  const resolutionGate = new Promise((resolve) => {
    releaseResolution = resolve;
  });
  let signalResolutionStarted;
  const resolutionStarted = new Promise((resolve) => {
    signalResolutionStarted = resolve;
  });
  let resolveCalls = 0;
  let deliveryCalls = 0;
  const source = new WeFlowInboxSource({
    config: { weflowInboxChat: "wxid_main" },
    onMessage: async () => {
      deliveryCalls += 1;
      return true;
    },
  });
  source.resolvePushMessage = async (push) => {
    resolveCalls += 1;
    signalResolutionStarted();
    await resolutionGate;
    return {
      message: normalizeWeFlowMessage(detail({ serverId: push.rawid })),
      snapshot: { chat: "yourself", chatUsername: "wxid_main" },
    };
  };
  const event = {
    event: "message.new",
    data: { sessionId: "wxid_main", rawid: "concurrent-1" },
  };
  source.pendingEvents.set("message.new:concurrent-1", {
    eventType: event.event,
    push: event.data,
  });

  const timerDrain = source.drainPendingEvents();
  await resolutionStarted;
  const sseDrain = source.handleSseEvent(event);
  await new Promise((resolve) => setImmediate(resolve));
  releaseResolution();
  const [timerResult, sseResult] = await Promise.all([timerDrain, sseDrain]);

  assert.equal(timerResult.processed, 1);
  assert.equal(sseResult.processed, 1);
  assert.equal(resolveCalls, 1);
  assert.equal(deliveryCalls, 1);
  assert.deepEqual(source.state.seenIds, ["message.new:concurrent-1"]);
  assert.equal(source.pendingEvents.size, 0);
});

test("WeFlow stop stays bounded and a late handler cannot commit its pending event", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  let signalDeliveryStarted;
  const deliveryStarted = new Promise((resolve) => {
    signalDeliveryStarted = resolve;
  });
  let releaseDelivery;
  const deliveryGate = new Promise((resolve) => {
    releaseDelivery = resolve;
  });
  const source = new WeFlowInboxSource({
    config: {
      weflowInboxChat: "wxid_main",
      weflowInboxCursorFile: cursorFile,
    },
    onMessage: async () => {
      signalDeliveryStarted();
      await deliveryGate;
      return true;
    },
  });
  source.resolvePushMessage = async (push) => ({
    message: normalizeWeFlowMessage(detail({ serverId: push.rawid })),
    snapshot: { chat: "yourself", chatUsername: "wxid_main" },
  });

  const delivery = source.handleSseEvent({
    event: "message.new",
    data: { sessionId: "wxid_main", rawid: "stop-pending-1" },
  });
  source.loopPromise = delivery;
  await deliveryStarted;

  const stopStartedAt = Date.now();
  let guardTimer;
  try {
    await Promise.race([
      source.stop(),
      new Promise((_, reject) => {
        guardTimer = setTimeout(() => reject(new Error("WeFlow stop exceeded its bounded drain wait")), 7_500);
      }),
    ]);
    const stopElapsedMs = Date.now() - stopStartedAt;
    assert.ok(stopElapsedMs >= 4_500, `stop returned too early after ${stopElapsedMs}ms`);
    assert.ok(stopElapsedMs < 7_500, `stop returned too late after ${stopElapsedMs}ms`);
    assert.equal(source.pendingEvents.size, 1);
    assert.deepEqual(source.state.seenIds, []);
    const stoppedState = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
    assert.deepEqual(stoppedState.seenIds, []);
    assert.deepEqual(stoppedState.pendingEvents.map((item) => item.key), ["message.new:stop-pending-1"]);
  } finally {
    clearTimeout(guardTimer);
    releaseDelivery();
  }

  const deliveryResult = await delivery;
  assert.deepEqual(deliveryResult, { status: "stopped", processed: 0 });
  assert.equal(source.pendingEvents.size, 1);
  assert.deepEqual(source.state.seenIds, []);
  const finalState = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.deepEqual(finalState.seenIds, []);
  assert.deepEqual(finalState.pendingEvents.map((item) => item.key), ["message.new:stop-pending-1"]);
});

test("WeFlow timer drain records rejection without an unhandled rejection and keeps pending", () => {
  const modulePath = path.resolve(__dirname, "../src/integrations/weflow-inbox.js");
  const script = `
    const { WeFlowInboxSource } = require(${JSON.stringify(modulePath)});
    const errors = [];
    const source = new WeFlowInboxSource({
      config: { weflowInboxChat: "wxid_main" },
      logger: { error(message) { errors.push(String(message)); } },
    });
    source.resolvePushMessage = async () => {
      throw new Error("fixture timer drain failure");
    };
    source.pendingEvents.set("message.new:timer-reject-1", {
      eventType: "message.new",
      push: { sessionId: "wxid_main", rawid: "timer-reject-1" },
    });
    source.running = true;
    source.schedulePendingDrain();
    setTimeout(async () => {
      await source.stop();
      process.stdout.write(JSON.stringify({
        pending: source.pendingEvents.size,
        seenIds: source.state.seenIds,
        errors,
      }));
    }, 1_250);
  `;

  const child = spawnSync(process.execPath, ["--unhandled-rejections=strict", "-e", script], {
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(child.signal, null);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.pending, 1);
  assert.deepEqual(observed.seenIds, []);
  assert.equal(observed.errors.length, 1);
  assert.match(observed.errors[0], /WeFlow pending retry failed: fixture timer drain failure/);
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

test("Cyberboss consumes a ledger-owned outgoing WeFlow row without creating another turn", async () => {
  const classified = [];
  let routed = false;
  const appLike = {
    config: {
      stateDir: createTempDir(),
      weflowInboxChat: "wxid_main",
    },
    weflowMessageLedger: {
      async classifyObservedOutgoing(payload) {
        classified.push(payload);
        return { origin: "cyberboss", matchedBy: "localId" };
      },
    },
    resolveWeFlowInboxReplyTarget() {
      throw new Error("owned outbound must be consumed before resolving a reply target");
    },
    async handlePreparedMessage() {
      routed = true;
    },
  };
  const accepted = await CyberbossApp.prototype.handleWeFlowInboxMessage.call(
    appLike,
    normalizeWeFlowMessage(detail({
      localId: 73,
      serverId: "outgoing-73",
      isSend: 1,
      content: "处理中",
      parsedContent: "处理中",
    })),
    { chat: "yourself", chatUsername: "wxid_main" }
  );
  assert.equal(accepted, true);
  assert.equal(routed, false);
  assert.equal(classified.length, 1);
  assert.equal(classified[0].talker, "wxid_main");
  assert.equal(classified[0].localId, 73);
  assert.equal(classified[0].text, "处理中");
  assert.equal(classified[0].direction, "outgoing");
});

test("Cyberboss consumes a ledger-owned incoming bot echo without starting a feedback turn", async () => {
  let routed = 0;
  const appLike = {
    config: {
      stateDir: createTempDir(),
      weflowInboxChat: "wxid_main",
    },
    weflowMessageLedger: {
      async classifyObservedOutgoing(payload) {
        assert.equal(payload.talker, "wxid_main");
        assert.equal(payload.text, "bot 最终回复");
        assert.equal(payload.direction, "incoming");
        return { origin: "cyberboss", matchedBy: "content_hash_fifo" };
      },
    },
    resolveWeFlowInboxReplyTarget() {
      throw new Error("native bot echo must be consumed before reply routing");
    },
    async handlePreparedMessage() {
      routed += 1;
    },
  };

  const accepted = await CyberbossApp.prototype.handleWeFlowInboxMessage.call(
    appLike,
    normalizeWeFlowMessage(detail({
      localId: 74,
      serverId: "incoming-bot-74",
      isSend: 0,
      content: "bot 最终回复",
      parsedContent: "bot 最终回复",
    })),
    { chat: "yourself", chatUsername: "wxid_main" }
  );

  assert.equal(accepted, true);
  assert.equal(routed, 0);
});

test("Cyberboss routes an unmatched same-account outgoing row as a manual control input", async () => {
  const received = [];
  const appLike = {
    activeAccountId: "account-1",
    config: {
      stateDir: createTempDir(),
      workspaceId: "default",
      weflowInboxChat: "wxid_main",
      weflowInboxDisplayName: "yourself",
    },
    weflowMessageLedger: {
      async classifyObservedOutgoing() {
        return { origin: "self_manual", matchedBy: "none" };
      },
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
    normalizeWeFlowMessage(detail({
      localId: 74,
      serverId: "manual-74",
      isSend: 1,
      content: "从手机继续处理这个任务",
      parsedContent: "从手机继续处理这个任务",
    })),
    { chat: "yourself", chatUsername: "wxid_main" }
  );
  assert.equal(accepted, true);
  assert.equal(received.length, 1);
  assert.equal(received[0].provider, "weflow-uia");
  assert.match(received[0].text, /同号人工控制输入/);
  assert.match(received[0].text, /从手机继续处理这个任务/);
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
