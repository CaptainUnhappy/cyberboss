const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { PipelineActivityStore } = require("../src/core/pipeline-activity-store");
const { CyberbossApp } = require("../src/core/app");

test("pipeline activity writes atomic process, inbound, and live counter snapshots", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-pipeline-activity-"));
  const filePath = path.join(dir, "cyberboss-pipeline-activity.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { value: Date.parse("2026-08-28T12:00:00.000Z") };
  const counters = {
    activeTurnCount: 1,
    turnGateCount: 2,
    activeDeliveryCount: 3,
    pendingInboundCount: 4,
  };
  const store = new PipelineActivityStore({
    filePath,
    snapshotProvider: () => counters,
    now: () => clock.value,
    refreshIntervalMs: 60_000,
    logger: { warn() {} },
  });

  store.start();
  let snapshot = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.pid, process.pid);
  assert.match(snapshot.instanceId, /^[a-f0-9-]{36}$/);
  assert.equal(snapshot.updatedAt, "2026-08-28T12:00:00.000Z");
  assert.equal(snapshot.activeTurnCount, 1);
  assert.equal(snapshot.turnGateCount, 2);
  assert.equal(snapshot.activeDeliveryCount, 3);
  assert.equal(snapshot.pendingInboundCount, 4);

  clock.value += 1_000;
  store.markUserInbound();
  clock.value += 1_000;
  counters.activeTurnCount = 0;
  counters.turnGateCount = 0;
  store.markTurnCompleted();
  store.stop();
  snapshot = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(snapshot.lastUserInboundAt, "2026-08-28T12:00:01.000Z");
  assert.equal(snapshot.lastTurnCompletedAt, "2026-08-28T12:00:02.000Z");
  assert.equal(snapshot.activeTurnCount, 0);
  assert.equal(snapshot.turnGateCount, 0);
  assert.equal(store.timer, null);
  assert.equal(fs.readdirSync(dir).some((name) => name.includes(".tmp-")), false);
});

test("pipeline activity preserves the previous user-inbound timestamp across restart", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-pipeline-activity-restart-"));
  const filePath = path.join(dir, "activity.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(filePath, JSON.stringify({
    lastUserInboundAt: "2026-08-28T11:59:00.000Z",
  }), "utf8");
  const store = new PipelineActivityStore({
    filePath,
    now: () => Date.parse("2026-08-28T12:00:00.000Z"),
    logger: { warn() {} },
  });
  const snapshot = store.refresh();
  assert.equal(snapshot.lastUserInboundAt, "2026-08-28T11:59:00.000Z");
});

test("Cyberboss activity counters cover turns, gates, deliveries, and durable inbound work", () => {
  const snapshot = CyberbossApp.prototype.buildPipelineActivitySnapshot.call({
    threadStateStore: {
      snapshot() {
        return [
          { status: "running" },
          { status: "waiting_approval" },
          { status: "idle" },
          { status: "failed" },
        ];
      },
    },
    turnGateStore: { pendingScopeKeys: new Set(["gate-1", "gate-2"]) },
    streamDelivery: { stateByRunKey: new Map([["run-1", {}]]) },
    pendingInboundByScope: new Map([
      ["scope-1", { messages: [{}, {}] }],
    ]),
    pendingSharedContentInboundByScope: new Map([
      ["shared-1", { messages: [{}] }],
    ]),
    pendingInboundPostDispatchCommits: new Map([["commit-1", {}]]),
  });
  assert.deepEqual(snapshot, {
    activeTurnCount: 2,
    turnGateCount: 2,
    activeDeliveryCount: 1,
    pendingInboundCount: 4,
  });
});
