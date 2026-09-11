const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const { launchFromRequest } = require("../scripts/shared-hidden-console-host");

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-hidden-console-test-"));
  const requestPath = path.join(directory, "request.json");
  const resultPath = path.join(directory, "result.json");
  const logFile = path.join(directory, "app-server.log");
  fs.writeFileSync(requestPath, JSON.stringify({
    version: 1,
    command: "codex.exe",
    args: ["app-server", "--listen", "ws://127.0.0.1:8765"],
    cwd: directory,
    env: { CYBERBOSS_STATE_DIR: directory },
    logFile,
  }));
  return { directory, requestPath, resultPath, logFile };
}

test("hidden console host publishes the real child PID and preserves its inherited console", async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.directory, { force: true, recursive: true }));
  const child = new EventEmitter();
  child.pid = 42420;
  child.kill = () => {};
  let spawnCall = null;

  const launched = launchFromRequest(fixture.requestPath, fixture.resultPath, {
    baseEnv: { BASE_ENV: "kept" },
    hostPid: 31310,
    onChildExit: () => {},
    spawnImpl(command, args, options) {
      spawnCall = { command, args, options };
      setImmediate(() => child.emit("spawn"));
      return child;
    },
  });

  assert.equal((await launched).pid, 42420);
  const result = JSON.parse(fs.readFileSync(fixture.resultPath, "utf8"));
  assert.deepEqual(result, { version: 1, ok: true, pid: 42420, hostPid: 31310 });
  assert.equal(spawnCall.command, "codex.exe");
  assert.deepEqual(spawnCall.args, ["app-server", "--listen", "ws://127.0.0.1:8765"]);
  assert.equal(spawnCall.options.detached, false);
  assert.equal(spawnCall.options.windowsHide, true);
  assert.equal(spawnCall.options.shell, false);
  assert.equal(spawnCall.options.stdio[0], "ignore");
  assert.equal(spawnCall.options.env.BASE_ENV, "kept");
  assert.equal(spawnCall.options.env.CYBERBOSS_STATE_DIR, fixture.directory);
});

test("hidden console host reports spawn errors instead of publishing a launcher PID", async (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.directory, { force: true, recursive: true }));
  const child = new EventEmitter();
  child.kill = () => {};

  const launched = launchFromRequest(fixture.requestPath, fixture.resultPath, {
    hostPid: 51510,
    onChildExit: () => {},
    spawnImpl() {
      setImmediate(() => child.emit("error", new Error("synthetic spawn failure")));
      return child;
    },
  });

  await assert.rejects(launched, /synthetic spawn failure/);
  const result = JSON.parse(fs.readFileSync(fixture.resultPath, "utf8"));
  assert.equal(result.version, 1);
  assert.equal(result.ok, false);
  assert.equal(result.hostPid, 51510);
  assert.match(result.error, /synthetic spawn failure/);
  assert.equal(result.pid, undefined);
});

test("VBS launcher uses a hidden, asynchronous WshShell.Run call", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "shared-hidden-console-launch.vbs"),
    "utf8"
  );
  assert.match(source, /shell\.Run\(command, 0, False\)/i);
  assert.doesNotMatch(source, /powershell|cmd\.exe/i);
});
