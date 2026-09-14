const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createDshRuntimeAdapter,
  resolveApprovalPatchPath,
} = require("../src/adapters/runtime/dsh");
const { resolveDshApprovalMode } = require("../src/core/config");

/**
 * Enabling the collaborative decider is an explicit opt-in with a fatal failure
 * mode: the overlay names its plugin by absolute path, and cordis resolves that
 * from the *profile* directory, so a path that does not exist makes DSH exit 5
 * and takes the whole runtime down. These tests pin the wiring that decides
 * whether the overlay is applied at all, and that the path it names is real.
 */
const projectRoot = path.resolve(__dirname, "..");

function makeAdapter(config = {}) {
  return createDshRuntimeAdapter({
    dshProfile: "sdk",
    workspaceRoot: projectRoot,
    dshSessionsFile: path.join(projectRoot, ".tmp-test-dsh-sessions.json"),
    ...config,
  });
}

test("the approval overlay path resolves to this checkout's overlay", () => {
  const resolved = resolveApprovalPatchPath();
  assert.equal(
    resolved,
    path.join(projectRoot, "dsh-plugins", "cyberboss-approval", "main.patch.yml"),
  );
  assert.equal(fs.existsSync(resolved), true,
    "a missing overlay is fatal: DSH exits 5 rather than degrading");
});

test("no approval mode is the fail-closed default and composes no answerer", () => {
  for (const value of [undefined, "", "  ", "yes", "allow", "session2", "never2"]) {
    assert.equal(resolveDshApprovalMode(value), "",
      `${JSON.stringify(value)} must not silently become a deciding mode`);
    const adapter = makeAdapter({ dshApprovalMode: resolveDshApprovalMode(value) });
    assert.equal(adapter.describe().approval, "(none)");
  }
});

test("the two recognised modes are reported verbatim", () => {
  assert.equal(makeAdapter({ dshApprovalMode: "session" }).describe().approval, "session");
  assert.equal(makeAdapter({ dshApprovalMode: "never" }).describe().approval, "never");
});

test("only the enabling modes reach the overlay", () => {
  // Read the shipped source because the adapter applies the overlay inside
  // ensureRuntime(); the assertion that matters is that "" never gets there.
  const source = fs.readFileSync(
    path.join(projectRoot, "src", "adapters", "runtime", "dsh", "index.js"),
    "utf8",
  );
  assert.match(source, /const approvalEnabled = approvalMode === "session" \|\| approvalMode === "never"/u);
  assert.match(source, /const approvalPatchPath = approvalEnabled \? resolveApprovalPatchPath\(\) : ""/u);
  assert.match(source, /patchPaths: approvalPatchPath \? \[approvalPatchPath\] : \[\]/u,
    "an empty mode must not hand the overlay to the child");
  assert.match(source, /CYBERBOSS_DSH_APPROVAL_ENDPOINT: approvalEndpoint\.endpoint/u);
  assert.match(source, /CYBERBOSS_DSH_APPROVAL_TOKEN: approvalEndpoint\.token/u);
});

test("the endpoint is started before the first child spawns", () => {
  // The child learns its endpoint and token from the environment, so starting
  // the endpoint after the spawn would hand it an empty transport - which the
  // answerer would then (correctly) treat as fail-closed forever.
  const source = fs.readFileSync(
    path.join(projectRoot, "src", "adapters", "runtime", "dsh", "index.js"),
    "utf8",
  );
  const initialize = /async initialize\(\) \{[\s\S]*?\n    \},/u.exec(source);
  assert.ok(initialize, "initialize() must still be where this test expects it");
  const endpointIndex = initialize[0].indexOf("await ensureApprovalEndpoint()");
  const runtimeIndex = initialize[0].indexOf("ensureRuntime(");
  assert.ok(endpointIndex >= 0, "initialize() must start the approval endpoint");
  assert.ok(runtimeIndex > endpointIndex,
    "the endpoint must exist before ensureRuntime() can build a child environment");
});

test("a spawned child would receive the overlay only when the mode enables it", () => {
  // The overlay must never be applied for the default mode, because composing an
  // answerer that can only ever say `unavailable` changes the failure mode from
  // "no answerer" to "an answerer that looked and gave up", which is harder to
  // diagnose and no safer.
  const disabled = makeAdapter({ dshApprovalMode: "" });
  assert.equal(disabled.describe().approval, "(none)");
  const enabled = makeAdapter({ dshApprovalMode: "session" });
  assert.equal(enabled.describe().approval, "session");
  assert.equal(fs.existsSync(resolveApprovalPatchPath()), true);
});
