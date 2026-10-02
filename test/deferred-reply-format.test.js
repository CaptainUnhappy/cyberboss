#!/usr/bin/env node
/**
 * One drained deferred batch goes back to the channel it came from.
 *
 * The `上轮有一条回复当时没能发出去，现在补上。` notice plus the
 * `===== 上轮对话遗留内容 =====` header are an artifact of the OFFICIAL channel, where
 * a reply only exists inside a reply window. The desktop channel has no window: the
 * leftover is simply sent as itself, and the wrapper showed up verbatim in the user's
 * own chat (operator report 2026-10-02).
 *
 * Run: node --test test/deferred-reply-format.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { formatDeferredRepliesForRetry } = require("../src/core/app");

test("a CUA leftover is sent as itself, without the official-channel notice", () => {
  const text = formatDeferredRepliesForRetry([
    { provider: "wechat-cua", text: "闭环成功", kind: "plain_reply" },
  ]);
  assert.equal(text, "闭环成功");
  assert.doesNotMatch(text, /上轮有一条回复当时没能发出去/);
  assert.doesNotMatch(text, /遗留内容/);
});

test("two CUA leftovers stay two paragraphs, still with no notice or header", () => {
  const text = formatDeferredRepliesForRetry([
    { provider: "wechat-cua", text: "第一条" },
    { provider: "wechat-cua", text: "第二条", kind: "system_reply" },
  ]);
  assert.equal(text, "第一条\n\n第二条");
  assert.doesNotMatch(text, /遗留内容|期间模型主动联系|没能发出去/);
});

test("a batch from the desktop channel keeps the plain shape even for a row with no provider", () => {
  // One chat, one shape: an entry written before the provider was recorded must not
  // drag the official-channel banner back into the conversation.
  const text = formatDeferredRepliesForRetry([
    { provider: "wechat-cua", text: "第一条" },
    { provider: "", text: "旧条目" },
  ]);
  assert.equal(text, "第一条\n\n旧条目");
});

test("a blank CUA leftover formats to nothing, never to a bare notice", () => {
  assert.equal(formatDeferredRepliesForRetry([{ provider: "wechat-cua", text: "   " }]), "");
});

test("the official channel keeps the leftover notice its reply window needs", () => {
  const text = formatDeferredRepliesForRetry([
    { provider: "weixin", text: "旧尾段", kind: "plain_reply" },
  ]);
  assert.match(text, /上轮有一条回复当时没能发出去，现在补上。/);
  assert.match(text, /===== 上轮对话遗留内容 =====/);
  assert.match(text, /旧尾段/);
});
