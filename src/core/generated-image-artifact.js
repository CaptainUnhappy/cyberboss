const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_FILES = 1_000;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

function extractGeneratedImageArtifacts(response, { turnId = "" } = {}) {
  const result = response?.result && typeof response.result === "object" ? response.result : response;
  const thread = result?.thread && typeof result.thread === "object" ? result.thread : result;
  let turns = Array.isArray(thread?.turns)
    ? thread.turns
    : Array.isArray(result?.turns)
      ? result.turns
      : [];
  const normalizedTurnId = normalizeText(turnId);
  if (!turns.length && Array.isArray(result?.data)) {
    const listedItems = result.data
      .filter((entry) => !normalizedTurnId
        || normalizeText(entry?.turnId ?? entry?.turn_id) === normalizedTurnId)
      .map((entry) => entry?.item || entry)
      .filter((item) => item && typeof item === "object");
    turns = [{ id: normalizedTurnId, items: listedItems }];
  }
  const selectedTurns = normalizedTurnId
    ? turns.filter((turn) => normalizeText(turn?.id ?? turn?.turnId ?? turn?.turn_id) === normalizedTurnId)
    : turns.slice(-1);
  const artifacts = [];
  const seen = new Set();
  for (const turn of selectedTurns) {
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      if (!isCompletedImageGenerationItem(item)) {
        continue;
      }
      const itemId = normalizeText(item?.id ?? item?.itemId ?? item?.callId ?? item?.call_id);
      const savedPath = normalizeText(item?.savedPath ?? item?.saved_path);
      const resultData = typeof item?.result === "string" ? item.result : "";
      if (!savedPath && !resultData) {
        continue;
      }
      const identity = itemId || crypto.createHash("sha256")
        .update(`${savedPath}\n${resultData.slice(0, 256)}`, "utf8")
        .digest("hex");
      if (seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      artifacts.push({
        itemId: itemId || identity,
        savedPath,
        result: resultData,
        revisedPrompt: normalizeText(item?.revisedPrompt ?? item?.revised_prompt),
      });
    }
  }
  return artifacts;
}

function materializeGeneratedImageArtifact(artifact, {
  outputDir,
  threadId = "",
  turnId = "",
  maxBytes = DEFAULT_MAX_IMAGE_BYTES,
  allowedSourceRoots = [],
} = {}) {
  const normalizedOutputDir = normalizeText(outputDir);
  if (!normalizedOutputDir) {
    throw new Error("generated image outputDir is required");
  }
  const byteLimit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
    ? Math.floor(Number(maxBytes))
    : DEFAULT_MAX_IMAGE_BYTES;
  const bytes = readArtifactBytes(artifact, byteLimit, allowedSourceRoots);
  if (bytes.length > byteLimit) {
    throw new Error(`generated image exceeds ${byteLimit} bytes`);
  }
  if (!hasPngSignature(bytes)) {
    throw new Error("generated image is not a PNG file");
  }

  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const identityDigest = crypto.createHash("sha256").update([
    normalizeText(threadId),
    normalizeText(turnId),
    normalizeText(artifact?.itemId),
    digest,
  ].join("\n"), "utf8").digest("hex");
  const absoluteOutputDir = path.resolve(normalizedOutputDir);
  const filePath = path.join(absoluteOutputDir, `${identityDigest}.png`);
  fs.mkdirSync(absoluteOutputDir, { recursive: true });
  pruneManagedGeneratedImages(absoluteOutputDir, { excludePath: filePath });
  if (!fs.existsSync(filePath)) {
    atomicWriteFile(filePath, bytes);
  } else {
    const existing = fs.readFileSync(filePath);
    const existingDigest = crypto.createHash("sha256").update(existing).digest("hex");
    if (existingDigest !== digest) {
      throw new Error("generated image artifact path has conflicting content");
    }
  }
  return {
    itemId: normalizeText(artifact?.itemId) || identityDigest,
    filePath,
    sha256: digest,
    byteLength: bytes.length,
    idempotencyKey: `generated-image:${identityDigest}`,
  };
}

function pruneManagedGeneratedImages(outputDir, {
  excludePath = "",
  nowMs = Date.now(),
  retentionMs = DEFAULT_RETENTION_MS,
  maxFiles = DEFAULT_MAX_FILES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
} = {}) {
  const root = path.resolve(outputDir);
  const excluded = excludePath ? path.resolve(excludePath) : "";
  const entries = [];
  for (const name of fs.readdirSync(root)) {
    const candidate = path.join(root, name);
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch {
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    if (name.includes(".tmp-") && nowMs - stat.mtimeMs > 60 * 60_000) {
      try { fs.unlinkSync(candidate); } catch {}
      continue;
    }
    if (!name.toLowerCase().endsWith(".png")) {
      continue;
    }
    entries.push({ path: candidate, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  entries.sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path));
  let retainedFiles = 0;
  let retainedBytes = 0;
  for (const entry of entries) {
    const isExcluded = excluded && path.resolve(entry.path) === excluded;
    const keep = isExcluded || (
      nowMs - entry.mtimeMs <= retentionMs
      && retainedFiles < maxFiles
      && retainedBytes + entry.size <= maxTotalBytes
    );
    if (keep) {
      retainedFiles += 1;
      retainedBytes += entry.size;
      continue;
    }
    try { fs.unlinkSync(entry.path); } catch {}
  }
}

function isCompletedImageGenerationItem(item) {
  if (!item || typeof item !== "object") {
    return false;
  }
  const type = normalizeText(item.type).toLowerCase().replace(/[_-]/g, "");
  if (type !== "imagegeneration") {
    return false;
  }
  const status = normalizeText(item.status).toLowerCase();
  return !status || status === "completed" || status === "success" || status === "succeeded";
}

function readArtifactBytes(artifact, byteLimit, allowedSourceRoots) {
  const savedPath = normalizeText(artifact?.savedPath ?? artifact?.saved_path);
  if (savedPath) {
    const absolutePath = path.resolve(savedPath);
    const roots = (Array.isArray(allowedSourceRoots) ? allowedSourceRoots : [])
      .map((root) => normalizeText(root))
      .filter(Boolean)
      .map((root) => path.resolve(root));
    if (!roots.length || !roots.some((root) => isPathWithinRoot(absolutePath, root))) {
      throw new Error("generated image savedPath is outside the managed source root");
    }
    const realPath = fs.realpathSync(absolutePath);
    const realRoots = roots.map((root) => {
      try {
        return fs.realpathSync(root);
      } catch {
        return root;
      }
    });
    if (!realRoots.some((root) => isPathWithinRoot(realPath, root))) {
      throw new Error("generated image savedPath resolves outside the managed source root");
    }
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) {
      throw new Error("generated image savedPath is not a file");
    }
    if (stat.size > byteLimit) {
      throw new Error(`generated image exceeds ${byteLimit} bytes`);
    }
    return fs.readFileSync(realPath);
  }

  const source = typeof artifact?.result === "string" ? artifact.result.trim() : "";
  if (!source) {
    throw new Error("generated image has no savedPath or result bytes");
  }
  const match = source.match(/^data:image\/png;base64,([a-z0-9+/=\s]+)$/iu);
  const encoded = (match ? match[1] : source).replace(/\s+/g, "");
  if (!encoded || !/^[a-z0-9+/]+={0,2}$/iu.test(encoded) || encoded.length % 4 === 1) {
    throw new Error("generated image result is not valid base64");
  }
  const estimatedBytes = Math.floor(encoded.length * 3 / 4);
  if (estimatedBytes > byteLimit + 2) {
    throw new Error(`generated image exceeds ${byteLimit} bytes`);
  }
  return Buffer.from(encoded, "base64");
}

function isPathWithinRoot(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hasPngSignature(bytes) {
  return Buffer.isBuffer(bytes)
    && bytes.length >= PNG_SIGNATURE.length
    && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function atomicWriteFile(filePath, bytes) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const handle = fs.openSync(temporaryPath, "wx");
  try {
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {}
    if (!fs.existsSync(filePath)) {
      throw error;
    }
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  DEFAULT_MAX_IMAGE_BYTES,
  extractGeneratedImageArtifacts,
  materializeGeneratedImageArtifact,
  pruneManagedGeneratedImages,
};
