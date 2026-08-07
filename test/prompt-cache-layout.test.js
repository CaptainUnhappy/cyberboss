const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { assembleRuntimeTurnText } = require("../src/core/inbound-turn");
const {
  buildSystemInboundText,
  loadSystemActionInstructions,
} = require("../src/core/system-message-dispatcher");

test("system wake prompt keeps stable instructions first and dynamic time last", () => {
  const prompt = buildSystemInboundText(
    "User comes to mind again.",
    "2026-08-06T05:20:00.000Z",
  );

  assert.ok(prompt.startsWith("SYSTEM ACTION MODE:"));
  assert.ok(prompt.indexOf("Trigger:") > prompt.indexOf("No markdown fences"));
  assert.ok(prompt.indexOf("Event time:") > prompt.indexOf("User comes to mind again."));
  assert.ok(prompt.endsWith("Event time: [2026-08-06 13:20]"));
});

test("normal inbound prompt places message time after content", () => {
  const prompt = assembleRuntimeTurnText({
    prepared: {
      originalText: "你好",
      receivedAt: "2026-08-06T05:20:00.000Z",
    },
  });

  assert.ok(prompt.startsWith("你好"));
  assert.ok(prompt.endsWith("Message time: [2026-08-06 13:20]"));
});

test("normal inbound prompt recalls durable memory without moving dynamic time from the end", () => {
  const prompt = assembleRuntimeTurnText({
    prepared: {
      originalText: "如何回复",
      receivedAt: "2026-08-06T05:20:00.000Z",
    },
    memoryContext: {
      items: [{ category: "style", key: "wechat_reply_style", content: "回复保持短句。" }],
    },
  });
  assert.match(prompt, /Relevant durable memory:/);
  assert.match(prompt, /回复保持短句/);
  assert.ok(prompt.endsWith("Message time: [2026-08-06 13:20]"));
});

test("direct merged forwards carry an implicit ready-to-send reply task", () => {
  const prompt = assembleRuntimeTurnText({
    prepared: {
      originalText: "WeFlow 微信入站（来自大号会话 yourself）\n[合并转发]\n[2026-08-07 12:00] 对方: 周末吃饭吗\n[2026-08-07 12:01] yourself: 看看",
      receivedAt: "2026-08-07T04:01:00.000Z",
    },
  });

  assert.match(prompt, /Implicit task for this direct merged-forward message:/);
  assert.match(prompt, /output only one ready-to-send reply/);
  assert.ok(prompt.endsWith("Message time: [2026-08-07 12:01]"));
});

test("quoted merged-forward material does not create a second implicit task", () => {
  const prompt = assembleRuntimeTurnText({
    prepared: {
      originalText: "总结一下",
      quotedContexts: [{ kind: "text", text: "[合并转发] 对方: 周末吃饭吗" }],
      receivedAt: "2026-08-07T04:01:00.000Z",
    },
  });

  assert.doesNotMatch(prompt, /Implicit task for this direct merged-forward message:/);
  assert.match(prompt, /Quoted context:/);
});

test("system action instructions can be customized from a file", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-system-prompt-"));
  const promptFile = path.join(stateDir, "system-action.md");
  fs.writeFileSync(promptFile, "Hello {{USER_NAME}}.\nReturn JSON.", "utf8");

  const prompt = loadSystemActionInstructions({
    systemActionInstructionsFile: promptFile,
    userName: "Alice",
  });

  assert.equal(prompt, "Hello Alice.\nReturn JSON.");
});
