const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// scripts/cyberboss-watchdog.ps1 contains non-ASCII characters (for example the
// recycle emoji in the restart-notification text).  Windows PowerShell 5.1
// decodes a BOM-less file as ANSI, which turns those characters into invalid
// tokens and makes the whole script fail to parse.  The failure is silent from
// the watchdog's point of view: it simply stops running, and the only visible
// symptom is a stale status file.  Guard the BOM explicitly.
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const PS1_FILES_REQUIRING_BOM = [
  "scripts/cyberboss-watchdog.ps1",
  "scripts/cyberboss-service.ps1",
  "scripts/install-cyberboss-watchdog-task.ps1",
];

function readBytes(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath));
}

test("PowerShell scripts that carry non-ASCII text keep their UTF-8 BOM", () => {
  for (const relativePath of PS1_FILES_REQUIRING_BOM) {
    const bytes = readBytes(relativePath);
    const hasNonAscii = bytes.some((byte) => byte > 0x7f);
    if (!hasNonAscii) {
      continue;
    }
    assert.ok(
      bytes.subarray(0, 3).equals(UTF8_BOM),
      `${relativePath} contains non-ASCII text but lost its UTF-8 BOM; `
        + "Windows PowerShell 5.1 will decode it as ANSI and fail to parse it",
    );
  }
});

test("the watchdog script still parses as UTF-8 text", () => {
  const source = readBytes("scripts/cyberboss-watchdog.ps1").toString("utf8");
  // A correctly decoded file must not contain replacement characters.
  assert.equal(
    source.includes("\ufffd"),
    false,
    "scripts/cyberboss-watchdog.ps1 contains U+FFFD, which means its encoding "
      + "no longer matches its bytes",
  );
  assert.match(source, /function Get-WatchdogRestartNotificationText/);
});
