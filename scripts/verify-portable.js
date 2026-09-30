#!/usr/bin/env node
/**
 * Static portability gate.
 *
 * "Migrate to another machine" fails at the first absolute path a script
 * assumes, so this check reads the *code* trees (prose is exempt) and fails on
 * any machine binding: a drive-rooted literal that is not the documented
 * fallback of an explicit environment lookup.
 *
 * There is no baseline and no allowlist: the tree is at zero, and the point is
 * that it stays there.
 *
 * Run:  node scripts/verify-portable.js
 *       node scripts/verify-portable.js --list   # print every violation too
 */

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");

/** Trees that execute on the operator's machine. */
const SCAN_DIRS = ["bin", "dsh-plugins", "scripts", "src", "tools"];

const SCAN_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".py", ".ps1", ".vbs", ".cmd", ".bat", ".yml", ".yaml", ".json",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "tmp", ".venv", ".venv-akasha", "analysis", "user", "output", "outputs",
]);

/** Files whose whole job is to be a template a human edits per machine. */
const ALLOWED_FILES = new Set([]);

const PATTERNS = [
  { name: "windows-drive-path", re: /\b[A-Za-z]:[\\/](?![\\/])/ },
  { name: "user-home-path", re: /\bUsers[\\/][A-Za-z0-9._-]+/ },
  { name: "posix-home-path", re: /\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+/ },
];

/**
 * A literal path is acceptable when it belongs to an explicit environment
 * lookup: it documents the historical default and the operator can override it.
 * The path must sit *inside* the lookup or its fallback branch — merely sharing
 * a line with an env var is not enough, or a seeded literal slips through.
 *
 * Acceptable:
 *   os.environ.get("X") or r"C:\default"
 *   os.environ.get("X", r"C:\default")
 *   $root = if ($env:X) { $env:X } else { 'C:\default' }
 *   if not defined PY if exist "D:\Tools\py.exe" set "PY=D:\Tools\py.exe"
 *
 * Not acceptable (each is a real machine binding):
 *   const p = 'C:\ProgramData\cwin-probe\x';
 *   cd /d D:\Projects\cyberboss
 *   name: 'D:/Projects/.../index.js'
 */
const ENV_MARKERS = [
  /os\.environ\.get\(\s*/u,
  /getenv\(\s*/u,
  // `or` only as a standalone keyword: a bare \b matches the tail of any word
  // ending in "or" (`Program Files` in a default path was matched this way).
  /(?<![A-Za-z_])or\s+/u,
  /\belse\s*\{\s*/u,
  /if\s+exist\s+/iu,
  /set\s+"[A-Za-z_][A-Za-z0-9_]*=\s*/iu,
];

/**
 * What may sit between the env lookup and its fallback path: quotes, an `r`
 * prefix, whitespace. Crucially NOT `+`, `/` or `=`, so a path *built* from a
 * literal (`QUEUE_ROOT / 'x.txt'`, `'C:' + name`) is still a binding.
 */
const GAP_ONLY = /^[\s(,]*r?["']?$/u;

function isEnvDefault(line, matchIndex) {
  const before = line.slice(0, matchIndex);
  const markers = [];
  for (const re of ENV_MARKERS) {
    const global = new RegExp(re.source, "gu");
    let hit;
    while ((hit = global.exec(before)) !== null) {
      markers.push(hit.index + hit[0].length);
      if (hit[0].length === 0) {
        break;
      }
    }
  }
  if (!markers.length) {
    return false;
  }
  const nearest = Math.max(...markers);
  return GAP_ONLY.test(before.slice(nearest));
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      walk(full, out);
    } else if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

function collectViolations() {
  const violations = [];
  let scanned = 0;
  for (const relDir of SCAN_DIRS) {
    const absDir = path.join(REPO_ROOT, relDir);
    if (!fs.existsSync(absDir)) {
      continue;
    }
    for (const file of walk(absDir)) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      if (ALLOWED_FILES.has(rel)) {
        continue;
      }
      scanned += 1;
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (/^\s*(\/\/|#|\*)/.test(line) || /--help|usage:/i.test(line) || /^\s*"(text|key|note)":/.test(line)) {
          continue;
        }
        for (const pattern of PATTERNS) {
          const match = line.match(pattern.re);
          if (!match) {
            continue;
          }
          // The path must belong to an env lookup; otherwise it is a binding.
          if (isEnvDefault(line, match.index)) {
            break;
          }
          violations.push({
            rel,
            line: index + 1,
            rule: pattern.name,
            text: line.trim().slice(0, 120),
            hit: match[0],
          });
          break;
        }
      }
    }
  }
  return { violations, scanned };
}

function main() {
  const argv = process.argv.slice(2);
  const { violations, scanned } = collectViolations();

  if (argv.includes("--list")) {
    for (const violation of violations) {
      console.log(`${violation.rel}:${violation.line} [${violation.rule}] ${violation.text}`);
    }
  }

  if (!violations.length) {
    console.log(`portable ok: ${scanned} file(s) scanned, no machine bindings`);
    return 0;
  }

  const byFile = new Map();
  for (const violation of violations) {
    if (!byFile.has(violation.rel)) {
      byFile.set(violation.rel, []);
    }
    byFile.get(violation.rel).push(violation);
  }
  for (const [rel, items] of [...byFile.entries()].sort()) {
    console.error(`${rel} — ${items.length} machine path(s)`);
    for (const item of items.slice(0, 6)) {
      console.error(`  ${item.line}: [${item.rule}] ${item.text}`);
    }
    if (items.length > 6) {
      console.error(`  … ${items.length - 6} more`);
    }
  }
  console.error(`portable check failed: ${violations.length} machine binding(s) in ${byFile.size} file(s)`);
  console.error("Rule: derive machine paths from the environment or from the script's own location.");
  console.error("A literal is allowed only as the documented fallback of an env lookup, e.g.");
  console.error("  os.environ.get(\"CYBERBOSS_QUEUE_ROOT\") or r\"C:\\ProgramData\\cwin-probe\"");
  return 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { main, collectViolations, SCAN_DIRS };
