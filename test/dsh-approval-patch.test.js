const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  materializeApprovalPatch,
  APPROVAL_PLUGIN_PLACEHOLDER,
} = require("../src/adapters/runtime/dsh");

// Loading this overlay adds an answerer to the live `approval/request` waterfall.
// Facts that are fatal-but-silent if they drift, so they are pinned here:
//
//  1. cordis resolves an insert's `name` relative to the *profile* directory
//     (~/.dsh/profiles/<profile>), not the workspace. A bare package name fails
//     with ERR_MODULE_NOT_FOUND and the whole runtime exits 5, so the overlay
//     must name the plugin by an absolute path.
//  2. That path cannot be committed: it differs per checkout, and a wrong one is
//     fatal. The committed overlay therefore carries a placeholder, and the
//     adapter materializes the machine-specific copy. Both halves are pinned.
//  3. A loaded answerer must keep failing closed until a decider transport
//     exists. The plugin's own test pins the outcome vocabulary; this file pins
//     the shipped configuration so it cannot quietly start granting.
const projectRoot = path.resolve(__dirname, "..");
const pluginDir = path.join(projectRoot, "dsh-plugins", "cyberboss-approval");
const patchPath = path.join(pluginDir, "main.patch.yml");
const pluginEntry = path.join(pluginDir, "src", "index.js");

function readPatch() {
  return fs.readFileSync(patchPath, "utf8");
}

function namedTarget(source) {
  const match = /^\s*name:\s*'([^']+)'\s*$/mu.exec(source);
  assert.ok(match, "the overlay must name the plugin explicitly");
  return match[1];
}

test("the committed overlay carries a placeholder, never a machine path", () => {
  const source = readPatch();
  assert.equal(
    namedTarget(source),
    APPROVAL_PLUGIN_PLACEHOLDER,
    "a committed absolute path makes every other checkout exit 5",
  );
  assert.equal(
    /^\s*name:\s*'[A-Za-z]:[\\/]/mu.test(source),
    false,
    "the overlay must not contain a drive-rooted path",
  );
});

test("the materialized overlay points at this checkout's plugin", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-patch-"));
  const materialized = materializeApprovalPatch({ templatePath: patchPath, stateDir, pluginEntry });
  const source = fs.readFileSync(materialized, "utf8");
  const named = namedTarget(source);

  assert.equal(path.isAbsolute(named), true, `cordis needs a path, got: ${named}`);
  assert.equal(fs.existsSync(named), true, `the overlay points at a missing file: ${named}`);
  assert.equal(
    path.resolve(named),
    path.resolve(pluginEntry),
    "the materialized overlay must point at this checkout's plugin entry point",
  );
  assert.equal(
    source.includes(APPROVAL_PLUGIN_PLACEHOLDER),
    false,
    "the placeholder must not survive into the materialized copy",
  );
});

test("materializing is idempotent and keeps the template untouched", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-patch-"));
  const before = readPatch();
  const first = materializeApprovalPatch({ templatePath: patchPath, stateDir, pluginEntry });
  const firstStat = fs.statSync(first).mtimeMs;
  const second = materializeApprovalPatch({ templatePath: patchPath, stateDir, pluginEntry });
  assert.equal(first, second, "the same state directory must resolve to one path");
  assert.equal(fs.statSync(second).mtimeMs, firstStat, "an unchanged overlay must not be rewritten");
  assert.equal(readPatch(), before, "materializing must never edit the committed template");
});

test("an overlay without a placeholder is passed through unchanged", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-patch-"));
  const template = path.join(stateDir, "hand-edited.patch.yml");
  fs.writeFileSync(template, "- insert:\n    - id: x\n      name: '/somewhere/index.js'\n", "utf8");
  assert.equal(
    materializeApprovalPatch({ templatePath: template, stateDir, pluginEntry }),
    template,
  );
});

test("the plugin entry the overlay names is the package entry point", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"));
  const declared = path.resolve(pluginDir, pkg.exports?.["."] || pkg.main);
  assert.equal(
    path.resolve(pluginEntry),
    declared,
    "the adapter and package.json must agree on the entry point",
  );
  assert.match(pkg.type, /^module$/u, "the plugin is ESM; cordis imports it dynamically");
});

test("the shipped overlay fails closed", () => {
  const source = readPatch();
  const mode = /^\s*mode:\s*(\S+)\s*$/mu.exec(source);
  const endpoint = /^\s*endpoint:\s*'([^']*)'\s*$/mu.exec(source);
  assert.ok(mode, "the overlay must state an explicit mode");
  assert.ok(endpoint, "the overlay must state an explicit endpoint");
  assert.equal(
    endpoint[1],
    "",
    "with no decider transport shipped yet, the overlay must not claim an endpoint",
  );
  assert.notEqual(
    mode[1],
    "never",
    "`never` is the explicit deny mode, not the default for the main runtime",
  );
});

test("the overlay only inserts the answerer and leaves the rest of the profile alone", () => {
  const source = readPatch();
  // Config overrides and disables are how this file could silently widen or
  // narrow something else in the sdk profile. It must only ever insert.
  const topLevelKeys = source
    .split(/\r?\n/u)
    .filter((line) => /^-\s+\w/u.test(line))
    .map((line) => line.replace(/^-\s+/u, "").split(":")[0].trim());
  assert.deepEqual(topLevelKeys, ["insert"], `unexpected top-level patch entries: ${topLevelKeys}`);
});
