const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// Loading this overlay adds an answerer to the live `approval/request` waterfall.
// Two facts are fatal-but-silent if they drift, so they are pinned here:
//
//  1. cordis resolves an insert's `name` relative to the *profile* directory
//     (~/.dsh/profiles/<profile>), not the workspace. A bare package name fails
//     with ERR_MODULE_NOT_FOUND and the whole runtime exits 5, so the overlay
//     must name the plugin by path, and that path must exist.
//  2. A loaded answerer must keep failing closed until a decider transport
//     exists. The plugin's own test pins the outcome vocabulary; this file pins
//     the shipped configuration so it cannot quietly start granting.
const projectRoot = path.resolve(__dirname, "..");
const pluginDir = path.join(projectRoot, "dsh-plugins", "cyberboss-approval");
const patchPath = path.join(pluginDir, "main.patch.yml");

function readPatch() {
  return fs.readFileSync(patchPath, "utf8");
}

test("the approval overlay names the plugin by a path that exists", () => {
  const source = readPatch();
  const match = /^\s*name:\s*'([^']+)'\s*$/mu.exec(source);
  assert.ok(match, "the overlay must name the plugin explicitly");

  const named = match[1];
  assert.equal(
    path.isAbsolute(named),
    true,
    `cordis resolves a bare name from the profile directory, so the overlay must use a path: ${named}`,
  );
  assert.equal(
    fs.existsSync(named),
    true,
    `the overlay points at a file that does not exist, which makes DSH exit 5: ${named}`,
  );
  assert.equal(
    path.resolve(named),
    path.resolve(pluginDir, "src", "index.js"),
    "the overlay must point at this checkout's plugin entry point",
  );
});

test("the plugin entry the overlay names is the package entry point", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"));
  const source = readPatch();
  const match = /^\s*name:\s*'([^']+)'\s*$/mu.exec(source);
  const named = path.resolve(match[1]);
  const declared = path.resolve(pluginDir, pkg.exports?.["."] || pkg.main);
  assert.equal(named, declared, "the overlay and package.json must agree on the entry point");
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
