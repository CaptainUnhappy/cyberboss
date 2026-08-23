const fs = require("fs");
const os = require("os");
const path = require("path");

const GLOBAL_PROCESS_LOCK_FILE = path.join(os.homedir(), ".cyberboss", "cyberboss.pid");

function acquireCyberbossProcessLock({
  lockFile = GLOBAL_PROCESS_LOCK_FILE,
  pid = process.pid,
  isProcessAlive = defaultIsProcessAlive,
} = {}) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    throw new Error(`invalid Cyberboss process id: ${pid}`);
  }

  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writePidExclusively(lockFile, numericPid);
      let released = false;
      return {
        lockFile,
        pid: numericPid,
        release() {
          if (released) {
            return false;
          }
          released = true;
          return removeLockIfOwned(lockFile, numericPid);
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }

    const existingPid = readLockPid(lockFile);
    if (existingPid && isProcessAlive(existingPid)) {
      const error = new Error(`Cyberboss is already running pid=${existingPid}`);
      error.code = "CYBERBOSS_ALREADY_RUNNING";
      error.pid = existingPid;
      throw error;
    }

    try {
      fs.rmSync(lockFile, { force: false });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  throw new Error(`failed to acquire Cyberboss process lock: ${lockFile}`);
}

function writePidExclusively(lockFile, pid) {
  let fd = null;
  try {
    fd = fs.openSync(lockFile, "wx");
    fs.writeFileSync(fd, `${pid}\n`, "utf8");
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close failure while preserving the original write error
      }
      try {
        fs.rmSync(lockFile, { force: true });
      } catch {
        // ignore cleanup failure while preserving the original write error
      }
    }
    throw error;
  }
  fs.closeSync(fd);
}

function readLockPid(lockFile) {
  try {
    const parsed = Number.parseInt(fs.readFileSync(lockFile, "utf8").trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function removeLockIfOwned(lockFile, pid) {
  if (readLockPid(lockFile) !== pid) {
    return false;
  }
  try {
    fs.rmSync(lockFile, { force: true });
    return true;
  } catch {
    return false;
  }
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

module.exports = {
  GLOBAL_PROCESS_LOCK_FILE,
  acquireCyberbossProcessLock,
  defaultIsProcessAlive,
  readLockPid,
};
