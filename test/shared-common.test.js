const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSharedCodexIsolationArgs,
  buildHiddenConsoleLauncherSpec,
  resolveCodexCommand,
} = require("../scripts/shared-common");

test("shared Codex app-server keeps browser-control plugins and disables unrelated integrations", () => {
  const args = buildSharedCodexIsolationArgs(`
[mcp_servers.chrome-devtools]
command = "npx"

[mcp_servers.fastctx]
command = "fastctx"

[mcp_servers.cyberboss_tools]
command = "node"

[plugins."browser@openai-bundled"]
enabled = true

[plugins."chrome@openai-bundled"]
enabled = true

[plugins."computer-use@openai-bundled"]
enabled = true

[plugins."unrelated@example"]
enabled = true
`);

  assert.deepEqual(args, [
    "-c",
    "mcp_servers.chrome-devtools.enabled=false",
    "-c",
    "mcp_servers.fastctx.enabled=false",
    "-c",
    'plugins."unrelated@example".enabled=false',
  ]);
});

test("Windows app-server launcher uses wscript and the hidden-console host", () => {
  const spec = buildHiddenConsoleLauncherSpec(
    "C:\\state\\request.json",
    "C:\\state\\result.json",
    {
      platform: "win32",
      nodePath: "C:\\Node\\node.exe",
      systemRoot: "C:\\Windows",
    }
  );

  assert.equal(spec.command, "C:\\Windows\\System32\\wscript.exe");
  assert.deepEqual(spec.args.slice(0, 2), ["//B", "//NoLogo"]);
  assert.match(spec.args[2], /shared-hidden-console-launch\.vbs$/);
  assert.equal(spec.args[3], "C:\\Node\\node.exe");
  assert.match(spec.args[4], /shared-hidden-console-host\.js$/);
  assert.deepEqual(spec.args.slice(5), ["C:\\state\\request.json", "C:\\state\\result.json"]);
});

test("shared app-server prefers the current desktop Codex CLI when no explicit command is configured", () => {
  const root = "C:\\Users\\tester\\AppData\\Local";
  const desktopRoot = `${root}\\OpenAI\\Codex\\bin`;
  const newest = `${desktopRoot}\\newer\\codex.exe`;
  const older = `${desktopRoot}\\older\\codex.exe`;
  const statByPath = new Map([
    [desktopRoot, { isFile: () => false, mtimeMs: 0 }],
    [`${desktopRoot}\\newer`, { isFile: () => false, mtimeMs: 200 }],
    [`${desktopRoot}\\older`, { isFile: () => false, mtimeMs: 100 }],
    [newest, { isFile: () => true, mtimeMs: 200 }],
    [older, { isFile: () => true, mtimeMs: 100 }],
  ]);
  const fsImpl = {
    readdirSync(directory) {
      assert.equal(directory, desktopRoot);
      return [
        { name: "older", isDirectory: () => true },
        { name: "newer", isDirectory: () => true },
        { name: "rg-only", isDirectory: () => true },
      ];
    },
    statSync(filePath) {
      const value = statByPath.get(filePath);
      if (!value) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return value;
    },
  };

  assert.equal(
    resolveCodexCommand({
      env: { LOCALAPPDATA: root },
      platform: "win32",
      fsImpl,
    }),
    newest
  );
});

test("explicit shared Codex command overrides desktop discovery", () => {
  assert.equal(
    resolveCodexCommand({
      env: { CYBERBOSS_CODEX_COMMAND: "D:\\Tools\\codex.exe", LOCALAPPDATA: "C:\\Ignored" },
      platform: "win32",
      fsImpl: {
        readdirSync() {
          throw new Error("desktop discovery should not run");
        },
        statSync() {
          throw new Error("desktop discovery should not run");
        },
      },
    }),
    "D:\\Tools\\codex.exe"
  );
});
