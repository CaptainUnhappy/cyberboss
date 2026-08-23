const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const rootDir = path.resolve(__dirname, "..");

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

function main() {
  const stdoutPath = readFlag("--stdout");
  const stderrPath = readFlag("--stderr");
  if (!stdoutPath || !stderrPath) {
    throw new Error("usage: node scripts/shared-launch.js --stdout FILE --stderr FILE");
  }

  fs.mkdirSync(path.dirname(stdoutPath), { recursive: true });
  fs.mkdirSync(path.dirname(stderrPath), { recursive: true });
  const stdoutFd = fs.openSync(stdoutPath, "a");
  const stderrFd = fs.openSync(stderrPath, "a");
  let child;
  try {
    child = spawn(process.execPath, [path.join(__dirname, "shared-start.js")], {
      cwd: rootDir,
      env: process.env,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
  child.unref();
  process.stdout.write(`${child.pid}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
