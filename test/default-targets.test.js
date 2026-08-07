const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { resolvePreferredSenderId } = require("../src/core/default-targets");

test("check-in target prefers the ClawBot user id with a context token over a display alias", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-default-target-"));
  const accountsDir = path.join(stateDir, "accounts");
  fs.mkdirSync(accountsDir, { recursive: true });
  fs.writeFileSync(path.join(accountsDir, "account-1.context-tokens.json"), JSON.stringify({
    "platform-user@im.wechat": "context-token",
  }), "utf8");

  const senderId = resolvePreferredSenderId({
    config: {
      accountsDir,
      workspaceId: "default",
      allowedUserIds: ["display-alias"],
    },
    accountId: "account-1",
    sessionStore: null,
  });
  assert.equal(senderId, "platform-user@im.wechat");
});

test("an explicit check-in platform user remains the highest-priority target", () => {
  assert.equal(resolvePreferredSenderId({
    config: { accountsDir: "unused", allowedUserIds: ["display-alias"] },
    accountId: "account-1",
    explicitUser: "explicit-platform-user",
  }), "explicit-platform-user");
});
