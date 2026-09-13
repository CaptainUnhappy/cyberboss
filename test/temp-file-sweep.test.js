const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CyberbossApp } = require("../src/core/app");

/**
 * Every durable store writes through a `.<name>.<pid>.<timestamp>.tmp` sibling and
 * renames it into place. A rename that fails (the live state recorded EPERM during
 * the canary poll) leaves the sibling behind and nothing collected it - 91 had
 * accumulated since 2026-08-28. The sweep must be conservative: only files with
 * the exact atomic-write shape and an old embedded timestamp.
 */
function harness(stateDir) {
  const app = Object.create(CyberbossApp.prototype);
  app.config = { stateDir };
  return app;
}

function makeTempFile(dir, { ageMs = 0, pid = 12345 } = {}) {
  const name = `.weflow-inbox-cursor.json.${pid}.${Date.now() - ageMs}.tmp`;
  const full = path.join(dir, name);
  fs.writeFileSync(full, "x");
  return full;
}

test("stale atomic-write temporaries are swept while fresh ones are preserved", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-sweep-"));
  try {
    const stale = makeTempFile(dir, { ageMs: 2 * 60 * 60_000 });
    const fresh = makeTempFile(dir, { ageMs: 1_000 });

    const removed = harness(dir).sweepStaleTemporaryFiles();

    assert.equal(removed, 1);
    assert.equal(fs.existsSync(stale), false, "an old orphan must be collected");
    assert.equal(fs.existsSync(fresh), true,
      "an in-flight write must never be collected");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the sweep leaves files that do not match the atomic-write shape alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-sweep-"));
  try {
    const unrelated = [
      path.join(dir, "weflow-inbox-cursor.json"),
      path.join(dir, "not-a-temp.txt"),
      path.join(dir, ".env"),
      // Missing the leading dot: not produced by the atomic writer.
      path.join(dir, `weflow-inbox-cursor.json.12345.${Date.now() - 7_200_000}.tmp`),
      // Leading dot but no pid/timestamp pair.
      path.join(dir, ".partial.tmp"),
    ];
    for (const file of unrelated) fs.writeFileSync(file, "x");

    const removed = harness(dir).sweepStaleTemporaryFiles();

    assert.equal(removed, 0);
    for (const file of unrelated) {
      assert.equal(fs.existsSync(file), true, `must be preserved: ${path.basename(file)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the sweep is safe when the state directory is missing or empty", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-sweep-"));
  try {
    assert.equal(harness(path.join(dir, "does-not-exist")).sweepStaleTemporaryFiles(), 0);
    assert.equal(harness("").sweepStaleTemporaryFiles(), 0);
    assert.equal(harness(dir).sweepStaleTemporaryFiles(), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the grace period keeps a recently written temporary", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-sweep-"));
  try {
    const file = makeTempFile(dir, { ageMs: 5_000 });
    const removed = harness(dir).sweepStaleTemporaryFiles({ graceMs: 10 * 60_000 });
    assert.equal(removed, 0);
    assert.equal(fs.existsSync(file), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The bridge loop runs for days, so a startup-only sweep let temporaries from
 * failed renames accumulate again between restarts. The loop now re-runs it, but
 * throttled: the sweep walks the state directory, so it must not run on every
 * long-poll turn.
 */
test("the periodic sweep runs once, then stays throttled until the interval elapses", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-sweep-"));
  try {
    const app = harness(dir);
    makeTempFile(dir, { ageMs: 2 * 60 * 60_000 });
    assert.equal(app.sweepStaleTemporaryFilesIfDue(), 1, "the first call must sweep");

    // A fresh orphan appears, but the interval has not elapsed.
    makeTempFile(dir, { ageMs: 2 * 60 * 60_000 });
    assert.equal(app.sweepStaleTemporaryFilesIfDue(), 0, "a due check must not sweep twice");
    assert.equal(
      fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")).length,
      1,
      "the throttled call must leave the new orphan in place",
    );

    // Force the interval to have elapsed.
    app.lastStaleTempSweepAtMs = Date.now() - 2 * 60 * 60_000;
    assert.equal(app.sweepStaleTemporaryFilesIfDue(), 1, "the sweep must resume");
    assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit startup sweep still re-arms the throttle", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-sweep-"));
  try {
    const app = harness(dir);
    assert.equal(app.sweepStaleTemporaryFiles(), 0);
    assert.equal(
      Number.isFinite(app.lastStaleTempSweepAtMs),
      true,
      "the startup sweep must record when it ran so the loop does not repeat it immediately",
    );
    makeTempFile(dir, { ageMs: 2 * 60 * 60_000 });
    assert.equal(app.sweepStaleTemporaryFilesIfDue(), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
