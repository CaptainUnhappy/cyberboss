const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { WeFlowCanaryInboxSource } = require("../src/integrations/weflow-canary-inbox");

function fixture(t, rows, onMessage = async () => true) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-canary-inbox-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const calls = [];
  const config = {
    weflowBaseUrl: "http://127.0.0.1:5031",
    weflowToken: "fixture-token",
    weflowCanaryChat: "wxid_canary_self",
    weflowCanaryDisplayName: "Azzy",
    weflowCanaryInboxCursorFile: path.join(stateDir, "weflow-canary-inbox-cursor.json"),
    weflowCanaryMessageLimit: 200,
  };
  const source = new WeFlowCanaryInboxSource({
    config,
    onMessage: async (...args) => {
      calls.push(args);
      return onMessage(...args);
    },
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, "/api/v1/messages");
      assert.equal(parsed.searchParams.get("talker"), config.weflowCanaryChat);
      return { ok: true, status: 200, async json() { return { messages: rows }; } };
    },
    logger: { error() {} },
  });
  return { calls, config, source };
}

test("dedicated canary poll skips ordinary/media rows and advances only reserved outgoing markers", async (t) => {
  const rows = [
    { localId: 1, isSend: 1, localType: 1, content: "hi", senderUsername: "wxid_canary_self" },
    { localId: 2, isSend: 1, localType: 3, content: "[图片]", senderUsername: "wxid_canary_self" },
    { localId: 3, isSend: 0, content: "[Cyberboss心跳探针 inbound]" },
    { localId: 3, isSend: 1, content: "[Cyberboss心跳探针 wrong-sender]", senderUsername: "wxid_other" },
    {
      localId: 4,
      serverId: "server-4",
      isSend: 1,
      content: "[Cyberboss心跳探针 trigger=fixture nonce=fixture]",
      createTime: 1_788_000_000,
      senderUsername: "wxid_canary_self",
    },
  ];
  const { calls, config, source } = fixture(t, rows);
  const result = await source.pollOnce();
  assert.deepEqual(result, { status: "ok", fetched: 5, candidates: 1, processed: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].localId, "4");
  assert.equal(calls[0][0].direction, "outgoing");
  assert.equal(calls[0][1].chat, "Azzy");
  assert.equal(calls[0][1].chatUsername, "wxid_canary_self");
  assert.equal(calls[0][1].canaryOnly, true);

  const cursor = JSON.parse(fs.readFileSync(config.weflowCanaryInboxCursorFile, "utf8"));
  assert.equal(cursor.talker, "wxid_canary_self");
  assert.equal(cursor.lastLocalId, "4");
  assert.deepEqual(cursor.seenIdentities, ["local:4"]);

  const replay = await source.pollOnce();
  assert.equal(replay.processed, 0);
  assert.equal(calls.length, 1);
});

test("a deferred marker is not crossed or committed and is retried on the next poll", async (t) => {
  let accepted = false;
  const rows = [
    { localId: 10, serverId: "s10", isSend: 1, content: "[Cyberboss心跳探针 one]", senderUsername: "wxid_canary_self" },
    { localId: 11, serverId: "s11", isSend: 1, content: "[Cyberboss心跳正常 two]", senderUsername: "wxid_canary_self" },
  ];
  const { calls, config, source } = fixture(t, rows, async () => accepted);
  let result = await source.pollOnce();
  assert.equal(result.status, "deferred");
  assert.equal(result.processed, 0);
  let cursor = JSON.parse(fs.readFileSync(config.weflowCanaryInboxCursorFile, "utf8"));
  assert.equal(cursor.lastLocalId, "");
  assert.equal(calls.length, 1, "later marker must not be crossed");

  accepted = true;
  result = await source.pollOnce();
  assert.equal(result.processed, 2);
  cursor = JSON.parse(fs.readFileSync(config.weflowCanaryInboxCursorFile, "utf8"));
  assert.equal(cursor.lastLocalId, "11");
  assert.equal(calls.length, 3);
});

test("cursor identity is bound to the configured canary talker", async (t) => {
  const rows = [{ localId: 20, isSend: 1, content: "[Cyberboss心跳探针 fixture]", senderUsername: "wxid_canary_self" }];
  const first = fixture(t, rows);
  await first.source.pollOnce();
  const second = new WeFlowCanaryInboxSource({
    config: { ...first.config, weflowCanaryChat: "wxid_new_self" },
    onMessage: async () => true,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { messages: rows.map((row) => ({ ...row, senderUsername: "wxid_new_self" })) };
      },
    }),
  });
  const result = await second.pollOnce();
  assert.equal(result.processed, 1, "a different talker must not inherit the old high-water mark");
  const cursor = JSON.parse(fs.readFileSync(first.config.weflowCanaryInboxCursorFile, "utf8"));
  assert.equal(cursor.talker, "wxid_new_self");
});
