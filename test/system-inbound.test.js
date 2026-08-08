const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { CyberbossApp } = require("../src/core/app");
const {
  assembleRuntimeTurnText,
  buildImplicitReferencedPrepared,
  buildMergedInboundPrepared,
  takeImageOnlyBatchMessages,
} = require("../src/core/inbound-turn");

test("system messages bypass normal inbound wrapping", async () => {
  const prepared = await CyberbossApp.prototype.prepareIncomingMessageForRuntime.call({}, {
    provider: "system",
    text: "SYSTEM ACTION MODE\n\nTrigger:\n测试 system send 命令",
    attachments: [],
  }, "/tmp");

  assert.deepEqual(prepared, {
    provider: "system",
    text: "SYSTEM ACTION MODE\n\nTrigger:\n测试 system send 命令",
    originalText: "SYSTEM ACTION MODE\n\nTrigger:\n测试 system send 命令",
    attachments: [],
    attachmentFailures: [],
  });
});

test("image attachments stay as inbound drafts before runtime turn assembly", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-inbound-test-"));
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    headers: {
      get(name) {
        return String(name || "").toLowerCase() === "content-type" ? "image/jpeg" : "";
      },
    },
    async arrayBuffer() {
      return Buffer.from("fake-jpeg-bytes");
    },
  });

  try {
    const prepared = await CyberbossApp.prototype.prepareIncomingMessageForRuntime.call({
      config: {
        stateDir,
        weixinCdnBaseUrl: "https://cdn.example.com",
        userName: "User",
      },
      runtimeAdapter: {
        describe() {
          return { id: "codex" };
        },
      },
      channelAdapter: {
        async sendText() {},
      },
    }, {
      provider: "weixin",
      text: "",
      senderId: "user-1",
      contextToken: "ctx-1",
      attachments: [{
        kind: "image",
        fileName: "photo.jpg",
        directUrls: ["https://example.com/photo.jpg"],
        mediaRef: { encryptType: 0 },
      }],
      receivedAt: "2026-04-17T10:00:00.000Z",
    }, "/workspace");

    assert.equal(prepared.text, "");
    assert.equal(prepared.originalText, "");
    assert.equal(prepared.attachments[0].contentType, "image/jpeg");
    assert.equal(prepared.attachments[0].isImage, true);

    const runtimeTurn = await CyberbossApp.prototype.buildRuntimeTurn.call({
      config: {
        userName: "User",
      },
      runtimeAdapter: {
        getTurnCapabilities() {
          return { nativeImageInput: false };
        },
      },
    }, { prepared, model: "" });
    assert.match(runtimeTurn.text, /Saved attachments:/i);
    assert.match(runtimeTurn.text, /vision caption provider is not configured/i);
    assert.match(runtimeTurn.text, /cyberboss_sticker_save_from_inbox/i);
    assert.match(runtimeTurn.text, /`items` array/i);
    assert.match(runtimeTurn.text, /cyberboss_sticker_tags/i);
    assert.match(runtimeTurn.text, /short new tag/i);
    assert.match(runtimeTurn.text, /Do not describe save steps/i);
    assert.doesNotMatch(runtimeTurn.text, /view_image/i);
    assert.doesNotMatch(runtimeTurn.text, /Read every image first/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test("system messages dispatch to a known platform user without a context token", async () => {
  let captured = null;
  const dispatched = await CyberbossApp.prototype.dispatchSystemMessage.call({
    channelAdapter: {
      getKnownContextTokens() {
        return {};
      },
    },
    systemMessageDispatcher: {
      buildPreparedMessage(message, contextToken) {
        return {
          provider: "system",
          workspaceId: "default",
          accountId: "account-1",
          senderId: message.senderId,
          contextToken,
          workspaceRoot: "/workspace",
          text: message.text,
        };
      },
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
        };
      },
    },
    isTurnDispatchBlocked() {
      return false;
    },
    async dispatchPreparedTurn(payload) {
      captured = payload;
      return true;
    },
  }, {
    id: "system-1",
    senderId: "platform-user@im.wechat",
    text: "periodic check-in",
  });

  assert.equal(dispatched, true);
  assert.equal(captured.prepared.senderId, "platform-user@im.wechat");
  assert.equal(captured.prepared.contextToken, "");
});

test("quoted attachments retain their origin and reference through persistence", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-quoted-inbound-test-"));
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    headers: { get: () => "image/jpeg" },
    async arrayBuffer() {
      return Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    },
  });

  try {
    const prepared = await CyberbossApp.prototype.prepareIncomingMessageForRuntime.call({
      config: {
        stateDir,
        weixinCdnBaseUrl: "https://cdn.example.com",
      },
      channelAdapter: { async sendText() {} },
    }, {
      provider: "weixin",
      text: "总结一下",
      senderId: "user-1",
      contextToken: "ctx-1",
      quotedContexts: [{
        kind: "image",
        title: "引用图片",
        text: "",
        url: "",
        attachmentRefs: ["quoted:message-1:0"],
        rawSecret: "must-not-leak",
      }],
      attachments: [{
        kind: "image",
        origin: "quoted",
        quoteIndex: 0,
        attachmentRef: "quoted:message-1:0",
        fileName: "quoted.jpg",
        directUrls: ["https://cdn.example.com/quoted.jpg"],
        mediaRef: { encryptType: 0 },
      }],
      receivedAt: "2026-08-06T05:20:00.000Z",
    }, "/workspace");

    assert.equal(prepared.attachments[0].origin, "quoted");
    assert.equal(prepared.attachments[0].quoteIndex, 0);
    assert.equal(prepared.attachments[0].attachmentRef, "quoted:message-1:0");
    assert.deepEqual(prepared.quotedContexts, [{
      kind: "image",
      title: "引用图片",
      text: "",
      url: "",
      attachmentRefs: ["quoted:message-1:0"],
    }]);

    const prompt = assembleRuntimeTurnText({ prepared });
    assert.ok(prompt.startsWith("总结一下"));
    assert.ok(prompt.indexOf("Quoted context:") < prompt.indexOf("Saved attachments:"));
    assert.match(prompt, /\[quoted image\]/i);
    assert.match(prompt, /quoted:message-1:0/);
    assert.doesNotMatch(prompt, /must-not-leak|aes_key|encrypt_query_param/i);
    assert.ok(prompt.endsWith("Message time: [2026-08-06 13:20]"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("merged inbound messages preserve ordered quote contexts", () => {
  const merged = buildMergedInboundPrepared({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    messages: [{
      originalText: "第一条",
      quotedContexts: [{ kind: "text", title: "A", text: "甲", attachmentRefs: [] }],
      attachments: [],
      attachmentFailures: [],
      receivedAt: "2026-08-06T05:20:00.000Z",
    }],
    trailingPrepared: {
      originalText: "第二条",
      quotedContexts: [{ kind: "link", title: "B", text: "乙", url: "https://example.com", attachmentRefs: [] }],
      attachments: [],
      attachmentFailures: [],
      receivedAt: "2026-08-06T05:20:01.000Z",
    },
  });

  assert.equal(merged.originalText, "第一条\n\n第二条");
  assert.deepEqual(merged.quotedContexts.map((item) => item.title), ["A", "B"]);
  assert.equal(merged.receivedAt, "2026-08-06T05:20:01.000Z");
});

test("quoted image contexts follow their attachment batch", () => {
  const attachments = Array.from({ length: 12 }, (_, index) => ({
    kind: "image",
    isImage: true,
    attachmentRef: `quoted:message-1:${index}`,
  }));
  const quotedContexts = attachments.map((item, index) => ({
    kind: "image",
    title: `image-${index}`,
    attachmentRefs: [item.attachmentRef],
  }));

  const split = takeImageOnlyBatchMessages([{
    originalText: "",
    attachments,
    quotedContexts,
  }], 10);

  assert.equal(split.batchMessages[0].quotedContexts.length, 10);
  assert.equal(split.remainingMessages[0].quotedContexts.length, 2);
  assert.deepEqual(
    split.remainingMessages[0].quotedContexts.map((item) => item.title),
    ["image-10", "image-11"]
  );
});

test("image prompt assembly is runtime-neutral for claudecode drafts", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-inbound-test-"));
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    headers: {
      get(name) {
        return String(name || "").toLowerCase() === "content-type" ? "image/jpeg" : "";
      },
    },
    async arrayBuffer() {
      return Buffer.from("fake-jpeg-bytes");
    },
  });

  try {
    const prepared = await CyberbossApp.prototype.prepareIncomingMessageForRuntime.call({
      config: {
        stateDir,
        weixinCdnBaseUrl: "https://cdn.example.com",
        userName: "User",
      },
      runtimeAdapter: {
        describe() {
          return { id: "claudecode" };
        },
      },
      channelAdapter: {
        async sendText() {},
      },
    }, {
      provider: "weixin",
      text: "",
      senderId: "user-1",
      contextToken: "ctx-1",
      attachments: [{
        kind: "image",
        fileName: "photo.jpg",
        directUrls: ["https://example.com/photo.jpg"],
        mediaRef: { encryptType: 0 },
      }],
      receivedAt: "2026-04-17T10:00:00.000Z",
    }, "/workspace");

    const runtimeTurn = await CyberbossApp.prototype.buildRuntimeTurn.call({
      config: {
        userName: "User",
      },
      runtimeAdapter: {
        getTurnCapabilities() {
          return { nativeImageInput: false };
        },
      },
    }, { prepared, model: "" });

    assert.match(runtimeTurn.text, /Saved attachments:/i);
    assert.match(runtimeTurn.text, /cyberboss_sticker_save_from_inbox/i);
    assert.match(runtimeTurn.text, /`items` array/i);
    assert.match(runtimeTurn.text, /cyberboss_sticker_tags/i);
    assert.match(runtimeTurn.text, /short new tag/i);
    assert.match(runtimeTurn.text, /Do not describe save steps/i);
    assert.doesNotMatch(runtimeTurn.text, /Read every image first/i);
    assert.doesNotMatch(runtimeTurn.text, /view_image/i);
    assert.equal(prepared.attachments[0].contentType, "image/jpeg");
    assert.equal(prepared.attachments[0].isImage, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("text-only runtimes receive vision API captions as visual context", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-vision-test-"));
  const imagePath = path.join(stateDir, "photo.jpg");
  fs.writeFileSync(imagePath, Buffer.from("fake-jpeg-bytes"));
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(String(url), "https://dashscope.example.com/compatible-mode/v1/chat/completions");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "qwen-vl-demo");
    assert.equal(body.messages[0].content[1].type, "image_url");
    assert.match(body.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
    return {
      ok: true,
      async text() {
        return JSON.stringify({
          choices: [{
            message: {
              content: "一杯带拉花的咖啡放在桌上。",
            },
          }],
        });
      },
    };
  };

  try {
    const runtimeTurn = await CyberbossApp.prototype.buildRuntimeTurn.call({
      config: {
        visionMode: "auto",
        visionProvider: "openai-compatible",
        visionApiBaseUrl: "https://dashscope.example.com/compatible-mode/v1",
        visionModel: "qwen-vl-demo",
      },
      runtimeAdapter: {
        getTurnCapabilities() {
          return { nativeImageInput: false };
        },
      },
    }, {
      prepared: {
        provider: "weixin",
        originalText: "",
        text: "",
        attachments: [{
          kind: "image",
          contentType: "image/jpeg",
          isImage: true,
          absolutePath: imagePath,
        }],
        attachmentFailures: [],
        receivedAt: "2026-04-17T10:00:00.000Z",
      },
      model: "deepseek-chat",
    });

    assert.match(runtimeTurn.text, /Visual context from attachments:/i);
    assert.match(runtimeTurn.text, /一杯带拉花的咖啡/);
    assert.match(runtimeTurn.text, /cyberboss_sticker_save_from_inbox/i);
    assert.deepEqual(runtimeTurn.attachments, []);
    assert.equal(runtimeTurn.visionContext.route, "caption");
  } finally {
    global.fetch = originalFetch;
  }
});

test("native image-capable runtimes receive attachments without caption fallback", async () => {
  const attachment = {
    kind: "image",
    contentType: "image/jpeg",
    isImage: true,
    absolutePath: "/tmp/native.jpg",
  };
  const runtimeTurn = await CyberbossApp.prototype.buildRuntimeTurn.call({
    config: {
      visionMode: "auto",
    },
    runtimeAdapter: {
      getTurnCapabilities() {
        return { nativeImageInput: true };
      },
    },
  }, {
    prepared: {
      provider: "weixin",
      originalText: "看看这个",
      text: "看看这个",
      attachments: [attachment],
      attachmentFailures: [],
      receivedAt: "2026-04-17T10:00:00.000Z",
    },
    model: "vision-model",
  });

  assert.match(runtimeTurn.text, /Saved attachments:/i);
  assert.doesNotMatch(runtimeTurn.text, /Visual context from attachments:/i);
  assert.deepEqual(runtimeTurn.attachments, [attachment]);
  assert.equal(runtimeTurn.visionContext.route, "native");
});

test("tool image-capable runtimes keep local image paths without caption fallback", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("caption provider should not be called");
  };

  try {
    const runtimeTurn = await CyberbossApp.prototype.buildRuntimeTurn.call({
      config: {
        visionMode: "auto",
        visionProvider: "openai-compatible",
        visionApiBaseUrl: "https://dashscope.example.com/compatible-mode/v1",
        visionModel: "qwen-vl-demo",
      },
      runtimeAdapter: {
        getTurnCapabilities() {
          return { nativeImageInput: false, toolImageRead: true };
        },
      },
    }, {
      prepared: {
        provider: "weixin",
        originalText: "看看这个",
        text: "看看这个",
        attachments: [{
          kind: "image",
          contentType: "image/jpeg",
          isImage: true,
          absolutePath: "/tmp/tool-readable.jpg",
        }],
        attachmentFailures: [],
        receivedAt: "2026-04-17T10:00:00.000Z",
      },
      model: "claude-sonnet",
    });

    assert.match(runtimeTurn.text, /Saved attachments:/i);
    assert.match(runtimeTurn.text, /\/tmp\/tool-readable\.jpg/);
    assert.doesNotMatch(runtimeTurn.text, /Visual context from attachments:/i);
    assert.deepEqual(runtimeTurn.attachments, []);
    assert.equal(runtimeTurn.visionContext.route, "tool");
  } finally {
    global.fetch = originalFetch;
  }
});

test("shared-content-only inbound turns enter the one-minute prompt queue", async () => {
  const queued = [];
  let routed = 0;
  await CyberbossApp.prototype.handlePreparedMessage.call({
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
        };
      },
    },
    streamDelivery: {
      setReplyTarget() {},
    },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    async prepareIncomingMessageForRuntime() {
      return {
        workspaceId: "default",
        accountId: "wx-account",
        senderId: "user-1",
        chatId: "chat-1",
        contextToken: "ctx-1",
        provider: "weixin",
        originalText: "",
        text: "",
        attachments: [{
          kind: "image",
          contentType: "image/jpeg",
          isImage: true,
          absolutePath: "/tmp/a.jpg",
        }],
        attachmentFailures: [],
        contentKind: "image",
        sharedContent: true,
        explicitPrompt: false,
        receivedAt: "2026-04-30T10:00:00.000Z",
      };
    },
    enqueuePendingSharedContentInbound(payload) {
      queued.push(payload);
    },
    async routePreparedInbound() {
      routed += 1;
    },
  }, {
    workspaceId: "default",
    accountId: "wx-account",
    senderId: "user-1",
    contextToken: "ctx-1",
    text: "",
    attachments: [],
  }, {
    allowCommands: false,
  });

  assert.equal(queued.length, 1);
  assert.equal(routed, 0);
});

test("shared content becomes implicit quoted context when a prompt follows within 59 seconds", async () => {
  const scopeKey = "binding-1::/workspace::chat-1";
  let routed = null;
  const app = {
    pendingSharedContentInboundByScope: new Map([[scopeKey, {
      bindingKey: "binding-1",
      workspaceRoot: "/workspace",
      chatId: "chat-1",
      messages: [{
        senderId: "user-1",
        accountId: "wx-account",
        workspaceId: "default",
        provider: "weixin",
        chatId: "chat-1",
        messageId: "image-1",
        contextToken: "ctx-1",
        originalText: "",
        text: "",
        attachments: [{
          kind: "image",
          contentType: "image/jpeg",
          isImage: true,
          absolutePath: "/tmp/a.jpg",
          attachmentRef: "direct:image-1",
        }],
        attachmentFailures: [],
        contentKind: "image",
        contentTitle: "截图",
        sharedContent: true,
        explicitPrompt: false,
        receivedAt: "2026-04-30T10:00:00.000Z",
      }, {
        senderId: "user-1",
        accountId: "wx-account",
        workspaceId: "default",
        provider: "weixin",
        chatId: "chat-1",
        messageId: "link-1",
        contextToken: "ctx-1",
        originalText: "项目资料\nhttps://example.com/report",
        text: "项目资料\nhttps://example.com/report",
        attachments: [],
        attachmentFailures: [],
        contentKind: "link",
        contentTitle: "项目资料",
        contentText: "项目资料",
        contentUrl: "https://example.com/report",
        sharedContent: true,
        explicitPrompt: false,
        receivedAt: "2026-04-30T10:00:01.000Z",
      }],
      timer: null,
      lastContentAtMs: Date.parse("2026-04-30T10:00:01.000Z"),
    }]]),
    clearPendingSharedContentInboundTimer: CyberbossApp.prototype.clearPendingSharedContentInboundTimer,
    async routePreparedInbound({ prepared }) {
      routed = prepared;
      return true;
    },
  };

  await CyberbossApp.prototype.consumePendingSharedContentInbound.call(app, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    trailingPrepared: {
      senderId: "user-1",
      accountId: "wx-account",
      workspaceId: "default",
      provider: "weixin",
      chatId: "chat-1",
      contextToken: "ctx-2",
      originalText: "总结一下",
      text: "总结一下",
      attachments: [],
      attachmentFailures: [],
      sharedContent: false,
      explicitPrompt: true,
      receivedAt: "2026-04-30T10:01:00.000Z",
    },
  });

  assert.ok(routed);
  assert.equal(routed.attachments.length, 1);
  assert.equal(routed.contextToken, "ctx-2");
  assert.equal(routed.originalText, "总结一下");
  assert.equal(routed.text, "总结一下");
  assert.deepEqual(routed.quotedContexts.map((item) => item.kind), ["image", "link"]);
  assert.equal(routed.quotedContexts[0].attachmentRefs[0], "direct:image-1");
  assert.equal(routed.quotedContexts[1].url, "https://example.com/report");
  assert.equal(routed.attachments[0].origin, "quoted");
});

test("implicit referenced content enters the ordinary pending buffer as one turn when runtime is blocked", async () => {
  const scopeKey = "binding-1::/workspace::chat-1";
  const buffered = [];
  const app = {
    pendingSharedContentInboundByScope: new Map([[scopeKey, {
      bindingKey: "binding-1",
      workspaceRoot: "/workspace",
      chatId: "chat-1",
      messages: [{
        senderId: "user-1",
        accountId: "wx-account",
        workspaceId: "default",
        provider: "weixin",
        chatId: "chat-1",
        messageId: "file-1",
        contextToken: "ctx-1",
        originalText: "",
        text: "",
        attachments: [{
          kind: "file",
          contentType: "application/pdf",
          absolutePath: "/tmp/a.pdf",
          sourceFileName: "a.pdf",
          attachmentRef: "direct:file-1",
        }],
        attachmentFailures: [],
        contentKind: "file",
        contentTitle: "a.pdf",
        sharedContent: true,
        explicitPrompt: false,
        receivedAt: "2026-04-30T10:00:00.000Z",
      }],
      timer: null,
      lastContentAtMs: Date.parse("2026-04-30T10:00:00.000Z"),
    }]]),
    isTurnDispatchBlocked() {
      return true;
    },
    bufferPendingInboundMessage(payload) {
      buffered.push(payload);
    },
    async dispatchPreparedTurn() {
      throw new Error("should not dispatch while blocked");
    },
    clearPendingSharedContentInboundTimer: CyberbossApp.prototype.clearPendingSharedContentInboundTimer,
    routePreparedInbound: CyberbossApp.prototype.routePreparedInbound,
  };

  await CyberbossApp.prototype.consumePendingSharedContentInbound.call(app, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    trailingPrepared: {
      senderId: "user-1",
      accountId: "wx-account",
      workspaceId: "default",
      provider: "weixin",
      chatId: "chat-1",
      contextToken: "ctx-2",
      originalText: "提取要点",
      text: "提取要点",
      attachments: [],
      attachmentFailures: [],
      explicitPrompt: true,
      receivedAt: "2026-04-30T10:00:30.000Z",
    },
  });

  assert.equal(buffered.length, 1);
  assert.equal(buffered[0].prepared.attachments.length, 1);
  assert.equal(buffered[0].prepared.originalText, "提取要点");
  assert.equal(buffered[0].prepared.quotedContexts[0].kind, "file");
});

test("all shared content kinds are rendered as ordered implicit references", () => {
  const messages = ["image", "voice", "video", "file"].map((kind, index) => ({
    messageId: `${kind}-${index}`,
    contentKind: kind,
    contentTitle: `${kind} title`,
    contentText: kind === "voice" ? "语音转写内容" : "",
    contentUrl: "",
    attachments: [{
      kind,
      absolutePath: `/tmp/${kind}`,
      attachmentRef: `direct:${kind}`,
    }],
    attachmentFailures: [],
  }));
  messages.push({
    messageId: "link-1",
    contentKind: "link",
    contentTitle: "链接标题",
    contentText: "链接摘要",
    contentUrl: "https://example.com/item",
    attachments: [],
    attachmentFailures: [],
  });

  const prepared = buildImplicitReferencedPrepared({
    messages,
    prompt: {
      originalText: "统一分析",
      text: "统一分析",
      quotedContexts: [],
      attachments: [],
      attachmentFailures: [],
    },
  });

  assert.equal(prepared.originalText, "统一分析");
  assert.deepEqual(prepared.quotedContexts.map((item) => item.kind), [
    "image", "voice", "video", "file", "link",
  ]);
  assert.equal(prepared.quotedContexts[1].text, "语音转写内容");
  assert.equal(prepared.attachments.length, 4);
});

test("shared content timeout clears silently and logical chats remain isolated", async () => {
  const scopeKey = "binding-1::/workspace::chat-a";
  const app = {
    pendingSharedContentInboundByScope: new Map([[scopeKey, {
      bindingKey: "binding-1",
      workspaceRoot: "/workspace",
      chatId: "chat-a",
      messages: [{ contentKind: "image" }],
      timer: null,
      lastContentAtMs: Date.now(),
    }]]),
    clearPendingSharedContentInboundTimer: CyberbossApp.prototype.clearPendingSharedContentInboundTimer,
    dropPendingSharedContentInboundByScopeKey: CyberbossApp.prototype.dropPendingSharedContentInboundByScopeKey,
  };

  assert.equal(CyberbossApp.prototype.hasPendingSharedContentInbound.call(
    app, "binding-1", "/workspace", "chat-a"
  ), true);
  assert.equal(CyberbossApp.prototype.hasPendingSharedContentInbound.call(
    app, "binding-1", "/workspace", "chat-b"
  ), false);

  CyberbossApp.prototype.schedulePendingSharedContentInboundExpiry.call(app, scopeKey, 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(app.pendingSharedContentInboundByScope.size, 0);
});

test("a prompt after 60 seconds is routed normally without the expired implicit reference", async () => {
  const scopeKey = "binding-1::/workspace::chat-1";
  let routed = null;
  const preparedPrompt = {
    workspaceId: "default",
    accountId: "wx-account",
    senderId: "user-1",
    provider: "weixin",
    chatId: "chat-1",
    contextToken: "ctx-2",
    originalText: "这是新问题",
    text: "这是新问题",
    quotedContexts: [],
    attachments: [],
    attachmentFailures: [],
    explicitPrompt: true,
    receivedAt: "2026-04-30T10:01:01.000Z",
  };
  const app = {
    pendingSharedContentInboundByScope: new Map([[scopeKey, {
      bindingKey: "binding-1",
      workspaceRoot: "/workspace",
      chatId: "chat-1",
      messages: [{ contentKind: "image", attachments: [] }],
      timer: null,
      lastContentAtMs: Date.parse("2026-04-30T10:00:00.000Z"),
    }]]),
    runtimeAdapter: {
      getSessionStore() {
        return { buildBindingKey() { return "binding-1"; } };
      },
    },
    streamDelivery: { setReplyTarget() {} },
    resolveWorkspaceRoot() { return "/workspace"; },
    async prepareIncomingMessageForRuntime() { return preparedPrompt; },
    hasPendingSharedContentInbound: CyberbossApp.prototype.hasPendingSharedContentInbound,
    consumePendingSharedContentInbound: CyberbossApp.prototype.consumePendingSharedContentInbound,
    clearPendingSharedContentInboundTimer: CyberbossApp.prototype.clearPendingSharedContentInboundTimer,
    async routePreparedInbound({ prepared }) {
      routed = prepared;
      return true;
    },
  };

  await CyberbossApp.prototype.handlePreparedMessage.call(app, preparedPrompt, { allowCommands: false });

  assert.equal(routed.originalText, "这是新问题");
  assert.deepEqual(routed.quotedContexts, []);
  assert.equal(app.pendingSharedContentInboundByScope.size, 0);
});

test("an explicit quote takes priority and clears pending implicit content", async () => {
  const scopeKey = "binding-1::/workspace::chat-1";
  let routed = null;
  const explicitPrompt = {
    workspaceId: "default",
    accountId: "wx-account",
    senderId: "user-1",
    provider: "weixin",
    chatId: "chat-1",
    contextToken: "ctx-2",
    originalText: "分析引用内容",
    text: "分析引用内容",
    quotedContexts: [{
      kind: "link",
      title: "显式引用",
      text: "",
      url: "https://example.com/explicit",
      attachmentRefs: [],
    }],
    attachments: [],
    attachmentFailures: [],
    explicitPrompt: true,
    receivedAt: "2026-04-30T10:00:30.000Z",
  };
  const app = {
    pendingSharedContentInboundByScope: new Map([[scopeKey, {
      bindingKey: "binding-1",
      workspaceRoot: "/workspace",
      chatId: "chat-1",
      messages: [{ contentKind: "image" }],
      timer: null,
      lastContentAtMs: Date.parse("2026-04-30T10:00:00.000Z"),
    }]]),
    runtimeAdapter: {
      getSessionStore() {
        return { buildBindingKey() { return "binding-1"; } };
      },
    },
    streamDelivery: { setReplyTarget() {} },
    resolveWorkspaceRoot() { return "/workspace"; },
    async prepareIncomingMessageForRuntime() { return explicitPrompt; },
    hasPendingSharedContentInbound: CyberbossApp.prototype.hasPendingSharedContentInbound,
    dropPendingSharedContentInbound: CyberbossApp.prototype.dropPendingSharedContentInbound,
    dropPendingSharedContentInboundByScopeKey: CyberbossApp.prototype.dropPendingSharedContentInboundByScopeKey,
    clearPendingSharedContentInboundTimer: CyberbossApp.prototype.clearPendingSharedContentInboundTimer,
    async routePreparedInbound({ prepared }) {
      routed = prepared;
      return true;
    },
  };

  await CyberbossApp.prototype.handlePreparedMessage.call(app, explicitPrompt, { allowCommands: false });

  assert.equal(routed.quotedContexts.length, 1);
  assert.equal(routed.quotedContexts[0].url, "https://example.com/explicit");
  assert.equal(app.pendingSharedContentInboundByScope.size, 0);
});

test("pending image-only inbox messages merge into one clean inbound draft", () => {
  const merged = CyberbossApp.prototype.mergePendingInboundDraft.call({
    config: {
      userName: "User",
    },
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
    },
  }, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    messages: [{
      senderId: "user-1",
      accountId: "wx-account",
      workspaceId: "default",
      provider: "weixin",
      contextToken: "ctx-1",
      originalText: "",
      text: "old image prompt 1",
      attachments: [{
        kind: "image",
        contentType: "image/jpeg",
        isImage: true,
        absolutePath: "/tmp/a.jpg",
      }],
      attachmentFailures: [],
      receivedAt: "2026-04-30T10:00:00.000Z",
    }, {
      senderId: "user-1",
      accountId: "wx-account",
      workspaceId: "default",
      provider: "weixin",
      contextToken: "ctx-1",
      originalText: "",
      text: "old image prompt 2",
      attachments: [{
        kind: "image",
        contentType: "image/png",
        isImage: true,
        absolutePath: "/tmp/b.png",
      }],
      attachmentFailures: [],
      receivedAt: "2026-04-30T10:00:01.000Z",
    }],
  });

  assert.equal(merged.prepared.attachments.length, 2);
  assert.equal(merged.remainingMessages.length, 0);
  assert.equal(merged.prepared.text, "");
  assert.doesNotMatch(merged.prepared.text, /Saved attachments:/i);
  assert.doesNotMatch(merged.prepared.text, /Read every image first/i);
});

test("pending image-only inbox messages are split into batches of 10 attachments", () => {
  const merged = CyberbossApp.prototype.mergePendingInboundDraft.call({
    config: {
      userName: "User",
    },
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
    },
  }, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    messages: [{
      senderId: "user-1",
      accountId: "wx-account",
      workspaceId: "default",
      provider: "weixin",
      contextToken: "ctx-1",
      originalText: "",
      text: "old image prompt",
      attachments: Array.from({ length: 12 }, (_, index) => ({
        kind: "image",
        contentType: "image/jpeg",
        isImage: true,
        absolutePath: `/tmp/${index + 1}.jpg`,
      })),
      attachmentFailures: [],
      receivedAt: "2026-04-30T10:00:00.000Z",
    }],
  });

  assert.equal(merged.prepared.attachments.length, 10);
  assert.equal(merged.remainingMessages.length, 1);
  assert.equal(merged.remainingMessages[0].attachments.length, 2);
});

test("location arrive_home trigger enqueues a system action message", () => {
  const queued = [];
  CyberbossApp.prototype.handleLocationAccepted.call({
    activeAccountId: "wx-account",
    config: {
      allowedUserIds: ["user-1"],
      workspaceRoot: "/workspace",
      workspaceId: "default",
    },
    runtimeAdapter: {
      getSessionStore() {
        return {};
      },
    },
    systemMessageQueue: {
      enqueue(message) {
        queued.push(message);
        return message;
      },
    },
  }, {
    appended: {
      point: {
        id: "point-1",
        trigger: "arrive_home",
        timestamp: "2026-04-18T16:00:00.000Z",
        receivedAt: "2026-04-18T16:00:01.000Z",
      },
      movementEvent: null,
    },
  });

  assert.equal(queued.length, 1);
  assert.equal(queued[0].id, "location-trigger:point-1");
  assert.equal(queued[0].senderId, "user-1");
  assert.equal(queued[0].workspaceRoot, "/workspace");
  assert.equal(queued[0].text, "User arrives home.");
});

test("location leave_home trigger and major move both enqueue system action messages", () => {
  const queued = [];
  CyberbossApp.prototype.handleLocationAccepted.call({
    activeAccountId: "wx-account",
    config: {
      allowedUserIds: ["user-1"],
      workspaceRoot: "/workspace",
      workspaceId: "default",
    },
    runtimeAdapter: {
      getSessionStore() {
        return {};
      },
    },
    systemMessageQueue: {
      enqueue(message) {
        queued.push(message);
        return message;
      },
    },
  }, {
    appended: {
      point: {
        id: "point-2",
        trigger: "leave_home",
        timestamp: "2026-04-18T17:00:00.000Z",
        receivedAt: "2026-04-18T17:00:02.000Z",
      },
      movementEvent: {
        id: "move-1",
        distanceMeters: 2400,
        fromAddress: "Home",
        toAddress: "Office",
        movedAt: "2026-04-18T17:20:00.000Z",
      },
    },
  });

  assert.equal(queued.length, 2);
  assert.equal(queued[0].id, "location-trigger:point-2");
  assert.equal(queued[0].text, "User leaves home.");
  assert.equal(queued[1].id, "location-move:move-1");
  assert.match(queued[1].text, /location appears to have changed significantly/i);
});
