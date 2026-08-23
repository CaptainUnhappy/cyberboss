const test = require("node:test");
const assert = require("node:assert/strict");

const { buildSharedCodexIsolationArgs } = require("../scripts/shared-common");

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
