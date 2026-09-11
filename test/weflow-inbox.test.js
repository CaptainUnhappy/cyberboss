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
  assert.equal(source.pendingRetryAttempt, 0);
  assert.equal(source.pendingEvents.get("message.new:42").retryAttempt, 1);
  assert.ok(Date.parse(source.pendingEvents.get("message.new:42").retryNotBefore) > Date.now());
  accepted = true;
  assert.equal((await source.drainPendingEvents()).status, "waiting_for_pending_retry");
  assert.equal(attempts, 1);
  source.pendingEvents.get("message.new:42").retryNotBefore = "";
  assert.equal((await source.drainPendingEvents()).processed, 1);
  assert.equal(attempts, 2);
  assert.match(fs.readFileSync(cursorFile, "utf8"), /message\.new:42/);
  assert.equal((await source.handleSseEvent({
    event: "message.new",
    data: { sessionId: "wxid_main", rawid: "42" },
  })).status, "duplicate");
});

test("WeFlow persists, retries, restores, and deduplicates revoke activity without fetching message details", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const observedAtMs = 1_800_100_000_000;
  let nowMs = observedAtMs;
  let fetchCalls = 0;
  let messageCalls = 0;
  let acceptActivity = false;
  const firstActivities = [];
  const rawPayload = {
    sessionId: "wxid_main",
    rawid: "revoked-42",
    timestamp: 1_800_099_999,
    custom: { reason: "fixture", values: [1, "two"] },
  };
  const event = { event: "message.revoke", data: rawPayload };
  const config = {
    weflowInboxChat: "wxid_main",
    weflowInboxCursorFile: cursorFile,
  };
  const first = new WeFlowInboxSource({
    config,
    now: () => nowMs,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("revoke must not fetch message details");
    },
    onMessage: async () => {
      messageCalls += 1;
      return true;
    },
    onActivity: async (activity, snapshot) => {
      firstActivities.push({ activity, snapshot });
      return acceptActivity;
    },
  });

  const deferred = await first.handleSseEvent(event);
  assert.equal(deferred.status, "deferred");
  assert.equal(deferred.processed, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(messageCalls, 0);
  assert.deepEqual(first.state.seenIds, []);
  assert.equal(firstActivities.length, 1);
  assert.deepEqual(firstActivities[0], {
    activity: {
      kind: "revoke",
      eventType: "message.revoke",
      revokedMessageId: "revoked-42",
      receivedAt: new Date(observedAtMs).toISOString(),
      pushTimestamp: rawPayload.timestamp,
    },
    snapshot: {
      chat: "",
      chatUsername: "wxid_main",
      messages: [],
      failures: [],
    },
  });

  const persistedWhileDeferred = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.deepEqual(persistedWhileDeferred.seenIds, []);
  assert.equal(persistedWhileDeferred.pendingEvents.length, 1);
  assert.equal(persistedWhileDeferred.pendingEvents[0].key, "message.revoke:revoked-42");
  assert.equal(persistedWhileDeferred.pendingEvents[0].eventType, "message.revoke");
  assert.deepEqual(persistedWhileDeferred.pendingEvents[0].push, rawPayload);
  assert.equal(
    persistedWhileDeferred.pendingEvents[0].receivedAt,
    new Date(observedAtMs).toISOString()
  );
  const originalRetryNotBefore = persistedWhileDeferred.pendingEvents[0].retryNotBefore;

  nowMs += 30_000;
  assert.equal((await first.handleSseEvent(event)).status, "duplicate");
  assert.equal(firstActivities.length, 1);
  const persistedAfterDuplicate = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.equal(persistedAfterDuplicate.pendingEvents[0].receivedAt, new Date(observedAtMs).toISOString());
  assert.equal(persistedAfterDuplicate.pendingEvents[0].retryNotBefore, originalRetryNotBefore);

  const restoredActivities = [];
  acceptActivity = true;
  nowMs = Date.parse(originalRetryNotBefore) + 1;
  const restarted = new WeFlowInboxSource({
    config,
    now: () => nowMs,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("restored revoke must not fetch message details");
    },
    onMessage: async () => {
      messageCalls += 1;
      return true;
    },
    onActivity: async (activity, snapshot) => {
      restoredActivities.push({ activity, snapshot });
      return acceptActivity;
    },
  });
  assert.equal(restarted.pendingEvents.size, 1);
  assert.deepEqual(restarted.pendingEvents.get("message.revoke:revoked-42").push, rawPayload);
  assert.equal(
    restarted.pendingEvents.get("message.revoke:revoked-42").receivedAt,
    new Date(observedAtMs).toISOString()
  );

  const recovered = await restarted.drainPendingEvents();
  assert.equal(recovered.status, "ok");
  assert.equal(recovered.processed, 1);
  assert.equal(restoredActivities.length, 1);
  assert.equal(restoredActivities[0].activity.receivedAt, new Date(observedAtMs).toISOString());
  assert.equal(fetchCalls, 0);
  assert.equal(messageCalls, 0);
  const persistedAfterAccept = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.deepEqual(persistedAfterAccept.pendingEvents, []);
  assert.deepEqual(persistedAfterAccept.seenIds, [
    "message.new:revoked-42",
    "message.revoke:revoked-42",
  ]);
  assert.equal((await restarted.handleSseEvent(event)).status, "duplicate");
  assert.equal(restoredActivities.length, 1);
});

test("WeFlow durably tombstones message.new when its accepted revoke arrives first", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const config = { weflowInboxChat: "wxid_main", weflowInboxCursorFile: cursorFile };
  let messageCalls = 0;
  let fetchCalls = 0;
  const createSource = () => new WeFlowInboxSource({
    config,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("a recalled message.new must not resolve details");
    },
    onMessage: async () => {
      messageCalls += 1;
      return true;
    },
    onActivity: async () => true,
  });

  const first = createSource();
  const recalled = await first.handleSseEvent({
    event: "message.revoke",
    data: { sessionId: "wxid_main", rawid: "revoke-before-new" },
  });
  assert.equal(recalled.status, "ok");
  assert.equal(recalled.processed, 1);
  assert.deepEqual(new Set(first.state.seenIds), new Set([
    "message.new:revoke-before-new",
    "message.revoke:revoke-before-new",
  ]));

  const restarted = createSource();
  assert.equal(restarted.eventTombstones.has("message.new:revoke-before-new"), true);
  assert.equal(restarted.eventTombstones.has("message.revoke:revoke-before-new"), true);
  const delayedNew = await restarted.handleSseEvent({
    event: "message.new",
    data: { sessionId: "wxid_main", rawid: "revoke-before-new" },
  });
  assert.equal(delayedNew.status, "duplicate");
  assert.equal(messageCalls, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(restarted.pendingEvents.size, 0);
});

test("WeFlow revoke cancels every pending participant in locked and awaiting pairings", async (t) => {
  const cases = [
    {
      name: "locked group recalled by companion id",
      ownerId: "pending-locked-prompt",
      companionId: "pending-locked-image",
      revokedId: "pending-locked-image",
      pairingStatus: "locked",
    },
    {
      name: "awaiting group recalled by anchor id",
      ownerId: "pending-awaiting-prompt",
      companionId: "",
      revokedId: "pending-awaiting-prompt",
      pairingStatus: "awaiting_companion",
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const dir = createTempDir();
      const cursorFile = path.join(dir, "cursor.json");
      const nowMs = 1_800_300_000_000;
      const ownerKey = `message.new:${fixture.ownerId}`;
      const companionKey = fixture.companionId
        ? `message.new:${fixture.companionId}`
        : "";
      let messageCalls = 0;
      const source = new WeFlowInboxSource({
        config: { weflowInboxChat: "wxid_main", weflowInboxCursorFile: cursorFile },
        now: () => nowMs,
        onMessage: async () => {
          messageCalls += 1;
          return true;
        },
        onActivity: async () => true,
      });
      const retryNotBefore = new Date(nowMs + 60_000).toISOString();
      source.pendingEvents.set(ownerKey, {
        eventType: "message.new",
        push: { sessionId: "wxid_main", rawid: fixture.ownerId },
        pairing: {
          status: fixture.pairingStatus,
          anchorKey: ownerKey,
          ...(fixture.pairingStatus === "awaiting_companion"
            ? { observationDeadline: new Date(nowMs + 15_000).toISOString() }
            : {}),
        },
        companionKeys: companionKey ? [companionKey] : [],
        retryNotBefore,
      });
      if (companionKey) {
        source.pendingEvents.set(companionKey, {
          eventType: "message.new",
          push: { sessionId: "wxid_main", rawid: fixture.companionId },
          retryNotBefore,
        });
      }
      source.syncPendingState();
      await source.saveState();

      const result = await source.handleSseEvent({
        event: "message.revoke",
        data: { sessionId: "wxid_main", rawid: fixture.revokedId },
      });
      assert.equal(result.status, "waiting_for_pending_retry");
      assert.equal(result.processed, 1);
      assert.equal(messageCalls, 0);
      assert.equal(source.pendingEvents.has(ownerKey), false);
      if (companionKey) {
        assert.equal(source.pendingEvents.has(companionKey), false);
      }
      for (const canceledKey of [ownerKey, companionKey].filter(Boolean)) {
        assert.equal(source.eventTombstones.has(canceledKey), true);
        assert.equal((await source.handleSseEvent({
          event: "message.new",
          data: { sessionId: "wxid_main", rawid: canceledKey.slice("message.new:".length) },
        })).status, "duplicate");
      }
      assert.equal(messageCalls, 0);
      assert.deepEqual(JSON.parse(fs.readFileSync(cursorFile, "utf8")).pendingEvents, []);
    });
  }
});

test("WeFlow rolls back revoke acknowledgement when its atomic cursor save fails", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const source = new WeFlowInboxSource({
    config: { weflowInboxChat: "wxid_main", weflowInboxCursorFile: cursorFile },
    now: () => 1_800_200_000_000,
    onActivity: async () => true,
  });
  const saveState = source.saveState.bind(source);
  let injected = false;
  source.saveState = async () => {
    if (!injected && source.state.seenIds.includes("message.revoke:atomic-revoke")) {
      injected = true;
      throw new Error("fixture revoke acknowledgement save failed");
    }
    return saveState();
  };

  await assert.rejects(source.handleSseEvent({
    event: "message.revoke",
    data: { sessionId: "wxid_main", rawid: "atomic-revoke", marker: "keep-raw" },
  }), /fixture revoke acknowledgement save failed/);
  assert.equal(injected, true);
  assert.deepEqual(source.state.seenIds, []);
  assert.equal(source.pendingEvents.size, 1);
  assert.deepEqual(
    source.pendingEvents.get("message.revoke:atomic-revoke").push,
    { sessionId: "wxid_main", rawid: "atomic-revoke", marker: "keep-raw" }
  );
  const persisted = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.deepEqual(persisted.seenIds, []);
  assert.equal(persisted.pendingEvents[0].key, "message.revoke:atomic-revoke");
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

test("WeFlow SSE locks the 23:04 exact leading explanation and trailing image before one callback", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const firstImage = createMediaFile(dir, "explain-1.jpg", "image-one");
  const createTime = 1_787_756_680;
  const rows = [
    detail({
      talker: "wxid_main",
      serverId: "explain-prompt",
      localId: 298,
      createTime,
      isSend: 0,
      senderUsername: "ACCOUNT",
      content: "解释",
      parsedContent: "解释",
      rawContent: "解释",
    }),
    detail({
      talker: "wxid_main",
      serverId: "explain-image-1",
      localId: 299,
      localType: 3,
      createTime,
      isSend: 0,
      senderUsername: "ACCOUNT",
      content: "[图片]",
      parsedContent: "[图片]",
      mediaType: "image",
      mediaLocalPath: firstImage,
    }),
  ];
  const delivered = [];
  let lockedAtCallback = null;
  const source = new WeFlowInboxSource({
    config: {
      weflowInboxChat: "wxid_main",
      weflowInboxCursorFile: cursorFile,
    },
    fetchImpl: async () => ({
      ok: true,
      async json() { return { messages: rows }; },
    }),
    onMessage: async (message) => {
      lockedAtCallback = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
      delivered.push(message);
      return true;
    },
  });

  const result = await source.handleSseEvent({
    event: "message.new",
    data: {
      sessionId: "wxid_main",
      rawid: "explain-prompt",
      localId: 298,
      timestamp: createTime,
      isSend: 0,
      senderUsername: "ACCOUNT",
      content: "解释",
    },
  });

  assert.equal(result.status, "ok");
  assert.equal(result.processed, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, "explain-prompt");
  assert.equal(delivered[0].text, "解释");
  assert.equal(delivered[0].kind, "text");
  assert.equal(delivered[0].direction, "incoming");
  assert.deepEqual(delivered[0].attachments.map((item) => item.path), [firstImage]);
  assert.deepEqual(delivered[0].attachments.map((item) => item.attachmentRef), [
    "weflow:explain-prompt:direct:1",
  ]);
  assert.equal(lockedAtCallback.version, 3);
  assert.deepEqual(lockedAtCallback.pendingEvents[0].companionKeys, [
    "message.new:explain-image-1",
  ]);
  assert.deepEqual(lockedAtCallback.pendingEvents[0].pairing, {
    status: "locked",
    anchorKey: "message.new:explain-prompt",
  });
  assert.deepEqual(source.state.seenIds, [
    "message.new:explain-prompt",
    "message.new:explain-image-1",
  ]);
  assert.equal(source.pendingEvents.size, 0);
  assert.equal((await source.handleSseEvent({
    event: "message.new",
    data: { sessionId: "wxid_main", rawid: "explain-image-1" },
  })).status, "duplicate");
});

test("WeFlow pairs a '什么意思' prompt with its immediately trailing image across one timestamp tick", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const imagePath = createMediaFile(dir, "meaning-image.jpg", "meaning-image");
  const createTime = 1_788_305_910;
  const prompt = detail({
    talker: "wxid_main",
    serverId: "meaning-prompt",
    localId: 365,
    createTime,
    isSend: 0,
    senderUsername: "ACCOUNT",
    content: "什么意思",
    parsedContent: "什么意思",
    rawContent: "什么意思",
  });
  const image = detail({
    talker: "wxid_main",
    serverId: "meaning-image",
    localId: 366,
    localType: 3,
    createTime: createTime + 1,
    isSend: 0,
    senderUsername: "ACCOUNT",
    content: "[图片]",
    parsedContent: "[图片]",
    mediaType: "image",
    mediaLocalPath: imagePath,
  });
  const delivered = [];
  const source = new WeFlowInboxSource({
    config: {
      weflowInboxChat: "wxid_main",
      weflowInboxCursorFile: cursorFile,
    },
    fetchImpl: async () => ({
      ok: true,
      async json() { return { messages: [prompt, image] }; },
    }),
    onMessage: async (message) => {
      delivered.push(message);
      return true;
    },
  });

  const result = await source.handleSseEvent({
    event: "message.new",
    data: {
      sessionId: "wxid_main",
      rawid: prompt.serverId,
      localId: prompt.localId,
      timestamp: createTime,
      isSend: 0,
      senderUsername: "ACCOUNT",
      content: "什么意思",
    },
  });

  assert.equal(result.status, "ok");
  assert.equal(result.processed, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, prompt.serverId);
  assert.equal(delivered[0].text, "什么意思");
  assert.deepEqual(delivered[0].attachments.map((item) => item.path), [imagePath]);
  assert.deepEqual(source.state.seenIds, [
    "message.new:meaning-prompt",
    "message.new:meaning-image",
  ]);
  assert.equal((await source.handleSseEvent({
    event: "message.new",
    data: { sessionId: "wxid_main", rawid: image.serverId },
  })).status, "duplicate");
  assert.equal(delivered.length, 1);
});

test("WeFlow pairs an explicit '图中有什么' with its adjacent image after a four-second desktop send", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const imagePath = createMediaFile(dir, "current-379.jpg", "current-image-379");
  const createTime = 1_788_334_693;
  const prompt = detail({
    talker: "wxid_main",
    serverId: "current-prompt-386",
    localId: 386,
    createTime,
    isSend: 0,
    senderUsername: "ACCOUNT",
    content: "图中有什么",
    parsedContent: "图中有什么",
    rawContent: "图中有什么",
  });
  const image = detail({
    talker: "wxid_main",
    serverId: "current-image-387",
    localId: 387,
    localType: 3,
    createTime: createTime + 4,
    isSend: 0,
    senderUsername: "ACCOUNT",
    content: "[图片]",
    parsedContent: "[图片]",
    mediaType: "image",
    mediaLocalPath: imagePath,
  });
  const delivered = [];
  const source = new WeFlowInboxSource({
    config: { weflowInboxChat: "wxid_main", weflowInboxCursorFile: cursorFile },
    fetchImpl: async () => ({
      ok: true,
      async json() { return { messages: [prompt, image] }; },
    }),
    onMessage: async (message) => {
      delivered.push(message);
      return true;
    },
  });

  const result = await source.handleSseEvent({
    event: "message.new",
    data: {
      sessionId: "wxid_main",
      rawid: prompt.serverId,
      localId: prompt.localId,
      timestamp: prompt.createTime,
      isSend: prompt.isSend,
      senderUsername: prompt.senderUsername,
      content: prompt.content,
    },
  });

  assert.equal(result.status, "ok");
  assert.equal(result.processed, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, prompt.serverId);
  assert.equal(delivered[0].text, "图中有什么");
  assert.equal(delivered[0].receivedAt, new Date((createTime + 4) * 1_000).toISOString());
  assert.deepEqual(delivered[0].attachments.map((item) => item.path), [imagePath]);
  assert.deepEqual(delivered[0].sourceMessageIds, [
    "weflow:current-prompt-386",
    "weflow:current-image-387",
  ]);
  assert.deepEqual(source.state.seenIds, [
    "message.new:current-prompt-386",
    "message.new:current-image-387",
  ]);
  assert.equal((await source.handleSseEvent({
    event: "message.new",
    data: { sessionId: "wxid_main", rawid: image.serverId },
  })).status, "duplicate");
  assert.equal(delivered.length, 1);
});

test("WeFlow structurally pairs a non-lexical short caption when REST already shows the image and its event arrives first", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const imagePath = createMediaFile(dir, "outgoing-explain-image.jpg", "outgoing-explain-image");
  const createTime = 1_788_318_133;
  const prompt = detail({
    talker: "wxid_main",
    serverId: "outgoing-explain-prompt",
    localId: 373,
    createTime,
    isSend: 1,
    senderUsername: "wxid_self",
    content: "看看这个细节",
    parsedContent: "看看这个细节",
    rawContent: "看看这个细节",
  });
  const image = detail({
    talker: "wxid_main",
    serverId: "outgoing-explain-image",
    localId: 374,
    localType: 3,
    createTime: createTime + 1,
    isSend: 1,
    senderUsername: "wxid_self",
    content: "[图片]",
    parsedContent: "[图片]",
    mediaType: "image",
    mediaLocalPath: imagePath,
  });
  const delivered = [];
  const source = new WeFlowInboxSource({
    config: { weflowInboxChat: "wxid_main", weflowInboxCursorFile: cursorFile },
    fetchImpl: async () => ({
      ok: true,
      async json() { return { messages: [prompt, image] }; },
    }),
    onMessage: async (message) => {
      delivered.push(message);
      return true;
    },
  });

  const result = await source.handleSseEvent({
    event: "message.new",
    data: {
      sessionId: "wxid_main",
      rawid: image.serverId,
      localId: image.localId,
      localType: image.localType,
      timestamp: image.createTime,
      isSend: image.isSend,
      senderUsername: image.senderUsername,
      content: image.content,
    },
  });

  assert.equal(result.status, "ok");
  assert.equal(result.processed, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, prompt.serverId);
  assert.equal(delivered[0].text, "看看这个细节");
  assert.deepEqual(delivered[0].attachments.map((item) => item.path), [imagePath]);
  assert.deepEqual(source.state.seenIds, [
    "message.new:outgoing-explain-prompt",
    "message.new:outgoing-explain-image",
  ]);
  assert.deepEqual(source.state.pendingEvents, []);
});

test("WeFlow keeps observing '图中有什么' and pairs an image that appears in REST after six seconds", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const imagePath = createMediaFile(dir, "six-second-image.jpg", "six-second-image");
  const createTime = 1_800_000_100;
  let nowMs = createTime * 1_000;
  const prompt = detail({
    talker: "wxid_main",
    serverId: "six-second-prompt",
    localId: 100,
    createTime,
    isSend: 0,
    senderUsername: "ACCOUNT",
    content: "图中有什么",
    parsedContent: "图中有什么",
    rawContent: "图中有什么",
  });
  const image = detail({
    talker: "wxid_main",
    serverId: "six-second-image",
    localId: 101,
    localType: 3,
    createTime,
    isSend: 0,
    senderUsername: "ACCOUNT",
    content: "[图片]",
    parsedContent: "[图片]",
    mediaType: "image",
    mediaLocalPath: imagePath,
  });
  let visibleRows = [prompt];
  const delivered = [];
  const source = new WeFlowInboxSource({
    config: { weflowInboxChat: "wxid_main", weflowInboxCursorFile: cursorFile },
    now: () => nowMs,
    fetchImpl: async () => ({
      ok: true,
      async json() { return { messages: visibleRows }; },
    }),
    onMessage: async (message) => {
      delivered.push(message);
      return true;
    },
  });

  const first = await source.handleSseEvent({
    event: "message.new",
    data: {
      sessionId: "wxid_main",
      rawid: prompt.serverId,
      localId: prompt.localId,
      timestamp: createTime,
      isSend: 0,
      senderUsername: "ACCOUNT",
      content: "图中有什么",
    },
  });
  assert.equal(first.status, "waiting_for_companion");
  assert.equal(delivered.length, 0);
  let persisted = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  const deadline = new Date(nowMs + 15_000).toISOString();
  assert.deepEqual(persisted.pendingEvents[0].pairing, {
    status: "awaiting_companion",
    anchorKey: "message.new:six-second-prompt",
    observationDeadline: deadline,
  });

  nowMs += 6_000;
  visibleRows = [prompt, image];
  source.pendingRetryNotBeforeMs = 0;
  const paired = await source.drainPendingEvents();
  assert.equal(paired.status, "ok");
  assert.equal(paired.processed, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, prompt.serverId);
  assert.deepEqual(delivered[0].attachments.map((item) => item.path), [imagePath]);
  assert.deepEqual(source.state.seenIds, [
    "message.new:six-second-prompt",
    "message.new:six-second-image",
  ]);
  persisted = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.deepEqual(persisted.pendingEvents, []);
});

test("WeFlow delivers a standalone explanation once when its observation window expires", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const createTime = 1_800_000_120;
  let nowMs = createTime * 1_000;
  const prompt = detail({
    talker: "wxid_main",
    serverId: "expired-observation-prompt",
    localId: 120,
    createTime,
    isSend: 0,
    senderUsername: "ACCOUNT",
    content: "解释",
    parsedContent: "解释",
    rawContent: "解释",
  });
  let fetchCalls = 0;
  const delivered = [];
  const source = new WeFlowInboxSource({
    config: { weflowInboxChat: "wxid_main", weflowInboxCursorFile: cursorFile },
    now: () => nowMs,
    fetchImpl: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        async json() { return { messages: [prompt] }; },
      };
    },
    onMessage: async (message) => {
      delivered.push(message);
      return true;
    },
  });
  const event = {
    event: "message.new",
    data: {
      sessionId: "wxid_main",
      rawid: prompt.serverId,
      localId: prompt.localId,
      timestamp: createTime,
      isSend: 0,
      senderUsername: "ACCOUNT",
      content: "解释",
    },
  };

  const waiting = await source.handleSseEvent(event);
  assert.equal(waiting.status, "waiting_for_companion");
  assert.equal(fetchCalls, 4);
  const persistedWhileWaiting = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  const deadline = persistedWhileWaiting.pendingEvents[0].pairing.observationDeadline;
  assert.equal(deadline, new Date(nowMs + 15_000).toISOString());

  nowMs = Date.parse(deadline);
  source.pendingRetryNotBeforeMs = 0;
  const completed = await source.drainPendingEvents();
  assert.equal(completed.status, "ok");
  assert.equal(completed.processed, 1);
  assert.equal(fetchCalls, 5);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, prompt.serverId);
  assert.equal(delivered[0].text, "解释");
  assert.deepEqual(delivered[0].attachments, []);
  assert.equal((await source.handleSseEvent(event)).status, "duplicate");
  assert.equal(delivered.length, 1);
  const persistedAfterExpiry = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.deepEqual(persistedAfterExpiry.pendingEvents, []);
  assert.deepEqual(persistedAfterExpiry.seenIds, ["message.new:expired-observation-prompt"]);
});

test("WeFlow restart preserves an unfinished companion observation deadline", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const createTime = 1_800_000_140;
  let nowMs = createTime * 1_000;
  const prompt = detail({
    talker: "wxid_main",
    serverId: "restart-observation-prompt",
    localId: 140,
    createTime,
    isSend: 0,
    senderUsername: "ACCOUNT",
    content: "解释",
    parsedContent: "解释",
    rawContent: "解释",
  });
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      async json() { return { messages: [prompt] }; },
    };
  };
  const config = { weflowInboxChat: "wxid_main", weflowInboxCursorFile: cursorFile };
  const first = new WeFlowInboxSource({
    config,
    now: () => nowMs,
    fetchImpl,
    onMessage: async () => true,
  });
  const waiting = await first.handleSseEvent({
    event: "message.new",
    data: {
      sessionId: "wxid_main",
      rawid: prompt.serverId,
      localId: prompt.localId,
      timestamp: createTime,
      isSend: 0,
      senderUsername: "ACCOUNT",
      content: "解释",
    },
  });
  assert.equal(waiting.status, "waiting_for_companion");
  const deadline = JSON.parse(fs.readFileSync(cursorFile, "utf8"))
    .pendingEvents[0].pairing.observationDeadline;

  nowMs += 5_000;
  const restarted = new WeFlowInboxSource({
    config,
    now: () => nowMs,
    fetchImpl,
    onMessage: async () => true,
  });
  assert.equal(restarted.pendingEvents.size, 1);
  assert.deepEqual(restarted.pendingEvents.get("message.new:restart-observation-prompt").pairing, {
    status: "awaiting_companion",
    anchorKey: "message.new:restart-observation-prompt",
    observationDeadline: deadline,
  });
  const retried = await restarted.drainPendingEvents();
  assert.equal(retried.status, "waiting_for_companion");
  assert.equal(fetchCalls, 5);
  const persistedAfterRestart = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.equal(persistedAfterRestart.pendingEvents[0].pairing.observationDeadline, deadline);
  assert.equal(persistedAfterRestart.seenIds.length, 0);
});

test("WeFlow does not apply the companion observation window to a quoted image prompt", async () => {
  const dir = createTempDir();
  const quotedImagePath = createMediaFile(dir, "quoted-observation-guard.jpg", "quoted-image");
  const createTime = 1_800_000_160;
  const quotedImage = detail({
    talker: "wxid_main",
    serverId: "quoted-observation-image",
    localId: 159,
    localType: 3,
    createTime: createTime - 1,
    isSend: 0,
    senderUsername: "ACCOUNT",
    content: "[图片]",
    parsedContent: "[图片]",
    mediaType: "image",
    mediaLocalPath: quotedImagePath,
  });
  const reply = detail({
    talker: "wxid_main",
    serverId: "quoted-observation-reply",
    localId: 160,
    createTime,
    isSend: 0,
    senderUsername: "ACCOUNT",
    content: "解释",
    parsedContent: "解释",
    rawContent: "<msg><appmsg><title>解释</title><type>57</type></appmsg></msg>",
    replyToMessageId: quotedImage.serverId,
    quote: {
      platformMessageId: quotedImage.serverId,
      accountName: "yourself",
      content: "[图片]",
    },
  });
  let fetchCalls = 0;
  const delivered = [];
  const source = new WeFlowInboxSource({
    config: { weflowInboxChat: "wxid_main" },
    fetchImpl: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        async json() { return { messages: [quotedImage, reply] }; },
      };
    },
    onMessage: async (message) => {
      delivered.push(message);
      return true;
    },
  });

  const result = await source.handleSseEvent({
    event: "message.new",
    data: {
      sessionId: "wxid_main",
      rawid: reply.serverId,
      localId: reply.localId,
      timestamp: createTime,
      isSend: 0,
      senderUsername: "ACCOUNT",
      content: "解释",
      replyToMessageId: quotedImage.serverId,
    },
  });
  assert.equal(result.status, "ok");
  assert.equal(fetchCalls, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, reply.serverId);
  assert.deepEqual(delivered[0].attachments.map((item) => item.path), [quotedImagePath]);
  assert.equal(source.pendingEvents.size, 0);
});

test("WeFlow poll pairs at most ten consecutive direct images and leaves the eleventh standalone", async () => {
  const dir = createTempDir();
  const nowSeconds = 1_800_000_200;
  const prompt = detail({
    talker: "wxid_main",
    serverId: "poll-prompt",
    localId: 200,
    createTime: nowSeconds - 1,
    isSend: 1,
    senderUsername: "wxid_self",
    content: "请解释一下这些图片",
    parsedContent: "请解释一下这些图片",
    rawContent: "请解释一下这些图片",
  });
  const images = Array.from({ length: 11 }, (_value, index) => detail({
    talker: "wxid_main",
    serverId: `poll-image-${index + 1}`,
    localId: 201 + index,
    localType: 3,
    createTime: nowSeconds - 1,
    isSend: 1,
    senderUsername: "wxid_self",
    content: "[图片]",
    parsedContent: "[图片]",
    mediaType: "image",
    mediaLocalPath: createMediaFile(dir, `poll-image-${index + 1}.jpg`, `image-${index + 1}`),
  }));
  const rows = [prompt, ...images];
  const delivered = [];
  const source = new WeFlowInboxSource({
    config: {
      weflowInboxChat: "wxid_main",
      weflowOutgoingReplayWindowMs: 10_000,
    },
    now: () => nowSeconds * 1_000,
    fetchImpl: async () => ({
      ok: true,
      async json() { return { messages: rows, hasMore: false }; },
    }),
    onMessage: async (message) => {
      delivered.push(message);
      return true;
    },
  });

  const result = await source.pollOutgoingMessagesOnce();
  assert.equal(result.queued, 12);
  assert.equal(result.processed, 2);
  assert.equal(delivered.length, 2);
  assert.equal(delivered[0].id, "poll-prompt");
  assert.equal(delivered[0].attachments.length, 10);
  assert.equal(delivered[1].id, "poll-image-11");
  assert.equal(delivered[1].attachments.length, 1);
  assert.equal(source.pendingEvents.size, 0);
  assert.equal(source.state.seenIds.length, 12);
});

test("WeFlow keeps an explanation pending until its paired image media is usable", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const imagePath = path.join(dir, "eventual-full-image.jpg");
  const createTime = 1_800_000_300;
  const rows = [
    detail({
      talker: "wxid_main",
      serverId: "media-prompt",
      localId: 300,
      createTime,
      isSend: 1,
      senderUsername: "wxid_self",
      content: "解释",
      parsedContent: "解释",
      rawContent: "解释",
    }),
    detail({
      talker: "wxid_main",
      serverId: "media-image",
      localId: 301,
      localType: 3,
      createTime,
      isSend: 1,
      senderUsername: "wxid_self",
      content: "[图片]",
      parsedContent: "[图片]",
      mediaType: "image",
      mediaLocalPath: imagePath,
    }),
  ];
  let visibleRows = rows;
  const delivered = [];
  const source = new WeFlowInboxSource({
    config: {
      weflowInboxChat: "wxid_main",
      weflowInboxCursorFile: cursorFile,
    },
    fetchImpl: async () => ({
      ok: true,
      async json() { return { messages: visibleRows }; },
    }),
    onMessage: async (message) => {
      delivered.push(message);
      return true;
    },
  });

  const waiting = await source.handleSseEvent({
    event: "message.new",
    data: {
      sessionId: "wxid_main",
      rawid: "media-prompt",
      localId: 300,
      timestamp: createTime,
      isSend: 1,
      senderUsername: "wxid_self",
      content: "解释",
    },
  });
  assert.equal(waiting.status, "waiting_for_companion_media");
  assert.equal(waiting.processed, 0);
  assert.equal(delivered.length, 0);
  assert.equal(source.pendingEvents.size, 1);
  let persisted = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.deepEqual(persisted.seenIds, []);
  assert.deepEqual(persisted.pendingEvents[0].companionKeys, ["message.new:media-image"]);
  assert.equal(persisted.pendingEvents[0].pairing.status, "locked");

  visibleRows = [rows[0]];
  source.pendingRetryNotBeforeMs = 0;
  source.pendingEvents.get("message.new:media-prompt").retryNotBefore = "";
  const temporarilyMissing = await source.drainPendingEvents();
  assert.equal(temporarilyMissing.status, "waiting_for_companion_media");
  assert.equal(temporarilyMissing.processed, 0);
  assert.equal(delivered.length, 0);
  persisted = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.deepEqual(persisted.pendingEvents[0].companionKeys, ["message.new:media-image"]);
  assert.equal(persisted.pendingEvents[0].pairing.status, "locked");

  visibleRows = rows;
  createMediaFile(dir, "eventual-full-image.jpg", "eventual-image");
  source.pendingRetryNotBeforeMs = 0;
  source.pendingEvents.get("message.new:media-prompt").retryNotBefore = "";
  const recovered = await source.drainPendingEvents();
  assert.equal(recovered.status, "ok");
  assert.equal(recovered.processed, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, "media-prompt");
  assert.equal(delivered[0].attachments[0].path, imagePath);
  persisted = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.deepEqual(persisted.pendingEvents, []);
  assert.deepEqual(persisted.seenIds, ["message.new:media-prompt", "message.new:media-image"]);
});

test("WeFlow keeps a direct image pending while its REST detail is temporarily missing", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const imagePath = createMediaFile(dir, "temporarily-missing.jpg", "full-image");
  const createTime = 1_800_000_350;
  const imageRow = detail({
    talker: "wxid_main",
    serverId: "temporarily-missing-image",
    localId: 350,
    localType: 3,
    createTime,
    isSend: 1,
    senderUsername: "wxid_self",
    content: "[图片]",
    parsedContent: "[图片]",
    mediaType: "image",
    mediaLocalPath: imagePath,
  });
  let visibleRows = [];
  let fetchCalls = 0;
  const delivered = [];
  const source = new WeFlowInboxSource({
    config: {
      weflowInboxChat: "wxid_main",
      weflowInboxCursorFile: cursorFile,
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        async json() { return { messages: visibleRows }; },
      };
    },
    onMessage: async (message) => {
      delivered.push(message);
      return true;
    },
  });

  const waiting = await source.handleSseEvent({
    event: "message.new",
    data: {
      sessionId: "wxid_main",
      rawid: "temporarily-missing-image",
      localId: 350,
      localType: 3,
      timestamp: createTime,
      isSend: 1,
      senderUsername: "wxid_self",
      content: "[图片]",
    },
  });
  assert.equal(waiting.status, "waiting_for_media");
  assert.equal(waiting.processed, 0);
  assert.equal(fetchCalls, 4);
  assert.equal(delivered.length, 0);
  assert.deepEqual(source.state.seenIds, []);
  assert.equal(source.pendingEvents.size, 1);
  assert.equal(source.pendingRetryAttempt, 0);
  assert.equal(source.pendingEvents.get("message.new:temporarily-missing-image").retryAttempt, 1);
  assert.ok(Date.parse(
    source.pendingEvents.get("message.new:temporarily-missing-image").retryNotBefore
  ) > Date.now());
  let persisted = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.deepEqual(persisted.seenIds, []);
  assert.equal("pairing" in persisted.pendingEvents[0], false);
  assert.deepEqual(persisted.pendingEvents.map((item) => item.key), [
    "message.new:temporarily-missing-image",
  ]);

  visibleRows = [imageRow];
  source.pendingRetryNotBeforeMs = 0;
  source.pendingEvents.get("message.new:temporarily-missing-image").retryNotBefore = "";
  const recovered = await source.drainPendingEvents();
  assert.equal(recovered.status, "ok");
  assert.equal(recovered.processed, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, "temporarily-missing-image");
  assert.equal(delivered[0].attachments[0].path, imagePath);
  persisted = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.deepEqual(persisted.pendingEvents, []);
  assert.deepEqual(persisted.seenIds, ["message.new:temporarily-missing-image"]);
});

test("WeFlow lets later text pass a fresh missing video and preserves its durable deadline across restart", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const nowMs = 1_800_001_000_000;
  const createTime = Math.floor(nowMs / 1_000);
  const video = detail({
    talker: "wxid_main",
    serverId: "fresh-video",
    localId: 360,
    localType: 43,
    createTime,
    isSend: 0,
    senderUsername: "wxid_sender",
    content: "[视频]",
    parsedContent: "[视频]",
    mediaType: "video",
  });
  const textRow = detail({
    talker: "wxid_main",
    serverId: "after-fresh-video",
    localId: 361,
    createTime,
    isSend: 0,
    senderUsername: "wxid_sender",
    content: "后续文字必须继续",
    parsedContent: "后续文字必须继续",
  });
  fs.writeFileSync(cursorFile, `${JSON.stringify({
    version: 3,
    seenIds: [],
    lastEventAt: "",
    pendingEvents: [video, textRow].map((row) => ({
      key: `message.new:${row.serverId}`,
      eventType: "message.new",
      push: {
        sessionId: "wxid_main",
        rawid: row.serverId,
        localId: row.localId,
        localType: row.localType,
        timestamp: row.createTime,
        isSend: row.isSend,
        senderUsername: row.senderUsername,
        content: row.content,
      },
    })),
  })}\n`, "utf8");
  const delivered = [];
  const config = { weflowInboxChat: "wxid_main", weflowInboxCursorFile: cursorFile };
  const fetchImpl = async () => ({
    ok: true,
    async json() { return { messages: [video, textRow] }; },
  });
  const source = new WeFlowInboxSource({
    config,
    now: () => nowMs,
    fetchImpl,
    onMessage: async (message) => {
      delivered.push(message);
      return true;
    },
  });

  const waiting = await source.drainPendingEvents();
  assert.equal(waiting.status, "waiting_for_media");
  assert.equal(waiting.processed, 1);
  assert.equal(waiting.perEventWaiting, true);
  assert.deepEqual(delivered.map((message) => message.id), ["after-fresh-video"]);
  assert.deepEqual([...source.pendingEvents.keys()], ["message.new:fresh-video"]);
  const pending = source.pendingEvents.get("message.new:fresh-video");
  assert.equal(pending.mediaDeadline, new Date(nowMs + 60_000).toISOString());
  assert.equal(pending.retryAttempt, 1);
  assert.equal(pending.retryNotBefore, new Date(nowMs + 1_000).toISOString());

  const restarted = new WeFlowInboxSource({ config, now: () => nowMs, fetchImpl });
  const restored = restarted.pendingEvents.get("message.new:fresh-video");
  assert.equal(restored.mediaDeadline, pending.mediaDeadline);
  assert.equal(restored.retryAttempt, pending.retryAttempt);
  assert.equal(restored.retryNotBefore, pending.retryNotBefore);
  assert.deepEqual(restarted.state.seenIds, ["message.new:after-fresh-video"]);
});

test("WeFlow quarantines two expired videos once and delivers the following text in the same drain", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const nowMs = 1_800_010_000_000;
  const oldCreateTime = Math.floor(nowMs / 1_000) - (24 * 60 * 60);
  const currentCreateTime = Math.floor(nowMs / 1_000);
  const rows = [
    detail({
      talker: "wxid_main",
      serverId: "expired-video-305",
      localId: 305,
      localType: 43,
      createTime: oldCreateTime,
      isSend: 0,
      senderUsername: "wxid_sender",
      content: "[视频]",
      parsedContent: "[视频]",
      mediaType: "video",
    }),
    detail({
      talker: "wxid_main",
      serverId: "expired-video-306",
      localId: 306,
      localType: 43,
      createTime: oldCreateTime + 1,
      isSend: 0,
      senderUsername: "wxid_sender",
      content: "[视频]",
      parsedContent: "[视频]",
      mediaType: "video",
    }),
    detail({
      talker: "wxid_main",
      serverId: "current-text-307",
      localId: 307,
      createTime: currentCreateTime,
      isSend: 0,
      senderUsername: "wxid_sender",
      content: "最新普通文字",
      parsedContent: "最新普通文字",
    }),
  ];
  fs.writeFileSync(cursorFile, `${JSON.stringify({
    version: 3,
    seenIds: [],
    lastEventAt: "",
    pendingEvents: rows.map((row) => ({
      key: `message.new:${row.serverId}`,
      eventType: "message.new",
      push: {
        sessionId: "wxid_main",
        rawid: row.serverId,
        localId: row.localId,
        localType: row.localType,
        timestamp: row.createTime,
        isSend: row.isSend,
        senderUsername: row.senderUsername,
        content: row.content,
      },
    })),
  })}\n`, "utf8");
  const delivered = [];
  const warnings = [];
  const source = new WeFlowInboxSource({
    config: { weflowInboxChat: "wxid_main", weflowInboxCursorFile: cursorFile },
    now: () => nowMs,
    fetchImpl: async () => ({
      ok: true,
      async json() { return { messages: rows }; },
    }),
    logger: { warn: (message) => warnings.push(message) },
    onMessage: async (message) => {
      delivered.push(message);
      return true;
    },
  });

  const result = await source.drainPendingEvents();
  assert.equal(result.status, "ok");
  assert.equal(result.processed, 1);
  assert.equal(result.quarantined, 2);
  assert.deepEqual(delivered.map((message) => message.id), ["current-text-307"]);
  assert.equal(source.pendingEvents.size, 0);
  assert.equal(warnings.length, 2);
  assert.deepEqual(source.state.seenIds, [
    "message.new:expired-video-305",
    "message.new:expired-video-306",
    "message.new:current-text-307",
  ]);
  assert.deepEqual(source.state.deadLetters.map((item) => item.key), [
    "message.new:expired-video-305",
    "message.new:expired-video-306",
  ]);
  assert.deepEqual(source.state.deadLetters.map((item) => item.push.localId), [305, 306]);
  assert.ok(source.state.deadLetters.every((item) => (
    item.code === "media_export_deadline_exceeded"
      && item.kind === "video"
      && item.reason.includes("60 秒")
  )));

  const persisted = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.equal(persisted.pendingEvents.length, 0);
  assert.equal(persisted.deadLetters.length, 2);
  assert.deepEqual(persisted.deadLetters.map((item) => item.push.rawid), [
    "expired-video-305",
    "expired-video-306",
  ]);
  const restarted = new WeFlowInboxSource({
    config: { weflowInboxChat: "wxid_main", weflowInboxCursorFile: cursorFile },
  });
  assert.equal(restarted.pendingEvents.size, 0);
  assert.equal(restarted.state.deadLetters.length, 2);
});

test("WeFlow reserves a pairing discovered mid-drain so its companion is not delivered separately", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const createTime = 1_800_020_000;
  const rows = [
    detail({
      talker: "wxid_main",
      serverId: "mid-drain-prompt",
      localId: 370,
      createTime,
      isSend: 0,
      senderUsername: "wxid_sender",
      content: "解释",
      parsedContent: "解释",
      rawContent: "解释",
    }),
    detail({
      talker: "wxid_main",
      serverId: "mid-drain-image",
      localId: 371,
      localType: 3,
      createTime,
      isSend: 0,
      senderUsername: "wxid_sender",
      content: "[图片]",
      parsedContent: "[图片]",
      mediaType: "image",
    }),
    detail({
      talker: "wxid_main",
      serverId: "mid-drain-text",
      localId: 372,
      createTime: createTime + 1,
      isSend: 0,
      senderUsername: "wxid_sender",
      content: "后续消息",
      parsedContent: "后续消息",
    }),
  ];
  fs.writeFileSync(cursorFile, `${JSON.stringify({
    version: 3,
    seenIds: [],
    lastEventAt: "",
    pendingEvents: rows.map((row) => ({
      key: `message.new:${row.serverId}`,
      eventType: "message.new",
      push: {
        sessionId: "wxid_main",
        rawid: row.serverId,
        localId: row.localId,
        localType: row.localType,
        timestamp: row.createTime,
        isSend: row.isSend,
        senderUsername: row.senderUsername,
        content: row.content,
      },
    })),
  })}\n`, "utf8");
  let fetchCalls = 0;
  const delivered = [];
  const source = new WeFlowInboxSource({
    config: { weflowInboxChat: "wxid_main", weflowInboxCursorFile: cursorFile },
    fetchImpl: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        async json() { return { messages: rows }; },
      };
    },
    onMessage: async (message) => {
      delivered.push(message);
      return true;
    },
  });

  const result = await source.drainPendingEvents();
  assert.equal(result.status, "waiting_for_companion_media");
  assert.equal(result.processed, 1);
  assert.equal(fetchCalls, 5);
  assert.deepEqual(delivered.map((message) => message.id), ["mid-drain-text"]);
  assert.deepEqual([...source.pendingEvents.keys()], [
    "message.new:mid-drain-prompt",
    "message.new:mid-drain-image",
  ]);
  const owner = source.pendingEvents.get("message.new:mid-drain-prompt");
  assert.equal(owner.pairing.status, "locked");
  assert.deepEqual(owner.companionKeys, ["message.new:mid-drain-image"]);
  assert.deepEqual(source.state.seenIds, ["message.new:mid-drain-text"]);
});

test("WeFlow canonicalizes a dual-owner locked v3 pairing and delivers the group once", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const imagePath = createMediaFile(dir, "canonical-pair.jpg", "image");
  const createTime = 1_800_021_000;
  const prompt = detail({
    talker: "wxid_main",
    serverId: "canonical-prompt",
    localId: 380,
    createTime,
    isSend: 0,
    senderUsername: "wxid_sender",
    content: "解释",
    parsedContent: "解释",
    rawContent: "解释",
  });
  const imageRow = detail({
    talker: "wxid_main",
    serverId: "canonical-image",
    localId: 381,
    localType: 3,
    createTime,
    isSend: 0,
    senderUsername: "wxid_sender",
    content: "[图片]",
    parsedContent: "[图片]",
    mediaType: "image",
    mediaLocalPath: imagePath,
  });
  const promptKey = "message.new:canonical-prompt";
  const imageKey = "message.new:canonical-image";
  const pairing = { status: "locked", anchorKey: promptKey };
  const pushFor = (row) => ({
    sessionId: "wxid_main",
    rawid: row.serverId,
    localId: row.localId,
    localType: row.localType,
    timestamp: row.createTime,
    isSend: row.isSend,
    senderUsername: row.senderUsername,
    content: row.content,
  });
  fs.writeFileSync(cursorFile, `${JSON.stringify({
    version: 3,
    seenIds: [],
    lastEventAt: "",
    pendingEvents: [
      { key: promptKey, eventType: "message.new", push: pushFor(prompt), pairing, companionKeys: [imageKey] },
      { key: imageKey, eventType: "message.new", push: pushFor(imageRow), pairing, companionKeys: [imageKey] },
    ],
  })}\n`, "utf8");
  const delivered = [];
  const source = new WeFlowInboxSource({
    config: { weflowInboxChat: "wxid_main", weflowInboxCursorFile: cursorFile },
    fetchImpl: async () => ({
      ok: true,
      async json() { return { messages: [prompt, imageRow] }; },
    }),
    onMessage: async (message) => {
      delivered.push(message);
      return true;
    },
  });

  const result = await source.drainPendingEvents();
  assert.equal(result.status, "ok");
  assert.equal(result.processed, 1);
  assert.deepEqual(delivered.map((message) => message.id), ["canonical-prompt"]);
  assert.deepEqual(delivered[0].attachments.map((item) => item.path), [imagePath]);
  assert.equal(source.pendingEvents.size, 0);
  assert.deepEqual(source.state.seenIds, [promptKey, imageKey]);
  const persisted = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.deepEqual(persisted.pendingEvents, []);
});

test("WeFlow migrates locked v3 groups containing seen participants without replaying attachments", async (t) => {
  const createFixture = ({ seenIds }) => {
    const dir = createTempDir();
    const cursorFile = path.join(dir, "cursor.json");
    const promptKey = "message.new:seen-pair-prompt";
    const imageKey = "message.new:seen-pair-image";
    const createTime = 1_800_022_000;
    const pendingEvents = [
      {
        key: promptKey,
        eventType: "message.new",
        push: {
          sessionId: "wxid_main",
          rawid: "seen-pair-prompt",
          localId: 390,
          timestamp: createTime,
          isSend: 0,
          senderUsername: "wxid_sender",
          content: "解释",
        },
        pairing: { status: "locked", anchorKey: promptKey },
        companionKeys: [imageKey],
      },
      {
        key: imageKey,
        eventType: "message.new",
        push: {
          sessionId: "wxid_main",
          rawid: "seen-pair-image",
          localId: 391,
          localType: 3,
          timestamp: createTime,
          isSend: 0,
          senderUsername: "wxid_sender",
          content: "[图片]",
        },
        pairing: { status: "locked", anchorKey: promptKey },
        companionKeys: [imageKey],
      },
    ];
    fs.writeFileSync(cursorFile, `${JSON.stringify({
      version: 3,
      seenIds,
      lastEventAt: "",
      pendingEvents,
    })}\n`, "utf8");
    return { cursorFile, promptKey, imageKey };
  };

  await t.test("anchor already seen clears the entire residual group", async () => {
    const fixture = createFixture({ seenIds: ["message.new:seen-pair-prompt"] });
    let fetchCalls = 0;
    const source = new WeFlowInboxSource({
      config: { weflowInboxChat: "wxid_main", weflowInboxCursorFile: fixture.cursorFile },
      fetchImpl: async () => {
        fetchCalls += 1;
        return { ok: true, async json() { return { messages: [] }; } };
      },
    });
    const result = await source.drainPendingEvents();
    assert.equal(result.processed, 0);
    assert.equal(fetchCalls, 0);
    assert.equal(source.pendingEvents.size, 0);
    assert.equal(source.state.deadLetters.length, 0);
    assert.deepEqual(source.state.seenIds, [fixture.promptKey, fixture.imageKey]);
  });

  await t.test("seen companion quarantines the partial group atomically", async () => {
    const fixture = createFixture({ seenIds: ["message.new:seen-pair-image"] });
    let fetchCalls = 0;
    const source = new WeFlowInboxSource({
      config: { weflowInboxChat: "wxid_main", weflowInboxCursorFile: fixture.cursorFile },
      fetchImpl: async () => {
        fetchCalls += 1;
        return { ok: true, async json() { return { messages: [] }; } };
      },
    });
    const result = await source.drainPendingEvents();
    assert.equal(result.processed, 0);
    assert.equal(result.quarantined, 1);
    assert.equal(fetchCalls, 0);
    assert.equal(source.pendingEvents.size, 0);
    assert.equal(source.state.deadLetters.length, 1);
    assert.equal(source.state.deadLetters[0].code, "partial_pairing_already_seen");
    assert.deepEqual(source.state.deadLetters[0].participantKeys, [fixture.promptKey, fixture.imageKey]);
    assert.deepEqual(source.state.seenIds, [fixture.promptKey, fixture.imageKey]);
  });
});

test("WeFlow reschedules an existing long pending timer when an immediate item arrives", () => {
  const source = new WeFlowInboxSource({ config: { weflowInboxChat: "wxid_main" } });
  const nowMs = Date.now();
  source.running = true;
  source.pendingEvents.set("message.new:slow", {
    eventType: "message.new",
    push: { sessionId: "wxid_main", rawid: "slow" },
    retryNotBefore: new Date(nowMs + 60_000).toISOString(),
  });
  source.schedulePendingDrain();
  const slowTimer = source.pendingTimer;
  const slowDueAtMs = source.pendingTimerDueAtMs;

  source.pendingEvents.set("message.new:immediate", {
    eventType: "message.new",
    push: { sessionId: "wxid_main", rawid: "immediate" },
  });
  source.schedulePendingDrain();
  assert.notEqual(source.pendingTimer, slowTimer);
  assert.ok(source.pendingTimerDueAtMs < slowDueAtMs);
  assert.ok(source.pendingTimerDueAtMs <= Date.now() + 500);

  clearTimeout(source.pendingTimer);
  source.pendingTimer = null;
  source.pendingTimerDueAtMs = 0;
  source.running = false;
});

test("WeFlow timer ignores a reserved pairing companion and follows the owner retry", () => {
  const source = new WeFlowInboxSource({ config: { weflowInboxChat: "wxid_main" } });
  const nowMs = Date.now();
  const ownerKey = "message.new:timer-pair-owner";
  const companionKey = "message.new:timer-pair-image";
  source.running = true;
  source.pendingEvents.set(ownerKey, {
    eventType: "message.new",
    push: { sessionId: "wxid_main", rawid: "timer-pair-owner" },
    pairing: { status: "locked", anchorKey: ownerKey },
    companionKeys: [companionKey],
    retryNotBefore: new Date(nowMs + 60_000).toISOString(),
  });
  source.pendingEvents.set(companionKey, {
    eventType: "message.new",
    push: { sessionId: "wxid_main", rawid: "timer-pair-image", localType: 3 },
  });

  source.schedulePendingDrain();
  assert.ok(source.pendingTimerDueAtMs >= nowMs + 59_000);
  assert.ok(source.pendingTimerDueAtMs <= nowMs + 60_500);
  const pairingDueAtMs = source.pendingTimerDueAtMs;

  source.pendingEvents.set("message.new:timer-unrelated", {
    eventType: "message.new",
    push: { sessionId: "wxid_main", rawid: "timer-unrelated" },
  });
  source.schedulePendingDrain();
  assert.ok(source.pendingTimerDueAtMs < pairingDueAtMs);
  assert.ok(source.pendingTimerDueAtMs <= Date.now() + 500);

  clearTimeout(source.pendingTimer);
  source.pendingTimer = null;
  source.pendingTimerDueAtMs = 0;
  source.running = false;
});

test("WeFlow persists a rejected item retry while allowing the following item through", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const delivered = [];
  const source = new WeFlowInboxSource({
    config: { weflowInboxChat: "wxid_main", weflowInboxCursorFile: cursorFile },
    onMessage: async (message) => {
      delivered.push(message.id);
      return message.id !== "deferred-first";
    },
  });
  source.resolvePushMessage = async (push) => ({
    message: normalizeWeFlowMessage(detail({ serverId: push.rawid, content: push.content, parsedContent: push.content })),
    snapshot: { chatUsername: "wxid_main" },
  });

  const first = await source.handleSseEvent({
    event: "message.new",
    data: { sessionId: "wxid_main", rawid: "deferred-first", content: "first" },
  });
  assert.equal(first.status, "deferred");
  const second = await source.handleSseEvent({
    event: "message.new",
    data: { sessionId: "wxid_main", rawid: "accepted-second", content: "second" },
  });
  assert.equal(second.status, "waiting_for_pending_retry");
  assert.equal(second.processed, 1);
  assert.deepEqual(delivered, ["deferred-first", "accepted-second"]);
  assert.deepEqual([...source.pendingEvents.keys()], ["message.new:deferred-first"]);
  assert.deepEqual(source.state.seenIds, ["message.new:accepted-second"]);
  const persisted = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.equal(persisted.pendingEvents[0].retryAttempt, 1);
  assert.ok(persisted.pendingEvents[0].retryNotBefore);
});

test("WeFlow gives a direct image a durable five-minute deadline and tombstones it once", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const createTime = 1_800_023_000;
  let nowMs = createTime * 1_000;
  const imageRow = detail({
    talker: "wxid_main",
    serverId: "deadline-image",
    localId: 395,
    localType: 3,
    createTime,
    isSend: 0,
    senderUsername: "wxid_sender",
    content: "[图片]",
    parsedContent: "[图片]",
    mediaType: "image",
  });
  const event = {
    event: "message.new",
    data: {
      sessionId: "wxid_main",
      rawid: imageRow.serverId,
      localId: imageRow.localId,
      localType: imageRow.localType,
      timestamp: imageRow.createTime,
      isSend: imageRow.isSend,
      senderUsername: imageRow.senderUsername,
      content: imageRow.content,
    },
  };
  const config = { weflowInboxChat: "wxid_main", weflowInboxCursorFile: cursorFile };
  const fetchImpl = async () => ({
    ok: true,
    async json() { return { messages: [imageRow] }; },
  });
  const source = new WeFlowInboxSource({ config, now: () => nowMs, fetchImpl, logger: {} });

  const waiting = await source.handleSseEvent(event);
  assert.equal(waiting.status, "waiting_for_media");
  const deadline = new Date(nowMs + (5 * 60_000)).toISOString();
  assert.equal(source.pendingEvents.get("message.new:deadline-image").mediaDeadline, deadline);
  const restarted = new WeFlowInboxSource({ config, now: () => nowMs, fetchImpl, logger: {} });
  assert.equal(restarted.pendingEvents.get("message.new:deadline-image").mediaDeadline, deadline);

  nowMs = Date.parse(deadline);
  restarted.now = () => nowMs;
  const expired = await restarted.drainPendingEvents();
  assert.equal(expired.status, "ok");
  assert.equal(expired.quarantined, 1);
  assert.equal(restarted.pendingEvents.size, 0);
  assert.equal(restarted.state.deadLetters.length, 1);
  assert.equal(restarted.state.deadLetters[0].kind, "image");
  assert.match(restarted.state.deadLetters[0].reason, /300 秒/);
  assert.equal((await restarted.handleSseEvent(event)).status, "duplicate");
  assert.equal(restarted.state.deadLetters.length, 1);
});

test("WeFlow expires a locked image pair as one atomic dead letter and tombstones both participants", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const createTime = 1_800_024_000;
  let nowMs = createTime * 1_000;
  const prompt = detail({
    talker: "wxid_main",
    serverId: "deadline-pair-prompt",
    localId: 400,
    createTime,
    isSend: 0,
    senderUsername: "wxid_sender",
    content: "解释",
    parsedContent: "解释",
    rawContent: "解释",
  });
  const imageRow = detail({
    talker: "wxid_main",
    serverId: "deadline-pair-image",
    localId: 401,
    localType: 3,
    createTime,
    isSend: 0,
    senderUsername: "wxid_sender",
    content: "[图片]",
    parsedContent: "[图片]",
    mediaType: "image",
  });
  const toEvent = (row) => ({
    event: "message.new",
    data: {
      sessionId: "wxid_main",
      rawid: row.serverId,
      localId: row.localId,
      localType: row.localType,
      timestamp: row.createTime,
      isSend: row.isSend,
      senderUsername: row.senderUsername,
      content: row.content,
    },
  });
  const source = new WeFlowInboxSource({
    config: { weflowInboxChat: "wxid_main", weflowInboxCursorFile: cursorFile },
    now: () => nowMs,
    fetchImpl: async () => ({
      ok: true,
      async json() { return { messages: [prompt, imageRow] }; },
    }),
    logger: {},
  });

  const waiting = await source.handleSseEvent(toEvent(prompt));
  assert.equal(waiting.status, "waiting_for_companion_media");
  const deadline = new Date(nowMs + (5 * 60_000)).toISOString();
  assert.equal(source.pendingEvents.get("message.new:deadline-pair-prompt").mediaDeadline, deadline);
  await source.handleSseEvent(toEvent(imageRow));
  assert.equal(source.pendingEvents.size, 2);

  nowMs = Date.parse(deadline);
  const expired = await source.drainPendingEvents();
  assert.equal(expired.status, "ok");
  assert.equal(expired.quarantined, 1);
  assert.equal(source.pendingEvents.size, 0);
  assert.equal(source.state.deadLetters.length, 1);
  assert.deepEqual(source.state.deadLetters[0].participantKeys, [
    "message.new:deadline-pair-prompt",
    "message.new:deadline-pair-image",
  ]);
  assert.deepEqual(source.state.seenIds, [
    "message.new:deadline-pair-prompt",
    "message.new:deadline-pair-image",
  ]);
  assert.equal((await source.handleSseEvent(toEvent(prompt))).status, "duplicate");
  assert.equal((await source.handleSseEvent(toEvent(imageRow))).status, "duplicate");
  assert.equal(source.state.deadLetters.length, 1);
});

test("WeFlow retries three due media items with one REST lookup each before delivering text", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const nowMs = 1_800_025_000_000;
  const createTime = Math.floor(nowMs / 1_000);
  const mediaRows = Array.from({ length: 3 }, (_value, index) => detail({
    talker: "wxid_main",
    serverId: `due-video-${index + 1}`,
    localId: 410 + index,
    localType: 43,
    createTime,
    isSend: 0,
    senderUsername: "wxid_sender",
    content: "[视频]",
    parsedContent: "[视频]",
    mediaType: "video",
  }));
  const textRow = detail({
    talker: "wxid_main",
    serverId: "after-three-due-videos",
    localId: 413,
    createTime,
    isSend: 0,
    senderUsername: "wxid_sender",
    content: "立即处理文字",
    parsedContent: "立即处理文字",
  });
  const rows = [...mediaRows, textRow];
  fs.writeFileSync(cursorFile, `${JSON.stringify({
    version: 3,
    seenIds: [],
    lastEventAt: "",
    pendingEvents: rows.map((row, index) => ({
      key: `message.new:${row.serverId}`,
      eventType: "message.new",
      push: {
        sessionId: "wxid_main",
        rawid: row.serverId,
        localId: row.localId,
        localType: row.localType,
        timestamp: row.createTime,
        isSend: row.isSend,
        senderUsername: row.senderUsername,
        content: row.content,
      },
      ...(index < 3 ? {
        mediaDeadline: new Date(nowMs + 60_000).toISOString(),
        retryAttempt: 1,
        retryNotBefore: new Date(nowMs - 1_000).toISOString(),
      } : {}),
    })),
  })}\n`, "utf8");
  let fetchCalls = 0;
  const delivered = [];
  const source = new WeFlowInboxSource({
    config: { weflowInboxChat: "wxid_main", weflowInboxCursorFile: cursorFile },
    now: () => nowMs,
    fetchImpl: async () => {
      fetchCalls += 1;
      return { ok: true, async json() { return { messages: rows }; } };
    },
    onMessage: async (message) => {
      delivered.push(message.id);
      return true;
    },
  });

  const startedAt = Date.now();
  const result = await source.drainPendingEvents();
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.processed, 1);
  assert.equal(fetchCalls, 4);
  assert.ok(elapsedMs < 500, `due media drain took ${elapsedMs}ms`);
  assert.deepEqual(delivered, ["after-three-due-videos"]);
  assert.deepEqual([...source.pendingEvents.keys()], mediaRows.map((row) => `message.new:${row.serverId}`));
});

test("WeFlow rolls back a failed quarantine save and later commits one durable dead letter", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const nowMs = 1_800_026_000_000;
  const createTime = Math.floor(nowMs / 1_000) - 120;
  const row = detail({
    talker: "wxid_main",
    serverId: "save-failure-video",
    localId: 420,
    localType: 43,
    createTime,
    isSend: 0,
    senderUsername: "wxid_sender",
    content: "[视频]",
    parsedContent: "[视频]",
    mediaType: "video",
  });
  const event = {
    event: "message.new",
    data: {
      sessionId: "wxid_main",
      rawid: row.serverId,
      localId: row.localId,
      localType: row.localType,
      timestamp: row.createTime,
      isSend: row.isSend,
      senderUsername: row.senderUsername,
      content: row.content,
    },
  };
  const source = new WeFlowInboxSource({
    config: { weflowInboxChat: "wxid_main", weflowInboxCursorFile: cursorFile },
    now: () => nowMs,
    fetchImpl: async () => ({
      ok: true,
      async json() { return { messages: [row] }; },
    }),
    logger: {},
  });
  source.pendingEvents.set("message.new:save-failure-video", {
    eventType: "message.new",
    push: event.data,
  });
  const saveState = source.saveState.bind(source);
  let injected = false;
  source.saveState = async () => {
    if (!injected && source.state.deadLetters.length) {
      injected = true;
      throw new Error("fixture quarantine save failed");
    }
    return saveState();
  };

  await assert.rejects(source.drainPendingEvents(), /fixture quarantine save failed/);
  assert.equal(injected, true);
  assert.equal(source.pendingEvents.size, 1);
  assert.deepEqual(source.state.seenIds, []);
  assert.deepEqual(source.state.deadLetters, []);
  let persisted = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.equal(persisted.pendingEvents.length, 1);
  assert.equal(persisted.deadLetters.length, 0);

  source.pendingRetryNotBeforeMs = 0;
  const recovered = await source.drainPendingEvents();
  assert.equal(recovered.quarantined, 1);
  assert.equal(source.pendingEvents.size, 0);
  assert.equal(source.state.deadLetters.length, 1);
  persisted = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.equal(persisted.pendingEvents.length, 0);
  assert.equal(persisted.deadLetters.length, 1);
  assert.equal((await source.handleSseEvent(event)).status, "duplicate");
  assert.equal(source.state.deadLetters.length, 1);
});

test("WeFlow uses dead-letter keys and participants as durable replay tombstones", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const ownerKey = "message.new:tombstone-owner";
  const participantKey = "message.new:tombstone-participant";
  fs.writeFileSync(cursorFile, `${JSON.stringify({
    version: 3,
    seenIds: [],
    lastEventAt: "",
    deadLetters: [{
      key: ownerKey,
      eventType: "message.new",
      push: { sessionId: "wxid_main", rawid: "tombstone-owner" },
      code: "media_export_deadline_exceeded",
      kind: "image",
      participantKeys: [ownerKey, participantKey],
      quarantinedAt: new Date().toISOString(),
    }],
    pendingEvents: [
      {
        key: ownerKey,
        eventType: "message.new",
        push: { sessionId: "wxid_main", rawid: "tombstone-owner" },
      },
      {
        key: participantKey,
        eventType: "message.new",
        push: { sessionId: "wxid_main", rawid: "tombstone-participant" },
      },
    ],
  })}\n`, "utf8");
  const source = new WeFlowInboxSource({
    config: { weflowInboxChat: "wxid_main", weflowInboxCursorFile: cursorFile },
  });
  assert.equal(source.pendingEvents.size, 0);
  assert.equal((await source.handleSseEvent({
    event: "message.new",
    data: { sessionId: "wxid_main", rawid: "tombstone-owner" },
  })).status, "duplicate");
  assert.equal((await source.handleSseEvent({
    event: "message.new",
    data: { sessionId: "wxid_main", rawid: "tombstone-participant" },
  })).status, "duplicate");
  assert.equal(source.state.deadLetters.length, 1);
});

test("WeFlow does not assign an image deadline to merged-forward XML containing nested img tags", async () => {
  const row = detail({
    talker: "wxid_main",
    serverId: "merged-with-img",
    localId: 430,
    localType: 81604378673,
    createTime: 1_800_027_000,
    isSend: 0,
    senderUsername: "wxid_sender",
    content: "[聊天记录]",
    parsedContent: "[聊天记录]",
    rawContent: [
      "<msg><appmsg><title>聊天记录</title><type>19</type>",
      "<recorditem><![CDATA[<recordinfo><datalist><dataitem>",
      "<datadesc><img src=\"nested.jpg\"/>图片摘要</datadesc>",
      "</dataitem></datalist></recordinfo>]]></recorditem></appmsg></msg>",
    ].join(""),
  });
  const source = new WeFlowInboxSource({
    config: { weflowInboxChat: "wxid_main" },
    fetchImpl: async () => ({
      ok: true,
      async json() { return { messages: [row] }; },
    }),
  });
  const resolved = await source.resolvePushMessage({
    sessionId: "wxid_main",
    rawid: row.serverId,
    localId: row.localId,
    localType: row.localType,
    timestamp: row.createTime,
    isSend: row.isSend,
    senderUsername: row.senderUsername,
    content: row.content,
  });
  assert.equal(resolved.ready, true);
  assert.equal(resolved.message.kind, "text");
  assert.equal(resolved.mediaDeadline, undefined);
  assert.equal(resolved.deadLetter, undefined);
});

test("WeFlow restores a deferred locked image pairing and commits anchor plus companion together", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const imagePath = createMediaFile(dir, "restart-pair.jpg", "restart-image");
  const createTime = 1_800_000_400;
  const rows = [
    detail({
      talker: "wxid_main",
      serverId: "restart-prompt",
      localId: 400,
      createTime,
      isSend: 1,
      senderUsername: "wxid_self",
      content: "帮我解读这张图片",
      parsedContent: "帮我解读这张图片",
      rawContent: "帮我解读这张图片",
    }),
    detail({
      talker: "wxid_main",
      serverId: "restart-image",
      localId: 401,
      localType: 3,
      createTime,
      isSend: 1,
      senderUsername: "wxid_self",
      content: "[图片]",
      parsedContent: "[图片]",
      mediaType: "image",
      mediaLocalPath: imagePath,
    }),
  ];
  const config = { weflowInboxChat: "wxid_main", weflowInboxCursorFile: cursorFile };
  const fetchImpl = async () => ({
    ok: true,
    async json() { return { messages: rows }; },
  });
  const first = new WeFlowInboxSource({ config, fetchImpl, onMessage: async () => false });
  const deferred = await first.handleSseEvent({
    event: "message.new",
    data: {
      sessionId: "wxid_main",
      rawid: "restart-prompt",
      localId: 400,
      timestamp: createTime,
      isSend: 1,
      senderUsername: "wxid_self",
      content: "帮我解读这张图片",
    },
  });
  assert.equal(deferred.status, "deferred");
  let persisted = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.equal(persisted.version, 3);
  assert.equal(persisted.pendingEvents[0].pairing.status, "locked");
  assert.deepEqual(persisted.pendingEvents[0].companionKeys, ["message.new:restart-image"]);
  const duplicateWhilePending = await first.handleSseEvent({
    event: "message.new",
    data: {
      sessionId: "wxid_main",
      rawid: "restart-prompt",
      localId: 400,
      timestamp: createTime,
      isSend: 1,
      senderUsername: "wxid_self",
      content: "帮我解读这张图片",
    },
  });
  assert.equal(duplicateWhilePending.status, "waiting_for_pending_retry");
  persisted = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.equal(persisted.pendingEvents[0].pairing.status, "locked");
  assert.deepEqual(persisted.pendingEvents[0].companionKeys, ["message.new:restart-image"]);
  const retryAfterMs = Date.parse(persisted.pendingEvents[0].retryNotBefore) + 1;

  const delivered = [];
  const restarted = new WeFlowInboxSource({
    config,
    now: () => retryAfterMs,
    fetchImpl,
    onMessage: async (message) => {
      delivered.push(message);
      return true;
    },
  });
  assert.equal(restarted.pendingEvents.size, 1);
  const recovered = await restarted.drainPendingEvents();
  assert.equal(recovered.processed, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, "restart-prompt");
  assert.equal(delivered[0].attachments[0].path, imagePath);
  persisted = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.deepEqual(persisted.pendingEvents, []);
  assert.deepEqual(persisted.seenIds, ["message.new:restart-prompt", "message.new:restart-image"]);
});

test("WeFlow self-heals an old empty awaiting pairing and delivers standalone explanation once", async () => {
  const dir = createTempDir();
  const cursorFile = path.join(dir, "cursor.json");
  const createTime = 1_800_000_450;
  const push = {
    sessionId: "wxid_main",
    rawid: "standalone-prompt",
    localId: 450,
    timestamp: createTime,
    isSend: 1,
    senderUsername: "wxid_self",
    content: "解释",
  };
  fs.writeFileSync(cursorFile, `${JSON.stringify({
    version: 3,
    seenIds: [],
    lastEventAt: "",
    pendingEvents: [{
      key: "message.new:standalone-prompt",
      eventType: "message.new",
      push,
      companionKeys: [
        "damaged-key",
        "message.new:standalone-prompt",
        "message.new:standalone-prompt",
      ],
      pairing: { status: "awaiting_companion", anchorKey: "message.new:standalone-prompt" },
    }],
  })}\n`, "utf8");
  let fetchCalls = 0;
  const delivered = [];
  let persistedAtCallback = null;
  const source = new WeFlowInboxSource({
    config: {
      weflowInboxChat: "wxid_main",
      weflowInboxCursorFile: cursorFile,
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        async json() {
          return { messages: [detail({
            talker: "wxid_main",
            serverId: "standalone-prompt",
            localId: 450,
            createTime,
            isSend: 1,
            senderUsername: "wxid_self",
            content: "解释",
            parsedContent: "解释",
            rawContent: "解释",
          })] };
        },
      };
    },
    onMessage: async (message) => {
      persistedAtCallback = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
      delivered.push(message);
      return true;
    },
  });

  assert.deepEqual(source.pendingEvents.get("message.new:standalone-prompt").companionKeys, []);
  const result = await source.drainPendingEvents();
  assert.equal(result.status, "ok");
  assert.equal(result.processed, 1);
  assert.equal(fetchCalls, 4);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, "standalone-prompt");
  assert.equal(delivered[0].text, "解释");
  assert.equal("pairing" in persistedAtCallback.pendingEvents[0], false);
  assert.equal("companionKeys" in persistedAtCallback.pendingEvents[0], false);
  const persisted = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.deepEqual(persisted.pendingEvents, []);
  assert.deepEqual(persisted.seenIds, ["message.new:standalone-prompt"]);
  assert.equal((await source.handleSseEvent({ event: "message.new", data: push })).status, "duplicate");
  assert.equal(delivered.length, 1);
});

test("WeFlow does not replay a seen prompt when its image arrives later", async () => {
  const dir = createTempDir();
  const imagePath = createMediaFile(dir, "late-image.jpg", "late-image");
  const createTime = 1_800_000_475;
  const prompt = detail({
    talker: "wxid_main",
    serverId: "seen-prompt",
    localId: 475,
    createTime,
    isSend: 1,
    senderUsername: "wxid_self",
    content: "解释",
    parsedContent: "解释",
    rawContent: "解释",
  });
  const lateImage = detail({
    talker: "wxid_main",
    serverId: "late-image",
    localId: 476,
    localType: 3,
    createTime,
    isSend: 1,
    senderUsername: "wxid_self",
    content: "[图片]",
    parsedContent: "[图片]",
    mediaType: "image",
    mediaLocalPath: imagePath,
  });
  const delivered = [];
  const source = new WeFlowInboxSource({
    config: { weflowInboxChat: "wxid_main" },
    fetchImpl: async () => ({
      ok: true,
      async json() { return { messages: [prompt, lateImage] }; },
    }),
    onMessage: async (message) => {
      delivered.push(message);
      return true;
    },
  });
  source.rememberSeen("message.new:seen-prompt");

  const result = await source.handleSseEvent({
    event: "message.new",
    data: {
      sessionId: "wxid_main",
      rawid: "late-image",
      localId: 476,
      localType: 3,
      timestamp: createTime,
      isSend: 1,
      senderUsername: "wxid_self",
      content: "[图片]",
    },
  });
  assert.equal(result.processed, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, "late-image");
  assert.equal(delivered[0].kind, "image");
  assert.equal(delivered[0].attachments[0].path, imagePath);
  assert.deepEqual(source.state.seenIds, ["message.new:seen-prompt", "message.new:late-image"]);
});

test("WeFlow does not pair images beyond source skew or across direction, sender, chat, localId, or commands", async (t) => {
  const dir = createTempDir();
  const imagePath = createMediaFile(dir, "not-a-companion.jpg", "standalone-image");
  const basePrompt = detail({
    talker: "wxid_main",
    serverId: "guard-prompt",
    localId: 500,
    createTime: 1_800_000_500,
    isSend: 1,
    senderUsername: "wxid_self",
    content: "解释",
    parsedContent: "解释",
    rawContent: "解释",
  });
  const baseImage = detail({
    talker: "wxid_main",
    serverId: "guard-image",
    localId: 501,
    localType: 3,
    createTime: 1_800_000_500,
    isSend: 1,
    senderUsername: "wxid_self",
    content: "[图片]",
    parsedContent: "[图片]",
    mediaType: "image",
    mediaLocalPath: imagePath,
  });
  const cases = [
    ["more than fifteen seconds after explicit prompt", {}, { createTime: 1_800_000_516 }],
    ["generic caption more than two seconds after prompt", {
      content: "看看这个细节",
      parsedContent: "看看这个细节",
      rawContent: "看看这个细节",
    }, { createTime: 1_800_000_503 }],
    ["image timestamp predates prompt", {}, { createTime: 1_800_000_499 }],
    ["different direction", {}, { isSend: 0 }],
    ["different sender", {}, { senderUsername: "wxid_other" }],
    ["different chat", {}, { talker: "wxid_other" }],
    ["same but unexpected chat", { talker: "wxid_other" }, { talker: "wxid_other" }],
    ["localId gap", {}, { localId: 502 }],
    ["slash command", {
      content: "/status",
      parsedContent: "/status",
      rawContent: "/status",
    }, {}],
  ];
  for (const [name, promptExtra, imageExtra] of cases) {
    await t.test(name, async () => {
      const prompt = { ...basePrompt, ...promptExtra };
      const image = { ...baseImage, ...imageExtra, serverId: `guard-image-${name}` };
      const source = new WeFlowInboxSource({
        config: { weflowInboxChat: "wxid_main" },
        fetchImpl: async () => ({
          ok: true,
          async json() { return { messages: [prompt, image] }; },
        }),
      });
      const resolved = await source.resolvePushMessage({
        sessionId: "wxid_main",
        rawid: image.serverId,
        localId: image.localId,
        timestamp: image.createTime,
        isSend: image.isSend,
        senderUsername: image.senderUsername,
      });
      assert.equal(resolved.ready, true);
      assert.equal(resolved.pairing, undefined);
      assert.equal(resolved.message.id, image.serverId);
      assert.equal(resolved.message.kind, "image");
      assert.equal(resolved.message.attachments[0].path, imagePath);
    });
  }
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
  assert.equal(persisted.version, 3);
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
  const retryAfterMs = Date.parse(persisted.pendingEvents[0].retryNotBefore) + 1;

  const delivered = [];
  const restarted = new WeFlowInboxSource({
    config,
    now: () => retryAfterMs,
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
    windowsHide: true,
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

test("Cyberboss intercepts a heartbeat canary before reply routing or model dispatch", async () => {
  const observed = [];
  let routed = false;
  const appLike = {
    config: {
      stateDir: createTempDir(),
      weflowInboxChat: "wxid_main",
    },
    weflowMessageLedger: {
      async classifyObservedOutgoing() {
        return { origin: "self_manual", matched: false };
      },
    },
    weflowHeartbeatCanary: {
      async handleObservedMessage(payload) {
        observed.push(payload);
        return { handled: true, accepted: true, status: "reply_dispatched" };
      },
    },
    resolveWeFlowInboxReplyTarget() {
      throw new Error("canary must be intercepted before ordinary reply routing");
    },
    async handlePreparedMessage() {
      routed = true;
    },
  };

  const accepted = await CyberbossApp.prototype.handleWeFlowInboxMessage.call(
    appLike,
    normalizeWeFlowMessage(detail({
      localId: 173,
      serverId: "outgoing-canary-173",
      isSend: 1,
      content: "[Cyberboss心跳探针 trigger=12345678-1234-4234-8234-123456789abc nonce=0123456789abcdef01234567]",
      parsedContent: "[Cyberboss心跳探针 trigger=12345678-1234-4234-8234-123456789abc nonce=0123456789abcdef01234567]",
    })),
    { chat: "yourself", chatUsername: "wxid_main" }
  );

  assert.equal(accepted, true);
  assert.equal(routed, false);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].talker, "wxid_main");
  assert.equal(observed[0].classification.origin, "self_manual");
});

test("Cyberboss dedicated canary inbox is talker-bound and never reaches ordinary model routing", async () => {
  const observed = [];
  let classified = 0;
  const appLike = {
    config: { weflowCanaryChat: "wxid_canary_self" },
    weflowMessageLedger: {
      async classifyObservedOutgoing(payload) {
        classified += 1;
        assert.equal(payload.talker, "wxid_canary_self");
        return { origin: "self_manual", matched: false };
      },
    },
    weflowHeartbeatCanary: {
      async handleObservedMessage(payload) {
        observed.push(payload);
        return { handled: true, accepted: true, status: "reply_dispatched" };
      },
    },
    async handlePreparedMessage() {
      throw new Error("dedicated canary markers must never enter model routing");
    },
  };
  const message = {
    id: "server-canary-201",
    localId: "201",
    direction: "outgoing",
    text: "[Cyberboss心跳探针 trigger=fixture]",
    receivedAt: new Date().toISOString(),
    kind: "text",
  };

  const wrongTalker = await CyberbossApp.prototype.handleWeFlowCanaryInboxMessage.call(
    appLike,
    message,
    { chat: "Azzy", chatUsername: "wxid_primary", canaryOnly: true },
  );
  assert.equal(wrongTalker, true);
  assert.equal(classified, 0);
  assert.equal(observed.length, 0);

  const accepted = await CyberbossApp.prototype.handleWeFlowCanaryInboxMessage.call(
    appLike,
    message,
    { chat: "Azzy", chatUsername: "wxid_canary_self", canaryOnly: true },
  );
  assert.equal(accepted, true);
  assert.equal(classified, 1);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].talker, "wxid_canary_self");
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
  const manualMessage = normalizeWeFlowMessage(detail({
      localId: 74,
      serverId: "manual-74",
      isSend: 1,
      content: "从手机继续处理这个任务",
      parsedContent: "从手机继续处理这个任务",
    }));
  manualMessage.sourceMessageIds = ["weflow:manual-74", "weflow:manual-image-75"];
  const accepted = await CyberbossApp.prototype.handleWeFlowInboxMessage.call(
    appLike,
    manualMessage,
    { chat: "yourself", chatUsername: "wxid_main" }
  );
  assert.equal(accepted, true);
  assert.equal(received.length, 1);
  assert.equal(received[0].provider, "weflow-uia");
  assert.deepEqual(received[0].sourceMessageIds, ["weflow:manual-74", "weflow:manual-image-75"]);
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
