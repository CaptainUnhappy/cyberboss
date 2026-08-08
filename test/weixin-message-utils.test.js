const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createInboundFilter,
  extractQuotedItems,
} = require("../src/adapters/channel/weixin/message-utils");

function normalizeItemList(itemList, overrides = {}) {
  return createInboundFilter().normalize({
    message_type: 1,
    from_user_id: "user-1",
    message_id: "message-1",
    create_time_ms: 1_774_000_000_000,
    item_list: itemList,
    ...overrides,
  }, { workspaceId: "default" }, "account-1");
}

test("quoted text is separated from the current prompt", () => {
  const normalized = normalizeItemList([{
    type: 1,
    text_item: { text: "总结一下" },
    ref_msg: {
      title: "某人",
      message_item: {
        type: 1,
        text_item: { text: "这是被引用的正文" },
      },
    },
  }]);

  assert.equal(normalized.text, "总结一下");
  assert.deepEqual(normalized.quotedContexts, [{
    kind: "text",
    title: "某人",
    text: "这是被引用的正文",
    url: "",
    attachmentRefs: [],
  }]);
  assert.deepEqual(normalized.attachments, []);
});

test("quoted links keep known titles and http URLs", () => {
  const normalized = normalizeItemList([{
    type: 1,
    text_item: { text: "分析这个链接" },
    ref_msg: {
      title: "引用卡片",
      message_item: {
        type: 1,
        text_item: {
          text: "卡片摘要",
          link: {
            title: "文章标题",
            description: "文章简介",
            url: "https://example.com/article?id=1",
          },
        },
      },
    },
  }]);

  assert.deepEqual(normalized.quotedContexts, [{
    kind: "link",
    title: "引用卡片",
    text: "卡片摘要",
    url: "https://example.com/article?id=1",
    attachmentRefs: [],
  }]);
});

test("quoted image, file, and video items become referenced attachments", () => {
  const cases = [
    { type: 2, bodyName: "image_item", kind: "image", fileName: "photo.jpg" },
    { type: 4, bodyName: "file_item", kind: "file", fileName: "brief.pdf" },
    { type: 5, bodyName: "video_item", kind: "video", fileName: "clip.mp4" },
  ];

  for (const itemCase of cases) {
    const messageItem = {
      type: itemCase.type,
      [itemCase.bodyName]: {
        file_name: itemCase.fileName,
        media: {
          url: `https://cdn.example.com/${itemCase.fileName}`,
          aes_key: "secret-aes-key",
          encrypt_query_param: "secret-query",
        },
      },
    };
    const normalized = normalizeItemList([{
      type: 1,
      text_item: { text: "处理一下" },
      ref_msg: { title: "资料", message_item: messageItem },
    }], { message_id: `message-${itemCase.type}` });

    assert.equal(normalized.quotedContexts[0].kind, itemCase.kind);
    assert.equal(normalized.quotedContexts[0].attachmentRefs.length, 1);
    assert.equal(normalized.attachments.length, 1);
    assert.equal(normalized.attachments[0].origin, "quoted");
    assert.equal(normalized.attachments[0].quoteIndex, 0);
    assert.equal(normalized.attachments[0].attachmentRef, normalized.quotedContexts[0].attachmentRefs[0]);
    assert.equal(normalized.attachments[0].fileName, itemCase.fileName);

    const promptSafeContext = JSON.stringify(normalized.quotedContexts);
    assert.doesNotMatch(promptSafeContext, /secret-aes-key|secret-query/);
  }
});

test("quoted voice transcripts and unknown types remain typed context", () => {
  const voice = extractQuotedItems([{
    type: 1,
    ref_msg: {
      title: "语音",
      message_item: { type: 3, voice_item: { text: "转写结果" } },
    },
  }]);
  assert.deepEqual(voice.contexts, [{
    kind: "voice",
    title: "语音",
    text: "转写结果",
    url: "",
    attachmentRefs: [],
  }]);

  const unknown = extractQuotedItems([{
    type: 1,
    ref_msg: {
      title: "未知资料",
      message_item: { type: 99, private_payload: { token: "hidden" } },
    },
  }]);
  assert.deepEqual(unknown.contexts, [{
    kind: "unknown",
    title: "未知资料",
    text: "",
    url: "",
    attachmentRefs: [],
  }]);
  assert.doesNotMatch(JSON.stringify(unknown.contexts), /hidden|private_payload/);
});

test("malformed references are ignored without dropping the current message", () => {
  const normalized = normalizeItemList([{
    type: 1,
    text_item: { text: "普通聊天" },
    ref_msg: { title: "损坏引用", message_item: null },
  }]);

  assert.equal(normalized.text, "普通聊天");
  assert.deepEqual(normalized.quotedContexts, []);
});

test("direct attachments retain a direct origin", () => {
  const normalized = normalizeItemList([{
    type: 2,
    image_item: {
      file_name: "direct.jpg",
      media: { url: "https://cdn.example.com/direct.jpg" },
    },
  }]);

  assert.equal(normalized.text, "");
  assert.equal(normalized.attachments[0].origin, "direct");
  assert.equal(normalized.attachments[0].quoteIndex, null);
  assert.equal(normalized.attachments[0].attachmentRef, "");
  assert.deepEqual(normalized.quotedContexts, []);
  assert.equal(normalized.contentKind, "image");
  assert.equal(normalized.sharedContent, true);
  assert.equal(normalized.explicitPrompt, false);
});

test("direct link cards and URL-only text are shared content without an explicit prompt", () => {
  const card = normalizeItemList([{
    type: 1,
    text_item: {
      text: "文章标题",
      link: {
        title: "文章标题",
        description: "文章简介",
        url: "https://example.com/card",
      },
    },
  }]);
  const urlOnly = normalizeItemList([{
    type: 1,
    text_item: { text: "https://example.com/plain" },
  }], { message_id: "message-url-only" });

  assert.equal(card.contentKind, "link");
  assert.equal(card.contentUrl, "https://example.com/card");
  assert.equal(card.sharedContent, true);
  assert.equal(card.explicitPrompt, false);
  assert.equal(urlOnly.contentKind, "link");
  assert.equal(urlOnly.sharedContent, true);
  assert.equal(urlOnly.explicitPrompt, false);
});

test("text containing an instruction and URL is handled as an explicit same-message prompt", () => {
  const normalized = normalizeItemList([{
    type: 1,
    text_item: { text: "总结这个链接 https://example.com/report" },
  }], { message_id: "message-url-prompt" });

  assert.equal(normalized.contentKind, "link");
  assert.equal(normalized.sharedContent, true);
  assert.equal(normalized.explicitPrompt, true);
});
