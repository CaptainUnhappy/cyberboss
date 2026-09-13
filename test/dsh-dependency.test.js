const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { defaultDshBin } = require("../src/adapters/runtime/dsh/rpc-client");

const projectRoot = path.join(__dirname, "..");

// The DSH adapter shells out to `dsh`. Resolving it only from the npx cache made
// the runtime depend on a directory the package manager is free to prune, so the
// dependency must be declared and the resolver must prefer it.
test("the DSH runtime is a declared dependency, not just an npx cache entry", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const declared = manifest.dependencies?.["@deepseek-ai/dsh"];
  assert.ok(declared, "@deepseek-ai/dsh must be declared in dependencies");
  // A pre-release SDK must be pinned exactly: the protocol has no version
  // negotiation, so a floating range could silently change the wire contract.
  assert.match(declared, /^\d+\.\d+\.\d+/u,
    "the DSH dependency must pin an exact version because the wire protocol is unversioned");
  assert.doesNotMatch(declared, /[\^~*x]/u, "a floating range is unsafe for this SDK");
});

test("the dsh launcher resolves from an installed dependency before the npx cache", () => {
  const resolved = defaultDshBin();
  assert.match(resolved, /@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/u,
    "it must resolve the dsh launcher entry point");
  // When installed the path sits under the project (or a hoisted) node_modules;
  // the npx cache is only the development fallback.
  if (!resolved.includes("_npx")) {
    assert.match(resolved, /node_modules/u);
  }
  assert.equal(fs.existsSync(resolved), true, `resolved launcher must exist: ${resolved}`);
});

test("an explicit CYBERBOSS_DSH_BIN overrides resolution", () => {
  const { resolveDshBin } = require("../src/adapters/runtime/dsh");
  assert.equal(resolveDshBin({ dshBin: "/custom/dsh/bin.js" }), "/custom/dsh/bin.js",
    "an explicit config value must win");
});
