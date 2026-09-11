const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const {
  buildCodexMcpConfigArgs,
  resolveCodexProjectToolMcpServerConfig,
} = require("../src/adapters/runtime/codex/mcp-config");

try {
  require("dotenv").config({ path: path.join(process.cwd(), ".env") });
} catch {
  // ignore
}

try {
  require("dotenv").config({ path: path.join(os.homedir(), ".cyberboss", ".env") });
} catch {
  // ignore
}

const rootDir = path.resolve(__dirname, "..");
const port = String(process.env.CYBERBOSS_SHARED_PORT || "8765");
const listenUrl = `ws://127.0.0.1:${port}`;
const stateDir = process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss");
const logDir = path.join(stateDir, "logs");
const appServerPidFile = path.join(logDir, "shared-app-server.pid");
const bridgePidFile = path.join(logDir, "shared-wechat.pid");
const appServerLogFile = path.join(logDir, "shared-app-server.log");
const weflowUiaBridgePidFile = path.join(logDir, "weflow-uia-bridge.pid");
const weflowUiaBridgeLogFile = path.join(logDir, "weflow-uia-bridge.log");
const hiddenConsoleLauncherScript = path.join(__dirname, "shared-hidden-console-launch.vbs");
const hiddenConsoleHostScript = path.join(__dirname, "shared-hidden-console-host.js");
const hiddenConsoleLaunchTimeoutMs = 10_000;
const accountsDir = path.join(stateDir, "accounts");
const sessionFile = process.env.CYBERBOSS_SESSIONS_FILE || path.join(stateDir, "sessions.json");
const sharedCodexEnabledPlugins = new Set([
  "browser@openai-bundled",
  "chrome@openai-bundled",
  "computer-use@openai-bundled",
]);

function buildSharedCodexIsolationArgs(configText = readCodexConfigText()) {
  const args = [];
  const seen = new Set();
  const sectionPattern = /^\s*\[(mcp_servers|plugins)\.((?:"[^"]+")|(?:[^\].]+))\]\s*$/gm;
  for (const match of String(configText || "").matchAll(sectionPattern)) {
    const group = match[1];
    const rawName = match[2].trim();
    const normalizedName = rawName.replace(/^"|"$/g, "");
    if (
      !normalizedName
      || (group === "mcp_servers" && normalizedName === "cyberboss_tools")
      || (group === "plugins" && sharedCodexEnabledPlugins.has(normalizedName))
    ) {
      continue;
    }
    const key = `${group}.${rawName}.enabled=false`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    args.push("-c", key);
  }
  return args;
}

function readCodexConfigText() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  try {
    return fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  } catch {
    return "";
  }
}

function resolveCodexCommand({
  env = process.env,
  platform = process.platform,
  fsImpl = fs,
} = {}) {
  const configured = normalizeText(env.CYBERBOSS_CODEX_COMMAND);
  if (configured) {
    return configured;
  }

  const cliPath = normalizeText(env.CODEX_CLI_PATH);
  if (cliPath && fileExists(fsImpl, cliPath)) {
    return cliPath;
  }

  if (platform === "win32") {
    const localAppData = normalizeText(env.LOCALAPPDATA);
    if (localAppData) {
      const desktopBinRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
      const desktopCommand = findNewestCodexDesktopCommand(fsImpl, desktopBinRoot);
      if (desktopCommand) {
        return desktopCommand;
      }

      const installedCommand = path.join(
        localAppData,
        "Programs",
        "OpenAI",
        "Codex",
        "bin",
        "codex.exe"
      );
      if (fileExists(fsImpl, installedCommand)) {
        return installedCommand;
      }
    }
  }

  return "codex";
}

function findNewestCodexDesktopCommand(fsImpl, desktopBinRoot) {
  let entries = [];
  try {
    entries = fsImpl.readdirSync(desktopBinRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const directory = path.join(desktopBinRoot, entry.name);
        const command = path.join(directory, "codex.exe");
        let mtimeMs = 0;
        try {
          mtimeMs = Number(fsImpl.statSync(directory).mtimeMs) || 0;
        } catch {
          // Keep probing the executable below.
        }
        return { command, mtimeMs };
      });
  } catch {
    return "";
  }

  return entries
    .filter((entry) => fileExists(fsImpl, entry.command))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .map((entry) => entry.command)[0] || "";
}

function fileExists(fsImpl, filePath) {
  try {
    return fsImpl.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function ensureLogDir() {
  fs.mkdirSync(logDir, { recursive: true });
}

function isPidAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return false;
  }
  try {
    process.kill(numeric, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    return raw ? Number.parseInt(raw, 10) : 0;
  } catch {
    return 0;
  }
}

function writePidFile(filePath, pid) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${pid}\n`, "utf8");
}

function removePidFileIfMatches(filePath, pid) {
  const current = readPidFile(filePath);
  if (current && current === pid) {
    fs.rmSync(filePath, { force: true });
  }
}

function checkReadyz() {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port: Number(port),
        path: "/readyz",
        timeout: 500,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function checkHttpEndpoint({ hostname = "127.0.0.1", port: endpointPort, pathname = "/healthz" }) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname,
        port: Number(endpointPort),
        path: pathname,
        timeout: 500,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForReadyz({ attempts = 10, delayMs = 300 } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    if (await checkReadyz()) {
      return true;
    }
    await sleep(delayMs);
  }
  return false;
}

function openLogFile(filePath) {
  return fs.openSync(filePath, "a");
}

function spawnDetachedCommand(command, args, { logFile, cwd = rootDir, env = {} } = {}) {
  const stdoutFd = openLogFile(logFile);
  const stderrFd = openLogFile(logFile);
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
    shell: false,
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

function buildHiddenConsoleLauncherSpec(
  requestPath,
  resultPath,
  {
    platform = process.platform,
    nodePath = process.execPath,
    systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
  } = {}
) {
  if (platform !== "win32") {
    throw new Error("the hidden inherited-console launcher is Windows-only");
  }
  return {
    command: path.win32.join(systemRoot, "System32", "wscript.exe"),
    args: [
      "//B",
      "//NoLogo",
      hiddenConsoleLauncherScript,
      nodePath,
      hiddenConsoleHostScript,
      requestPath,
      resultPath,
    ],
  };
}

async function spawnCommandWithHiddenInheritedConsole(
  command,
  args,
  { logFile, cwd = rootDir, env = {}, timeoutMs = hiddenConsoleLaunchTimeoutMs } = {}
) {
  if (process.platform !== "win32") {
    throw new Error("the hidden inherited-console launcher is Windows-only");
  }

  ensureLogDir();
  const launchDir = fs.mkdtempSync(path.join(logDir, "shared-app-server-launch-"));
  const requestPath = path.join(launchDir, "request.json");
  const resultPath = path.join(launchDir, "result.json");
  fs.writeFileSync(
    requestPath,
    `${JSON.stringify({
      version: 1,
      command,
      args,
      cwd,
      env,
      logFile,
    }, null, 2)}\n`,
    "utf8"
  );

  const launcherSpec = buildHiddenConsoleLauncherSpec(requestPath, resultPath);
  let launcher;
  try {
    launcher = spawn(launcherSpec.command, launcherSpec.args, {
      cwd,
      env: process.env,
      detached: true,
      stdio: "ignore",
      shell: false,
      windowsHide: true,
    });
    await waitForChildSpawn(launcher);
    launcher.unref();
  } catch (error) {
    fs.rmSync(launchDir, { force: true, recursive: true });
    throw new Error(`failed to start hidden console launcher: ${error.message || String(error)}`);
  }

  const result = await waitForHiddenConsoleLaunchResult(resultPath, timeoutMs);
  if (!result) {
    throw new Error(
      `hidden console host did not report an app-server PID within ${timeoutMs}ms; inspect ${launchDir}`
    );
  }
  if (result.version !== 1 || result.ok !== true) {
    fs.rmSync(launchDir, { force: true, recursive: true });
    throw new Error(`hidden console host failed: ${normalizeText(result.error) || "unknown error"}`);
  }

  const pid = Number(result.pid);
  if (!Number.isInteger(pid) || pid <= 0 || !isPidAlive(pid)) {
    fs.rmSync(launchDir, { force: true, recursive: true });
    throw new Error(`hidden console host returned a dead or invalid app-server PID: ${result.pid}`);
  }
  fs.rmSync(launchDir, { force: true, recursive: true });
  return pid;
}

function waitForChildSpawn(child) {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.removeListener("error", onError);
      resolve();
    };
    const onError = (error) => {
      child.removeListener("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

async function waitForHiddenConsoleLaunchResult(resultPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(fs.readFileSync(resultPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
    await sleep(25);
  }
  return null;
}

async function ensureSharedAppServer() {
  if (process.env.CYBERBOSS_RUNTIME && process.env.CYBERBOSS_RUNTIME !== "codex") {
    return { pid: 0, status: "skipped" };
  }

  ensureLogDir();
  const pidFromFile = readPidFile(appServerPidFile);
  if (pidFromFile && isPidAlive(pidFromFile) && (await checkReadyz())) {
    return { pid: pidFromFile, status: "already_running" };
  }

  if (await checkReadyz()) {
    return { pid: pidFromFile || 0, status: "already_running_unknown_pid" };
  }

  const env = {
    CYBERBOSS_STATE_DIR: stateDir,
    TIMELINE_FOR_AGENT_STATE_DIR: stateDir,
  };
  if (!process.env.TIMELINE_FOR_AGENT_CHROME_PATH) {
    env.TIMELINE_FOR_AGENT_CHROME_PATH =
      process.env.CYBERBOSS_SCREENSHOT_CHROME_PATH
      || (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : "");
  }

  const command = resolveCodexCommand();
  const isolationArgs = buildSharedCodexIsolationArgs();
  const mcpConfigArgs = buildCodexMcpConfigArgs(resolveCodexProjectToolMcpServerConfig({
    cyberbossHome: process.env.CYBERBOSS_HOME || rootDir,
  }));
  const appServerArgs = [...isolationArgs, ...mcpConfigArgs, "app-server", "--listen", listenUrl];
  const pid = process.platform === "win32"
    ? await spawnCommandWithHiddenInheritedConsole(command, appServerArgs, {
      logFile: appServerLogFile,
      env,
    })
    : spawnDetachedCommand(command, appServerArgs, {
      logFile: appServerLogFile,
      env,
    });
  writePidFile(appServerPidFile, pid);

  const ready = await waitForReadyz();
  if (!ready) {
    throw new Error(`failed to start shared app-server; check ${appServerLogFile}`);
  }

  writePidFile(appServerPidFile, pid);
  return { pid, status: "started" };
}

async function ensureWeFlowUiaBridge() {
  const enabled = ["1", "true", "yes", "on"].includes(
    normalizeText(process.env.CYBERBOSS_ENABLE_WEFLOW_INBOX).toLowerCase()
  );
  if (!enabled || process.platform !== "win32") {
    return { pid: 0, status: "skipped" };
  }

  const bridgeUrl = new URL(
    normalizeText(process.env.CYBERBOSS_WEFLOW_BRIDGE_BASE_URL) || "http://127.0.0.1:8766"
  );
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(bridgeUrl.hostname)) {
    return { pid: 0, status: "external" };
  }
  const bridgePort = Number(bridgeUrl.port || (bridgeUrl.protocol === "https:" ? 443 : 80));
  const isReady = () => checkHttpEndpoint({ hostname: bridgeUrl.hostname, port: bridgePort });
  ensureLogDir();
  const pidFromFile = readPidFile(weflowUiaBridgePidFile);
  if (pidFromFile && isPidAlive(pidFromFile) && (await isReady())) {
    return { pid: pidFromFile, status: "already_running" };
  }
  if (await isReady()) {
    return { pid: pidFromFile || 0, status: "already_running_unknown_pid" };
  }
  if (pidFromFile) {
    fs.rmSync(weflowUiaBridgePidFile, { force: true });
  }

  const pythonCommand = normalizeText(process.env.CYBERBOSS_WEFLOW_UIA_PYTHON) || "python";
  const script = path.join(rootDir, "scripts", "weflow-uia-bridge.py");
  const pid = spawnDetachedCommand(
    pythonCommand,
    [script, "--host", bridgeUrl.hostname, "--port", String(bridgePort)],
    { logFile: weflowUiaBridgeLogFile }
  );
  writePidFile(weflowUiaBridgePidFile, pid);
  for (let index = 0; index < 30; index += 1) {
    if (await isReady()) {
      return { pid, status: "started" };
    }
    await sleep(200);
  }
  throw new Error(`failed to start WeFlow UIA bridge; check ${weflowUiaBridgeLogFile}`);
}

function ensureBridgeNotRunning() {
  const pidFromFile = readPidFile(bridgePidFile);
  if (pidFromFile && isPidAlive(pidFromFile)) {
    return pidFromFile;
  }
  if (pidFromFile) {
    fs.rmSync(bridgePidFile, { force: true });
  }
  return 0;
}

function resolveCurrentAccountId() {
  if (!fs.existsSync(accountsDir)) {
    return "";
  }
  const entries = fs.readdirSync(accountsDir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".context-tokens.json"))
    .map((name) => {
      const fullPath = path.join(accountsDir, name);
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
        return {
          accountId: normalizeText(parsed?.accountId),
          savedAt: parseTimestamp(parsed?.savedAt),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((entry) => entry.accountId);
  entries.sort((left, right) => right.savedAt - left.savedAt);
  return entries[0]?.accountId || "";
}

function resolveBoundThread(workspaceRoot) {
  if (!fs.existsSync(sessionFile)) {
    throw new Error(`session file not found: ${sessionFile}`);
  }
  const runtimeId = normalizeText(process.env.CYBERBOSS_RUNTIME || "codex");
  const data = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  const currentAccountId = resolveCurrentAccountId();
  const bindings = Object.values(data.bindings || {})
    .filter((binding) => !currentAccountId || normalizeText(binding?.accountId) === currentAccountId)
    .sort((left, right) => parseTimestamp(right?.updatedAt) - parseTimestamp(left?.updatedAt));

  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  const exact = bindings.find((binding) => getThreadId(binding, normalizedWorkspaceRoot, runtimeId));
  if (exact) {
    return {
      threadId: getThreadId(exact, normalizedWorkspaceRoot, runtimeId),
      workspaceRoot: normalizedWorkspaceRoot,
    };
  }

  const active = bindings.find((binding) => {
    const activeWorkspaceRoot = normalizeText(binding?.activeWorkspaceRoot);
    return activeWorkspaceRoot && getThreadId(binding, activeWorkspaceRoot, runtimeId);
  });
  if (active) {
    const activeWorkspaceRoot = normalizeText(active.activeWorkspaceRoot);
    return {
      threadId: getThreadId(active, activeWorkspaceRoot, runtimeId),
      workspaceRoot: activeWorkspaceRoot,
    };
  }

  throw new Error(`no bound WeChat thread found for workspace: ${workspaceRoot}`);
}

function getThreadId(binding, workspaceRoot, runtimeId = "") {
  if (!workspaceRoot) {
    return "";
  }
  const map = getThreadMapForRuntime(binding, runtimeId);
  return normalizeText(map[workspaceRoot]);
}

function getThreadMapForRuntime(binding, runtimeId) {
  const normalizedRuntimeId = normalizeText(runtimeId);
  const runtimeMap = binding && typeof binding.threadIdByWorkspaceRootByRuntime === "object"
    ? binding.threadIdByWorkspaceRootByRuntime
    : {};
  const scoped = runtimeMap[normalizedRuntimeId];
  return scoped && typeof scoped === "object" ? scoped : {};
}

function parseTimestamp(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  rootDir,
  port,
  listenUrl,
  stateDir,
  logDir,
  appServerPidFile,
  bridgePidFile,
  appServerLogFile,
  weflowUiaBridgePidFile,
  weflowUiaBridgeLogFile,
  ensureLogDir,
  isPidAlive,
  readPidFile,
  writePidFile,
  removePidFileIfMatches,
  buildSharedCodexIsolationArgs,
  buildHiddenConsoleLauncherSpec,
  resolveCodexCommand,
  ensureSharedAppServer,
  ensureWeFlowUiaBridge,
  ensureBridgeNotRunning,
  resolveBoundThread,
};
