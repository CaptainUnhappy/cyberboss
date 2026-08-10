const test = require("node:test");
const assert = require("node:assert/strict");

const { CyberbossApp } = require("../src/core/app");
const { TurnGateStore } = require("../src/core/turn-gate-store");

test("turn gate tracks pending scopes until the turn is released", () => {
  const gate = new TurnGateStore();
  const scopeKey = gate.begin("binding-1", "/workspace");

  assert.equal(scopeKey, "binding-1::/workspace");
  assert.equal(gate.isPending("binding-1", "/workspace"), true);

  gate.attachThread(scopeKey, "thread-1");
  gate.releaseThread("thread-1");

  assert.equal(gate.isPending("binding-1", "/workspace"), false);
});

test("handlePreparedMessage queues a normal inbound message while the scope is busy", async () => {
  const queued = [];
  let dispatched = false;
  const appLike = {
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return { status: "running", pendingApproval: null };
      },
    },
    turnGateStore: {
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    streamDelivery: {
      setReplyTarget() {},
    },
    pendingInboundByScope: new Map(),
    hasPendingImageInbound() {
      return false;
    },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    async prepareIncomingMessageForRuntime(normalized) {
      return {
        ...normalized,
        text: "prepared-user-text",
      };
    },
    async dispatchPreparedTurn() {
      dispatched = true;
      return true;
    },
    bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared }) {
      queued.push({ bindingKey, workspaceRoot, ...prepared });
    },
    isTurnDispatchBlocked: CyberbossApp.prototype.isTurnDispatchBlocked,
    routePreparedInbound: CyberbossApp.prototype.routePreparedInbound,
  };

  await CyberbossApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default",
    accountId: "acc-1",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "hello",
    receivedAt: "2026-04-13T08:00:00.000Z",
  }, { allowCommands: true });

  assert.equal(dispatched, false);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].bindingKey, "binding-1");
  assert.equal(queued[0].workspaceRoot, "/workspace");
  assert.equal(queued[0].text, "prepared-user-text");
});

test("small UIA inbound replies with processing before it is queued", async () => {
  const order = [];
  const sent = [];
  const queued = [];
  const appLike = {
    channelAdapter: {
      async sendText(payload) {
        order.push("ack");
        sent.push(payload);
      },
    },
    acknowledgeWeFlowUiaInbound: CyberbossApp.prototype.acknowledgeWeFlowUiaInbound,
    isTurnDispatchBlocked() {
      return true;
    },
    bufferPendingInboundMessage(payload) {
      order.push("queue");
      queued.push(payload);
    },
    async dispatchPreparedTurn() {
      throw new Error("should not dispatch while blocked");
    },
  };

  const prepared = {
    provider: "weflow-uia",
    senderId: "user-1",
    contextToken: "ctx-1",
    messageId: "weflow:1",
    text: "检查项目",
  };
  const dispatched = await CyberbossApp.prototype.routePreparedInbound.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    prepared,
  });

  assert.equal(dispatched, false);
  assert.deepEqual(order, ["ack", "queue"]);
  assert.deepEqual(sent, [{
    userId: "user-1",
    text: "处理中",
    contextToken: "ctx-1",
    provider: "weflow-uia",
  }]);
  assert.equal(queued.length, 1);
});

test("reminder requests on both channels acknowledge once and keep the runtime turn silent", async () => {
  for (const provider of ["weixin", "weflow-uia"]) {
    const sent = [];
    const queued = [];
    const appLike = {
      channelAdapter: {
        async sendText(payload) {
          sent.push(payload);
        },
      },
      acknowledgeWeFlowUiaInbound: CyberbossApp.prototype.acknowledgeWeFlowUiaInbound,
      isTurnDispatchBlocked() {
        return true;
      },
      bufferPendingInboundMessage(payload) {
        queued.push(payload);
      },
      async dispatchPreparedTurn() {
        throw new Error("should not dispatch while blocked");
      },
    };
    const prepared = {
      provider,
      senderId: "user-1",
      contextToken: "ctx-1",
      messageId: `${provider}:1`,
      text: "明天上午9点提醒我请假",
      deliveryPolicy: "silent",
    };

    const dispatched = await CyberbossApp.prototype.routePreparedInbound.call(appLike, {
      bindingKey: "binding-1",
      workspaceRoot: "/workspace",
      prepared,
    });

    assert.equal(dispatched, false);
    assert.deepEqual(sent, [{
      userId: "user-1",
      text: "已记录",
      contextToken: "ctx-1",
      provider,
    }]);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].prepared.deliveryPolicy, "silent");
  }
});

test("handlePreparedMessage recognizes an actionable reminder before runtime dispatch", async () => {
  const replyTargets = [];
  const routed = [];
  const appLike = {
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() { return "binding-1"; },
        };
      },
    },
    streamDelivery: {
      setReplyTarget(bindingKey, target) {
        replyTargets.push({ bindingKey, target });
      },
    },
    resolveWorkspaceRoot() { return "/workspace"; },
    async prepareIncomingMessageForRuntime(normalized) {
      return { ...normalized, originalText: normalized.text };
    },
    async routePreparedInbound(payload) {
      routed.push(payload);
    },
  };

  await CyberbossApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default",
    accountId: "acc-1",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "明天上午9点提醒我周五请假",
  }, { allowCommands: true });

  await CyberbossApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default",
    accountId: "acc-1",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "明天的提醒是什么",
  }, { allowCommands: true });

  assert.equal(replyTargets[0].target.deliveryPolicy, "silent");
  assert.equal(routed[0].prepared.deliveryPolicy, "silent");
  assert.equal(replyTargets[1].target.deliveryPolicy, undefined);
  assert.equal(routed[1].prepared.deliveryPolicy, undefined);
});

test("a mixed pending batch stays replyable while an all-reminder batch stays silent", () => {
  const appLike = {};
  const base = {
    workspaceId: "default",
    accountId: "acc-1",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
  };
  const mixed = CyberbossApp.prototype.mergePendingInboundDraft.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    messages: [
      { ...base, text: "明天提醒我请假", deliveryPolicy: "silent", receivedAt: "2026-08-10T00:00:00Z" },
      { ...base, text: "顺便检查项目", receivedAt: "2026-08-10T00:00:01Z" },
    ],
  });
  const reminders = CyberbossApp.prototype.mergePendingInboundDraft.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    messages: [
      { ...base, text: "明天提醒我请假", deliveryPolicy: "silent", receivedAt: "2026-08-10T00:00:00Z" },
      { ...base, text: "后天提醒我交材料", deliveryPolicy: "silent", receivedAt: "2026-08-10T00:00:01Z" },
    ],
  });

  assert.equal(mixed.prepared.deliveryPolicy, "");
  assert.equal(reminders.prepared.deliveryPolicy, "silent");
});

test("background reminder turns suppress approval prompts", async () => {
  const sent = [];
  const appLike = {
    channelAdapter: {
      async sendTyping(payload) { sent.push({ type: "typing", payload }); },
      async sendText(payload) { sent.push({ type: "text", payload }); },
    },
    resolveReplyTargetForBinding() {
      throw new Error("explicit run target should be used");
    },
  };

  await CyberbossApp.prototype.sendApprovalPrompt.call(appLike, {
    bindingKey: "binding-1",
    approval: { requestId: "approval-1" },
    replyTarget: {
      userId: "user-1",
      contextToken: "ctx-1",
      provider: "weixin",
      deliveryPolicy: "silent",
    },
  });

  assert.deepEqual(sent, []);
});

test("ClawBot inbound does not send the small UIA processing acknowledgement", async () => {
  const sent = [];
  let dispatched = false;
  const appLike = {
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
      },
    },
    acknowledgeWeFlowUiaInbound: CyberbossApp.prototype.acknowledgeWeFlowUiaInbound,
    isTurnDispatchBlocked() {
      return false;
    },
    bufferPendingInboundMessage() {},
    async dispatchPreparedTurn() {
      dispatched = true;
      return true;
    },
  };

  const result = await CyberbossApp.prototype.routePreparedInbound.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    prepared: {
      provider: "weixin",
      senderId: "user-1",
      contextToken: "ctx-1",
      messageId: "native:1",
      text: "检查项目",
    },
  });

  assert.equal(result, true);
  assert.equal(dispatched, true);
  assert.deepEqual(sent, []);
});

test("dispatchSystemMessage yields when a local pending turn already owns the workspace thread", async () => {
  let handled = false;
  const appLike = {
    systemMessageDispatcher: {
      buildPreparedMessage() {
        return {
          workspaceId: "default",
          accountId: "acc-1",
          senderId: "user-1",
          workspaceRoot: "/workspace",
        };
      },
    },
    channelAdapter: {
      getKnownContextTokens() {
        return { "user-1": "ctx-1" };
      },
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return null;
      },
    },
    turnGateStore: {
      isPending() {
        return true;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    async handlePreparedMessage() {
      handled = true;
    },
    isTurnDispatchBlocked: CyberbossApp.prototype.isTurnDispatchBlocked,
  };

  const dispatched = await CyberbossApp.prototype.dispatchSystemMessage.call(appLike, {
    senderId: "user-1",
    id: "system-1",
    text: "ping",
  });

  assert.equal(dispatched, false);
  assert.equal(handled, false);
});

test("dispatchSystemMessage remaps a legacy alias to the only live ClawBot context target", async () => {
  let preparedInput = null;
  let dispatchedPrepared = null;
  const appLike = {
    systemMessageDispatcher: {
      buildPreparedMessage(message, contextToken) {
        preparedInput = { message, contextToken };
        return {
          workspaceId: "default",
          accountId: "acc-1",
          senderId: message.senderId,
          contextToken,
          workspaceRoot: "/workspace",
        };
      },
    },
    channelAdapter: {
      getKnownContextTokens() {
        return { "platform-user@im.wechat": "ctx-live" };
      },
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey({ senderId }) {
            return `binding:${senderId}`;
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
        };
      },
    },
    threadStateStore: { getThreadState() { return null; } },
    turnGateStore: { isPending() { return false; } },
    turnBoundaryScopeKeys: new Set(),
    resolveWorkspaceRoot() { return "/workspace"; },
    isTurnDispatchBlocked: CyberbossApp.prototype.isTurnDispatchBlocked,
    async dispatchPreparedTurn(payload) {
      dispatchedPrepared = payload.prepared;
      return true;
    },
  };

  const dispatched = await CyberbossApp.prototype.dispatchSystemMessage.call(appLike, {
    senderId: "legacy-alias",
    id: "system-remap",
    text: "ping",
  });
  assert.equal(dispatched, true);
  assert.equal(preparedInput.message.senderId, "platform-user@im.wechat");
  assert.equal(preparedInput.contextToken, "ctx-live");
  assert.equal(dispatchedPrepared.contextToken, "ctx-live");
});

test("handlePreparedMessage queues while the scope is in a turn-boundary handoff", async () => {
  const queued = [];
  let dispatched = false;
  const appLike = {
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return { status: "completed", pendingApproval: null };
      },
    },
    turnGateStore: {
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(["binding-1::/workspace"]),
    streamDelivery: {
      setReplyTarget() {},
    },
    pendingInboundByScope: new Map(),
    hasPendingImageInbound() {
      return false;
    },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    async prepareIncomingMessageForRuntime(normalized) {
      return {
        ...normalized,
        text: "prepared-user-text",
      };
    },
    async dispatchPreparedTurn() {
      dispatched = true;
      return true;
    },
    bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared }) {
      queued.push({ bindingKey, workspaceRoot, ...prepared });
    },
    isTurnDispatchBlocked: CyberbossApp.prototype.isTurnDispatchBlocked,
    routePreparedInbound: CyberbossApp.prototype.routePreparedInbound,
  };

  await CyberbossApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default",
    accountId: "acc-1",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "hello",
    receivedAt: "2026-04-13T08:00:00.000Z",
  }, { allowCommands: true });

  assert.equal(dispatched, false);
  assert.equal(queued.length, 1);
});

test("dispatchPreparedTurn binds reply target to the explicit turn id when runtime returns one", async () => {
  const turnBindings = [];
  const queuedBindings = [];
  const order = [];
  const appLike = {
    channelAdapter: {
      async sendTyping() {
        order.push("typing");
      },
      async sendText() {},
    },
    turnGateStore: {
      begin() {
        order.push("begin");
        return "binding-1::/workspace";
      },
      attachThread() {},
      releaseScope() {},
    },
    runtimeAdapter: {
      async sendTextTurn() {
        return { threadId: "thread-1", turnId: "turn-1" };
      },
      getSessionStore() {
        return {
          getRuntimeParamsForWorkspace() {
            return { model: "gpt-5.4" };
          },
        };
      },
    },
    async buildRuntimeTurn({ prepared }) {
      return {
        text: prepared.text,
        attachments: [],
      };
    },
    streamDelivery: {
      bindReplyTargetForTurn(payload) {
        turnBindings.push(payload);
      },
      queueReplyTargetForThread(threadId, target) {
        queuedBindings.push({ threadId, target });
      },
    },
  };

  const dispatched = await CyberbossApp.prototype.dispatchPreparedTurn.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    prepared: {
      workspaceId: "default",
      accountId: "acc-1",
      senderId: "user-1",
      contextToken: "ctx-1",
      provider: "system",
      text: "ping",
    },
  });

  assert.equal(dispatched, true);
  assert.deepEqual(turnBindings, [{
    threadId: "thread-1",
    turnId: "turn-1",
    target: {
      userId: "user-1",
      contextToken: "ctx-1",
      provider: "system",
    },
  }]);
  assert.deepEqual(queuedBindings, []);
  assert.deepEqual(order, ["begin", "typing"]);
});

test("completed turns flush queued inbound work before system messages", async () => {
  const calls = [];
  const appLike = {
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return {
              bindingKey: "binding-1",
              workspaceRoot: "/workspace",
            };
          },
        };
      },
    },
    turnGateStore: {
      releaseThread() {
        calls.push("releaseThread");
      },
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    hasPendingInboundMessage() {
      return false;
    },
    async stopTypingForThread() {
      calls.push("stopTyping");
    },
    async sendFailureToThread() {
      calls.push("sendFailure");
    },
    async flushPendingInboundMessages({ ignoreBoundary } = {}) {
      calls.push(`flushInbound:${ignoreBoundary ? "ignoreBoundary" : "default"}`);
    },
    async flushPendingSystemMessages() {
      calls.push("flushSystem");
    },
  };

  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.turn.completed",
    payload: { threadId: "thread-1", turnId: "turn-1" },
  });

  assert.deepEqual(calls, ["releaseThread", "flushInbound:ignoreBoundary", "flushSystem", "stopTyping"]);
});

test("completed turns keep the boundary closed until queued inbound work has been flushed", async () => {
  const calls = [];
  const appLike = {
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return {
              bindingKey: "binding-1",
              workspaceRoot: "/workspace",
            };
          },
        };
      },
    },
    turnGateStore: {
      releaseThread() {
        calls.push("releaseThread");
      },
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    hasPendingInboundMessage() {
      return true;
    },
    async stopTypingForThread() {
      calls.push("stopTyping");
    },
    async sendFailureToThread() {},
    async flushPendingInboundMessages({ ignoreBoundary } = {}) {
      calls.push(`flushInbound:${ignoreBoundary ? "ignoreBoundary" : "default"}`);
      assert.equal(this.turnBoundaryScopeKeys.has("binding-1::/workspace"), true);
    },
    async flushPendingSystemMessages() {
      calls.push("flushSystem");
    },
  };

  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.turn.completed",
    payload: { threadId: "thread-1", turnId: "turn-1" },
  });

  assert.deepEqual(calls, ["releaseThread", "flushInbound:ignoreBoundary", "flushSystem"]);
  assert.equal(appLike.turnBoundaryScopeKeys.has("binding-1::/workspace"), false);
});

test("completed turns flush queued inbound work before system messages", async () => {
  const calls = [];
  const appLike = {
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return null;
          },
        };
      },
    },
    turnGateStore: {
      releaseThread() {
        calls.push("releaseThread");
      },
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    hasPendingInboundMessage() {
      return false;
    },
    async stopTypingForThread() {
      calls.push("stopTyping");
    },
    async sendFailureToThread() {
      calls.push("sendFailure");
    },
    async flushPendingInboundMessages() {
      calls.push("flushInbound");
    },
    async flushPendingSystemMessages() {
      calls.push("flushSystem");
    },
  };

  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.turn.completed",
    payload: { threadId: "thread-1", turnId: "turn-1" },
  });

  assert.deepEqual(calls, ["releaseThread", "flushInbound", "flushSystem", "stopTyping"]);
});

test("failed turns still send error back when thread binding lookup is missing", async () => {
  const sent = [];
  const appLike = {
    streamDelivery: {
      resolveReplyTargetForRun() {
        return {
          userId: "user-1",
          contextToken: "ctx-1",
          provider: "weixin",
        };
      },
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return null;
          },
          getBinding() {
            return null;
          },
        };
      },
    },
    turnGateStore: {
      releaseThread() {},
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    hasPendingInboundMessage() {
      return false;
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
      },
    },
    async sendFailureToThread(threadId, text, fallbackTarget) {
      return CyberbossApp.prototype.sendFailureToThread.call(this, threadId, text, fallbackTarget);
    },
    async stopTypingForThread() {},
    async flushPendingInboundMessages() {},
    async flushPendingSystemMessages() {},
    resolveReplyTargetForBinding() {
      return null;
    },
  };

  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.turn.failed",
    payload: {
      threadId: "thread-1",
      turnId: "turn-1",
      text: "❌ Execution failed\ncontext window exceeded",
    },
  });

  assert.deepEqual(sent, [{
    userId: "user-1",
    text: "❌ Execution failed\ncontext window exceeded",
    contextToken: "ctx-1",
  }]);
});

test("flushPendingInboundMessages batches queued messages from the same scope into one turn", async () => {
  const dispatched = [];
  const scopeKey = "binding-1::/workspace";
  const appLike = {
    pendingInboundByScope: new Map([[
      scopeKey,
      {
        bindingKey: "binding-1",
        workspaceRoot: "/workspace",
        messages: [
          {
            workspaceId: "default",
            accountId: "acc-1",
            senderId: "user-1",
            messageId: "102",
            contextToken: "ctx-1",
            provider: "weixin",
            text: "[2026-04-13 16:01]\n第二条",
            receivedAt: "2026-04-13T08:00:02.000Z",
          },
          {
            workspaceId: "default",
            accountId: "acc-1",
            senderId: "user-1",
            messageId: "101",
            contextToken: "ctx-2",
            provider: "weixin",
            text: "[2026-04-13 16:00]\n第一条",
            receivedAt: "2026-04-13T08:00:01.000Z",
          },
        ],
      },
    ]]),
    isTurnDispatchBlocked() {
      return false;
    },
    async dispatchPreparedTurn(payload) {
      dispatched.push(payload);
      return true;
    },
    mergePendingInboundDraft: CyberbossApp.prototype.mergePendingInboundDraft,
  };

  await CyberbossApp.prototype.flushPendingInboundMessages.call(appLike);

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].prepared.contextToken, "ctx-1");
  assert.match(dispatched[0].prepared.text, /Multiple newer WeChat messages arrived/);
  assert.match(dispatched[0].prepared.text, /第一条[\s\S]*第二条/);
});

test("flushPendingInboundMessages falls back to messageId ordering when receivedAt ties", async () => {
  const dispatched = [];
  const appLike = {
    pendingInboundByScope: new Map([[
      "binding-1::/workspace",
      {
        bindingKey: "binding-1",
        workspaceRoot: "/workspace",
        messages: [
          {
            workspaceId: "default",
            accountId: "acc-1",
            senderId: "user-1",
            messageId: "200",
            contextToken: "ctx-200",
            provider: "weixin",
            text: "第三条",
            receivedAt: "2026-04-13T08:00:01.000Z",
          },
          {
            workspaceId: "default",
            accountId: "acc-1",
            senderId: "user-1",
            messageId: "198",
            contextToken: "ctx-198",
            provider: "weixin",
            text: "第一条",
            receivedAt: "2026-04-13T08:00:01.000Z",
          },
          {
            workspaceId: "default",
            accountId: "acc-1",
            senderId: "user-1",
            messageId: "199",
            contextToken: "ctx-199",
            provider: "weixin",
            text: "第二条",
            receivedAt: "2026-04-13T08:00:01.000Z",
          },
        ],
      },
    ]]),
    isTurnDispatchBlocked() {
      return false;
    },
    async dispatchPreparedTurn(payload) {
      dispatched.push(payload);
      return true;
    },
    mergePendingInboundDraft: CyberbossApp.prototype.mergePendingInboundDraft,
  };

  await CyberbossApp.prototype.flushPendingInboundMessages.call(appLike);

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].prepared.contextToken, "ctx-200");
  assert.match(dispatched[0].prepared.text, /第一条[\s\S]*第二条[\s\S]*第三条/);
});
