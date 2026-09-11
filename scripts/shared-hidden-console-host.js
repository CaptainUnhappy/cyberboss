const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function readFlag(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? String(argv[index + 1] || "").trim() : "";
}

function readLaunchRequest(requestPath) {
  const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  if (!request || request.version !== 1) {
    throw new Error("unsupported hidden console launch request");
  }
  if (typeof request.command !== "string" || !request.command.trim()) {
    throw new Error("hidden console launch command is missing");
  }
  if (!Array.isArray(request.args) || request.args.some((value) => typeof value !== "string")) {
    throw new Error("hidden console launch args must be strings");
  }
  if (typeof request.cwd !== "string" || !request.cwd.trim()) {
    throw new Error("hidden console launch cwd is missing");
  }
  if (typeof request.logFile !== "string" || !request.logFile.trim()) {
    throw new Error("hidden console launch log file is missing");
  }
  if (!request.env || typeof request.env !== "object" || Array.isArray(request.env)) {
    throw new Error("hidden console launch env must be an object");
  }
  for (const [name, value] of Object.entries(request.env)) {
    if (!name || typeof value !== "string") {
      throw new Error("hidden console launch env values must be strings");
    }
  }
  return request;
}

function writeResult(resultPath, result) {
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  const temporaryPath = `${resultPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(result)}\n`, "utf8");
  fs.renameSync(temporaryPath, resultPath);
}

function waitForSpawn(child) {
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

async function launchFromRequest(
  requestPath,
  resultPath,
  {
    spawnImpl = spawn,
    baseEnv = process.env,
    hostPid = process.pid,
    onChildExit = defaultChildExit,
  } = {}
) {
  let child = null;
  let stdoutFd = null;
  let stderrFd = null;
  try {
    const request = readLaunchRequest(requestPath);
    fs.mkdirSync(path.dirname(request.logFile), { recursive: true });
    stdoutFd = fs.openSync(request.logFile, "a");
    stderrFd = fs.openSync(request.logFile, "a");
    child = spawnImpl(request.command, request.args, {
      cwd: request.cwd,
      env: { ...baseEnv, ...request.env },
      detached: false,
      stdio: ["ignore", stdoutFd, stderrFd],
      shell: false,
      windowsHide: true,
    });
    child.once("exit", onChildExit);
    await waitForSpawn(child);
    writeResult(resultPath, {
      version: 1,
      ok: true,
      pid: child.pid,
      hostPid,
    });
    return { child, pid: child.pid };
  } catch (error) {
    if (child?.pid) {
      try {
        child.kill();
      } catch {
        // The child may already have exited.
      }
    }
    writeResult(resultPath, {
      version: 1,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      hostPid,
    });
    throw error;
  } finally {
    if (stdoutFd !== null) {
      fs.closeSync(stdoutFd);
    }
    if (stderrFd !== null) {
      fs.closeSync(stderrFd);
    }
  }
}

function defaultChildExit(code) {
  process.exitCode = Number.isInteger(code) ? code : 1;
}

async function main() {
  const requestPath = readFlag(process.argv.slice(2), "--request");
  const resultPath = readFlag(process.argv.slice(2), "--result");
  if (!requestPath || !resultPath) {
    throw new Error("usage: node shared-hidden-console-host.js --request FILE --result FILE");
  }
  await launchFromRequest(requestPath, resultPath);
}

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 1;
  });
}

module.exports = {
  readLaunchRequest,
  launchFromRequest,
};
