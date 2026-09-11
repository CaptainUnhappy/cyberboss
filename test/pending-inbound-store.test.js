const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { CyberbossApp } = require("../src/core/app");
const { PendingInboundStore } = require("../src/core/pending-inbound-store");
const {
  buildMergedInboundPrepared,
  clonePreparedInboundMessage,
} = require("../src/core/inbound-turn");

function createStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-pending-inbound-"));
  return {
    directory,
    filePath: path.join(directory, "pending-inbound.json"),
  };
}

function fixtureMessage(overrides = {}) {
  return {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    messageId: "weflow:301",
    contextToken: "context-1",
    provider: "weflow-uia",
    originalText: "检查状态",
    text: "检查状态",
    quotedContexts: [],
    attachments: [],
    attachmentFailures: [],
    receivedAt: "2026-08-24T02:00:00.000Z",
    ...overrides,
  };
}

test("pending inbound survives restart and deduplicates the same source message", () => {
  const { filePath } = createStore();
  const first = new PendingInboundStore({ filePath });
  const inserted = first.enqueue({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    message: fixtureMessage(),
  });
  const duplicate = first.enqueue({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    message: fixtureMessage({ contextToken: "new-context" }),
  });

  assert.equal(inserted.added, true);
  assert.equal(duplicate.added, false);
  const restored = new PendingInboundStore({ filePath }).snapshotMap();
  assert.equal(restored.size, 1);
  assert.equal(restored.get("binding-1::D:/workspace").messages.length, 1);
  assert.equal(restored.get("binding-1::D:/workspace").messages[0].contextToken, "context-1");
});

test("paired source message ids survive cloning, batching, and pending-store restart", () => {
  const paired = fixtureMessage({
    messageId: "weflow:378",
    sourceMessageIds: [" weflow:378 ", "weflow:379", "weflow:379", ""],
    text: "图中有什么",
    originalText: "图中有什么",
    attachments: [{ kind: "image", absolutePath: "D:/inbox/current.png" }],
  });
  const cloned = clonePreparedInboundMessage(paired);
  assert.deepEqual(cloned.sourceMessageIds, ["weflow:378", "weflow:379"]);

  const merged = buildMergedInboundPrepared({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    messages: [
      cloned,
      fixtureMessage({
        messageId: "weflow:380",
        sourceMessageIds: ["weflow:380", "weflow:379"],
        text: "补充问题",
        originalText: "补充问题",
      }),
    ],
  });
  assert.deepEqual(merged.sourceMessageIds, ["weflow:378", "weflow:379", "weflow:380"]);

  const { filePath } = createStore();
  new PendingInboundStore({ filePath }).enqueue({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    message: cloned,
  });
  const restored = new PendingInboundStore({ filePath })
    .snapshotMap()
    .get("binding-1::D:/workspace")
    .messages[0];
  assert.deepEqual(restored.sourceMessageIds, ["weflow:378", "weflow:379"]);
});

test("shared content survives restart until an in-window follow-up consumes it", async () => {
  const { filePath } = createStore();
  const firstStore = new PendingInboundStore({ filePath });
  const preparedShared = fixtureMessage({
    messageId: "weflow:shared-1",
    chatId: "weflow:wxid_main",
    originalText: "",
    text: "",
    contentKind: "image",
    sharedContent: true,
    explicitPrompt: false,
    receivedAt: "2026-08-24T02:00:00.000Z",
    attachments: [{ kind: "image", absolutePath: "D:/inbox/restart.png" }],
  });
  firstStore.enqueueSharedContent({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    chatId: preparedShared.chatId,
    message: preparedShared,
    lastContentAtMs: Date.parse(preparedShared.receivedAt),
  });

  const restartedStore = new PendingInboundStore({ filePath });
  const restored = restartedStore.snapshotSharedMap();
  const scopeKey = "binding-1::D:/workspace::weflow:wxid_main";
  assert.equal(restored.get(scopeKey).messages.length, 1);

  let routed = null;
  const appLike = {
    pendingInboundStore: restartedStore,
    pendingSharedContentInboundByScope: restored,
    clearPendingSharedContentInboundTimer: CyberbossApp.prototype.clearPendingSharedContentInboundTimer,
    commitPendingSharedContentConsumption: CyberbossApp.prototype.commitPendingSharedContentConsumption,
    schedulePendingSharedContentInboundExpiry: CyberbossApp.prototype.schedulePendingSharedContentInboundExpiry,
    async routePreparedInbound(payload) { routed = payload.prepared; },
  };
  await CyberbossApp.prototype.consumePendingSharedContentInbound.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    trailingPrepared: fixtureMessage({
      messageId: "weflow:shared-2",
      chatId: "weflow:wxid_main",
      originalText: "分析这张图",
      text: "分析这张图",
      receivedAt: "2026-08-24T02:00:10.000Z",
    }),
  });

  assert.equal(routed.attachments[0].absolutePath, "D:/inbox/restart.png");
  assert.equal(new PendingInboundStore({ filePath }).snapshotSharedMap().size, 0);
});

test("shared content consumption preserves a same-chat message that arrives during handoff", async () => {
  const { filePath } = createStore();
  const store = new PendingInboundStore({ filePath });
  const now = Date.now();
  const first = fixtureMessage({
    messageId: "weflow:shared-race-a",
    chatId: "weflow:wxid_main",
    originalText: "",
    text: "",
    contentKind: "image",
    sharedContent: true,
    explicitPrompt: false,
    receivedAt: new Date(now).toISOString(),
    attachments: [{ kind: "image", absolutePath: "D:/inbox/a.png" }],
  });
  store.enqueueSharedContent({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    chatId: first.chatId,
    message: first,
    lastContentAtMs: now,
  });
  let releaseRoute;
  const routeGate = new Promise((resolve) => { releaseRoute = resolve; });
  let routeStarted;
  const routeStartedPromise = new Promise((resolve) => { routeStarted = resolve; });
  const appLike = {
    pendingInboundStore: store,
    pendingSharedContentInboundByScope: store.snapshotSharedMap(),
    clearPendingSharedContentInboundTimer: CyberbossApp.prototype.clearPendingSharedContentInboundTimer,
    commitPendingSharedContentConsumption: CyberbossApp.prototype.commitPendingSharedContentConsumption,
    enqueuePendingSharedContentInbound: CyberbossApp.prototype.enqueuePendingSharedContentInbound,
    schedulePendingSharedContentInboundExpiry: CyberbossApp.prototype.schedulePendingSharedContentInboundExpiry,
    async routePreparedInbound() {
      routeStarted();
      await routeGate;
    },
  };
  const consuming = CyberbossApp.prototype.consumePendingSharedContentInbound.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    trailingPrepared: fixtureMessage({
      messageId: "weflow:shared-race-prompt",
      chatId: first.chatId,
      originalText: "先看第一张",
      text: "先看第一张",
      receivedAt: new Date(now + 1_000).toISOString(),
    }),
  });
  await routeStartedPromise;
  CyberbossApp.prototype.enqueuePendingSharedContentInbound.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    prepared: fixtureMessage({
      messageId: "weflow:shared-race-c",
      chatId: first.chatId,
      originalText: "",
      text: "",
      contentKind: "image",
      sharedContent: true,
      explicitPrompt: false,
      receivedAt: new Date(now + 2_000).toISOString(),
      attachments: [{ kind: "image", absolutePath: "D:/inbox/c.png" }],
    }),
  });
  releaseRoute();
  await consuming;

  const scopeKey = "binding-1::D:/workspace::weflow:wxid_main";
  const retained = new PendingInboundStore({ filePath }).snapshotSharedMap().get(scopeKey);
  assert.deepEqual(retained.messages.map((message) => message.messageId), ["weflow:shared-race-c"]);
  assert.deepEqual(appLike.pendingSharedContentInboundByScope.get(scopeKey).messages.map(
    (message) => message.messageId
  ), ["weflow:shared-race-c"]);
  CyberbossApp.prototype.clearPendingSharedContentInboundTimer.call(appLike, scopeKey);
});

test("acknowledgement claim is durable and can only be acquired once", () => {
  const { filePath } = createStore();
  const first = new PendingInboundStore({ filePath, now: () => Date.parse("2026-08-24T02:01:00Z") });
  const inserted = first.enqueue({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    message: fixtureMessage(),
  });

  assert.equal(first.claimAcknowledgement(inserted.scopeKey, inserted.message.pendingId), true);
  assert.equal(first.claimAcknowledgement(inserted.scopeKey, inserted.message.pendingId), false);
  const restarted = new PendingInboundStore({ filePath });
  assert.equal(restarted.claimAcknowledgement(inserted.scopeKey, inserted.message.pendingId), false);
  restarted.completeAcknowledgement(inserted.scopeKey, inserted.message.pendingId, { success: true });
  assert.equal(restarted.getScope(inserted.scopeKey).messages[0].acknowledgementStatus, "sent");
});

test("scope removal is persisted only after the queued handoff succeeds", () => {
  const { filePath } = createStore();
  const first = new PendingInboundStore({ filePath });
  const inserted = first.enqueue({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    message: fixtureMessage(),
  });
  assert.equal(first.removeScope(inserted.scopeKey), true);
  assert.equal(new PendingInboundStore({ filePath }).snapshotMap().size, 0);
});

test("dispatch commit removes only consumed ids while preserving concurrent and partial-image work", () => {
  const { filePath } = createStore();
  const store = new PendingInboundStore({ filePath });
  const first = store.enqueue({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    message: fixtureMessage({
      attachments: [{ id: 1 }, { id: 2 }],
      acknowledgementStatus: "sent",
      acknowledgementAt: "2026-08-24T02:00:00Z",
    }),
  });
  store.enqueue({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    message: fixtureMessage({ messageId: "weflow:302", receivedAt: "2026-08-24T02:00:01Z" }),
  });
  store.commitDispatch(first.scopeKey, [first.message.pendingId], {
    remainingMessages: [{ ...first.message, attachments: [{ id: 2 }] }],
  });

  const restarted = new PendingInboundStore({ filePath });
  const messages = restarted.getScope(first.scopeKey).messages;
  assert.deepEqual(messages.map((message) => message.messageId), ["weflow:301", "weflow:302"]);
  assert.deepEqual(messages[0].attachments, [{ id: 2 }]);
  assert.equal(messages[0].acknowledgementStatus, "sent");
  assert.equal(restarted.isCompleted(first.scopeKey, "weflow:301"), true);
});

test("failed runtime dispatch keeps the durable message queued and untombstoned", async () => {
  const { filePath } = createStore();
  const store = new PendingInboundStore({ filePath });
  const inserted = store.enqueue({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    message: fixtureMessage({ provider: "weixin" }),
  });
  const appLike = {
    pendingInboundStore: store,
    pendingInboundByScope: store.snapshotMap(),
    pendingInboundFlushScopeKeys: new Set(),
    isTurnDispatchBlocked() { return false; },
    async dispatchPreparedTurn() { return false; },
    commitPendingInboundDispatch: CyberbossApp.prototype.commitPendingInboundDispatch,
    mergePendingInboundDraft: CyberbossApp.prototype.mergePendingInboundDraft,
  };

  await CyberbossApp.prototype.flushPendingInboundMessages.call(appLike);

  const restarted = new PendingInboundStore({ filePath });
  assert.equal(restarted.getScope(inserted.scopeKey).messages.length, 1);
  assert.equal(restarted.isCompleted(inserted.scopeKey, inserted.message.pendingId), false);
});

test("busy UIA inbound acknowledges once and a restarted app dispatches the durable handoff once", async () => {
  const { filePath } = createStore();
  const acknowledgements = [];
  const dispatched = [];
  const prepared = fixtureMessage();

  function buildAppLike(store, { blocked }) {
    return {
      pendingInboundStore: store,
      pendingInboundByScope: store.snapshotMap(),
      pendingInboundFlushScopeKeys: new Set(),
      channelAdapter: {
        async sendTyping() {},
        async sendText(payload) { acknowledgements.push(payload); },
      },
      isTurnDispatchBlocked() { return blocked; },
      async dispatchPreparedTurn(payload) {
        dispatched.push(payload);
        return true;
      },
      acknowledgeWeFlowUiaInbound: CyberbossApp.prototype.acknowledgeWeFlowUiaInbound,
      acknowledgeBufferedInboundOnce: CyberbossApp.prototype.acknowledgeBufferedInboundOnce,
      bufferPendingInboundMessage: CyberbossApp.prototype.bufferPendingInboundMessage,
      commitPendingInboundDispatch: CyberbossApp.prototype.commitPendingInboundDispatch,
      findPendingInboundMessage: CyberbossApp.prototype.findPendingInboundMessage,
      flushPendingInboundMessages: CyberbossApp.prototype.flushPendingInboundMessages,
      isCompletedPendingInbound: CyberbossApp.prototype.isCompletedPendingInbound,
      mergePendingInboundDraft: CyberbossApp.prototype.mergePendingInboundDraft,
      removePendingInboundScope: CyberbossApp.prototype.removePendingInboundScope,
    };
  }

  const firstStore = new PendingInboundStore({ filePath });
  const busyApp = buildAppLike(firstStore, { blocked: true });
  const route = CyberbossApp.prototype.routePreparedInbound;
  await route.call(busyApp, { bindingKey: "binding-1", workspaceRoot: "D:/workspace", prepared });
  await route.call(busyApp, { bindingKey: "binding-1", workspaceRoot: "D:/workspace", prepared });

  assert.equal(acknowledgements.length, 1);
  assert.equal(dispatched.length, 0);
  assert.equal(new PendingInboundStore({ filePath }).snapshotMap().size, 1);

  const restartedStore = new PendingInboundStore({ filePath });
  const restartedApp = buildAppLike(restartedStore, { blocked: false });
  await route.call(restartedApp, { bindingKey: "binding-1", workspaceRoot: "D:/workspace", prepared });
  await CyberbossApp.prototype.flushPendingInboundMessages.call(restartedApp);
  const replayedApp = buildAppLike(new PendingInboundStore({ filePath }), { blocked: false });
  await route.call(replayedApp, { bindingKey: "binding-1", workspaceRoot: "D:/workspace", prepared });

  assert.equal(acknowledgements.length, 1);
  assert.equal(dispatched.length, 1);
  assert.equal(new PendingInboundStore({ filePath }).snapshotMap().size, 0);
});

test("an accepted turn is not redispatched while its durable commit is retried", async () => {
  const scopeKey = "binding-1::D:/workspace";
  const draft = {
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    messages: [fixtureMessage()],
  };
  let dispatchCount = 0;
  let commitCount = 0;
  const appLike = {
    pendingInboundByScope: new Map([[scopeKey, draft]]),
    pendingInboundFlushScopeKeys: new Set(),
    pendingInboundPostDispatchCommits: new Map(),
    isTurnDispatchBlocked() { return false; },
    async dispatchPreparedTurn() {
      dispatchCount += 1;
      return true;
    },
    commitPendingInboundDispatch() {
      commitCount += 1;
      if (commitCount === 1) {
        throw new Error("fixture durable commit failure");
      }
      this.pendingInboundByScope.delete(scopeKey);
      return null;
    },
    mergePendingInboundDraft: CyberbossApp.prototype.mergePendingInboundDraft,
  };

  await CyberbossApp.prototype.flushPendingInboundMessages.call(appLike);
  assert.equal(dispatchCount, 1);
  assert.equal(commitCount, 1);
  assert.equal(appLike.pendingInboundByScope.has(scopeKey), true);
  assert.equal(appLike.pendingInboundPostDispatchCommits.has(scopeKey), true);

  appLike.pendingInboundPostDispatchCommits.get(scopeKey).nextRetryAtMs = 0;
  await CyberbossApp.prototype.flushPendingInboundMessages.call(appLike);
  assert.equal(dispatchCount, 1);
  assert.equal(commitCount, 2);
  assert.equal(appLike.pendingInboundByScope.has(scopeKey), false);
  assert.equal(appLike.pendingInboundPostDispatchCommits.has(scopeKey), false);
});

test("a new message joins older durable work instead of overtaking it", async () => {
  const { filePath } = createStore();
  const store = new PendingInboundStore({ filePath });
  store.enqueue({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    message: fixtureMessage({
      messageId: "weflow:401",
      originalText: "第一条",
      text: "第一条",
      receivedAt: "2026-08-24T02:00:00.000Z",
      acknowledgementStatus: "sent",
    }),
  });
  const dispatched = [];
  const appLike = {
    pendingInboundStore: store,
    pendingInboundByScope: store.snapshotMap(),
    pendingInboundFlushScopeKeys: new Set(),
    pendingInboundPostDispatchCommits: new Map(),
    channelAdapter: { async sendTyping() {} },
    isTurnDispatchBlocked() { return false; },
    async acknowledgeBufferedInboundOnce() { return false; },
    async dispatchPreparedTurn(payload) {
      dispatched.push(payload);
      return true;
    },
    bufferPendingInboundMessage: CyberbossApp.prototype.bufferPendingInboundMessage,
    commitPendingInboundDispatch: CyberbossApp.prototype.commitPendingInboundDispatch,
    flushPendingInboundMessages: CyberbossApp.prototype.flushPendingInboundMessages,
    isCompletedPendingInbound: CyberbossApp.prototype.isCompletedPendingInbound,
    mergePendingInboundDraft: CyberbossApp.prototype.mergePendingInboundDraft,
  };

  await CyberbossApp.prototype.routePreparedInbound.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    prepared: fixtureMessage({
      messageId: "weflow:402",
      originalText: "第二条",
      text: "第二条",
      receivedAt: "2026-08-24T02:00:01.000Z",
    }),
  });

  assert.equal(dispatched.length, 1);
  assert.match(dispatched[0].prepared.text, /第一条[\s\S]*第二条/);
  assert.equal(new PendingInboundStore({ filePath }).snapshotMap().size, 0);
});

test("a failed direct handoff remains durable and dispatches after restart", async () => {
  const { filePath } = createStore();
  const prepared = fixtureMessage({ messageId: "weflow:501" });
  let failedDispatches = 0;
  const firstStore = new PendingInboundStore({ filePath });
  const firstApp = {
    pendingInboundStore: firstStore,
    pendingInboundByScope: firstStore.snapshotMap(),
    pendingInboundFlushScopeKeys: new Set(),
    pendingInboundPostDispatchCommits: new Map(),
    channelAdapter: { async sendTyping() {} },
    isTurnDispatchBlocked() { return false; },
    async acknowledgeBufferedInboundOnce() { return false; },
    async dispatchPreparedTurn() {
      failedDispatches += 1;
      return false;
    },
    bufferPendingInboundMessage: CyberbossApp.prototype.bufferPendingInboundMessage,
    commitPendingInboundDispatch: CyberbossApp.prototype.commitPendingInboundDispatch,
    flushPendingInboundMessages: CyberbossApp.prototype.flushPendingInboundMessages,
    isCompletedPendingInbound: CyberbossApp.prototype.isCompletedPendingInbound,
    mergePendingInboundDraft: CyberbossApp.prototype.mergePendingInboundDraft,
  };

  await CyberbossApp.prototype.routePreparedInbound.call(firstApp, {
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    prepared,
  });
  assert.equal(failedDispatches, 1);
  const deferredDraft = [...new PendingInboundStore({ filePath }).snapshotMap().values()][0];
  assert.equal(deferredDraft.dispatchAttemptCount, 1);
  assert.ok(Date.parse(deferredDraft.nextDispatchAt) > Date.now());

  // Main-loop flushes during the cooldown must not hammer the runtime or send
  // the same failure response again.
  await CyberbossApp.prototype.flushPendingInboundMessages.call(firstApp);
  assert.equal(failedDispatches, 1);

  let recoveredDispatches = 0;
  const recoveredStore = new PendingInboundStore({ filePath });
  const recoveredApp = {
    ...firstApp,
    pendingInboundStore: recoveredStore,
    pendingInboundByScope: recoveredStore.snapshotMap(),
    pendingInboundFlushScopeKeys: new Set(),
    pendingInboundPostDispatchCommits: new Map(),
    async dispatchPreparedTurn() {
      recoveredDispatches += 1;
      return true;
    },
  };
  await CyberbossApp.prototype.flushPendingInboundMessages.call(recoveredApp);
  assert.equal(recoveredDispatches, 0);

  // Simulate the persisted retry deadline becoming due without waiting 15s.
  recoveredApp.pendingInboundByScope.get(deferredDraft.scopeKey).nextDispatchAt = "";
  await CyberbossApp.prototype.flushPendingInboundMessages.call(recoveredApp);

  assert.equal(recoveredDispatches, 1);
  assert.equal(new PendingInboundStore({ filePath }).snapshotMap().size, 0);
});

test("mixed pending messages keep attachments and quoted context from earlier messages", () => {
  const result = CyberbossApp.prototype.mergePendingInboundDraft({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    messages: [
      fixtureMessage({
        messageId: "weflow:601",
        originalText: "",
        text: "",
        receivedAt: "2026-08-24T02:00:00.000Z",
        attachments: [{ kind: "image", absolutePath: "D:/inbox/photo.png" }],
        quotedContexts: [{ kind: "text", text: "前序引用", attachmentRefs: [] }],
      }),
      fixtureMessage({
        messageId: "weflow:602",
        originalText: "分析这张图",
        text: "分析这张图",
        receivedAt: "2026-08-24T02:00:01.000Z",
      }),
    ],
  });

  assert.equal(result.prepared.attachments.length, 1);
  assert.equal(result.prepared.attachments[0].absolutePath, "D:/inbox/photo.png");
  assert.equal(result.prepared.quotedContexts.length, 1);
  assert.match(result.prepared.originalText, /分析这张图/);
  assert.deepEqual(result.consumedIds, ["weflow:601", "weflow:602"]);
});

test("shared handoff metadata does not split one inactivity-window batch", () => {
  const handoffScopeKey = "binding-1::D:/workspace::weflow:wxid_current";
  const messages = [
    fixtureMessage({
      messageId: "weflow:boundary-before-1",
      originalText: "边界前第一条",
      text: "边界前第一条",
      receivedAt: "2026-08-24T02:01:00.000Z",
    }),
    fixtureMessage({
      messageId: "weflow:boundary-before-2",
      originalText: "边界前第二条",
      text: "边界前第二条",
      receivedAt: "2026-08-24T02:01:01.000Z",
    }),
    fixtureMessage({
      messageId: "weflow:boundary-handoff",
      originalText: "解释当前图片",
      text: "解释当前图片",
      receivedAt: "2026-08-24T02:01:02.000Z",
      sharedHandoffScopeKey: handoffScopeKey,
      quotedContexts: [{
        kind: "image",
        title: "当前图片",
        attachmentRefs: ["implicit:current:1"],
      }],
      attachments: [{
        kind: "image",
        absolutePath: "D:/inbox/current.png",
        attachmentRef: "implicit:current:1",
      }],
    }),
    fixtureMessage({
      messageId: "weflow:boundary-after",
      originalText: "边界后的新问题",
      text: "边界后的新问题",
      receivedAt: "2026-08-24T02:01:03.000Z",
    }),
  ];

  const merged = CyberbossApp.prototype.mergePendingInboundDraft({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    messages,
  });
  assert.deepEqual(merged.consumedIds, messages.map((message) => message.messageId));
  assert.equal(merged.prepared.attachments[0].absolutePath, "D:/inbox/current.png");
  assert.match(
    merged.prepared.text,
    /边界前第一条[\s\S]*边界前第二条[\s\S]*解释当前图片[\s\S]*边界后的新问题/,
  );
  assert.deepEqual(merged.remainingMessages, []);
});

test("pending flush preserves the shared handoff scope key in its prepared projection", async () => {
  const scopeKey = "binding-1::D:/workspace";
  const handoffScopeKey = `${scopeKey}::weflow:wxid_current`;
  const draft = {
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    messages: [fixtureMessage({
      messageId: "weflow:projected-handoff",
      originalText: "解释当前图片",
      text: "解释当前图片",
      sharedHandoffScopeKey: handoffScopeKey,
      attachments: [{ kind: "image", absolutePath: "D:/inbox/projected.png" }],
    })],
  };
  let dispatchedPrepared = null;
  const appLike = {
    pendingInboundByScope: new Map([[scopeKey, draft]]),
    pendingInboundFlushScopeKeys: new Set(),
    pendingInboundPostDispatchCommits: new Map(),
    isTurnDispatchBlocked() { return false; },
    async dispatchPreparedTurn(payload) {
      dispatchedPrepared = payload.prepared;
      return true;
    },
    commitPendingInboundDispatch() {
      this.pendingInboundByScope.delete(scopeKey);
      return null;
    },
    mergePendingInboundDraft: CyberbossApp.prototype.mergePendingInboundDraft,
  };

  await CyberbossApp.prototype.flushPendingInboundMessages.call(appLike);

  assert.equal(dispatchedPrepared.sharedHandoffScopeKey, handoffScopeKey);
  assert.equal(dispatchedPrepared.originalText, "解释当前图片");
  assert.equal(appLike.pendingInboundByScope.size, 0);
});

test("mixed durable inbound batches are bounded and preserve the exact ordered suffix", () => {
  const messages = Array.from({ length: 35 }, (_, index) => fixtureMessage({
    messageId: `weflow:bounded-${index + 1}`,
    originalText: `message-${index + 1}`,
    text: `message-${index + 1}`,
    receivedAt: new Date(Date.parse("2026-08-24T02:10:00.000Z") + index).toISOString(),
    attachments: [{ kind: "file", absolutePath: `D:/inbox/${index + 1}.bin` }],
  }));

  const result = CyberbossApp.prototype.mergePendingInboundDraft({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    messages,
  });

  assert.equal(result.consumedIds.length, 10);
  assert.deepEqual(result.consumedIds, messages.slice(0, 10).map((message) => message.messageId));
  assert.deepEqual(
    result.remainingMessages.map((message) => message.messageId),
    messages.slice(10).map((message) => message.messageId),
  );
  assert.equal(result.prepared.attachments.length, 10);

  const textLimited = CyberbossApp.prototype.mergePendingInboundDraft({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    messages: Array.from({ length: 30 }, (_, index) => fixtureMessage({
      messageId: `weflow:text-bounded-${index + 1}`,
      originalText: `${index + 1}:${"x".repeat(1_998)}`,
      text: `${index + 1}:${"x".repeat(1_998)}`,
      receivedAt: new Date(Date.parse("2026-08-24T02:11:00.000Z") + index).toISOString(),
    })),
  });
  assert.ok(textLimited.consumedIds.length > 0);
  assert.ok(textLimited.consumedIds.length < 20);
  assert.equal(textLimited.consumedIds.length + textLimited.remainingMessages.length, 30);

  const messageLimited = CyberbossApp.prototype.mergePendingInboundDraft({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    messages: Array.from({ length: 35 }, (_, index) => fixtureMessage({
      messageId: `weflow:count-bounded-${index + 1}`,
      originalText: `m${index + 1}`,
      text: `m${index + 1}`,
      receivedAt: new Date(Date.parse("2026-08-24T02:12:00.000Z") + index).toISOString(),
    })),
  });
  assert.equal(messageLimited.consumedIds.length, 20);
  assert.equal(messageLimited.remainingMessages.length, 15);

  const oversizedAttachmentMessage = fixtureMessage({
    messageId: "weflow:mixed-oversized-attachments",
    originalText: "只需解释一次的附件说明",
    text: "只需解释一次的附件说明",
    attachments: Array.from({ length: 25 }, (_, index) => ({
      kind: "file",
      absolutePath: `D:/inbox/oversized-${index + 1}.bin`,
      attachmentRef: `oversized:${index + 1}`,
    })),
  });
  const attachmentSplit = CyberbossApp.prototype.mergePendingInboundDraft({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    messages: [oversizedAttachmentMessage],
  });
  assert.deepEqual(attachmentSplit.consumedIds, [oversizedAttachmentMessage.messageId]);
  assert.equal(attachmentSplit.prepared.attachments.length, 10);
  assert.equal(attachmentSplit.remainingMessages.length, 1);
  assert.equal(attachmentSplit.remainingMessages[0].attachments.length, 15);
  assert.equal(attachmentSplit.remainingMessages[0].originalText, "");
  assert.equal(attachmentSplit.remainingMessages[0].messageId, oversizedAttachmentMessage.messageId);
});

test("an oversized first durable message cannot poison later bounded batches", async () => {
  const { filePath } = createStore();
  const store = new PendingInboundStore({ filePath });
  const poisonText = `poison:${"p".repeat(30_000)}`;
  store.enqueue({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    message: fixtureMessage({
      messageId: "weflow:poison",
      originalText: poisonText,
      text: poisonText,
      receivedAt: "2026-08-24T02:20:00.000Z",
    }),
  });
  for (let index = 0; index < 25; index += 1) {
    store.enqueue({
      bindingKey: "binding-1",
      workspaceRoot: "D:/workspace",
      message: fixtureMessage({
        messageId: `weflow:after-poison-${index + 1}`,
        originalText: `after-poison-${index + 1}`,
        text: `after-poison-${index + 1}`,
        receivedAt: new Date(Date.parse("2026-08-24T02:20:01.000Z") + index).toISOString(),
      }),
    });
  }

  const dispatched = [];
  const appLike = {
    pendingInboundStore: store,
    pendingInboundByScope: store.snapshotMap(),
    pendingInboundFlushScopeKeys: new Set(),
    pendingInboundPostDispatchCommits: new Map(),
    isTurnDispatchBlocked() { return false; },
    async dispatchPreparedTurn(payload) {
      dispatched.push(payload.prepared.text);
      return true;
    },
    commitPendingInboundDispatch: CyberbossApp.prototype.commitPendingInboundDispatch,
    mergePendingInboundDraft: CyberbossApp.prototype.mergePendingInboundDraft,
  };

  await CyberbossApp.prototype.flushPendingInboundMessages.call(appLike);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0], poisonText);
  assert.equal([...appLike.pendingInboundByScope.values()][0].messages.length, 25);

  await CyberbossApp.prototype.flushPendingInboundMessages.call(appLike);
  assert.equal(dispatched.length, 2);
  assert.match(dispatched[1], /after-poison-1/);
  assert.doesNotMatch(dispatched[1], /poison:p/);

  for (let index = 0; index < 10 && appLike.pendingInboundByScope.size; index += 1) {
    await CyberbossApp.prototype.flushPendingInboundMessages.call(appLike);
  }
  assert.equal(appLike.pendingInboundByScope.size, 0);
  assert.equal(new PendingInboundStore({ filePath }).snapshotMap().size, 0);
});

test("large shared-content handoff keeps every attachment for bounded normal dispatch", async () => {
  const { filePath } = createStore();
  const store = new PendingInboundStore({ filePath });
  const baseTime = Date.now();
  const chatId = "weflow:wxid_bounded_shared";
  store.enqueueSharedContent({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    chatId,
    message: fixtureMessage({
      messageId: "weflow:shared-bounded",
      chatId,
      originalText: "",
      text: "",
      contentKind: "image",
      sharedContent: true,
      explicitPrompt: false,
      receivedAt: new Date(baseTime).toISOString(),
      attachments: Array.from({ length: 25 }, (_, index) => ({
        kind: "image",
        absolutePath: `D:/inbox/shared-${index + 1}.png`,
      })),
    }),
    lastContentAtMs: baseTime,
  });

  const routedBatches = [];
  const appLike = {
    pendingInboundStore: store,
    pendingSharedContentInboundByScope: store.snapshotSharedMap(),
    clearPendingSharedContentInboundTimer: CyberbossApp.prototype.clearPendingSharedContentInboundTimer,
    commitPendingSharedContentConsumption: CyberbossApp.prototype.commitPendingSharedContentConsumption,
    schedulePendingSharedContentInboundExpiry: CyberbossApp.prototype.schedulePendingSharedContentInboundExpiry,
    async routePreparedInbound(payload) {
      routedBatches.push({
        messageId: payload.prepared.messageId,
        acknowledgementStatus: payload.prepared.acknowledgementStatus || "",
        attachmentPaths: payload.prepared.attachments.map((item) => item.absolutePath),
        prepared: payload.prepared,
      });
    },
  };
  const consume = (messageId, receivedAt) => CyberbossApp.prototype.consumePendingSharedContentInbound.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    trailingPrepared: fixtureMessage({
      messageId,
      chatId,
      originalText: "分析这些图片",
      text: "分析这些图片",
      receivedAt,
    }),
  });

  await consume("weflow:shared-bounded-prompt-1", new Date(baseTime + 1_000).toISOString());
  const scopeKey = `binding-1::D:/workspace::${chatId}`;
  assert.deepEqual(routedBatches.map((batch) => batch.attachmentPaths.length), [25]);
  assert.deepEqual(routedBatches.map((batch) => batch.acknowledgementStatus), [""]);
  assert.match(routedBatches[0].messageId, /^weflow:shared-bounded-prompt-1:shared:/);
  assert.equal(new PendingInboundStore({ filePath }).snapshotSharedMap().has(scopeKey), false);
  assert.equal(
    new PendingInboundStore({ filePath }).isCompleted(
      "binding-1::D:/workspace",
      "weflow:shared-bounded-prompt-1"
    ),
    true
  );
  const normalRuntimeBatchSizes = [];
  let normalRemainder = [routedBatches[0].prepared];
  while (normalRemainder.length) {
    const dispatch = CyberbossApp.prototype.mergePendingInboundDraft({
      bindingKey: "binding-1",
      workspaceRoot: "D:/workspace",
      messages: normalRemainder,
    });
    normalRuntimeBatchSizes.push(dispatch.prepared.attachments.length);
    normalRemainder = dispatch.remainingMessages;
  }
  assert.deepEqual(normalRuntimeBatchSizes, [10, 10, 5]);
});

test("shared prompt recovery resumes with stable content ids after the first batch commit", async () => {
  const { filePath } = createStore();
  const baseTime = Date.now();
  const chatId = "weflow:wxid_shared_crash";
  const promptId = "weflow:shared-crash-prompt";
  const store = new PendingInboundStore({ filePath });
  const expectedPaths = [];
  [10, 10, 5].forEach((attachmentCount, messageIndex) => {
    const attachments = Array.from({ length: attachmentCount }, (_value, attachmentIndex) => {
      const absolutePath = `D:/inbox/crash-${messageIndex + 1}-${attachmentIndex + 1}.png`;
      expectedPaths.push(absolutePath);
      return { kind: "image", absolutePath };
    });
    store.enqueueSharedContent({
      bindingKey: "binding-1",
      workspaceRoot: "D:/workspace",
      chatId,
      message: fixtureMessage({
        messageId: `weflow:shared-crash-${messageIndex + 1}`,
        chatId,
        originalText: "",
        text: "",
        contentKind: "image",
        sharedContent: true,
        explicitPrompt: false,
        receivedAt: new Date(baseTime + messageIndex).toISOString(),
        attachments,
      }),
      lastContentAtMs: baseTime + messageIndex,
    });
  });
  const prompt = fixtureMessage({
    messageId: promptId,
    chatId,
    originalText: "分析这些图片",
    text: "分析这些图片",
    receivedAt: new Date(baseTime + 1_000).toISOString(),
  });
  const firstRouted = [];
  const firstApp = {
    pendingInboundStore: store,
    pendingSharedContentInboundByScope: store.snapshotSharedMap(),
    clearPendingSharedContentInboundTimer: CyberbossApp.prototype.clearPendingSharedContentInboundTimer,
    commitPendingSharedContentConsumption: CyberbossApp.prototype.commitPendingSharedContentConsumption,
    schedulePendingSharedContentInboundExpiry: CyberbossApp.prototype.schedulePendingSharedContentInboundExpiry,
    async routePreparedInbound(payload) {
      if (firstRouted.length) {
        throw new Error("fixture crash after first shared commit");
      }
      firstRouted.push(payload.prepared);
    },
  };

  await assert.rejects(
    CyberbossApp.prototype.consumePendingSharedContentInbound.call(firstApp, {
      bindingKey: "binding-1",
      workspaceRoot: "D:/workspace",
      trailingPrepared: prompt,
    }),
    /fixture crash/
  );
  const scopeKey = `binding-1::D:/workspace::${chatId}`;
  CyberbossApp.prototype.clearPendingSharedContentInboundTimer.call(firstApp, scopeKey);
  const afterCrash = new PendingInboundStore({ filePath }).snapshotSharedMap().get(scopeKey);
  assert.equal(afterCrash.messages.length, 2);
  assert.equal(afterCrash.activePromptId, promptId);
  assert.equal(afterCrash.promptAcknowledged, true);

  const recoveredStore = new PendingInboundStore({ filePath });
  const recoveredRouted = [];
  const recoveredApp = {
    pendingInboundStore: recoveredStore,
    pendingSharedContentInboundByScope: recoveredStore.snapshotSharedMap(),
    clearPendingSharedContentInboundTimer: CyberbossApp.prototype.clearPendingSharedContentInboundTimer,
    commitPendingSharedContentConsumption: CyberbossApp.prototype.commitPendingSharedContentConsumption,
    schedulePendingSharedContentInboundExpiry: CyberbossApp.prototype.schedulePendingSharedContentInboundExpiry,
    async routePreparedInbound(payload) {
      recoveredRouted.push(payload.prepared);
    },
  };
  await CyberbossApp.prototype.consumePendingSharedContentInbound.call(recoveredApp, {
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    trailingPrepared: prompt,
  });

  const routed = [...firstRouted, ...recoveredRouted];
  assert.equal(new Set(routed.map((item) => item.messageId)).size, 3);
  assert.deepEqual(recoveredRouted.map((item) => item.acknowledgementStatus), ["sent", "sent"]);
  assert.deepEqual(
    routed.flatMap((item) => item.attachments.map((attachment) => attachment.absolutePath)),
    expectedPaths
  );
  assert.equal(recoveredStore.snapshotSharedMap().size, 0);
  assert.equal(recoveredStore.isCompleted("binding-1::D:/workspace", promptId), true);
  let replayBuffered = false;
  await CyberbossApp.prototype.routePreparedInbound.call({
    pendingInboundStore: recoveredStore,
    isCompletedPendingInbound: CyberbossApp.prototype.isCompletedPendingInbound,
    bufferPendingInboundMessage() {
      replayBuffered = true;
      throw new Error("completed source prompt must not be buffered again");
    },
  }, {
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    prepared: prompt,
  });
  assert.equal(replayBuffered, false);
});

test("a full shared queue can hand off into normal durable work without a capacity deadlock", async () => {
  const { filePath } = createStore();
  const store = new PendingInboundStore({ filePath, maxMessages: 2 });
  const baseTime = Date.now();
  const chatId = "weflow:wxid_full_shared";
  for (let index = 0; index < 2; index += 1) {
    store.enqueueSharedContent({
      bindingKey: "binding-1",
      workspaceRoot: "D:/workspace",
      chatId,
      message: fixtureMessage({
        messageId: `weflow:full-shared-${index + 1}`,
        chatId,
        originalText: "",
        text: "",
        contentKind: "link",
        contentUrl: `https://example.com/${index + 1}`,
        sharedContent: true,
        explicitPrompt: false,
        receivedAt: new Date(baseTime + index).toISOString(),
      }),
      lastContentAtMs: baseTime + index,
    });
  }
  const appLike = {
    pendingInboundStore: store,
    pendingInboundByScope: store.snapshotMap(),
    pendingSharedContentInboundByScope: store.snapshotSharedMap(),
    channelAdapter: { async sendTyping() {} },
    bufferPendingInboundMessage: CyberbossApp.prototype.bufferPendingInboundMessage,
    clearPendingSharedContentInboundTimer: CyberbossApp.prototype.clearPendingSharedContentInboundTimer,
    commitPendingSharedContentConsumption: CyberbossApp.prototype.commitPendingSharedContentConsumption,
    schedulePendingSharedContentInboundExpiry: CyberbossApp.prototype.schedulePendingSharedContentInboundExpiry,
    async routePreparedInbound(payload) {
      CyberbossApp.prototype.bufferPendingInboundMessage.call(this, payload);
    },
  };

  await CyberbossApp.prototype.consumePendingSharedContentInbound.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    trailingPrepared: fixtureMessage({
      messageId: "weflow:full-shared-prompt",
      chatId,
      originalText: "总结刚才的链接",
      text: "总结刚才的链接",
      receivedAt: new Date(baseTime + 1_000).toISOString(),
    }),
  });

  const restored = new PendingInboundStore({ filePath, maxMessages: 2 });
  assert.equal(restored.snapshotSharedMap().size, 0);
  assert.equal(restored.snapshotMap().size, 1);
  assert.equal([...restored.snapshotMap().values()][0].messages.length, 1);
  assert.equal(restored.isCompleted("binding-1::D:/workspace", "weflow:full-shared-prompt"), true);
});

test("restart preserves an expired shared-content deadline and promotes it immediately", async () => {
  const { filePath } = createStore();
  const historicalTime = Date.now() - (5 * 60_000);
  const chatId = "weflow:wxid_historical_shared";
  const store = new PendingInboundStore({ filePath });
  store.enqueueSharedContent({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    chatId,
    message: fixtureMessage({
      messageId: "weflow:historical-shared",
      chatId,
      originalText: "",
      text: "",
      contentKind: "image",
      sharedContent: true,
      explicitPrompt: false,
      receivedAt: new Date(historicalTime).toISOString(),
      attachments: [{ kind: "image", absolutePath: "D:/inbox/historical.png" }],
    }),
    lastContentAtMs: historicalTime,
  });

  const routed = [];
  const recoveredStore = new PendingInboundStore({ filePath });
  const appLike = {
    pendingInboundStore: recoveredStore,
    pendingInboundByScope: recoveredStore.snapshotMap(),
    pendingSharedContentInboundByScope: recoveredStore.snapshotSharedMap(),
    restorePendingSharedContentInboundTimers: CyberbossApp.prototype.restorePendingSharedContentInboundTimers,
    schedulePendingSharedContentInboundExpiry: CyberbossApp.prototype.schedulePendingSharedContentInboundExpiry,
    clearPendingSharedContentInboundTimer: CyberbossApp.prototype.clearPendingSharedContentInboundTimer,
    commitPendingSharedContentConsumption: CyberbossApp.prototype.commitPendingSharedContentConsumption,
    promotePendingSharedContentInbound: CyberbossApp.prototype.promotePendingSharedContentInbound,
    async routePreparedInbound(payload) {
      routed.push(payload.prepared);
    },
  };

  CyberbossApp.prototype.restorePendingSharedContentInboundTimers.call(appLike);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(routed.length, 1);
  assert.equal(routed[0].attachments[0].absolutePath, "D:/inbox/historical.png");
  assert.equal(appLike.pendingSharedContentInboundByScope.size, 0);
  assert.equal(new PendingInboundStore({ filePath }).snapshotSharedMap().size, 0);
  assert.equal(new PendingInboundStore({ filePath }).snapshotMap().size, 1);
});

test("a unique t0/t6/t10 sequence slides one scope deadline to t25 while a duplicate does not", () => {
  const { filePath } = createStore();
  const baseTime = Date.parse("2026-09-03T01:00:00.000Z");
  let nowMs = baseTime;
  const store = new PendingInboundStore({
    filePath,
    quietWindowMs: 15_000,
    now: () => nowMs,
  });
  const enqueueAt = (seconds, messageId, text) => {
    nowMs = baseTime + (seconds * 1_000);
    return store.enqueue({
      bindingKey: "binding-1",
      workspaceRoot: "D:/workspace",
      message: fixtureMessage({
        messageId,
        originalText: text,
        text,
        receivedAt: new Date(nowMs).toISOString(),
      }),
    });
  };

  const first = enqueueAt(0, "weflow:quiet-1", "第一条");
  assert.equal(first.draft.quietUntil, new Date(baseTime + 15_000).toISOString());
  assert.equal(first.draft.generation, 1);
  assert.equal(enqueueAt(6, "weflow:quiet-2", "第二条").draft.quietUntil,
    new Date(baseTime + 21_000).toISOString());
  const third = enqueueAt(10, "weflow:quiet-3", "第三条");
  assert.equal(third.draft.lastActivityAt, new Date(baseTime + 10_000).toISOString());
  assert.equal(third.draft.quietUntil, new Date(baseTime + 25_000).toISOString());
  assert.equal(third.draft.generation, 3);

  nowMs = baseTime + 20_000;
  const duplicate = store.enqueue({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    message: fixtureMessage({
      messageId: "weflow:quiet-3",
      originalText: "重复回放",
      text: "重复回放",
      receivedAt: new Date(nowMs).toISOString(),
    }),
  });
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.draft.quietUntil, new Date(baseTime + 25_000).toISOString());
  assert.equal(duplicate.draft.generation, 3);
});

test("quiet-window state survives restart, scopes are isolated, and old stores are immediately due", () => {
  const { filePath } = createStore();
  const baseTime = Date.parse("2026-09-03T02:00:00.000Z");
  let nowMs = baseTime;
  const store = new PendingInboundStore({ filePath, quietWindowMs: 15_000, now: () => nowMs });
  store.enqueue({
    bindingKey: "binding-a",
    workspaceRoot: "D:/workspace",
    message: fixtureMessage({
      messageId: "weflow:scope-a-1",
      receivedAt: new Date(baseTime).toISOString(),
    }),
  });
  nowMs += 2_000;
  store.enqueue({
    bindingKey: "binding-b",
    workspaceRoot: "D:/workspace",
    message: fixtureMessage({
      messageId: "weflow:scope-b-1",
      receivedAt: new Date(nowMs).toISOString(),
    }),
  });
  nowMs += 4_000;
  store.enqueue({
    bindingKey: "binding-a",
    workspaceRoot: "D:/workspace",
    message: fixtureMessage({
      messageId: "weflow:scope-a-2",
      receivedAt: new Date(nowMs).toISOString(),
    }),
  });

  const beforeRestart = store.snapshotMap();
  assert.equal(beforeRestart.get("binding-a::D:/workspace").quietUntil,
    new Date(baseTime + 21_000).toISOString());
  assert.equal(beforeRestart.get("binding-b::D:/workspace").quietUntil,
    new Date(baseTime + 17_000).toISOString());
  const recovered = new PendingInboundStore({
    filePath,
    quietWindowMs: 1,
    now: () => baseTime + 10_000,
  }).snapshotMap();
  assert.equal(recovered.get("binding-a::D:/workspace").quietUntil,
    new Date(baseTime + 21_000).toISOString());
  assert.equal(recovered.get("binding-a::D:/workspace").generation, 2);

  const legacy = JSON.parse(fs.readFileSync(filePath, "utf8"));
  legacy.version = 5;
  for (const scope of legacy.scopes) {
    delete scope.lastActivityAt;
    delete scope.quietUntil;
    delete scope.generation;
  }
  fs.writeFileSync(filePath, JSON.stringify(legacy), "utf8");
  const migrated = new PendingInboundStore({
    filePath,
    quietWindowMs: 15_000,
    now: () => baseTime + 30_000,
  }).snapshotMap();
  assert.equal(migrated.get("binding-a::D:/workspace").quietUntil, "");
  assert.equal(migrated.get("binding-a::D:/workspace").lastActivityAt, "");
  assert.equal(migrated.get("binding-a::D:/workspace").generation, 0);
});

test("message receipt time, not delayed media preparation time, anchors the quiet deadline", () => {
  const { filePath } = createStore();
  const receivedAtMs = Date.parse("2026-09-03T03:00:00.000Z");
  const preparedAtMs = receivedAtMs + 20_000;
  const store = new PendingInboundStore({
    filePath,
    quietWindowMs: 15_000,
    now: () => preparedAtMs,
  });
  const inserted = store.enqueue({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    message: fixtureMessage({ receivedAt: new Date(receivedAtMs).toISOString() }),
  });
  assert.equal(inserted.draft.lastActivityAt, new Date(receivedAtMs).toISOString());
  assert.equal(inserted.draft.quietUntil, new Date(receivedAtMs + 15_000).toISOString());

  const future = store.enqueue({
    bindingKey: "binding-future",
    workspaceRoot: "D:/workspace",
    message: fixtureMessage({
      messageId: "weflow:future",
      receivedAt: new Date(preparedAtMs + 60_000).toISOString(),
    }),
  });
  assert.equal(future.draft.lastActivityAt, new Date(preparedAtMs).toISOString());
  assert.equal(future.draft.quietUntil, new Date(preparedAtMs + 15_000).toISOString());
});

test("dispatch backoff remains independent from the persisted quiet deadline", () => {
  const { filePath } = createStore();
  const baseTime = Date.parse("2026-09-03T04:00:00.000Z");
  let nowMs = baseTime;
  const store = new PendingInboundStore({ filePath, quietWindowMs: 15_000, now: () => nowMs });
  const inserted = store.enqueue({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    message: fixtureMessage({ receivedAt: new Date(baseTime).toISOString() }),
  });
  const quietUntil = inserted.draft.quietUntil;
  const generation = inserted.draft.generation;
  nowMs += 5_000;
  const failed = store.recordDispatchFailure(inserted.scopeKey, { error: "fixture" });

  assert.equal(failed.quietUntil, quietUntil);
  assert.equal(failed.generation, generation);
  assert.equal(failed.nextDispatchAt, new Date(baseTime + 20_000).toISOString());
});

test("one collected scope can claim at most one acknowledgement across partial commits", () => {
  const { filePath } = createStore();
  const store = new PendingInboundStore({ filePath, quietWindowMs: 0 });
  const first = store.enqueue({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    message: fixtureMessage({ messageId: "weflow:ack-1" }),
  });
  store.enqueue({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    message: fixtureMessage({ messageId: "weflow:ack-2" }),
  });
  assert.equal(store.claimAcknowledgement(first.scopeKey, "weflow:ack-1"), true);
  store.completeAcknowledgement(first.scopeKey, "weflow:ack-1", { success: true });
  assert.equal(store.claimAcknowledgement(first.scopeKey, "weflow:ack-2"), false);
  store.commitDispatch(first.scopeKey, ["weflow:ack-1"]);
  assert.equal(store.claimAcknowledgement(first.scopeKey, "weflow:ack-2"), false);
  assert.equal(new PendingInboundStore({ filePath }).getScope(first.scopeKey).acknowledgementStatus, "sent");
});

test("a paired companion revoke removes its logical pending message and extends only an open scope", async () => {
  const { filePath } = createStore();
  const baseTime = Date.parse("2026-09-03T05:00:00.000Z");
  let nowMs = baseTime + 6_000;
  const store = new PendingInboundStore({ filePath, quietWindowMs: 15_000, now: () => nowMs });
  store.enqueue({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    message: fixtureMessage({
      messageId: "weflow:378",
      sourceMessageIds: ["378", "379"],
      receivedAt: new Date(baseTime).toISOString(),
    }),
  });
  store.enqueue({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    message: fixtureMessage({
      messageId: "weflow:380",
      receivedAt: new Date(baseTime + 1_000).toISOString(),
    }),
  });
  const scopeKey = "binding-1::D:/workspace";
  let scheduled = 0;
  let dispatched = 0;
  let acknowledged = 0;
  const appLike = {
    activeAccountId: "account-1",
    config: {
      workspaceId: "default",
      weflowInboxChat: "wxid_self",
      pendingInboundQuietWindowMs: 15_000,
    },
    pendingInboundStore: store,
    pendingInboundByScope: store.snapshotMap(),
    runtimeAdapter: {
      getSessionStore() {
        return { buildBindingKey() { return "binding-1"; } };
      },
    },
    resolveWeFlowInboxReplyTarget() { return { userId: "user-1" }; },
    resolveWorkspaceRoot() { return "D:/workspace"; },
    schedulePendingInboundFlush() { scheduled += 1; return true; },
    clearPendingInboundFlushTimer() {},
    markPipelineUserInbound() {},
    pipelineActivity: { refresh() {} },
    dispatchPreparedTurn() { dispatched += 1; },
    acknowledgeWeFlowUiaInbound() { acknowledged += 1; },
  };
  const handled = await CyberbossApp.prototype.handleWeFlowBatchActivity.call(appLike, {
    kind: "revoke",
    revokedMessageId: "379",
    receivedAt: new Date(baseTime + 6_000).toISOString(),
  }, { chatUsername: "wxid_self" });

  assert.equal(handled, true);
  assert.equal(scheduled, 1);
  assert.equal(dispatched, 0);
  assert.equal(acknowledged, 0);
  assert.deepEqual(appLike.pendingInboundByScope.get(scopeKey).messages.map(
    (message) => message.messageId
  ), ["weflow:380"]);
  assert.equal(appLike.pendingInboundByScope.get(scopeKey).quietUntil,
    new Date(baseTime + 21_000).toISOString());

  const noScopeHandled = await CyberbossApp.prototype.handleWeFlowBatchActivity.call({
    ...appLike,
    pendingInboundByScope: new Map(),
  }, {
    kind: "revoke",
    revokedMessageId: "999",
    receivedAt: new Date(nowMs).toISOString(),
  });
  assert.equal(noScopeHandled, true);
});

test("shared-content revoke removes a paired item durably and only touches its logical chat", () => {
  const { filePath } = createStore();
  const baseTime = Date.parse("2026-09-03T05:30:00.000Z");
  let nowMs = baseTime + 6_000;
  const store = new PendingInboundStore({ filePath, now: () => nowMs });
  const chatA = "weflow:wxid_a";
  const chatB = "weflow:wxid_b";
  store.enqueueSharedContent({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    chatId: chatA,
    message: fixtureMessage({
      messageId: "weflow:shared-a-pair",
      chatId: chatA,
      sourceMessageIds: ["378", "379"],
      receivedAt: new Date(baseTime).toISOString(),
    }),
    lastContentAtMs: baseTime,
  });
  store.enqueueSharedContent({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    chatId: chatA,
    message: fixtureMessage({
      messageId: "weflow:shared-a-keep",
      chatId: chatA,
      receivedAt: new Date(baseTime + 1_000).toISOString(),
    }),
    lastContentAtMs: baseTime + 1_000,
  });
  store.enqueueSharedContent({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    chatId: chatB,
    message: fixtureMessage({
      messageId: "weflow:379",
      chatId: chatB,
      receivedAt: new Date(baseTime + 2_000).toISOString(),
    }),
    lastContentAtMs: baseTime + 2_000,
  });

  const scopeA = `binding-1::D:/workspace::${chatA}`;
  const result = store.recordSharedActivity(scopeA, {
    receivedAt: new Date(nowMs).toISOString(),
    matchingMessageIds: ["379", "weflow:379"],
  });
  assert.deepEqual(result.removedPendingIds, ["weflow:shared-a-pair"]);
  assert.deepEqual(result.draft.messages.map((message) => message.messageId), ["weflow:shared-a-keep"]);
  assert.equal(result.draft.lastContentAtMs, nowMs);

  nowMs = baseTime + 10_000;
  const unmatchedRecall = store.recordSharedActivity(scopeA, {
    receivedAt: new Date(nowMs).toISOString(),
    matchingMessageIds: ["does-not-match"],
  });
  assert.deepEqual(unmatchedRecall.removedPendingIds, []);
  assert.equal(unmatchedRecall.draft.lastContentAtMs, nowMs);

  const restarted = new PendingInboundStore({ filePath });
  assert.deepEqual(
    restarted.snapshotSharedMap().get(scopeA).messages.map((message) => message.messageId),
    ["weflow:shared-a-keep"]
  );
  assert.equal(
    restarted.snapshotSharedMap().get(`binding-1::D:/workspace::${chatB}`).messages[0].messageId,
    "weflow:379"
  );
});

test("recalled standalone shared image is removed before a later prompt and creates no turn or ack", async () => {
  const { filePath } = createStore();
  const baseTime = Date.parse("2026-09-03T06:00:00.000Z");
  const store = new PendingInboundStore({ filePath, now: () => baseTime + 5_000 });
  const chatId = "weflow:wxid_self";
  const sharedScopeKey = `binding-1::D:/workspace::${chatId}`;
  store.enqueueSharedContent({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    chatId,
    message: fixtureMessage({
      messageId: "weflow:501",
      sourceMessageIds: ["501", "502"],
      chatId,
      originalText: "",
      text: "",
      contentKind: "image",
      sharedContent: true,
      explicitPrompt: false,
      receivedAt: new Date(baseTime).toISOString(),
      attachments: [{ kind: "image", absolutePath: "D:/inbox/recalled.png" }],
    }),
    lastContentAtMs: baseTime,
  });
  let dispatched = 0;
  let acknowledged = 0;
  let scheduled = 0;
  const appLike = {
    activeAccountId: "account-1",
    config: {
      workspaceId: "default",
      weflowInboxChat: "wxid_self",
      pendingInboundQuietWindowMs: 15_000,
    },
    pendingInboundStore: store,
    pendingInboundByScope: new Map(),
    pendingSharedContentInboundByScope: store.snapshotSharedMap(),
    runtimeAdapter: {
      getSessionStore() {
        return { buildBindingKey() { return "binding-1"; } };
      },
    },
    resolveWeFlowInboxReplyTarget() { return { userId: "user-1" }; },
    resolveWorkspaceRoot() { return "D:/workspace"; },
    clearPendingInboundFlushTimer() {},
    clearPendingSharedContentInboundTimer: CyberbossApp.prototype.clearPendingSharedContentInboundTimer,
    schedulePendingSharedContentInboundExpiry() { scheduled += 1; },
    markPipelineUserInbound() {},
    pipelineActivity: { refresh() {} },
    dispatchPreparedTurn() { dispatched += 1; },
    acknowledgeWeFlowUiaInbound() { acknowledged += 1; },
  };

  await CyberbossApp.prototype.handleWeFlowBatchActivity.call(appLike, {
    kind: "revoke",
    revokedMessageId: "502",
    receivedAt: new Date(baseTime + 5_000).toISOString(),
  }, { chatUsername: "wxid_self" });

  assert.equal(appLike.pendingSharedContentInboundByScope.has(sharedScopeKey), false);
  assert.equal(new PendingInboundStore({ filePath }).snapshotSharedMap().has(sharedScopeKey), false);
  assert.equal(scheduled, 0);
  assert.equal(dispatched, 0);
  assert.equal(acknowledged, 0);
  let routed = 0;
  appLike.routePreparedInbound = async () => { routed += 1; };
  const consumed = await CyberbossApp.prototype.consumePendingSharedContentInbound.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    trailingPrepared: fixtureMessage({
      messageId: "weflow:503",
      chatId,
      receivedAt: new Date(baseTime + 6_000).toISOString(),
    }),
  });
  assert.equal(consumed, false);
  assert.equal(routed, 0);
});

test("standalone shared content is promoted on its persisted 15-second inactivity deadline", async () => {
  const { filePath } = createStore();
  const quietWindowMs = 30;
  const receivedAtMs = Date.now();
  const store = new PendingInboundStore({ filePath, quietWindowMs });
  const chatId = "weflow:wxid_standalone";
  store.enqueueSharedContent({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    chatId,
    message: fixtureMessage({
      messageId: "weflow:601",
      sourceMessageIds: ["601"],
      chatId,
      originalText: "",
      text: "",
      contentKind: "image",
      sharedContent: true,
      explicitPrompt: false,
      receivedAt: new Date(receivedAtMs).toISOString(),
      attachments: [{ kind: "image", absolutePath: "D:/inbox/standalone.png" }],
    }),
    lastContentAtMs: receivedAtMs,
  });
  const routed = [];
  const appLike = {
    config: { pendingInboundQuietWindowMs: quietWindowMs },
    pendingInboundStore: store,
    pendingInboundByScope: new Map(),
    pendingSharedContentInboundByScope: store.snapshotSharedMap(),
    clearPendingSharedContentInboundTimer: CyberbossApp.prototype.clearPendingSharedContentInboundTimer,
    schedulePendingSharedContentInboundExpiry: CyberbossApp.prototype.schedulePendingSharedContentInboundExpiry,
    commitPendingSharedContentConsumption: CyberbossApp.prototype.commitPendingSharedContentConsumption,
    dropPendingSharedContentInboundByScopeKey: CyberbossApp.prototype.dropPendingSharedContentInboundByScopeKey,
    promotePendingSharedContentInbound: CyberbossApp.prototype.promotePendingSharedContentInbound,
    async routePreparedInbound({ bindingKey, workspaceRoot, prepared }) {
      routed.push(prepared);
      const buffered = store.enqueue({ bindingKey, workspaceRoot, message: prepared });
      this.pendingInboundByScope.set(buffered.scopeKey, buffered.draft);
    },
  };
  const sharedScopeKey = `binding-1::D:/workspace::${chatId}`;
  CyberbossApp.prototype.schedulePendingSharedContentInboundExpiry.call(appLike, sharedScopeKey);
  await new Promise((resolve) => setTimeout(resolve, quietWindowMs + 50));

  assert.equal(routed.length, 1);
  assert.equal(routed[0].attachments[0].absolutePath, "D:/inbox/standalone.png");
  assert.deepEqual(routed[0].sourceMessageIds, ["weflow:601", "601"]);
  assert.equal(appLike.pendingSharedContentInboundByScope.size, 0);
  assert.equal(new PendingInboundStore({ filePath }).snapshotSharedMap().size, 0);
  const ordinary = new PendingInboundStore({ filePath }).snapshotMap().get("binding-1::D:/workspace");
  assert.equal(ordinary.messages.length, 1);
  assert.equal(ordinary.quietUntil, new Date(receivedAtMs + quietWindowMs).toISOString());
});

test("image at t0, prompt at t6, and text at t10 share one batch with a t25 deadline", async () => {
  const { filePath } = createStore();
  const baseTime = Date.parse("2026-09-03T07:00:00.000Z");
  let nowMs = baseTime;
  const store = new PendingInboundStore({ filePath, quietWindowMs: 15_000, now: () => nowMs });
  const chatId = "weflow:wxid_joined";
  store.enqueueSharedContent({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    chatId,
    message: fixtureMessage({
      messageId: "weflow:701",
      sourceMessageIds: ["701"],
      chatId,
      originalText: "",
      text: "",
      contentKind: "image",
      sharedContent: true,
      explicitPrompt: false,
      receivedAt: new Date(baseTime).toISOString(),
      attachments: [{ kind: "image", absolutePath: "D:/inbox/joined.png" }],
    }),
    lastContentAtMs: baseTime,
  });
  nowMs = baseTime + 6_000;
  const appLike = {
    config: { pendingInboundQuietWindowMs: 15_000 },
    pendingInboundStore: store,
    pendingInboundByScope: new Map(),
    pendingSharedContentInboundByScope: store.snapshotSharedMap(),
    clearPendingSharedContentInboundTimer: CyberbossApp.prototype.clearPendingSharedContentInboundTimer,
    schedulePendingSharedContentInboundExpiry() {},
    commitPendingSharedContentConsumption: CyberbossApp.prototype.commitPendingSharedContentConsumption,
    async routePreparedInbound({ bindingKey, workspaceRoot, prepared }) {
      const buffered = store.enqueue({ bindingKey, workspaceRoot, message: prepared });
      this.pendingInboundByScope.set(buffered.scopeKey, buffered.draft);
    },
  };
  const consumed = await CyberbossApp.prototype.consumePendingSharedContentInbound.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    trailingPrepared: fixtureMessage({
      messageId: "weflow:702",
      sourceMessageIds: ["702"],
      chatId,
      originalText: "分析这张图",
      text: "分析这张图",
      receivedAt: new Date(nowMs).toISOString(),
    }),
  });

  assert.equal(consumed, true);
  const ordinary = new PendingInboundStore({ filePath }).snapshotMap().get("binding-1::D:/workspace");
  assert.equal(ordinary.messages.length, 1);
  assert.equal(ordinary.messages[0].attachments[0].absolutePath, "D:/inbox/joined.png");
  assert.equal(ordinary.quietUntil, new Date(baseTime + 21_000).toISOString());
  assert.equal(new PendingInboundStore({ filePath }).snapshotSharedMap().size, 0);

  nowMs = baseTime + 10_000;
  const trailing = store.enqueue({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    message: fixtureMessage({
      messageId: "weflow:703",
      sourceMessageIds: ["703"],
      chatId,
      originalText: "再补充一条",
      text: "再补充一条",
      receivedAt: new Date(nowMs).toISOString(),
    }),
  });
  assert.equal(trailing.draft.quietUntil, new Date(baseTime + 25_000).toISOString());
  const merged = CyberbossApp.prototype.mergePendingInboundDraft(trailing.draft);
  assert.equal(merged.consumedIds.length, 2);
  assert.equal(merged.prepared.attachments[0].absolutePath, "D:/inbox/joined.png");
  assert.match(merged.prepared.text, /分析这张图[\s\S]*再补充一条/);
  assert.equal(merged.remainingMessages.length, 0);
});

test("flush skips a future quiet deadline and dispatches immediately once an expired busy scope releases", async () => {
  const scopeKey = "binding-1::D:/workspace";
  const futureDraft = {
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    messages: [fixtureMessage()],
    quietUntil: new Date(Date.now() + 60_000).toISOString(),
    generation: 1,
  };
  let dispatches = 0;
  let schedules = 0;
  let blocked = false;
  const appLike = {
    pendingInboundByScope: new Map([[scopeKey, futureDraft]]),
    pendingInboundFlushScopeKeys: new Set(),
    pendingInboundPostDispatchCommits: new Map(),
    schedulePendingInboundFlush() { schedules += 1; return true; },
    isTurnDispatchBlocked() { return blocked; },
    mergePendingInboundDraft: CyberbossApp.prototype.mergePendingInboundDraft,
    async dispatchPreparedTurn() { dispatches += 1; return true; },
    commitPendingInboundDispatch() {
      this.pendingInboundByScope.delete(scopeKey);
      return null;
    },
  };
  await CyberbossApp.prototype.flushPendingInboundMessages.call(appLike);
  assert.equal(dispatches, 0);
  assert.equal(schedules, 1);

  futureDraft.quietUntil = new Date(Date.now() - 1).toISOString();
  blocked = true;
  await CyberbossApp.prototype.flushPendingInboundMessages.call(appLike);
  assert.equal(dispatches, 0);
  blocked = false;
  await CyberbossApp.prototype.flushPendingInboundMessages.call(appLike);
  assert.equal(dispatches, 1);
});

test("the per-scope timer honors a rescheduled generation and stop clears outstanding timers", async () => {
  const scopeKey = "binding-1::D:/workspace";
  const startedAt = Date.now();
  const draft = {
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    messages: [fixtureMessage()],
    quietUntil: new Date(startedAt + 35).toISOString(),
    generation: 1,
  };
  let dispatchedAt = 0;
  let resolveDispatch;
  const dispatched = new Promise((resolve) => { resolveDispatch = resolve; });
  const appLike = {
    pendingInboundByScope: new Map([[scopeKey, draft]]),
    pendingInboundFlushTimers: new Map(),
    pendingInboundFlushScopeKeys: new Set(),
    pendingInboundPostDispatchCommits: new Map(),
    schedulePendingInboundFlush: CyberbossApp.prototype.schedulePendingInboundFlush,
    clearPendingInboundFlushTimer: CyberbossApp.prototype.clearPendingInboundFlushTimer,
    clearPendingInboundFlushTimers: CyberbossApp.prototype.clearPendingInboundFlushTimers,
    flushPendingInboundMessages: CyberbossApp.prototype.flushPendingInboundMessages,
    mergePendingInboundDraft: CyberbossApp.prototype.mergePendingInboundDraft,
    isTurnDispatchBlocked() { return false; },
    async dispatchPreparedTurn() {
      dispatchedAt = Date.now();
      resolveDispatch();
      return true;
    },
    commitPendingInboundDispatch() {
      this.pendingInboundByScope.delete(scopeKey);
      this.clearPendingInboundFlushTimer(scopeKey);
      return null;
    },
  };
  CyberbossApp.prototype.schedulePendingInboundFlush.call(appLike, scopeKey);
  await new Promise((resolve) => setTimeout(resolve, 15));
  draft.quietUntil = new Date(Date.now() + 45).toISOString();
  draft.generation += 1;
  CyberbossApp.prototype.schedulePendingInboundFlush.call(appLike, scopeKey);
  await Promise.race([
    dispatched,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("quiet timer did not fire")), 500)),
  ]);
  assert.ok(dispatchedAt - startedAt >= 45);
  assert.equal(appLike.pendingInboundFlushTimers.size, 0);

  appLike.pendingInboundByScope.set(scopeKey, {
    ...draft,
    quietUntil: new Date(Date.now() + 100).toISOString(),
    generation: draft.generation + 1,
  });
  CyberbossApp.prototype.schedulePendingInboundFlush.call(appLike, scopeKey);
  assert.equal(appLike.pendingInboundFlushTimers.size, 1);
  CyberbossApp.prototype.clearPendingInboundFlushTimers.call(appLike);
  assert.equal(appLike.pendingInboundFlushTimers.size, 0);
});

test("startup reconciles a durable WeFlow revoke before an expired core batch can dispatch", async () => {
  const { filePath } = createStore();
  const store = new PendingInboundStore({ filePath, quietWindowMs: 0 });
  store.enqueue({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    message: fixtureMessage({
      messageId: "weflow:startup-revoked",
      sourceMessageIds: ["weflow:startup-revoked"],
      originalText: "已撤回内容",
      text: "已撤回内容",
      receivedAt: "2026-09-01T00:00:00.000Z",
    }),
  });
  store.enqueue({
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    message: fixtureMessage({
      messageId: "weflow:startup-kept",
      originalText: "保留内容",
      text: "保留内容",
      receivedAt: "2026-09-01T00:00:01.000Z",
    }),
  });

  const order = [];
  const dispatched = [];
  const source = {
    running: true,
    pendingEvents: new Map([[
      "message.revoke:startup-revoked",
      {
        eventType: "message.revoke",
        receivedAt: "2026-09-01T00:00:02.000Z",
        push: { sessionId: "wxid_self", rawid: "startup-revoked" },
      },
    ]]),
    schedulePendingDrain() {},
    async drainPendingEvents() {
      order.push("drain_revoke");
      await appLike.handleWeFlowBatchActivity({
        kind: "revoke",
        revokedMessageId: "startup-revoked",
        receivedAt: "2026-09-01T00:00:02.000Z",
      }, { chatUsername: "wxid_self" });
      this.pendingEvents.delete("message.revoke:startup-revoked");
      return { status: "ok", processed: 1 };
    },
  };
  const appLike = {
    activeAccountId: "account-1",
    config: {
      workspaceId: "default",
      weflowInboxChat: "wxid_self",
      pendingInboundQuietWindowMs: 0,
    },
    pendingInboundStore: store,
    pendingInboundByScope: store.snapshotMap(),
    pendingSharedContentInboundByScope: new Map(),
    pendingInboundFlushScopeKeys: new Set(),
    pendingInboundFlushTimers: new Map(),
    pendingInboundPostDispatchCommits: new Map(),
    weflowInboxSource: null,
    runtimeAdapter: {
      getSessionStore() {
        return { buildBindingKey() { return "binding-1"; } };
      },
    },
    async ensureWeFlowInboxStarted() {
      order.push("start_weflow");
      this.weflowInboxSource = source;
      return source;
    },
    resolveWeFlowInboxReplyTarget() { return { userId: "user-1" }; },
    resolveWorkspaceRoot() { return "D:/workspace"; },
    restorePendingSharedContentInboundTimers() { order.push("restore_shared_timers"); },
    restorePendingInboundFlushTimers() {
      order.push("restore_inbound_timers");
      return CyberbossApp.prototype.restorePendingInboundFlushTimers.call(this);
    },
    async flushPendingInboundMessages(options) {
      order.push("flush_core");
      return CyberbossApp.prototype.flushPendingInboundMessages.call(this, options);
    },
    handleWeFlowBatchActivity: CyberbossApp.prototype.handleWeFlowBatchActivity,
    reconcilePendingWeFlowRevokesBeforeRecovery:
      CyberbossApp.prototype.reconcilePendingWeFlowRevokesBeforeRecovery,
    resolvePrimaryWeFlowPendingScopeKey: CyberbossApp.prototype.resolvePrimaryWeFlowPendingScopeKey,
    resolvePendingWeFlowRevokeGate: CyberbossApp.prototype.resolvePendingWeFlowRevokeGate,
    schedulePendingInboundFlush: CyberbossApp.prototype.schedulePendingInboundFlush,
    clearPendingInboundFlushTimer: CyberbossApp.prototype.clearPendingInboundFlushTimer,
    commitPendingInboundDispatch: CyberbossApp.prototype.commitPendingInboundDispatch,
    removePendingInboundScope: CyberbossApp.prototype.removePendingInboundScope,
    mergePendingInboundDraft: CyberbossApp.prototype.mergePendingInboundDraft,
    markPipelineUserInbound() {},
    pipelineActivity: { refresh() {} },
    isTurnDispatchBlocked() { return false; },
    async dispatchPreparedTurn({ prepared }) {
      order.push("dispatch_core");
      dispatched.push(prepared);
      return true;
    },
  };

  await CyberbossApp.prototype.recoverPendingInboundAtStartup.call(appLike);

  assert.deepEqual(order, [
    "start_weflow",
    "drain_revoke",
    "restore_shared_timers",
    "restore_inbound_timers",
    "flush_core",
    "dispatch_core",
  ]);
  assert.equal(dispatched.length, 1);
  assert.match(dispatched[0].text, /保留内容/);
  assert.doesNotMatch(dispatched[0].text, /已撤回内容/);
  assert.equal(appLike.pendingInboundByScope.size, 0);
  assert.equal(source.pendingEvents.size, 0);
});

test("a retrying startup revoke gates only the primary WeFlow scope until it is consumed", async () => {
  const nowMs = Date.now();
  const retryAtMs = nowMs + 60_000;
  const primaryScopeKey = "binding-primary::D:/workspace";
  const otherScopeKey = "binding-other::D:/workspace";
  const makeDraft = (bindingKey, messageId) => ({
    bindingKey,
    workspaceRoot: "D:/workspace",
    messages: [fixtureMessage({
      messageId,
      originalText: messageId,
      text: messageId,
      receivedAt: new Date(nowMs - 60_000).toISOString(),
    })],
    quietUntil: new Date(nowMs - 1_000).toISOString(),
    generation: 1,
  });
  const dispatchedBindings = [];
  const appLike = {
    activeAccountId: "account-1",
    config: { workspaceId: "default", weflowInboxChat: "wxid_self" },
    pendingInboundByScope: new Map([
      [primaryScopeKey, makeDraft("binding-primary", "weflow:primary")],
      [otherScopeKey, makeDraft("binding-other", "native:other")],
    ]),
    pendingInboundFlushTimers: new Map(),
    pendingInboundFlushScopeKeys: new Set(),
    pendingInboundPostDispatchCommits: new Map(),
    weflowInboxSource: {
      pendingRetryNotBeforeMs: 0,
      pendingEvents: new Map([[
        "message.revoke:primary",
        {
          eventType: "message.revoke",
          retryNotBefore: new Date(retryAtMs).toISOString(),
          push: { sessionId: "wxid_self", rawid: "primary" },
        },
      ]]),
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey({ senderId }) {
            return senderId === "user-primary" ? "binding-primary" : "binding-other";
          },
        };
      },
    },
    resolveWeFlowInboxReplyTarget() { return { userId: "user-primary" }; },
    resolveWorkspaceRoot() { return "D:/workspace"; },
    resolvePrimaryWeFlowPendingScopeKey: CyberbossApp.prototype.resolvePrimaryWeFlowPendingScopeKey,
    resolvePendingWeFlowRevokeGate: CyberbossApp.prototype.resolvePendingWeFlowRevokeGate,
    schedulePendingInboundFlush: CyberbossApp.prototype.schedulePendingInboundFlush,
    clearPendingInboundFlushTimer: CyberbossApp.prototype.clearPendingInboundFlushTimer,
    mergePendingInboundDraft: CyberbossApp.prototype.mergePendingInboundDraft,
    isTurnDispatchBlocked() { return false; },
    async dispatchPreparedTurn({ bindingKey }) {
      dispatchedBindings.push(bindingKey);
      return true;
    },
    commitPendingInboundDispatch(scopeKey) {
      this.pendingInboundByScope.delete(scopeKey);
      this.clearPendingInboundFlushTimer(scopeKey);
      return null;
    },
  };

  await CyberbossApp.prototype.flushPendingInboundMessages.call(appLike);
  assert.deepEqual(dispatchedBindings, ["binding-other"]);
  assert.equal(appLike.pendingInboundByScope.has(primaryScopeKey), true);
  assert.ok(appLike.pendingInboundFlushTimers.get(primaryScopeKey).deadlineMs >= retryAtMs);

  appLike.weflowInboxSource.pendingEvents.clear();
  appLike.clearPendingInboundFlushTimer(primaryScopeKey);
  await CyberbossApp.prototype.flushPendingInboundMessages.call(appLike, {
    bindingKey: "binding-primary",
    workspaceRoot: "D:/workspace",
  });
  assert.deepEqual(dispatchedBindings, ["binding-other", "binding-primary"]);
  assert.equal(appLike.pendingInboundByScope.size, 0);
});

test("startup revoke reconciliation is bounded while the durable gate remains armed", async () => {
  let scheduled = 0;
  const source = {
    running: true,
    pendingEvents: new Map([[
      "message.revoke:slow",
      {
        eventType: "message.revoke",
        push: { sessionId: "wxid_self", rawid: "slow" },
      },
    ]]),
    drainPendingEvents() { return new Promise(() => {}); },
    schedulePendingDrain() { scheduled += 1; },
  };
  const startedAt = Date.now();
  const result = await CyberbossApp.prototype.reconcilePendingWeFlowRevokesBeforeRecovery.call({
    config: { weflowInboxChat: "wxid_self" },
    weflowInboxSource: source,
  }, { timeoutMs: 10 });

  assert.equal(result.status, "timeout");
  assert.equal(result.remaining, 1);
  assert.equal(scheduled, 1);
  assert.ok(Date.now() - startedAt < 500);
});
