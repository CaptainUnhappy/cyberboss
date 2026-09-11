const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  analyzeWeFlowAnchor,
  repairWeFlowAnchor,
  verifyAnchorBackup,
} = require("../scripts/weflow-anchor-torn-commit-repair");

const identity = "01234567-89abcdef";
const registryName = `AnchorV7-${identity}`;

function makeFixture({ registryData, extra = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-weflow-anchor-"));
  const weflowRoot = path.join(root, "WeFlow");
  const runtimeDir = path.join(weflowRoot, "Runtime");
  const stateDir = path.join(weflowRoot, "State");
  const securityDir = path.join(weflowRoot, "Security");
  const backupRoot = path.join(root, "backups");
  for (const directory of [runtimeDir, stateDir, securityDir, backupRoot]) fs.mkdirSync(directory, { recursive: true });

  const runtime = Buffer.alloc(310, 0x41);
  const stale = Buffer.alloc(310, 0x42);
  fs.writeFileSync(path.join(runtimeDir, `anchor-v7-${identity}.bin`), runtime);
  fs.writeFileSync(path.join(stateDir, `native-anchor-v7-${identity}.bin`), runtime);
  fs.writeFileSync(path.join(securityDir, "device-root-v1.bin"), Buffer.alloc(262, 0x52));
  const values = new Map([[registryName, {
    type: "REG_BINARY",
    data: Buffer.from(registryData || stale),
  }]]);
  const registryAdapter = {
    list() {
      return [...values.keys()].map((name) => ({ name, type: values.get(name).type }));
    },
    read(name) {
      const value = values.get(name);
      return value
        ? { exists: true, type: value.type, data: Buffer.from(value.data) }
        : { exists: false, type: "", data: Buffer.alloc(0) };
    },
    write(name, data) {
      const value = values.get(name);
      if (!value) throw new Error("missing registry value");
      value.data = Buffer.from(data);
    },
  };
  return {
    root,
    options: {
      weflowRoot,
      runtimeDir,
      stateDir,
      securityDir,
      backupRoot,
      ...extra,
    },
    registryAdapter,
    runtime,
    stale,
  };
}

function cleanup(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

test("Analyze identifies the exact two-file-majority torn commit without exposing blob bytes", () => {
  const fixture = makeFixture();
  try {
    const result = analyzeWeFlowAnchor(fixture.options, { registryAdapter: fixture.registryAdapter });
    assert.equal(result.action, "Analyze");
    assert.equal(result.status, "repairable_torn_commit");
    assert.equal(result.repairable, true);
    assert.equal(result.reason, "two_file_majority_registry_stale");
    assert.deepEqual(result.plan?.sourceReplicas, ["runtime", "state"]);
    assert.equal(result.plan?.targetReplica, "registry");
    assert.equal(result.replicas.runtime.sha256, result.replicas.state.sha256);
    assert.notEqual(result.replicas.runtime.sha256, result.replicas.registry.sha256);
    assert.equal(JSON.stringify(result).includes(fixture.runtime.toString("hex")), false);
  } finally {
    cleanup(fixture);
  }
});

test("Repair backs up all replicas, changes only the stale registry value, and verifies equality", () => {
  const fixture = makeFixture();
  try {
    const result = repairWeFlowAnchor(fixture.options, {
      registryAdapter: fixture.registryAdapter,
      now: () => new Date("2026-09-10T00:00:00.000Z"),
    });
    assert.equal(result.status, "repaired_verified");
    assert.equal(result.repaired, true);
    assert.equal(result.rollbackVerified, false);
    assert.equal(fixture.registryAdapter.read(registryName).data.equals(fixture.runtime), true);
    const backup = verifyAnchorBackup(result.backupDirectory);
    assert.equal(backup.verified, true);
    assert.equal(backup.identity, identity);
    for (const name of ["device-root-v1.bin", "runtime-anchor.bin", "state-anchor.bin", "registry-anchor.bin", "manifest.json", "manifest.sha256"]) {
      assert.equal(fs.existsSync(path.join(result.backupDirectory, name)), true, name);
    }
  } finally {
    cleanup(fixture);
  }
});

test("Repair is blocked for ambiguous replicas and never mutates the registry", () => {
  const fixture = makeFixture({ extra: {} });
  try {
    const other = crypto.randomBytes(310);
    fs.writeFileSync(path.join(fixture.options.stateDir, `native-anchor-v7-${identity}.bin`), other);
    const before = fixture.registryAdapter.read(registryName).data;
    const result = repairWeFlowAnchor(fixture.options, { registryAdapter: fixture.registryAdapter });
    assert.equal(result.status, "not_repairable");
    assert.equal(result.repaired, false);
    assert.deepEqual(fixture.registryAdapter.read(registryName).data, before);
  } finally {
    cleanup(fixture);
  }
});

test("A failed post-write verification rolls the registry replica back", () => {
  const fixture = makeFixture();
  try {
    const originalWrite = fixture.registryAdapter.write;
    let writes = 0;
    fixture.registryAdapter.write = (name, data) => {
      writes += 1;
      if (writes === 1) {
        // Simulate a torn registry write; the helper must restore the original
        // ciphertext on its second write.
        originalWrite.call(fixture.registryAdapter, name, Buffer.alloc(data.length, 0x7f));
        return;
      }
      originalWrite.call(fixture.registryAdapter, name, data);
    };
    const result = repairWeFlowAnchor(fixture.options, { registryAdapter: fixture.registryAdapter });
    assert.equal(result.repaired, false);
    assert.equal(result.status, "repair_failed_registry_rolled_back");
    assert.equal(result.rollbackVerified, true);
    assert.deepEqual(fixture.registryAdapter.read(registryName).data, fixture.stale);
  } finally {
    cleanup(fixture);
  }
});

