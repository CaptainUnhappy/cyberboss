const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { defaultDshBin } = require("../src/adapters/runtime/dsh/rpc-client");
const {
  DEFAULT_HELPER_PROFILE,
  DEFAULT_HELPER_PATCH,
} = require("../src/core/approval-decider");

/**
 * The decider runs a second DSH runtime. If that runtime could execute tools it
 * could raise its own `approval/request` and approve itself, and DSH's answerer
 * waterfall has no loop protection - a self-escalation path. Two independent
 * barriers are supposed to prevent it:
 *
 *   1. all five tool plugins are disabled by the helper overlay;
 *   2. `sdk-minimal` composes no approval service at all, so a request raised
 *      there has no answerer and resolves `unavailable`.
 *
 * These tests check the *composed* configuration rather than the overlay text,
 * because `--patch` merges by `id` and an id that does not exist is a silent
 * no-op - the mistake this file exists to catch.
 */
const projectRoot = path.resolve(__dirname, "..");

// The five real tool plugin ids, read from the overlay itself so a rename in one
// place cannot silently drift from the other.
function overlayEntries() {
  const source = fs.readFileSync(DEFAULT_HELPER_PATCH, "utf8");
  const entries = [];
  const pattern = /^- id:\s*(\S+)\s*\r?\n\s*name:\s*'([^']+)'\s*\r?\n\s*disabled:\s*(true|false)\s*$/gmu;
  let match = pattern.exec(source);
  while (match) {
    entries.push({ id: match[1], name: match[2], disabled: match[3] === "true" });
    match = pattern.exec(source);
  }
  return entries;
}

function dumpComposedConfig() {
  const dshBin = defaultDshBin();
  if (!dshBin || !fs.existsSync(dshBin)) return null;
  return spawnSync(process.execPath, [
    dshBin,
    "--profile", DEFAULT_HELPER_PROFILE,
    "--patch", DEFAULT_HELPER_PATCH,
    "--dump-config",
  ], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
}

test("the helper overlay disables every tool plugin it names", () => {
  const entries = overlayEntries();
  assert.equal(entries.length, 5, `expected the five tool plugins, saw ${entries.length}`);
  for (const entry of entries) {
    assert.equal(entry.disabled, true, `${entry.id} must be disabled in the overlay`);
  }
  const ids = entries.map((entry) => entry.id).sort();
  assert.deepEqual(ids, [
    "persistent-bash",
    "persistent-pwsh",
    "terminal-bash",
    "terminal-pwsh",
    "tools",
  ], "these are the real ids; a guessed id silently disables nothing");
});

test("the decider points at the constrained helper profile and overlay", () => {
  assert.equal(DEFAULT_HELPER_PROFILE, "sdk-minimal");
  assert.equal(DEFAULT_HELPER_PATCH, path.join(projectRoot, "docs", "dsh-helper-notools.patch.yml"));
  assert.equal(fs.existsSync(DEFAULT_HELPER_PATCH), true);
});

test("the composed helper config really has no usable tool and no answerer", {
  skip: process.platform === "win32" ? false : "the helper overlay is validated on Windows",
}, () => {
  const result = dumpComposedConfig();
  assert.ok(result, "dsh must be resolvable: without it this security property is unverified");
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const composed = result.stdout;
  assert.match(composed, /# == @deepseek-ai\/dsh-sdk-minimal/u,
    "the dump must be the composed sdk-minimal tree, not an empty or failed dump");

  // Parse the composed tree into id -> block, so each assertion is about that
  // entry's own body rather than a loose match anywhere later in the file.
  const blocks = new Map();
  let currentId = "";
  for (const line of composed.split(/\r?\n/u)) {
    const idMatch = /^- id:\s*(\S+)\s*$/u.exec(line);
    if (idMatch) {
      currentId = idMatch[1];
      blocks.set(currentId, []);
      continue;
    }
    if (currentId) blocks.get(currentId).push(line);
  }

  for (const entry of overlayEntries()) {
    assert.ok(blocks.has(entry.id),
      `${entry.id} is absent from the composed helper tree, so disabling it was a no-op`);
    const body = blocks.get(entry.id).join("\n");
    assert.match(body, /^\s*disabled:\s*true\s*$/mu,
      `${entry.id} did not compose as disabled, so the helper could still execute something`);
  }

  // And the runtime must compose no approval service, which is what makes any
  // request raised there resolve `unavailable` instead of reaching an answerer.
  assert.equal(blocks.has("approval"), false,
    "the helper profile must compose no approval service, or it could answer itself");
  assert.doesNotMatch(composed, /dsh-user-approval/u,
    "the helper profile must compose no approval service, or it could answer itself");
});
