#!/usr/bin/env node
/**
 * cyberboss state migration helper.
 *
 * Two machines, one bot: `export` decides what is *not* reproducible, `import`
 * restores it on the target machine and rewrites the absolute paths that the
 * runtime stores as data (thread bindings keep workspace roots as JSON keys).
 *
 * Commands
 *   node scripts/migrate.js list   [--state-dir DIR]
 *   node scripts/migrate.js export --to DIR [--state-dir DIR] [--force]
 *   node scripts/migrate.js verify DIR
 *   node scripts/migrate.js import --from DIR [--state-dir DIR] [--map old=new]... [--force]
 *
 * Deliberate non-goals: this tool never touches `.env`, never copies
 * `models/`, `inbox/`, `outbox/` or media caches, and never talks to a running
 * bot. See `.agents/notes/proposed/architecture/2026-09-30-portable-install-and-dual-channel-contract.md`.
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MANIFEST_SCHEMA = 1;
const MANIFEST_NAME = "manifest.json";
const STATE_COPY_DIR = "state";
const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * Portable state: unreproducible, safe to move between machines. Paths are
 * relative to the state directory.
 */
const PORTABLE_FILES = [
  "memory.json",
  "checkin-config.json",
  "pending-inbound.json",
  "reply-obligations.json",
  "deferred-system-replies.json",
  "system-message-queue.json",
  "dsh-sessions.json",
  "sessions.json",
  "thread-state.json",
  "timeline-screenshot-queue.json",
  "weflow-message-ledger.json",
  "weflow-inbox-cursor.json",
  "weflow-canary-inbox-cursor.json",
  "weflow-send-source.json",
  "wechat-cli-inbox-cursor.json",
  "wechat-image-keys.json",
  "cyberboss-watchdog-canary.json",
  "cyberboss-watchdog-model-canary.json",
  "weixin-instructions.md",
];

const PORTABLE_DIRS = [
  "accounts",
  "timeline",
  "sync-buffers",
  "stickers",
  "voice-transcripts",
  "generated-images-outbound",
];

/** Inside a portable dir, these subtrees are rebuilt on the target machine. */
const PORTABLE_DIR_EXCLUDES = new Set(["timeline/shots", "timeline/site"]);

/** Regenerable bulk: reported so the operator knows what is *not* moving. */
const REGENERABLE_DIRS = [
  "models",
  "inbox",
  "outbox",
  "weflow-media-cache",
  "douyin-profile",
  "logs",
  "quarantine",
  "backups",
];

const SECRET_NAMES = [".env"];
const SECRET_PATTERNS = [/\.bak/i, /backup/i, /\.pem$/i, /\.key$/i, /credential/i, /token/i, /secret/i];

/**
 * Credential-equivalent state. `accounts/<id>-im.bot.context-tokens.json` is a
 * bearer-ish secret; it is excluded unless the operator passes
 * `--with-credentials`, and the bundle is then labelled sensitive.
 */
const CREDENTIAL_RE = /^accounts\/.*context-tokens\.json$/;

/** Files whose JSON values may embed absolute machine paths. */
const PATH_REWRITE_FILES = new Set([
  "dsh-sessions.json",
  "sessions.json",
  "thread-state.json",
  "checkin-config.json",
  "pending-inbound.json",
  "reply-obligations.json",
  "deferred-system-replies.json",
  "weflow-message-ledger.json",
  "cyberboss-watchdog-canary.json",
  "cyberboss-watchdog-model-canary.json",
]);

// ---------------------------------------------------------------- utilities

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * One spelling for every path the tool compares or substitutes: forward
 * slashes, no trailing slash, no doubled separator. The source machine writes
 * the same workspace as `D:\x`, `D:/x` and `D://x` depending on which layer
 * produced it, and a mapping keyed on one spelling silently misses the others.
 */
function normalizeSlashes(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

function resolveStateDir(explicit) {
  const raw = explicit || process.env.CYBERBOSS_STATE_DIR || "";
  if (raw) {
    return path.resolve(raw);
  }
  return path.join(os.homedir(), ".cyberboss");
}

function dirSize(dir) {
  let total = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        total += fs.statSync(full).size;
        files += 1;
      }
    }
  }
  return { bytes: total, files };
}

function isSecretRel(rel, { withCredentials = false } = {}) {
  const normalized = rel.replace(/\\/g, "/");
  const base = path.basename(normalized);
  if (SECRET_NAMES.includes(base)) {
    return true;
  }
  if (CREDENTIAL_RE.test(normalized)) {
    return !withCredentials;
  }
  return SECRET_PATTERNS.some((pattern) => pattern.test(base));
}

/**
 * The repo root of the *source* machine. `REPO_ROOT` is only right when the
 * script is executed out of the checkout that produced the state, which is not
 * true when the tool is run from a git worktree or a copied bundle.
 */
function detectRepoRootFromState(stateDir) {
  const sessionsFile = path.join(stateDir, "dsh-sessions.json");
  try {
    const text = fs.readFileSync(sessionsFile, "utf8");
    const match = text.match(/[A-Za-z]:[\\/][^"',\s]*?[\\/]user[\\/]/);
    if (match) {
      const withoutUser = match[0].replace(/[\\/]user[\\/]$/, "");
      // Keep the source machine's separator: this value is compared against and
      // substituted into Windows JSON, not resolved on disk.
      return withoutUser;
    }
  } catch {
    // fall through to the executed checkout
  }
  return REPO_ROOT;
}

function walkRelFiles(root, relDir) {
  const out = [];
  const absDir = path.join(root, relDir);
  const stack = [relDir];
  while (stack.length) {
    const rel = stack.pop();
    const abs = path.join(root, rel);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (PORTABLE_DIR_EXCLUDES.has(childRel)) {
          continue;
        }
        stack.push(childRel);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
  }
  return out;
}

/** Every collectable file, with the reason an excluded one was skipped. */
function collect(stateDir, { withCredentials = false } = {}) {
  const included = [];
  const skippedSecrets = [];
  const secretOptions = { withCredentials };

  for (const rel of PORTABLE_FILES) {
    const abs = path.join(stateDir, rel);
    if (!fs.existsSync(abs)) {
      continue;
    }
    if (isSecretRel(rel, secretOptions)) {
      skippedSecrets.push(rel);
      continue;
    }
    included.push(rel);
  }

  for (const relDir of PORTABLE_DIRS) {
    if (!fs.existsSync(path.join(stateDir, relDir))) {
      continue;
    }
    for (const rel of walkRelFiles(stateDir, relDir)) {
      if (isSecretRel(rel, secretOptions)) {
        skippedSecrets.push(rel);
        continue;
      }
      included.push(rel);
    }
  }

  included.sort();
  return { included, skippedSecrets };
}

// ------------------------------------------------------------ path sniffing

/**
 * Absolute paths that live inside the collected JSON. They are *data* on the
 * source machine, so the target machine cannot guess them; we record the
 * prefixes and their kind instead.
 */
function sniffPathPrefixes(stateDir, files) {
  const candidates = new Map();
  const add = (value, kind) => {
    // Windows paths are normalized before they are ever compared: the runtime
    // writes the same workspace both as `D:\x` and as `D:/x`, depending on which
    // layer produced it (`dsh-sessions.json` holds both spellings).
    const normalized = normalizeSlashes(value);
    if (!normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized)) {
      return;
    }
    if (normalized.split("/").length < 3) {
      return;
    }
    if (!candidates.has(normalized)) {
      candidates.set(normalized, kind);
    }
  };

  add(path.join(os.homedir(), ".cyberboss"), "state");
  add(stateDir, "state");
  add(detectRepoRootFromState(stateDir), "repo");
  add(REPO_ROOT, "repo");
  add(path.join(REPO_ROOT, "user"), "workspace");
  add(path.join(detectRepoRootFromState(stateDir), "user"), "workspace");

  const found = new Map();
  for (const rel of files) {
    if (!PATH_REWRITE_FILES.has(path.basename(rel))) {
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(path.join(stateDir, rel), "utf8");
    } catch {
      continue;
    }
    const haystack = text.replace(/\\\\/g, "/").replace(/\\/g, "/");
    for (const [prefix, kind] of candidates) {
      if (haystack.includes(prefix)) {
        found.set(prefix, { prefix, kind });
      }
    }
    // Any other drive-rooted path shaped like a workspace root.
    const matches = haystack.match(/[A-Za-z]:\/[^"',\s\]]+/g) || [];
    for (const match of matches) {
      const trimmed = match.replace(/[\])},]+$/, "").replace(/\/+$/, "");
      if (!/\/user\//i.test(trimmed)) {
        continue;
      }
      // Media paths under the workspace are per-file, not per-workspace; only
      // directory-shaped paths become hints.
      const last = trimmed.split("/").pop() || "";
      if (/\.[A-Za-z0-9]{1,5}$/.test(last)) {
        continue;
      }
      add(trimmed, "workspace");
      found.set(trimmed, { prefix: trimmed, kind: "workspace" });
    }
  }
  return [...found.values()].sort((a, b) => b.prefix.length - a.prefix.length);
}

function rewriteValue(value, mappings) {
  if (typeof value === "string") {
    let out = value;
    for (const { from, to } of mappings) {
      if (from === to) {
        continue;
      }
      out = out.split(from).join(to);
      out = out.split(from.replace(/\//g, "\\")).join(to.replace(/\//g, "\\"));
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteValue(item, mappings));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const nextKey = rewriteValue(key, mappings);
      out[nextKey] = rewriteValue(child, mappings);
    }
    return out;
  }
  return value;
}

function applyMappings(stateDir, files, mappings) {
  const changed = [];
  for (const rel of files) {
    if (!PATH_REWRITE_FILES.has(path.basename(rel))) {
      continue;
    }
    const abs = path.join(stateDir, rel);
    let raw;
    try {
      raw = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const rewritten = rewriteValue(parsed, mappings);
    const next = `${JSON.stringify(rewritten, null, 2)}\n`;
    if (next !== raw) {
      fs.writeFileSync(abs, next, "utf8");
      changed.push(rel);
    }
  }
  return changed;
}

/**
 * Turn the source machine's path hints into concrete rewrites for *this*
 * machine. Shared by `export` (which prints the plan so the operator can see
 * where their state is about to land) and `import` (which executes it).
 */
function planMappings({ hints, explicit = [], stateDir, repoRoot }) {
  const normalizedRepoRoot = normalizeSlashes(repoRoot || REPO_ROOT);
  const normalizedStateDir = normalizeSlashes(stateDir);
  const mappings = explicit.map((item) => ({ ...item, explicit: true }));
  const claimed = new Set(explicit.map((item) => item.from));
  const unmapped = [];

  for (const hint of hints || []) {
    if (claimed.has(hint.prefix)) {
      continue;
    }
    // A per-contact workspace (`<repo>/user/Unhappy`) keeps its tail: the tail
    // *is* the workspace identity, and collapsing it would silently bind every
    // contact to one directory on the target machine.
    let to = "";
    if (hint.kind === "state") {
      to = normalizedStateDir;
    } else if (hint.kind === "repo") {
      to = normalizedRepoRoot;
    } else if (hint.kind === "workspace") {
      const tail = hint.prefix.match(/[\\/]user[\\/].*$/i);
      if (tail) {
        to = `${normalizedRepoRoot}${tail[0].replace(/\\/g, "/")}`;
      } else if (/[\\/]user$/i.test(hint.prefix)) {
        to = `${normalizedRepoRoot}/user`;
      }
    }
    if (!to) {
      unmapped.push(hint);
      continue;
    }
    mappings.push({ from: hint.prefix, to, explicit: false });
  }
  mappings.sort((a, b) => b.from.length - a.from.length);
  return { mappings, unmapped };
}

// ------------------------------------------------------------------ export
function commandExport(options) {
  const stateDir = resolveStateDir(options.stateDir);
  if (!fs.existsSync(stateDir)) {
    throw new Error(`state directory does not exist: ${stateDir}`);
  }
  const to = options.to ? path.resolve(options.to) : "";
  if (!to) {
    throw new Error("--to is required");
  }
  if (fs.existsSync(to) && fs.readdirSync(to).length && !options.force) {
    throw new Error(`target directory is not empty: ${to} (pass --force to overwrite)`);
  }

  const { included, skippedSecrets } = collect(stateDir, { withCredentials: options.withCredentials });
  if (!included.length) {
    throw new Error(`nothing to export from ${stateDir}`);
  }
  const pathPrefixes = sniffPathPrefixes(stateDir, included);

  const files = [];
  let totalBytes = 0;
  for (const rel of included) {
    const abs = path.join(stateDir, rel);
    const buffer = fs.readFileSync(abs);
    const stat = fs.statSync(abs);
    const dest = path.join(to, STATE_COPY_DIR, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buffer);
    totalBytes += buffer.length;
    files.push({
      rel,
      bytes: buffer.length,
      sha256: sha256(buffer),
      mtime: new Date(stat.mtimeMs).toISOString(),
    });
  }

  const regenerable = REGENERABLE_DIRS
    .filter((relDir) => fs.existsSync(path.join(stateDir, relDir)))
    .map((relDir) => ({ rel: relDir, ...dirSize(path.join(stateDir, relDir)) }));

  const manifest = {
    schema: MANIFEST_SCHEMA,
    kind: "cyberboss-state",
    exportedAt: new Date().toISOString(),
    source: {
      host: os.hostname(),
      platform: process.platform,
      stateDir,
      repoRoot: REPO_ROOT,
      workspaceRoot: process.env.CYBERBOSS_WORKSPACE_ROOT || "",
    },
    credentialsIncluded: Boolean(options.withCredentials),
    skippedSecrets,
    pathPrefixes,
    files,
    excludedRegenerable: regenerable,
  };
  writeJsonAtomic(path.join(to, MANIFEST_NAME), manifest);

  const skippedBytes = regenerable.reduce((sum, item) => sum + item.bytes, 0);
  console.log(`exported ${files.length} file(s), ${formatBytes(totalBytes)} -> ${to}`);
  console.log(`skipped regenerable: ${formatBytes(skippedBytes)} in ${regenerable.length} dir(s)`);
  if (pathPrefixes.length) {
    // Preview the rewrite for the *current* checkout so the operator sees the
    // shape of the import ("…/user/cyberboss" keeps its tail) before shipping
    // the bundle to the other machine.
    const preview = planMappings({ hints: pathPrefixes, stateDir, repoRoot: detectRepoRootFromState(stateDir) });
    console.log("path prefixes recorded (source -> target on this checkout):");
    for (const mapping of preview.mappings) {
      console.log(`  [${mapping.explicit ? "map" : "auto"}] ${mapping.from} -> ${mapping.to}`);
    }
    for (const hint of preview.unmapped) {
      console.log(`  [MANUAL] ${hint.prefix} has no inferable target — pass --map on import`);
    }
  }
  if (skippedSecrets.length) {
    console.log(`never exported (${skippedSecrets.length}): ${skippedSecrets.slice(0, 6).join(", ")}${skippedSecrets.length > 6 ? ", …" : ""}`);
  }
  console.log("");
  if (options.withCredentials) {
    console.log("!! SENSITIVE BUNDLE: this export contains a live context_token for the official");
    console.log("!! channel. Move it over an encrypted medium and delete it once the new machine");
    console.log("!! is green. Never commit it, never put it in a shared drive.");
    console.log("");
  }
  console.log("NOT included and not reproducible from this export:");
  console.log("  - .env            (CYBERBOSS_WEFLOW_TOKEN and machine paths) -> move by hand");
  console.log("  - ~/.dsh, ~/.codex, ~/.claude profiles, WeChat login state, WeFlow library");
  return 0;
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function loadManifest(from) {
  const manifestPath = path.join(from, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`not a migration bundle (no ${MANIFEST_NAME}): ${from}`);
  }
  const manifest = readJson(manifestPath);
  if (manifest.kind !== "cyberboss-state") {
    throw new Error(`unexpected bundle kind: ${manifest.kind}`);
  }
  if (manifest.schema !== MANIFEST_SCHEMA) {
    throw new Error(`unsupported manifest schema ${manifest.schema} (this tool speaks ${MANIFEST_SCHEMA})`);
  }
  return manifest;
}

// ------------------------------------------------------------------ verify

function commandVerify(from) {
  const manifest = loadManifest(from);
  const problems = [];
  for (const entry of manifest.files) {
    const abs = path.join(from, STATE_COPY_DIR, entry.rel);
    if (!fs.existsSync(abs)) {
      problems.push(`missing: ${entry.rel}`);
      continue;
    }
    const buffer = fs.readFileSync(abs);
    if (buffer.length !== entry.bytes) {
      problems.push(`size mismatch: ${entry.rel} (${buffer.length} != ${entry.bytes})`);
      continue;
    }
    if (sha256(buffer) !== entry.sha256) {
      problems.push(`sha256 mismatch: ${entry.rel}`);
    }
  }
  const ageMinutes = Math.round((Date.now() - Date.parse(manifest.exportedAt)) / 60000);
  console.log(`bundle: ${from}`);
  console.log(`exported: ${manifest.exportedAt} (${ageMinutes} minute(s) ago) on ${manifest.source.host}`);
  console.log(`files: ${manifest.files.length}, ${formatBytes(manifest.files.reduce((sum, f) => sum + f.bytes, 0))}`);
  if (problems.length) {
    for (const problem of problems) {
      console.error(`FAIL ${problem}`);
    }
    console.error(`verify failed: ${problems.length} problem(s)`);
    return 1;
  }
  console.log("verify ok: every file matches the manifest");
  if (ageMinutes > 30) {
    console.log(`WARNING the bundle is ${ageMinutes} minutes old — the live bot has moved on since;`);
    console.log("        plan a maintenance window instead of importing a stale snapshot.");
  }
  return 0;
}

// ------------------------------------------------------------------ import

function parseMapFlags(pairs) {
  return pairs.map((pair) => {
    const index = pair.indexOf("=");
    if (index <= 0) {
      throw new Error(`--map expects old=new, got: ${pair}`);
    }
    const from = pair.slice(0, index).replace(/\\/g, "/").replace(/\/+$/, "");
    const to = pair.slice(index + 1).replace(/\\/g, "/").replace(/\/+$/, "");
    return { from, to, explicit: true };
  });
}

function commandImport(options) {
  const from = options.from ? path.resolve(options.from) : "";
  if (!from) {
    throw new Error("--from is required");
  }
  const manifest = loadManifest(from);
  const stateDir = resolveStateDir(options.stateDir);
  const problemCount = commandVerify(from);
  if (problemCount !== 0) {
    throw new Error("bundle failed verification; refusing to import");
  }

  const explicit = parseMapFlags(options.map || []);
  const { mappings, unmapped } = planMappings({
    hints: manifest.pathPrefixes,
    explicit,
    stateDir,
    repoRoot: options.repoRoot || REPO_ROOT,
  });
  if (unmapped.length) {
    for (const hint of unmapped) {
      console.error(`FAIL nothing to map [${hint.kind}] ${hint.prefix} to`);
    }
    throw new Error("pass --map old=new for every prefix listed above");
  }

  let copied = 0;
  for (const entry of manifest.files) {
    const src = path.join(from, STATE_COPY_DIR, entry.rel);
    const dest = path.join(stateDir, entry.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest) && !options.force) {
      const existing = fs.readFileSync(dest);
      if (sha256(existing) !== entry.sha256) {
        throw new Error(`refusing to overwrite ${dest} (differs from bundle; pass --force)`);
      }
    }
    fs.copyFileSync(src, dest);
    copied += 1;
  }

  const changed = applyMappings(stateDir, manifest.files.map((entry) => entry.rel), mappings);
  console.log(`imported ${copied} file(s) into ${stateDir}`);
  console.log("path rewrites:");
  for (const mapping of mappings) {
    console.log(`  ${mapping.explicit ? "(explicit)" : "(auto)"} ${mapping.from} -> ${mapping.to}`);
  }
  console.log(changed.length ? `rewritten: ${changed.join(", ")}` : "rewritten: (nothing needed a rewrite)");
  console.log("next: restore .env by hand, then `npm run doctor`");
  return 0;
}

// -------------------------------------------------------------------- list

function commandList(options) {
  const stateDir = resolveStateDir(options.stateDir);
  if (!fs.existsSync(stateDir)) {
    throw new Error(`state directory does not exist: ${stateDir}`);
  }
  const { included, skippedSecrets } = collect(stateDir, { withCredentials: options.withCredentials });
  let bytes = 0;
  for (const rel of included) {
    bytes += fs.statSync(path.join(stateDir, rel)).size;
  }
  console.log(`state dir: ${stateDir}`);
  console.log(`portable: ${included.length} file(s), ${formatBytes(bytes)}`);
  const regenerable = REGENERABLE_DIRS
    .filter((relDir) => fs.existsSync(path.join(stateDir, relDir)))
    .map((relDir) => ({ rel: relDir, ...dirSize(path.join(stateDir, relDir)) }));
  for (const item of regenerable) {
    console.log(`  skip ${item.rel}/ (${formatBytes(item.bytes)}, ${item.files} file(s))`);
  }
  if (skippedSecrets.length) {
    console.log(`  never: ${skippedSecrets.join(", ")}`);
  }
  const prefixes = sniffPathPrefixes(stateDir, included);
  for (const item of prefixes) {
    console.log(`  path [${item.kind}] ${item.prefix}`);
  }
  return 0;
}

// --------------------------------------------------------------------- cli

function parseArgs(argv) {
  const options = { map: [] };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--to") {
      options.to = argv[++index];
    } else if (token === "--from") {
      options.from = argv[++index];
    } else if (token === "--state-dir") {
      options.stateDir = argv[++index];
    } else if (token === "--repo-root") {
      options.repoRoot = argv[++index];
    } else if (token === "--map") {
      options.map.push(argv[++index]);
    } else if (token === "--force") {
      options.force = true;
    } else if (token === "--with-credentials") {
      options.withCredentials = true;
    } else if (token === "--help" || token === "-h") {
      options.help = true;
    } else if (token.startsWith("--")) {
      throw new Error(`unknown flag: ${token}`);
    } else {
      positionals.push(token);
    }
  }
  options.positionals = positionals;
  return options;
}

const HELP = `cyberboss state migration

  node scripts/migrate.js list   [--state-dir DIR]
  node scripts/migrate.js export --to DIR [--state-dir DIR] [--with-credentials] [--force]
  node scripts/migrate.js verify DIR
  node scripts/migrate.js import --from DIR [--state-dir DIR] [--repo-root DIR] [--map old=new]... [--force]

Exports only unreproducible state; never .env, never caches.

  --with-credentials  also copy accounts/*context-tokens.json. The resulting
                      bundle carries a live bearer token for the official
                      channel: treat it as a secret, never as a file to share.`;

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] || "";
  const options = parseArgs(argv.slice(1));
  if (options.help || !command) {
    console.log(HELP);
    return 0;
  }
  if (command === "list") {
    return commandList(options);
  }
  if (command === "export") {
    return commandExport(options);
  }
  if (command === "verify") {
    const target = options.positionals[0] || options.from;
    if (!target) {
      throw new Error("verify needs a bundle directory");
    }
    return commandVerify(path.resolve(target));
  }
  if (command === "import") {
    return commandImport(options);
  }
  throw new Error(`unknown command: ${command}`);
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[migrate] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

module.exports = {
  PORTABLE_FILES,
  PORTABLE_DIRS,
  REGENERABLE_DIRS,
  PATH_REWRITE_FILES,
  collect,
  sniffPathPrefixes,
  planMappings,
  rewriteValue,
  resolveStateDir,
  detectRepoRootFromState,
};
