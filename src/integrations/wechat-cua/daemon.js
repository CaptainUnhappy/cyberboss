// daemon.js - is the driver actually there, and if not, bring it back.
//
// Measured 2026-10-01: the Cua daemon died on its own while the bot was running
// (its `status` went from "running" to "not running", and every later call answered
//   Cua Driver daemon is not running on \\.\pipe\cua-driver.
// ). With the reader's old behaviour that turned into "no rows, no events" - a bot
// that looks healthy and hears nothing, which is the worst failure mode available
// to a channel whose whole job is to answer people.
//
// So the channel checks liveness and, when the daemon is gone, starts it again
// through the driver's own autostart entry. That is not the bot inventing a
// privilege: `cua-driver autostart enable` exists exactly so the daemon is a logon
// service, and `kick` starts that entry now. If the entry is missing the driver is
// started directly, detached, with `serve`.
//
// Everything is injected (`exec`, `spawn`) so the recovery logic is testable without
// killing the real daemon.

const { execFileSync, spawn } = require("node:child_process");

const DRIVER = process.env.CUA_DRIVER
  || "C:\\Users\\79388\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe";

const NOT_RUNNING = /daemon is not running/i;

function defaultExec(driver, args) {
  return execFileSync(driver, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    // Keep the driver's own stderr out of the bot's log; it is available on the
    // thrown error. Otherwise every liveness probe during an outage prints
    // "daemon is not running" and buries the recovery line that matters.
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** `cua-driver status` in words: {running, raw}. Never throws. */
function driverStatus({ driver = DRIVER, exec = defaultExec } = {}) {
  try {
    const out = String(exec(driver, ["status"]) || "");
    const running = /daemon is running/i.test(out);
    return { running, raw: out.trim().split("\n")[0] || "" };
  } catch (error) {
    const text = `${error.stdout || ""}${error.stderr || ""}${error.message || ""}`;
    return { running: false, raw: text.trim().split("\n")[0] || "status failed", error: text };
  }
}

/**
 * Make sure the daemon is up. Returns what happened, so the caller can log it.
 *
 * @returns {{wasRunning:boolean, started:boolean, how:string, detail:string}}
 */
function ensureDriverRunning({
  driver = DRIVER,
  exec = defaultExec,
  spawnImpl = spawn,
  sleep = defaultSleep,
  settleMs = 4_000,
} = {}) {
  const status = driverStatus({ driver, exec });
  if (status.running) {
    return { wasRunning: true, started: false, how: "already-running", detail: status.raw };
  }
  // Preferred path: the registered logon entry, which knows the right socket.
  let kickDetail = "";
  try {
    kickDetail = String(exec(driver, ["autostart", "kick"]) || "").trim().split("\n")[0] || "";
  } catch (error) {
    kickDetail = `kick failed: ${error.message}`;
  }
  // Measured 2026-10-01: the entry starts the daemon, but not instantly - checking
  // status once right after the kick still said "not running", so the fallback also
  // spawned a detached `serve`. Give it a moment before deciding it did not work.
  if (waitForDaemon({ driver, exec, sleep, timeoutMs: settleMs })) {
    return { wasRunning: false, started: true, how: "autostart-kick", detail: kickDetail };
  }
  return { ...startDetached({ driver, spawnImpl }), detail: kickDetail || "the autostart entry did not bring it up" };
}

/** Poll `status` until the daemon answers or the budget runs out. */
function waitForDaemon({ driver = DRIVER, exec = defaultExec, sleep = defaultSleep, timeoutMs = 4_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (driverStatus({ driver, exec }).running) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    sleep(400);
  }
}

function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Last resort: start `cua-driver serve` detached and let it own the socket. */
function startDetached({ driver = DRIVER, spawnImpl = spawn } = {}) {
  try {
    const child = spawnImpl(driver, ["serve"], { detached: true, stdio: "ignore", windowsHide: true });
    if (child && typeof child.unref === "function") {
      child.unref();
    }
    return { wasRunning: false, started: true, how: "serve-detached", detail: "started a detached daemon" };
  } catch (error) {
    return { wasRunning: false, started: false, how: "failed", detail: error.message };
  }
}

/** Does this failure text mean "the daemon is not there"? */
function isDaemonDown(detail) {
  return NOT_RUNNING.test(String(detail || ""));
}

module.exports = {
  driverStatus,
  ensureDriverRunning,
  startDetached,
  isDaemonDown,
  DRIVER,
};
