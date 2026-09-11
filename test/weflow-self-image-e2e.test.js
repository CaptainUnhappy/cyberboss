"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { waitForSourcePair } = require("../scripts/weflow-self-image-e2e");

function sourceRows(textServerId, imageServerId, skewSeconds = 4) {
  return [
    {
      localId: 386,
      serverId: textServerId,
      localType: 1,
      createTime: 1_788_337_124,
      isSend: 1,
      content: "图中有什么",
    },
    {
      localId: 387,
      serverId: imageServerId,
      localType: 3,
      createTime: 1_788_337_124 + skewSeconds,
      isSend: 1,
      content: "[图片]",
    },
  ];
}

test("self-image E2E waits for unique positive serverIds to converge", async () => {
  const snapshots = [
    sourceRows("0", "0"),
    sourceRows("4411196009803242881", "4411196009803242881"),
    sourceRows("4411196009803242881", "5745540549041930042"),
  ];
  let fetchCount = 0;
  let sleepCount = 0;

  const pair = await waitForSourcePair({ pollMs: 1 }, {
    baselineMax: { text: "385", value: 385n },
    textLocalId: { text: "386", value: 386n },
    imageLocalId: { text: "387", value: 387n },
  }, {
    fetchMessages: async () => snapshots[Math.min(fetchCount++, snapshots.length - 1)],
    sleep: async () => { sleepCount += 1; },
    timeoutMs: 1_000,
  });

  assert.equal(fetchCount, 3);
  assert.equal(sleepCount, 2);
  assert.deepEqual({
    textLocalId: pair.textLocalId.text,
    imageLocalId: pair.imageLocalId.text,
    textServerId: pair.textServerId,
    imageServerId: pair.imageServerId,
    skewSeconds: pair.skewSeconds,
  }, {
    textLocalId: "386",
    imageLocalId: "387",
    textServerId: "4411196009803242881",
    imageServerId: "5745540549041930042",
    skewSeconds: 4,
  });
});

test("self-image E2E rejects an adjacent row beyond the explicit prompt contract", async () => {
  await assert.rejects(
    waitForSourcePair({ pollMs: 1 }, {
      baselineMax: { text: "385", value: 385n },
      textLocalId: { text: "386", value: 386n },
      imageLocalId: { text: "387", value: 387n },
    }, {
      fetchMessages: async () => sourceRows(
        "4411196009803242881",
        "5745540549041930042",
        16
      ),
      sleep: async () => {},
      timeoutMs: 1_000,
    }),
    /outside the 0\.\.15 second contract: 16/
  );
});
