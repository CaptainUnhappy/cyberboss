const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { acquireCyberbossProcessLock, readLockPid } = require("../src/core/process-lock");

function createLockFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-process-lock-"));
  return { dir, lockFile: path.join(dir, "cyberboss.pid") };
}

test("process lock rejects a second live Cyberboss instance", (t) => {
  const { dir, lockFile } = createLockFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const first = acquireCyberbossProcessLock({ lockFile, pid: 101, isProcessAlive: () => true });
  assert.equal(readLockPid(lockFile), 101);
  assert.throws(
    () => acquireCyberbossProcessLock({ lockFile, pid: 202, isProcessAlive: () => true }),
    (error) => error?.code === "CYBERBOSS_ALREADY_RUNNING" && error?.pid === 101
  );
  assert.equal(first.release(), true);
});

test("process lock replaces a stale pid and only its owner can release it", (t) => {
  const { dir, lockFile } = createLockFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(lockFile, "303\n", "utf8");

  const active = acquireCyberbossProcessLock({ lockFile, pid: 404, isProcessAlive: () => false });
  assert.equal(readLockPid(lockFile), 404);

  fs.writeFileSync(lockFile, "505\n", "utf8");
  assert.equal(active.release(), false);
  assert.equal(readLockPid(lockFile), 505);
});
