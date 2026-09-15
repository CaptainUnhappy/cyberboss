const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { listCommandGroups, buildWeixinHelpText } = require("../src/core/command-registry");
const { CONTROL_COMMANDS } = require("../src/integrations/weflow-outbound");

/**
 * `/help` is the only way a WeChat user can discover what the bridge accepts, so
 * a command that works but is not registered is effectively invisible, and a
 * registered command with no handler is a promise the bridge cannot keep.
 *
 * Both directions are checked against their real sources rather than a copied
 * list: the native send-source commands live in `weflow-outbound`, and the
 * handled names are the `case` labels of `dispatchChannelCommand`.
 */
const projectRoot = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(projectRoot, "src", "core", "app.js"), "utf8");

function declaredWeixinCommands() {
  const names = new Set();
  for (const group of listCommandGroups()) {
    for (const action of group.actions) {
      for (const alias of action.weixin) {
        names.add(alias.split(/\s+/u)[0].toLowerCase());
      }
    }
  }
  return names;
}

function dispatchedWeixinCommands() {
  const body = /async dispatchChannelCommand\([\s\S]*?\n  \}/u.exec(appSource);
  assert.ok(body, "dispatchChannelCommand must still be where this test expects it");
  const names = new Set();
  for (const match of body[0].matchAll(/case "([a-z0-9_]+)":/gu)) {
    names.add(`/${match[1]}`);
  }
  return names;
}

test("every command the bridge dispatches is advertised in /help", () => {
  const declared = declaredWeixinCommands();
  for (const name of dispatchedWeixinCommands()) {
    assert.equal(declared.has(name), true,
      `${name} has a handler but is missing from the command registry, so /help hides it`);
  }
});

test("every advertised command has a handler", () => {
  const dispatched = dispatchedWeixinCommands();
  // The native send-source commands are handled before dispatchChannelCommand
  // runs (isWeFlowControlCommand short-circuits in the inbound path), so they are
  // the one legitimate exception.
  const native = new Set([...CONTROL_COMMANDS].map((name) => name.toLowerCase()));
  for (const name of declaredWeixinCommands()) {
    assert.equal(dispatched.has(name) || native.has(name), true,
      `${name} is advertised in /help but nothing handles it`);
  }
});

test("the registered send-source commands match the ones actually handled", () => {
  // Two definitions of the same vocabulary drift silently otherwise: /help would
  // list a command the inbound path rejects, or hide one it accepts.
  const declared = declaredWeixinCommands();
  for (const name of CONTROL_COMMANDS) {
    assert.equal(declared.has(name.toLowerCase()), true,
      `${name} is handled natively but not registered, so /help hides it`);
  }
  const registeredChannelCommands = [...declared].filter((name) => name.startsWith("/") && (
    name === "/bot" || name === "/azzy" || name === "/mode" || name === "/状态"
  ));
  for (const name of registeredChannelCommands) {
    assert.equal(CONTROL_COMMANDS.has(name), true,
      `${name} is registered as a send-source command but the inbound path rejects it`);
  }
});

test("the help text actually renders the send-source commands", () => {
  const text = buildWeixinHelpText();
  for (const name of CONTROL_COMMANDS) {
    assert.match(text, new RegExp(name.replace(/[/]/gu, "\\/"), "u"),
      `/help must mention ${name}`);
  }
});
