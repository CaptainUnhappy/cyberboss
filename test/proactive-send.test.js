const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { saveWeixinAccount } = require("../src/adapters/channel/weixin/account-store");
const { CyberbossApp } = require("../src/core/app");
const { ReminderService } = require("../src/services/reminder-service");
const { SystemMessageService } = require("../src/services/system-message-service");

function createConfig() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-proactive-test-"));
  const config = {
    stateDir,
    accountsDir: path.join(stateDir, "accounts"),
    accountId: "account-1",
    weixinBaseUrl: "https://ilink.example.com",
    workspaceId: "default",
    workspaceRoot: stateDir,
    allowedUserIds: ["platform-user@im.wechat"],
    reminderQueueFile: path.join(stateDir, "reminders.json"),
    systemMessageQueueFile: path.join(stateDir, "system-messages.json"),
  };
  saveWeixinAccount(config, "account-1", {
    token: "bot-token",
    userId: "bot-user",
    baseUrl: config.weixinBaseUrl,
  });
  return config;
}

test("system messages can be queued for a platform user without a context token", () => {
  const config = createConfig();
  const service = new SystemMessageService({ config, sessionStore: null });
  const queued = service.queueMessage({
    text: "主动联系",
    userId: "platform-user@im.wechat",
    workspaceRoot: config.workspaceRoot,
  });

  assert.equal(queued.senderId, "platform-user@im.wechat");
  assert.equal(queued.text, "主动联系");
});

test("reminders can be created for a platform user without a context token", async () => {
  const config = createConfig();
  const service = new ReminderService({ config, sessionStore: null });
  const reminder = await service.create({
    delay: "5m",
    text: "记得喝水",
    userId: "platform-user@im.wechat",
  });

  assert.equal(reminder.senderId, "platform-user@im.wechat");
  assert.equal(reminder.contextToken, "");
  assert.equal(reminder.text, "记得喝水");
});

test("reminders use the active runtime account when the tool process has multiple accounts", async () => {
  const config = createConfig();
  saveWeixinAccount(config, "account-2", {
    token: "second-token",
    userId: "second-bot-user",
    baseUrl: config.weixinBaseUrl,
  });
  config.accountId = "";
  const service = new ReminderService({ config, sessionStore: null });

  const reminder = await service.create({
    delay: "5m",
    text: "记得请假",
  }, {
    accountId: "account-1",
    senderId: "platform-user@im.wechat",
  });

  assert.equal(reminder.accountId, "account-1");
  assert.equal(reminder.senderId, "platform-user@im.wechat");
  assert.equal(reminder.text, "记得请假");
});

test("the inbound poll wakes at the next reminder deadline without enabling check-ins", () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    const timeoutMs = CyberbossApp.prototype.resolveLongPollTimeoutMs.call({
      activeAccountId: "account-1",
      systemMessageDispatcher: { hasPending() { return false; } },
      timelineScreenshotQueue: { hasPendingForAccount() { return false; } },
      reminderQueue: { peekNextDueAtMs() { return 1_009_000; } },
    });
    assert.equal(timeoutMs, 9_000);
  } finally {
    Date.now = originalNow;
  }
});
