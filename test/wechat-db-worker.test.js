#!/usr/bin/env node
/**
 * The reader worker: framing, correlation, timeouts, and a dead child.
 *
 * A reader that stops answering is indistinguishable from a quiet chat unless
 * these paths are right, and the failure they guard against is silent: the bot
 * keeps running and never replies to anyone.
 *
 * Run: node --test test/wechat-db-worker.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { WechatDbWorker } = require("../src/integrations/wechat-db/worker");

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.written = [];
  child.stdin = {
    write(line) {
      child.written.push(line);
      return true;
    },
  };
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    child.emit("exit", 0, null);
  };
  child.respond = (payload) => child.stdout.emit("data", `${JSON.stringify(payload)}\n`);
  return child;
}

function harness() {
  const children = [];
  const spawnImpl = () => {
    const child = fakeChild();
    children.push(child);
    return child;
  };
  const logs = { log: [], warn: [], error: [], debug: [] };
  const logger = {
    log: (m) => logs.log.push(m),
    warn: (m) => logs.warn.push(m),
    error: (m) => logs.error.push(m),
    debug: (m) => logs.debug.push(m),
  };
  const worker = new WechatDbWorker({ spawnImpl, logger, requestTimeoutMs: 500 });
  return { worker, children, logs, child: () => children[children.length - 1] };
}

test("a request is framed as one JSON line carrying a correlation id", async () => {
  const { worker, child } = harness();
  const pending = worker.request({ cmd: "ping" });
  const line = child().written[0];
  assert.ok(line.endsWith("\n"), "one request per line");
  const parsed = JSON.parse(line);
  assert.equal(parsed.cmd, "ping");
  assert.equal(typeof parsed.id, "number");
  child().respond({ id: parsed.id, ok: true, pong: true });
  const payload = await pending;
  assert.equal(payload.pong, true);
});

test("a response is matched to its own request, in any order", async () => {
  const { worker, child } = harness();
  const first = worker.request({ cmd: "snapshot", chat: "a" });
  const second = worker.request({ cmd: "snapshot", chat: "b" });
  const ids = child().written.map((line) => JSON.parse(line).id);
  assert.notEqual(ids[0], ids[1]);
  child().respond({ id: ids[1], ok: true, snapshot: { chat: "b" } });
  child().respond({ id: ids[0], ok: true, snapshot: { chat: "a" } });
  assert.equal((await first).snapshot.chat, "a");
  assert.equal((await second).snapshot.chat, "b");
});

test("a refusal becomes a rejection with the reader's own words", async () => {
  const { worker, child } = harness();
  const pending = worker.request({ cmd: "snapshots" });
  const id = JSON.parse(child().written[0]).id;
  child().respond({ id, ok: false, error: "KeyMismatchError: 密钥与数据库不匹配" });
  await assert.rejects(pending, /KeyMismatchError/);
});

test("a child that cannot start fails the request instead of hanging", async () => {
  const { worker, child } = harness();
  const pending = worker.request({ cmd: "ping" });
  child().emit("error", new Error("spawn python ENOENT"));
  await assert.rejects(pending, /could not start/);
});

test("an in-flight request dies with the child it belonged to", async () => {
  const { worker, child } = harness();
  const pending = worker.request({ cmd: "snapshot", chat: "a" });
  child().exitCode = 1;
  child().emit("exit", 1, null);
  await assert.rejects(pending, /exited \(code=1/);
});

test("the next request restarts the reader, honouring a cooldown", async () => {
  const { worker, children, child } = harness();
  const first = worker.request({ cmd: "ping" });
  first.catch(() => {});
  children[0].exitCode = 1;
  children[0].emit("exit", 1, null);
  // Inside the cooldown a new call fails fast rather than spawning in a loop.
  await assert.rejects(worker.request({ cmd: "ping" }), /not restarting yet/);
  assert.equal(children.length, 1);
  // ...and the cooldown is the only thing holding it back.
  worker.restartCooldownMs = 0;
  const retried = worker.request({ cmd: "ping" });
  assert.equal(children.length, 2);
  const id = JSON.parse(child().written[0]).id;
  child().respond({ id, ok: true });
  await retried;
});

test("a request that is never answered times out and kills the reader", async () => {
  const { worker, child } = harness();
  await assert.rejects(worker.request({ cmd: "snapshots" }), /did not answer within 500ms/);
  assert.equal(child().killed, true, "a stuck reader must not be left holding the next poll");
});

test("reader stderr is kept for diagnosis and forwarded at debug level", async () => {
  const { worker, child, logs } = harness();
  const pending = worker.request({ cmd: "ping" }); // the child spawns on first use
  child().stderr.emit("data", "[wechat-db] opened D:\\xwechat_files\n");
  assert.equal(logs.debug.length, 1);
  assert.match(worker.describe().stderrTail.join("\n"), /opened/);
  const id = JSON.parse(child().written[0]).id;
  child().respond({ id, ok: true });
  await pending;
});

test("stop() asks the reader to exit", async () => {
  const { worker, child } = harness();
  const pending = worker.request({ cmd: "ping" });
  const stopping = worker.stop();
  const stopLine = JSON.parse(child().written[1]);
  assert.equal(stopLine.cmd, "stop");
  child().respond({ id: JSON.parse(child().written[0]).id, ok: true });
  await pending;
  child().respond({ id: stopLine.id, ok: true });
  assert.deepEqual(await stopping, { stopped: true, how: "asked" });
  await assert.rejects(worker.request({ cmd: "ping" }), /stopped/);
});

test("stop() kills a reader that will not exit, instead of waiting forever", async () => {
  const { worker, child } = harness();
  const pending = worker.request({ cmd: "ping" });
  pending.catch(() => {});
  const stopping = worker.stop({ graceMs: 50 }); // never answered
  assert.deepEqual(await stopping, { stopped: true, how: "killed" });
  assert.equal(child().killed, true);
  await assert.rejects(pending, /killed/);
});

test("a non-JSON line is reported and does not poison later responses", async () => {
  const { worker, child, logs } = harness();
  const pending = worker.request({ cmd: "ping" });
  child().stdout.emit("data", "Traceback (most recent call last):\n");
  const id = JSON.parse(child().written[0]).id;
  child().respond({ id, ok: true });
  await pending;
  assert.equal(logs.warn.length, 1);
  assert.match(logs.warn[0], /not JSON/);
});
