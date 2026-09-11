const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CodexRpcClient,
  MODEL_CANARY_EXECUTION_POLICY,
  buildCodexConfigArgs,
  cleanupStaleIsolatedProfiles,
} = require("../src/adapters/runtime/codex/rpc-client");

test("codex rpc client uses turn/interrupt for stop requests", async () => {
  const client = new CodexRpcClient({ endpoint: "ws://127.0.0.1:8765" });
  const calls = [];
  client.sendRequest = async (method, params) => {
    calls.push({ method, params });
    return { ok: true };
  };

  await client.cancelTurn({
    threadId: "thread-1",
    turnId: "turn-1",
  });

  assert.deepEqual(calls, [{
    method: "turn/interrupt",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
    },
  }]);
});

test("codex rpc client sends image attachments as local images", async () => {
  const client = new CodexRpcClient({ endpoint: "ws://127.0.0.1:8765" });
  const calls = [];
  client.sendRequest = async (method, params) => {
    calls.push({ method, params });
    return { result: { turn: { id: "turn-1" } } };
  };

  await client.sendUserMessage({
    threadId: "thread-1",
    text: "what is this image?",
    attachments: [{
      absolutePath: path.join("/tmp", "cyberboss image.jpg"),
      contentType: "image/jpeg",
    }],
  });

  assert.equal(calls[0].method, "turn/start");
  assert.deepEqual(calls[0].params.input, [
    { type: "text", text: "what is this image?" },
    {
      type: "localImage",
      path: path.join("/tmp", "cyberboss image.jpg"),
    },
  ]);
});

test("codex trusted mode skips approvals while retaining workspace-write isolation", async () => {
  const client = new CodexRpcClient({
    endpoint: "ws://127.0.0.1:8765",
    extraWritableRoots: [path.join("/tmp", "cyberboss-state")],
  });
  const calls = [];
  client.sendRequest = async (method, params) => {
    calls.push({ method, params });
    return { result: { turn: { id: "turn-1" } } };
  };

  await client.sendUserMessage({
    threadId: "thread-1",
    text: "inspect the attachment",
    accessMode: "trusted",
    workspaceRoot: path.join("/tmp", "workspace"),
  });

  assert.equal(calls[0].params.accessMode, "current");
  assert.equal(calls[0].params.approvalPolicy, "never");
  assert.deepEqual(calls[0].params.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: [path.join("/tmp", "workspace"), path.join("/tmp", "cyberboss-state")],
    networkAccess: true,
  });
});

test("model canary turn policy is read-only, offline, approval-free, and environment-free", async () => {
  const client = new CodexRpcClient({ endpoint: "ws://127.0.0.1:8765" });
  const calls = [];
  client.sendRequest = async (method, params) => {
    calls.push({ method, params });
    return { result: { turn: { id: "turn-isolated" } } };
  };

  await client.sendUserMessage({
    threadId: "thread-isolated",
    text: "probe",
    accessMode: "full-access",
    workspaceRoot: path.join(os.tmpdir(), "isolated-workspace"),
    executionPolicy: MODEL_CANARY_EXECUTION_POLICY,
  });

  assert.equal(calls[0].method, "turn/start");
  assert.equal(calls[0].params.accessMode, undefined);
  assert.equal(calls[0].params.approvalPolicy, "never");
  assert.deepEqual(calls[0].params.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.deepEqual(calls[0].params.environments, []);
});

test("isolated model canary profile hardlinks auth, starts empty, and is removed on close", async (t) => {
  const sourceHome = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-auth-source-"));
  const sourceAuth = path.join(sourceHome, "auth.json");
  fs.writeFileSync(sourceAuth, '{"fixture":"credential"}\n', "utf8");
  t.after(() => fs.rmSync(sourceHome, { recursive: true, force: true }));
  const client = new CodexRpcClient({
    env: { ...process.env, CODEX_HOME: sourceHome },
    isolatedProfile: true,
  });

  const isolatedEnv = client.ensureIsolatedProfileEnvironment();
  const isolatedRoot = client.isolatedProfileRoot;
  const isolatedAuth = path.join(isolatedEnv.CODEX_HOME, "auth.json");
  const sourceStat = fs.statSync(sourceAuth);
  const isolatedStat = fs.statSync(isolatedAuth);
  assert.equal(sourceStat.dev, isolatedStat.dev);
  assert.equal(sourceStat.ino, isolatedStat.ino);
  assert.notEqual(isolatedEnv.CODEX_HOME, sourceHome);
  assert.equal(fs.readdirSync(client.getIsolatedWorkspaceRoot()).length, 0);
  assert.match(fs.readFileSync(path.join(isolatedEnv.CODEX_HOME, "config.toml"), "utf8"), /web_search = "disabled"/);
  assert.deepEqual(buildCodexConfigArgs(null, { isolatedProfile: true }), [
    "-c", 'web_search="disabled"',
    "-c", "features.js_repl=false",
    "-c", "mcp_servers={}",
    "-c", "plugins={}",
  ]);

  await client.close();
  assert.equal(fs.existsSync(isolatedRoot), false);
  assert.equal(fs.existsSync(sourceAuth), true);
});

test("stale isolated model canary profiles are removed only from the temp root", (t) => {
  const stale = path.join(os.tmpdir(), "cyberboss-model-canary-codex-99999999-stale-fixture");
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, "fixture"), "x", "utf8");
  t.after(() => fs.rmSync(stale, { recursive: true, force: true }));
  cleanupStaleIsolatedProfiles();
  assert.equal(fs.existsSync(stale), false);
});
