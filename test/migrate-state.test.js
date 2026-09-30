#!/usr/bin/env node
/**
 * Offline round-trip test for scripts/migrate.js.
 *
 * The real migration only happens once, on a machine the operator may not have
 * yet — so the tool's promise ("your thread bindings point at the new checkout,
 * your caches stay behind, your credentials stay out unless you ask") has to be
 * proven without a second machine.
 *
 * Run: node test/migrate-state.test.js
 */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const MIGRATE = path.join(REPO_ROOT, "scripts", "migrate.js");

const OLD_REPO = "D:/Projects/cyberboss";
const NEW_REPO = "E:/Bots/cyberboss";

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cb-migrate-${label}-`));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** A miniature but faithful state directory: both path spellings, both
 *  credential kinds, and a fat cache that must not travel. */
function buildSourceState(dir) {
  writeJson(path.join(dir, "dsh-sessions.json"), {
    bindings: {
      "default:27cd579d9604-im.bot:o9cq@im.wechat": {
        activeWorkspaceRoot: `${OLD_REPO.replace(/\//g, "\\")}\\user\\cyberboss`,
        threadIdByWorkspaceRootByRuntime: {
          dsh: {
            [`${OLD_REPO}/user/Unhappy`]: "dsh-1",
            [`${OLD_REPO}/user/cyberboss`]: "dsh-2",
          },
        },
      },
    },
  });
  writeJson(path.join(dir, "checkin-config.json"), {
    enabled: true,
    workspace: `${OLD_REPO}/user/cyberboss`,
  });
  writeJson(path.join(dir, "pending-inbound.json"), { events: [], note: "keep me" });
  writeJson(path.join(dir, "weflow-message-ledger.json"), { entries: [{ id: "m1", direction: "outgoing" }] });
  writeJson(path.join(dir, "accounts", "27cd579d9604-im.bot.json"), { accountId: "27cd579d9604-im.bot" });
  writeJson(path.join(dir, "accounts", "27cd579d9604-im.bot.context-tokens.json"), { "o9cq@im.wechat": "TOKEN-VALUE" });
  writeJson(path.join(dir, "timeline", "timeline-state.json"), { facts: 3 });
  fs.mkdirSync(path.join(dir, "timeline", "shots"), { recursive: true });
  fs.writeFileSync(path.join(dir, "timeline", "shots", "big.png"), Buffer.alloc(4096, 7));
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "models", "whisper.bin"), Buffer.alloc(64 * 1024, 3));
  fs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
  fs.writeFileSync(path.join(dir, "inbox", "stale.jpg"), Buffer.alloc(2048, 1));
  fs.writeFileSync(path.join(dir, ".env"), "CYBERBOSS_WEFLOW_TOKEN=super-secret\n", "utf8");
  fs.writeFileSync(path.join(dir, "dsh-sessions.json.bak-stalebinding"), "{}\n", "utf8");
  return dir;
}

function runMigrate(args, options = {}) {
  const result = spawnSync(process.execPath, [MIGRATE, ...args], {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function testRoundTrip() {
  const source = buildSourceState(makeTempDir("src"));
  const bundle = path.join(makeTempDir("bundle"), "export");
  const target = makeTempDir("dst");
  const before = fs.readFileSync(path.join(source, "dsh-sessions.json"));

  const exported = runMigrate(["export", "--to", bundle, "--state-dir", source]);
  assert.strictEqual(exported.status, 0, `export failed: ${exported.stderr}`);

  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, "manifest.json"), "utf8"));
  const rels = manifest.files.map((entry) => entry.rel);
  assert.ok(rels.includes("dsh-sessions.json"), "session bindings must travel");
  assert.ok(rels.includes("weflow-message-ledger.json"), "the ledger must travel");
  assert.ok(rels.includes("timeline/timeline-state.json"), "timeline facts must travel");
  assert.ok(rels.includes("accounts/27cd579d9604-im.bot.json"), "account identity must travel");
  assert.ok(!rels.some((rel) => rel.endsWith("context-tokens.json")), "context tokens are credentials: excluded by default");
  assert.ok(!rels.some((rel) => rel.startsWith("models/")), "models must not travel");
  assert.ok(!rels.some((rel) => rel.startsWith("inbox/")), "inbox must not travel");
  assert.ok(!rels.some((rel) => rel.startsWith("timeline/shots/")), "regenerated screenshots must not travel");
  assert.deepStrictEqual(manifest.skippedSecrets, ["accounts/27cd579d9604-im.bot.context-tokens.json"]);
  assert.strictEqual(manifest.credentialsIncluded, false);

  const verified = runMigrate(["verify", bundle]);
  assert.strictEqual(verified.status, 0, `verify failed: ${verified.stderr}`);

  const imported = runMigrate([
    "import", "--from", bundle, "--state-dir", target, "--repo-root", NEW_REPO,
  ]);
  assert.strictEqual(imported.status, 0, `import failed: ${imported.stderr}`);

  const sessions = JSON.parse(fs.readFileSync(path.join(target, "dsh-sessions.json"), "utf8"));
  const binding = Object.values(sessions.bindings)[0];
  assert.strictEqual(binding.activeWorkspaceRoot, `${NEW_REPO.replace(/\//g, "\\")}\\user\\cyberboss`);
  assert.deepStrictEqual(
    Object.keys(binding.threadIdByWorkspaceRootByRuntime.dsh).sort(),
    [`${NEW_REPO}/user/Unhappy`, `${NEW_REPO}/user/cyberboss`].sort(),
    "each contact keeps its own workspace tail"
  );

  const checkin = JSON.parse(fs.readFileSync(path.join(target, "checkin-config.json"), "utf8"));
  assert.strictEqual(checkin.workspace, `${NEW_REPO}/user/cyberboss`);

  // Non-path payloads survive byte-for-byte (modulo the rewritten JSON files).
  assert.strictEqual(
    sha256(fs.readFileSync(path.join(target, "weflow-message-ledger.json"))),
    sha256(fs.readFileSync(path.join(bundle, "state", "weflow-message-ledger.json"))),
    "the ledger is copied, not transformed"
  );

  // The source machine is untouched: exporting must never rewrite in place.
  assert.strictEqual(sha256(fs.readFileSync(path.join(source, "dsh-sessions.json"))), sha256(before));

  return { source, bundle, target };
}

function testCredentialsOptIn() {
  const source = buildSourceState(makeTempDir("src-cred"));
  const bundle = path.join(makeTempDir("bundle-cred"), "export");
  const exported = runMigrate(["export", "--to", bundle, "--state-dir", source, "--with-credentials"]);
  assert.strictEqual(exported.status, 0, exported.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, "manifest.json"), "utf8"));
  assert.strictEqual(manifest.credentialsIncluded, true);
  assert.ok(manifest.files.some((entry) => entry.rel.endsWith("context-tokens.json")));
  assert.match(exported.stdout, /SENSITIVE BUNDLE/);
  assert.ok(!manifest.files.some((entry) => entry.rel === ".env"), ".env never travels, not even with the flag");
}

function testVerifyDetectsTampering() {
  const source = buildSourceState(makeTempDir("src-tamper"));
  const bundle = path.join(makeTempDir("bundle-tamper"), "export");
  assert.strictEqual(runMigrate(["export", "--to", bundle, "--state-dir", source]).status, 0);
  const victim = path.join(bundle, "state", "weflow-message-ledger.json");
  fs.writeFileSync(victim, `${fs.readFileSync(victim, "utf8")} `, "utf8");
  const verified = runMigrate(["verify", bundle]);
  assert.strictEqual(verified.status, 1, "tampering must fail verification");
  assert.match(verified.stderr, /(sha256|size) mismatch/);

  const blocked = runMigrate(["import", "--from", bundle, "--state-dir", makeTempDir("dst-tamper")]);
  assert.notStrictEqual(blocked.status, 0, "a tampered bundle must not be imported");
  assert.match(blocked.stderr, /refusing to import/);
}

function main() {
  const cases = [
    ["round trip rewrites paths and leaves caches behind", testRoundTrip],
    ["credentials require an explicit opt-in", testCredentialsOptIn],
    ["verify catches tampering and blocks the import", testVerifyDetectsTampering],
  ];
  let failures = 0;
  for (const [name, fn] of cases) {
    try {
      fn();
      console.log(`ok   ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${name}: ${error.message}`);
    }
  }
  if (failures) {
    console.error(`${cases.length - failures}/${cases.length} passed`);
    process.exitCode = 1;
    return;
  }
  console.log(`${cases.length}/${cases.length} passed`);
}

if (require.main === module) {
  main();
}
