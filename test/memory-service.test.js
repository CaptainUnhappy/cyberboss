const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { MemoryService } = require("../src/services/memory-service");

function createService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-memory-test-"));
  return new MemoryService({
    config: {
      memoryFile: path.join(dir, "memory.json"),
      memoryMaxEntries: 100,
    },
  });
}

test("memory service persists, updates, searches, and forgets durable entries", () => {
  const service = createService();
  const created = service.remember({
    key: "wechat_reply_style",
    category: "style",
    content: "微信回复偏短，少用标点，不主动说教。",
    tags: ["回复", "微信"],
    pinned: true,
  });
  assert.equal(created.created, true);

  const updated = service.remember({
    key: "wechat_reply_style",
    category: "style",
    content: "微信回复用短句，贴近用户原话。",
    tags: ["回复", "风格"],
    pinned: true,
  });
  assert.equal(updated.created, false);
  assert.equal(updated.entry.id, created.entry.id);

  const result = service.search({ query: "这条消息如何回复", limit: 5 });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].key, "wechat_reply_style");
  assert.match(result.entries[0].content, /短句/);

  const removed = service.forget({ identifier: "wechat_reply_style" });
  assert.equal(removed.removedCount, 1);
  assert.equal(service.search({ query: "回复" }).entries.length, 0);
});

test("pinned memory participates in automatic recall even without lexical overlap", () => {
  const service = createService();
  service.remember({
    key: "stable_profile",
    category: "profile",
    content: "用户偏好简洁表达。",
    pinned: true,
  });
  assert.equal(service.search({ query: "完全无关的查询" }).entries[0].key, "stable_profile");
});
