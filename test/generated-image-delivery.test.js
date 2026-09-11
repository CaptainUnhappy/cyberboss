const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { mapCodexMessageToRuntimeEvent } = require("../src/adapters/runtime/codex/events");
const { createWeixinChannelAdapter } = require("../src/adapters/channel/weixin");
const {
  extractGeneratedImageArtifacts,
  materializeGeneratedImageArtifact,
  pruneManagedGeneratedImages,
} = require("../src/core/generated-image-artifact");
const { StreamDelivery } = require("../src/core/stream-delivery");

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("Codex imageGeneration completion maps to a media event without carrying base64", () => {
  const event = mapCodexMessageToRuntimeEvent({
    method: "item/completed",
    params: {
      threadId: "thread-image",
      turnId: "turn-image",
      item: {
        id: "image-item",
        type: "imageGeneration",
        status: "completed",
        savedPath: "C:\\managed\\image.png",
        result: "very-large-base64",
        revisedPrompt: "fixture prompt",
      },
    },
  });

  assert.deepEqual(event, {
    type: "runtime.media.completed",
    payload: {
      threadId: "thread-image",
      turnId: "turn-image",
      itemId: "image-item",
      kind: "image",
      filePath: "C:\\managed\\image.png",
      mimeType: "image/png",
      revisedPrompt: "fixture prompt",
    },
  });
  assert.equal("result" in event.payload, false);
});

test("generated image extraction supports bounded thread item listing responses", () => {
  const artifacts = extractGeneratedImageArtifacts({
    result: {
      data: [{
        turnId: "turn-image",
        item: {
          id: "image-item",
          type: "imageGeneration",
          status: "completed",
          savedPath: "C:\\managed\\image.png",
          result: "base64-fallback",
        },
      }, {
        turnId: "turn-other",
        item: { id: "other", type: "imageGeneration", savedPath: "other.png" },
      }],
    },
  }, { turnId: "turn-image" });

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].itemId, "image-item");
  assert.equal(artifacts[0].savedPath, "C:\\managed\\image.png");
});

test("generated images are copied atomically into the managed outbound root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-generated-image-"));
  const sourceRoot = path.join(root, "source", "thread-image");
  const outputDir = path.join(root, "outbound");
  fs.mkdirSync(sourceRoot, { recursive: true });
  const sourcePath = path.join(sourceRoot, "image.png");
  fs.writeFileSync(sourcePath, ONE_PIXEL_PNG);

  const first = materializeGeneratedImageArtifact({
    itemId: "image-item",
    savedPath: sourcePath,
  }, {
    outputDir,
    threadId: "thread-image",
    turnId: "turn-image",
    allowedSourceRoots: [sourceRoot],
  });
  const second = materializeGeneratedImageArtifact({
    itemId: "image-item",
    result: ONE_PIXEL_PNG.toString("base64"),
  }, {
    outputDir,
    threadId: "thread-image",
    turnId: "turn-image",
  });

  assert.equal(first.filePath, second.filePath);
  assert.deepEqual(fs.readFileSync(first.filePath), ONE_PIXEL_PNG);
  assert.match(first.sha256, /^[a-f0-9]{64}$/u);
  assert.match(first.idempotencyKey, /^generated-image:/u);
});

test("generated image savedPath outside the declared source root is rejected", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-generated-image-boundary-"));
  const sourcePath = path.join(root, "outside.png");
  fs.writeFileSync(sourcePath, ONE_PIXEL_PNG);
  assert.throws(() => materializeGeneratedImageArtifact({
    itemId: "image-item",
    savedPath: sourcePath,
  }, {
    outputDir: path.join(root, "outbound"),
    threadId: "thread-image",
    turnId: "turn-image",
    allowedSourceRoots: [path.join(root, "allowed")],
  }), /outside the managed source root/u);
});

test("managed generated image retention prunes only excess PNG artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-generated-image-prune-"));
  const first = path.join(root, "first.png");
  const second = path.join(root, "second.png");
  const unrelated = path.join(root, "keep.txt");
  fs.writeFileSync(first, ONE_PIXEL_PNG);
  fs.writeFileSync(second, ONE_PIXEL_PNG);
  fs.writeFileSync(unrelated, "fixture");
  const now = Date.now();
  fs.utimesSync(first, new Date(now - 2_000), new Date(now - 2_000));
  fs.utimesSync(second, new Date(now - 1_000), new Date(now - 1_000));

  pruneManagedGeneratedImages(root, { nowMs: now, maxFiles: 1, maxTotalBytes: 1024 * 1024 });

  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(second), true);
  assert.equal(fs.existsSync(unrelated), true);
});

test("media and final text share one ordered delivery chain and duplicate media is suppressed", async () => {
  const deliveries = [];
  const stream = new StreamDelivery({
    channelAdapter: {
      async sendFile(payload) { deliveries.push(["file", payload]); },
      async sendText(payload) { deliveries.push(["text", payload]); },
      getKnownContextTokens() { return {}; },
    },
    sessionStore: { findBindingForThreadId() { return null; } },
    runtimeId: "codex",
  });
  stream.queueReplyTargetForThread("thread-image", {
    userId: "user-image",
    contextToken: "ctx-image",
    provider: "weflow-uia",
  });

  await stream.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-image", turnId: "turn-image" },
  });
  const mediaEvent = {
    type: "runtime.media.completed",
    payload: {
      threadId: "thread-image",
      turnId: "turn-image",
      itemId: "image-item",
      kind: "image",
      filePath: "C:\\managed\\image.png",
      mimeType: "image/png",
      sha256: "a".repeat(64),
      idempotencyKey: "generated-image:fixture",
    },
  };
  await stream.handleRuntimeEvent(mediaEvent);
  await stream.handleRuntimeEvent(mediaEvent);
  await stream.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: {
      threadId: "thread-image",
      turnId: "turn-image",
      itemId: "final-item",
      text: "生成好了",
      phase: "final_answer",
    },
  });
  await stream.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId: "thread-image", turnId: "turn-image" },
  });

  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0][0], "file");
  assert.equal(deliveries[0][1].provider, "weflow-uia");
  assert.equal(deliveries[0][1].idempotencyKey, "generated-image:fixture");
  assert.equal(deliveries[1][0], "text");
  assert.equal(deliveries[1][1].text, "生成好了");
});

test("WeFlow UIA file delivery stays on the azzy image bridge route", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const ledgerEvents = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      async json() {
        return { dispatched: true, verified: true, localId: "91" };
      },
    };
  };
  try {
    const adapter = createWeixinChannelAdapter({
      stateDir: "C:\\fixture-state",
      weflowBridgeBaseUrl: "http://bridge.local:8766",
      weflowInboxDisplayName: "fixture-contact",
      weflowInboxChat: "fixture-talker",
    }, {
      weflowMessageLedger: {
        async planOutbound(payload) {
          ledgerEvents.push(["planned", payload]);
          return { id: "image-operation", status: "planned" };
        },
        async markSending(entry) { ledgerEvents.push(["sending", entry]); },
        async markVerified(entry, details) { ledgerEvents.push(["verified", entry, details]); },
        async markFailed() { throw new Error("unexpected failure"); },
      },
    });
    await adapter.sendFile({
      userId: "fixture-user",
      filePath: "C:\\fixture-state\\generated-images-outbound\\image.png",
      provider: "weflow-uia",
      idempotencyKey: "generated-image:fixture",
      sha256: "a".repeat(64),
      messageKind: "generated_image",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://bridge.local:8766/api/send-image");
  assert.equal(requests[0].body.sha256, "a".repeat(64));
  assert.equal(ledgerEvents[0][0], "planned");
  assert.equal(ledgerEvents[0][1].contentKind, "image");
  assert.equal(ledgerEvents.at(-1)[0], "verified");
});

test("a certain media failure is retried only twice and does not suppress final text", async () => {
  const deliveries = [];
  let fileAttempts = 0;
  const stream = new StreamDelivery({
    channelAdapter: {
      async sendFile() {
        fileAttempts += 1;
        throw new Error("fixture image validation failed");
      },
      async sendText(payload) { deliveries.push(payload.text); },
      getKnownContextTokens() { return {}; },
    },
    sessionStore: { findBindingForThreadId() { return null; } },
    runtimeId: "codex",
  });
  stream.queueReplyTargetForThread("thread-failed-image", {
    userId: "user-image",
    contextToken: "ctx-image",
    provider: "weflow-uia",
  });
  await stream.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-failed-image", turnId: "turn-failed-image" },
  });
  await stream.handleRuntimeEvent({
    type: "runtime.media.completed",
    payload: {
      threadId: "thread-failed-image",
      turnId: "turn-failed-image",
      itemId: "image-item",
      kind: "image",
      filePath: "C:\\managed\\image.png",
      sha256: "b".repeat(64),
      idempotencyKey: "generated-image:failed",
    },
  });
  await stream.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: {
      threadId: "thread-failed-image",
      turnId: "turn-failed-image",
      itemId: "final-item",
      text: "生成好了",
      phase: "final_answer",
    },
  });
  await stream.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId: "thread-failed-image", turnId: "turn-failed-image" },
  });

  assert.equal(fileAttempts, 2);
  assert.deepEqual(deliveries, [
    "生成好了",
    "❌ 图片已经生成，但发送到微信失败；原图已保留，可稍后补发。",
  ]);
});
