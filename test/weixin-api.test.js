const test = require("node:test");
const assert = require("node:assert/strict");

const { sendText } = require("../src/adapters/channel/weixin/api");

test("sendText omits context_token when proactive delivery has no current context", async () => {
  const originalFetch = global.fetch;
  let requestBody = null;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      async text() {
        return JSON.stringify({ ret: 0 });
      },
    };
  };
  try {
    await sendText({
      baseUrl: "https://ilink.example.com",
      token: "bot-token",
      toUserId: "platform-user@im.wechat",
      text: "主动消息",
      contextToken: "",
      clientId: "client-1",
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(requestBody.msg.to_user_id, "platform-user@im.wechat");
  assert.equal("context_token" in requestBody.msg, false);
});

test("sendText keeps a supplied context_token for direct replies", async () => {
  const originalFetch = global.fetch;
  let requestBody = null;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      async text() {
        return JSON.stringify({ ret: 0 });
      },
    };
  };
  try {
    await sendText({
      baseUrl: "https://ilink.example.com",
      token: "bot-token",
      toUserId: "platform-user@im.wechat",
      text: "回复消息",
      contextToken: "ctx-1",
      clientId: "client-2",
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(requestBody.msg.context_token, "ctx-1");
});
