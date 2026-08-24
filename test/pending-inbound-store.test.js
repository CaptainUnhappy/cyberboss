const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { CyberbossApp } = require("../src/core/app");
const { PendingInboundStore } = require("../src/core/pending-inbound-store");

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

test("shared content survives restart until a follow-up consumes it", async () => {
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
      receivedAt: "2026-08-24T02:00:30.000Z",
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

test("historical shared content gets restart grace so a nearby backfilled prompt can consume it", async () => {
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
    pendingSharedContentInboundByScope: recoveredStore.snapshotSharedMap(),
    restorePendingSharedContentInboundTimers: CyberbossApp.prototype.restorePendingSharedContentInboundTimers,
    schedulePendingSharedContentInboundExpiry: CyberbossApp.prototype.schedulePendingSharedContentInboundExpiry,
    clearPendingSharedContentInboundTimer: CyberbossApp.prototype.clearPendingSharedContentInboundTimer,
    commitPendingSharedContentConsumption: CyberbossApp.prototype.commitPendingSharedContentConsumption,
    async routePreparedInbound(payload) {
      routed.push(payload.prepared);
    },
  };

  CyberbossApp.prototype.restorePendingSharedContentInboundTimers.call(appLike);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(appLike.pendingSharedContentInboundByScope.size, 1);

  await CyberbossApp.prototype.consumePendingSharedContentInbound.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
    trailingPrepared: fixtureMessage({
      messageId: "weflow:historical-prompt",
      chatId,
      originalText: "分析刚才的图片",
      text: "分析刚才的图片",
      receivedAt: new Date(historicalTime + 10_000).toISOString(),
    }),
  });

  assert.equal(routed.length, 1);
  assert.equal(routed[0].attachments[0].absolutePath, "D:/inbox/historical.png");
  assert.equal(appLike.pendingSharedContentInboundByScope.size, 0);
  assert.equal(new PendingInboundStore({ filePath }).snapshotSharedMap().size, 0);
});
