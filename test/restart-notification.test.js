const test = require("node:test");
const assert = require("node:assert/strict");

const { CyberbossApp } = require("../src/core/app");

test("restart notification is always sent through the native bot channel", async () => {
  const sent = [];
  const appLike = {
    config: {
      restartNotificationText: "✅ 服务已重启",
      restartNotificationUserId: "",
      weflowInboxReplyUserId: "platform-user@im.wechat",
    },
    resolveLocalWechatReplyTarget(userId) {
      assert.equal(userId, "platform-user@im.wechat");
      return { userId, contextToken: "ctx-1", provider: "weixin" };
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
      },
    },
  };

  const result = await CyberbossApp.prototype.sendRestartNotification.call(appLike);
  assert.deepEqual(result, {
    userId: "platform-user@im.wechat",
    text: "✅ 服务已重启",
  });
  assert.deepEqual(sent, [{
    userId: "platform-user@im.wechat",
    text: "✅ 服务已重启",
    contextToken: "ctx-1",
    preserveBlock: true,
  }]);
  assert.equal("provider" in sent[0], false);
});

test("restart notification retries without a stale context token", async () => {
  const sent = [];
  const appLike = {
    config: {
      restartNotificationText: "✅ Cyberboss 已重启，服务已恢复。",
      restartNotificationUserId: "platform-user@im.wechat",
      weflowInboxReplyUserId: "",
    },
    resolveLocalWechatReplyTarget(userId) {
      return { userId, contextToken: "stale-token", provider: "weixin" };
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
        if (sent.length === 1) {
          throw new Error("sendMessage ret=-2 errmsg=prepare failed");
        }
      },
    },
  };

  await CyberbossApp.prototype.sendRestartNotification.call(appLike);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].contextToken, "");
  assert.equal(sent[1].omitContextToken, true);
  assert.equal("provider" in sent[1], false);
});

test("restart notification falls back to the verified WeFlow UIA channel", async () => {
  const sent = [];
  const appLike = {
    config: {
      restartNotificationText: "✅ Cyberboss 已重启，服务已恢复。",
      restartNotificationUserId: "platform-user@im.wechat",
      weflowInboxReplyUserId: "platform-user@im.wechat",
    },
    resolveLocalWechatReplyTarget(userId) {
      return { userId, contextToken: "stale-token", provider: "weixin" };
    },
    async sendRestartNotificationViaWeFlow(text) {
      sent.push({ provider: "weflow-uia", text });
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
        throw new Error("sendMessage ret=-2 errmsg=prepare failed");
      },
    },
  };

  const result = await CyberbossApp.prototype.sendRestartNotification.call(appLike);
  assert.deepEqual(result, {
    userId: "platform-user@im.wechat",
    text: "✅ Cyberboss 已重启，服务已恢复。",
  });
  assert.equal(sent.length, 3);
  assert.equal(sent[1].omitContextToken, true);
  assert.deepEqual(sent[2], {
    provider: "weflow-uia",
    text: "✅ Cyberboss 已重启，服务已恢复。",
  });
});
