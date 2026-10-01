// Inspect a PE's requested execution level + uiAccess flag from its embedded manifest.
// Usage: node scripts/inspect-pe-manifest.js <path-to-exe>
const fs = require("fs");

const file = process.argv[2];
if (!file) {
  console.error("usage: node inspect-pe-manifest.js <path-to-exe>");
  process.exit(2);
}
const bytes = fs.readFileSync(file);
const text = bytes.toString("latin1");

const level = text.match(/<requestedExecutionLevel[^>]*>/i);
const uiAccess = text.match(/<uiAccess[^>]*>([^<]*)<\/uiAccess>/i);
const autoElevate = text.match(/<autoElevate[^>]*>([^<]*)<\/autoElevate>/i);

console.log(`file            : ${file}`);
console.log(`size            : ${bytes.length} bytes`);
console.log(`execution level : ${level ? level[0] : "(not found)"}`);
console.log(`uiAccess        : ${uiAccess ? uiAccess[1] : "(not found)"}`);
console.log(`autoElevate     : ${autoElevate ? autoElevate[1] : "(not found)"}`);

// A UIAccess binary must be signed by a cert in the machine's Trusted Root store
// AND live in a "secure" location (%ProgramFiles% or %SystemRoot%\System32).
const inProgramFiles = /^[A-Za-z]:\\Program Files/i.test(file) || /^[A-Za-z]:\\Windows\\System32/i.test(file);
console.log(`secure location : ${inProgramFiles ? "yes" : "NO - UIAccess requires Program Files or System32"}`);
const signed = /PKCS7|Authenticode|http:\/\/schemas\.microsoft\.com\/SOM\/2/i.test(text) || text.includes("Microsoft Root");
console.log(`looks signed    : ${signed ? "yes (heuristic)" : "unclear (heuristic only)"}`);
