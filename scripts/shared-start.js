const { spawn } = require("child_process");
const {
  rootDir,
  listenUrl,
  bridgePidFile,
  writePidFile,
  removePidFileIfMatches,
  ensureSharedAppServer,
  ensureWeFlowUiaBridge,
  ensureBridgeNotRunning,
} = require("./shared-common");

async function main() {
  const runtime = process.env.CYBERBOSS_RUNTIME || "codex";
  console.log(`starting shared bridge runtime=${runtime}`);
  const appServer = await ensureSharedAppServer();
  const appServerPidLabel = appServer.pid ? ` pid=${appServer.pid}` : "";
  if (appServer.status === "skipped") {
    console.log(`shared app-server skipped (runtime=${runtime})`);
  } else {
    console.log(`shared app-server ${appServer.status}${appServerPidLabel} listen=${listenUrl}`);
  }

  const weflowBridge = await ensureWeFlowUiaBridge();
  const weflowBridgePidLabel = weflowBridge.pid ? ` pid=${weflowBridge.pid}` : "";
  console.log(`WeFlow UIA bridge ${weflowBridge.status}${weflowBridgePidLabel}`);

  const existingBridgePid = ensureBridgeNotRunning();
  if (existingBridgePid) {
    console.log(`shared cyberboss already running pid=${existingBridgePid}`);
    return;
  }

  const childEnv = { ...process.env };
  const isCodex = runtime === "codex";
  if (isCodex) {
    childEnv.CYBERBOSS_CODEX_ENDPOINT = listenUrl;
  }

  const child = spawn(process.execPath, ["./bin/cyberboss.js", "start", "--checkin"], {
    cwd: rootDir,
    env: childEnv,
    stdio: "inherit",
    windowsHide: true,
  });

  writePidFile(bridgePidFile, child.pid);
  const cleanup = () => removePidFileIfMatches(bridgePidFile, child.pid);
  // Keep the child PID recorded until the child itself exits. If the launcher
  // closes first on Windows, removing this file would orphan a live bridge and
  // let the next shared:start launch a duplicate responder.
  process.on("SIGINT", () => {
    child.kill("SIGINT");
  });
  process.on("SIGTERM", () => {
    child.kill("SIGTERM");
  });

  child.on("exit", (code, signal) => {
    cleanup();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
