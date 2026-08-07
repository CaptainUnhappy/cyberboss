const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const { promisify } = require("util");

const execFile = promisify(childProcess.execFile);
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_HISTORY_LIMIT = 100;
const DEFAULT_REPLAY_LIMIT = 20;
const MAX_SEEN_IDS = 2_000;
const IMAGE_KEY_SCAN_RETRY_MS = 60_000;
const imageKeyScanAttempts = new Map();

class WechatCliInboxSource {
  constructor({
    config,
    onMessage,
    isReady = () => true,
    reader = readWechatCliSnapshot,
    logger = console,
  }) {
    this.config = config || {};
    this.onMessage = typeof onMessage === "function" ? onMessage : async () => true;
    this.isReady = typeof isReady === "function" ? isReady : () => true;
    this.reader = reader;
    this.logger = logger;
    this.state = loadCursorState(this.config.wechatCliInboxCursorFile);
    this.running = false;
    this.timer = null;
    this.inFlight = null;
  }

  async start() {
    if (this.running) {
      return;
    }
    this.running = true;
    await this.runCycle();
    this.scheduleNext();
  }

  async stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await Promise.resolve(this.inFlight).catch(() => {});
  }

  scheduleNext() {
    if (!this.running) {
      return;
    }
    const intervalMs = normalizePositiveInt(
      this.config.wechatCliInboxPollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
      1_000
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = this.runCycle().finally(() => {
        this.inFlight = null;
        this.scheduleNext();
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  async runCycle() {
    try {
      return await this.pollOnce();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "unknown error");
      this.logger.error?.(`[cyberboss] wechat-cli inbox poll failed: ${message}`);
      return { status: "error", processed: 0, error: message };
    }
  }

  async pollOnce() {
    if (!await this.isReady()) {
      return { status: "waiting_for_reply_target", processed: 0 };
    }

    const snapshot = normalizeSnapshot(await this.reader(this.config));
    const seen = new Set(this.state.seenIds);
    const firstSnapshot = !this.state.initialized;
    const replayEnabled = firstSnapshot && Boolean(this.config.wechatCliInboxReplayOnStart);
    const replayLimit = normalizePositiveInt(
      this.config.wechatCliInboxReplayLimit,
      DEFAULT_REPLAY_LIMIT,
      1
    );
    const incomingUnseen = snapshot.messages.filter((message) => (
      message.direction === "incoming" && !seen.has(message.id)
    ));
    const replayIds = replayEnabled
      ? new Set(incomingUnseen.slice(-replayLimit).map((message) => message.id))
      : new Set();
    let processed = 0;

    for (const message of snapshot.messages) {
      if (seen.has(message.id)) {
        continue;
      }
      const shouldDispatch = message.direction === "incoming"
        && (!firstSnapshot || replayIds.has(message.id));
      if (shouldDispatch) {
        const accepted = await this.onMessage(message, snapshot);
        if (accepted === false) {
          await this.saveState();
          return { status: "deferred", processed };
        }
        processed += 1;
      }
      this.rememberSeen(message.id);
      seen.add(message.id);
      await this.saveState();
    }

    if (!this.state.initialized) {
      this.state.initialized = true;
      await this.saveState();
    }
    this.state.lastPollAt = new Date().toISOString();
    this.state.chatUsername = snapshot.chatUsername;
    await this.saveState();
    return {
      status: firstSnapshot && !replayEnabled ? "baselined" : "ok",
      processed,
      failures: snapshot.failures.length,
    };
  }

  rememberSeen(messageId) {
    const normalized = normalizeText(messageId);
    if (!normalized) {
      return;
    }
    this.state.seenIds = this.state.seenIds.filter((item) => item !== normalized);
    this.state.seenIds.push(normalized);
    if (this.state.seenIds.length > MAX_SEEN_IDS) {
      this.state.seenIds = this.state.seenIds.slice(-MAX_SEEN_IDS);
    }
  }

  async saveState() {
    const filePath = normalizeText(this.config.wechatCliInboxCursorFile);
    if (!filePath) {
      return;
    }
    await writeJsonAtomic(filePath, this.state);
  }
}

async function readWechatCliSnapshot(config = {}) {
  const pythonCommand = normalizeText(config.wechatCliPythonCommand) || "python";
  const scriptPath = normalizeText(config.wechatCliInboxReaderScript)
    || path.resolve(__dirname, "..", "..", "scripts", "wechat-cli-inbox-read.py");
  const wechatCliRoot = normalizeText(config.wechatCliRoot);
  const chat = normalizeText(config.wechatCliInboxChat);
  if (!wechatCliRoot) {
    throw new Error("CYBERBOSS_WECHAT_CLI_ROOT is required");
  }
  if (!chat) {
    throw new Error("CYBERBOSS_WECHAT_CLI_INBOX_CHAT is required");
  }

  const args = [
    scriptPath,
    "--wechat-cli-root", wechatCliRoot,
    "--chat", chat,
    "--limit", String(normalizePositiveInt(
      config.wechatCliInboxHistoryLimit,
      DEFAULT_HISTORY_LIMIT,
      1
    )),
  ];
  const configFile = normalizeText(config.wechatCliConfigFile);
  if (configFile) {
    args.push("--config", configFile);
  }
  const { stdout } = await execFile(pythonCommand, args, {
    cwd: wechatCliRoot,
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  });
  return JSON.parse(String(stdout || "").trim());
}

async function persistLocalWechatAttachments({
  attachments,
  stateDir,
  messageId = "",
  receivedAt = "",
  config = {},
}) {
  const saved = [];
  const failed = [];
  const imageKeys = await resolveWechatImageKeys(attachments, config);
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    try {
      saved.push(await persistLocalWechatAttachment({
        attachment,
        stateDir,
        messageId,
        receivedAt,
        imageKeys,
      }));
    } catch (error) {
      failed.push({
        kind: normalizeAttachmentKind(attachment?.kind),
        origin: normalizeAttachmentOrigin(attachment?.origin),
        attachmentRef: normalizeText(attachment?.attachmentRef),
        sourceFileName: normalizeText(attachment?.fileName),
        reason: error instanceof Error ? error.message : String(error || "local attachment error"),
      });
    }
  }
  return { saved, failed };
}

async function persistLocalWechatAttachment({ attachment, stateDir, messageId, receivedAt, imageKeys }) {
  const sourcePath = path.resolve(normalizeText(attachment?.path));
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error("local WeChat attachment path does not exist");
  }
  const stats = await fsPromises.stat(sourcePath);
  if (!stats.isFile()) {
    throw new Error("local WeChat attachment path is not a file");
  }

  const sourceBytes = await fsPromises.readFile(sourcePath);
  const decoded = decodeWechatDatImage(sourceBytes, path.extname(sourcePath), imageKeys);
  const media = detectMedia(decoded.bytes);
  if (path.extname(sourcePath).toLowerCase() === ".dat" && !decoded.decoded && attachment?.kind === "image") {
    throw new Error("local WeChat image is still encoded as .dat");
  }

  const targetDir = path.join(
    stateDir,
    "inbox",
    normalizeDateFolder(receivedAt)
  );
  const preferredName = normalizeText(attachment?.fileName) || path.basename(sourcePath);
  const fileName = buildLocalTargetFileName({
    preferredName,
    messageId,
    extension: media.extension || decoded.extension || path.extname(sourcePath),
  });
  const absolutePath = await writeUniqueFile(targetDir, fileName, decoded.bytes);
  const kind = normalizeAttachmentKind(attachment?.kind);
  const isImage = media.contentType.startsWith("image/");
  return {
    kind,
    origin: normalizeAttachmentOrigin(attachment?.origin),
    quoteIndex: null,
    attachmentRef: normalizeText(attachment?.attachmentRef),
    contentType: media.contentType,
    isImage,
    sourceFileName: preferredName,
    fileName: path.basename(absolutePath),
    absolutePath,
    relativePath: path.relative(stateDir, absolutePath).replace(/\\/g, "/"),
    sizeBytes: decoded.bytes.length,
  };
}

async function resolveWechatImageKeys(attachments, config = {}) {
  let keys = loadWechatImageKeys(config);
  if (keys.aesKey || config.wechatCliAutoImageKey === false) {
    return keys;
  }
  const v2Sample = (Array.isArray(attachments) ? attachments : [])
    .map((attachment) => normalizeText(attachment?.path))
    .find((filePath) => isWechatV2ImageFile(filePath));
  if (!v2Sample) {
    return keys;
  }

  const keyFile = normalizeText(config.wechatCliImageKeyFile);
  const scannerScript = normalizeText(config.wechatCliImageKeyScannerScript);
  const wechatCliRoot = normalizeText(config.wechatCliRoot);
  const lastAttemptAt = imageKeyScanAttempts.get(keyFile) || 0;
  if (!keyFile || !scannerScript || !wechatCliRoot || Date.now() - lastAttemptAt < IMAGE_KEY_SCAN_RETRY_MS) {
    return keys;
  }
  imageKeyScanAttempts.set(keyFile, Date.now());
  try {
    await execFile(normalizeText(config.wechatCliPythonCommand) || "python", [
      scannerScript,
      "--wechat-cli-root", wechatCliRoot,
      "--dat", v2Sample,
      "--output", keyFile,
    ], {
      cwd: wechatCliRoot,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
    });
    keys = loadWechatImageKeys(config);
  } catch {
    // The attachment will carry a precise missing-key error below.
  }
  return keys;
}

function loadWechatImageKeys(config = {}) {
  const fromConfig = {
    aesKey: normalizeText(config.wechatCliImageAesKey),
    xorKey: normalizeXorKey(config.wechatCliImageXorKey),
  };
  if (fromConfig.aesKey) {
    return fromConfig;
  }
  const keyFile = normalizeText(config.wechatCliImageKeyFile);
  if (!keyFile) {
    return fromConfig;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    return {
      aesKey: normalizeText(parsed?.aesKey),
      xorKey: normalizeXorKey(parsed?.xorKey),
    };
  } catch {
    return fromConfig;
  }
}

function isWechatV2ImageFile(filePath) {
  const normalized = normalizeText(filePath);
  if (!normalized || path.extname(normalized).toLowerCase() !== ".dat") {
    return false;
  }
  try {
    const handle = fs.openSync(normalized, "r");
    try {
      const header = Buffer.alloc(6);
      const bytesRead = fs.readSync(handle, header, 0, header.length, 0);
      return bytesRead === header.length && header.equals(Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]));
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return false;
  }
}

function normalizeSnapshot(value) {
  const raw = value && typeof value === "object" ? value : {};
  const messages = (Array.isArray(raw.messages) ? raw.messages : [])
    .map(normalizeSnapshotMessage)
    .filter(Boolean)
    .sort((left, right) => (
      left.timestamp - right.timestamp
      || left.localId - right.localId
      || left.id.localeCompare(right.id)
    ));
  return {
    chat: normalizeText(raw.chat),
    chatUsername: normalizeText(raw.chatUsername),
    messages,
    failures: Array.isArray(raw.failures)
      ? raw.failures.map((item) => normalizeText(item)).filter(Boolean)
      : [],
  };
}

function normalizeSnapshotMessage(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const id = normalizeText(value.id);
  if (!id) {
    return null;
  }
  return {
    id,
    localId: normalizeNonNegativeInt(value.localId),
    timestamp: normalizeNonNegativeInt(value.timestamp),
    receivedAt: normalizeText(value.receivedAt),
    direction: normalizeText(value.direction).toLowerCase() === "incoming" ? "incoming" : "outgoing",
    kind: normalizeAttachmentKind(value.kind),
    title: collapseText(value.title, 500),
    text: collapseText(value.text, 8_000, { preserveNewlines: true }),
    url: normalizeUrl(value.url),
    quotedContexts: normalizeQuotedContexts(value.quotedContexts),
    attachments: normalizeLocalAttachments(value.attachments),
  };
}

function normalizeQuotedContexts(value) {
  return (Array.isArray(value) ? value : [])
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      kind: normalizeAttachmentKind(item.kind),
      title: collapseText(item.title, 500),
      text: collapseText(item.text, 4_000),
      url: normalizeUrl(item.url),
      attachmentRefs: Array.isArray(item.attachmentRefs)
        ? [...new Set(item.attachmentRefs.map((entry) => normalizeText(entry)).filter(Boolean))]
        : [],
    }));
}

function normalizeLocalAttachments(value) {
  return (Array.isArray(value) ? value : [])
    .filter((item) => item && typeof item === "object" && normalizeText(item.path))
    .map((item) => ({
      kind: normalizeAttachmentKind(item.kind),
      path: path.resolve(normalizeText(item.path)),
      fileName: path.basename(normalizeText(item.fileName) || normalizeText(item.path)),
      origin: normalizeAttachmentOrigin(item.origin),
      attachmentRef: normalizeText(item.attachmentRef),
    }));
}

function loadCursorState(filePath) {
  const empty = {
    version: 1,
    initialized: false,
    seenIds: [],
    lastPollAt: "",
    chatUsername: "",
  };
  const normalizedPath = normalizeText(filePath);
  if (!normalizedPath) {
    return empty;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(normalizedPath, "utf8"));
    return {
      ...empty,
      initialized: Boolean(parsed?.initialized),
      seenIds: Array.isArray(parsed?.seenIds)
        ? parsed.seenIds.map((item) => normalizeText(item)).filter(Boolean).slice(-MAX_SEEN_IDS)
        : [],
      lastPollAt: normalizeText(parsed?.lastPollAt),
      chatUsername: normalizeText(parsed?.chatUsername),
    };
  } catch {
    return empty;
  }
}

async function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  await fsPromises.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fsPromises.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsPromises.rename(tempPath, filePath);
}

function decodeWechatDatImage(bytes, extension, imageKeys = {}) {
  if (!Buffer.isBuffer(bytes) || extension.toLowerCase() !== ".dat" || bytes.length < 4) {
    return { bytes, decoded: false, extension: "" };
  }
  if (bytes.length >= 15
    && bytes[0] === 0x07
    && bytes[1] === 0x08
    && bytes[2] === 0x56
    && (bytes[3] === 0x31 || bytes[3] === 0x32)
    && bytes[4] === 0x08
    && bytes[5] === 0x07) {
    return decodeWechatV4Image(bytes, imageKeys);
  }
  const signatures = [
    { bytes: Buffer.from([0xFF, 0xD8, 0xFF]), extension: ".jpg" },
    { bytes: Buffer.from([0x89, 0x50, 0x4E, 0x47]), extension: ".png" },
    { bytes: Buffer.from("GIF8", "ascii"), extension: ".gif" },
  ];
  for (const signature of signatures) {
    const key = bytes[0] ^ signature.bytes[0];
    const matches = signature.bytes.every((value, index) => ((bytes[index] ^ key) === value));
    if (!matches) {
      continue;
    }
    const decoded = Buffer.allocUnsafe(bytes.length);
    for (let index = 0; index < bytes.length; index += 1) {
      decoded[index] = bytes[index] ^ key;
    }
    return { bytes: decoded, decoded: true, extension: signature.extension };
  }
  return { bytes, decoded: false, extension: ".dat" };
}

function decodeWechatV4Image(bytes, imageKeys) {
  const version = bytes[3];
  const aesSize = bytes.readUInt32LE(6);
  const xorSize = bytes.readUInt32LE(10);
  const encryptedSize = (Math.floor(aesSize / 16) + 1) * 16;
  const encryptedStart = 15;
  const xorStart = encryptedStart + encryptedSize;
  const xorEnd = xorStart + xorSize;
  if (aesSize <= 0 || xorSize < 0 || xorEnd > bytes.length) {
    throw new Error("local WeChat image has an invalid V4 layout");
  }

  const keyCandidates = version === 0x31
    ? [Buffer.from("cfcd208495d565ef", "utf8")]
    : buildWechatImageAesKeyCandidates(imageKeys?.aesKey);
  if (!keyCandidates.length) {
    throw new Error("local WeChat V2 image key is unavailable");
  }

  let aesPlain = null;
  for (const key of keyCandidates) {
    try {
      const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
      decipher.setAutoPadding(true);
      const candidate = Buffer.concat([
        decipher.update(bytes.subarray(encryptedStart, xorStart)),
        decipher.final(),
      ]);
      if (detectMedia(candidate).contentType.startsWith("image/")
        || candidate.subarray(0, 4).toString("ascii") === "wxgf") {
        aesPlain = candidate;
        break;
      }
    } catch {
      // Try the next supported key encoding.
    }
  }
  if (!aesPlain) {
    throw new Error("local WeChat V2 image key did not decrypt the image header");
  }

  const xorKey = Number.isInteger(imageKeys?.xorKey)
    ? imageKeys.xorKey
    : inferWechatV4XorKey(bytes.subarray(xorStart, xorEnd));
  const encryptedTail = bytes.subarray(xorStart, xorEnd);
  const xorPlain = Buffer.allocUnsafe(encryptedTail.length);
  for (let index = 0; index < encryptedTail.length; index += 1) {
    xorPlain[index] = encryptedTail[index] ^ xorKey;
  }
  const decoded = Buffer.concat([aesPlain, xorPlain, bytes.subarray(xorEnd)]);
  const media = detectMedia(decoded);
  const extension = media.extension
    || (decoded.subarray(0, 4).toString("ascii") === "wxgf" ? ".hevc" : ".bin");
  return { bytes: decoded, decoded: true, extension };
}

function buildWechatImageAesKeyCandidates(value) {
  const normalized = normalizeText(value);
  const candidates = [];
  if (Buffer.byteLength(normalized, "utf8") >= 16) {
    candidates.push(Buffer.from(normalized.slice(0, 16), "utf8"));
  }
  if (/^[0-9a-f]{32}$/i.test(normalized)) {
    candidates.push(Buffer.from(normalized, "hex"));
  }
  return candidates.filter((candidate, index) => (
    candidate.length === 16
    && candidates.findIndex((entry) => entry.equals(candidate)) === index
  ));
}

function inferWechatV4XorKey(encryptedTail) {
  const signatures = [
    Buffer.from([0xFF, 0xD9]),
    Buffer.from([0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]),
    Buffer.from([0x3B]),
  ];
  for (const signature of signatures) {
    if (encryptedTail.length < signature.length) {
      continue;
    }
    const slice = encryptedTail.subarray(encryptedTail.length - signature.length);
    const key = slice[0] ^ signature[0];
    if (signature.every((value, index) => ((slice[index] ^ key) === value))) {
      return key;
    }
  }
  return 0x88;
}

function detectMedia(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    return { extension: "", contentType: "application/octet-stream" };
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
    return { extension: ".png", contentType: "image/png" };
  }
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xFF, 0xD8, 0xFF]))) {
    return { extension: ".jpg", contentType: "image/jpeg" };
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "GIF8") {
    return { extension: ".gif", contentType: "image/gif" };
  }
  if (bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WAVE") {
    return { extension: ".wav", contentType: "audio/wav" };
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "fLaC") {
    return { extension: ".flac", contentType: "audio/flac" };
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "OggS") {
    return { extension: ".ogg", contentType: "audio/ogg" };
  }
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString("ascii") === "ID3") {
    return { extension: ".mp3", contentType: "audio/mpeg" };
  }
  if (bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return { extension: ".webp", contentType: "image/webp" };
  }
  if (bytes.length >= 8 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    return { extension: ".mp4", contentType: "video/mp4" };
  }
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
    return { extension: ".pdf", contentType: "application/pdf" };
  }
  return { extension: "", contentType: "application/octet-stream" };
}

function buildLocalTargetFileName({ preferredName, messageId, extension }) {
  const parsed = path.parse(sanitizeFileName(preferredName));
  const normalizedExtension = normalizeExtension(extension);
  const baseName = parsed.name || sanitizeFileName(messageId) || "wechat-attachment";
  const existingExtension = normalizeExtension(parsed.ext);
  return `${baseName.slice(0, 120)}${normalizedExtension || existingExtension || ".bin"}`;
}

async function writeUniqueFile(targetDir, fileName, bytes) {
  await fsPromises.mkdir(targetDir, { recursive: true });
  const parsed = path.parse(fileName);
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const candidate = path.join(targetDir, `${parsed.name || "attachment"}${suffix}${parsed.ext}`);
    try {
      await fsPromises.writeFile(candidate, bytes, { flag: "wx" });
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
  }
  throw new Error("could not allocate a local WeChat inbox file name");
}

function normalizeDateFolder(receivedAt) {
  const date = receivedAt ? new Date(receivedAt) : new Date();
  return Number.isNaN(date.getTime())
    ? new Date().toISOString().slice(0, 10)
    : date.toISOString().slice(0, 10);
}

function normalizeAttachmentKind(value) {
  const normalized = normalizeText(value).toLowerCase();
  return ["text", "image", "voice", "video", "file", "link", "unknown"].includes(normalized)
    ? normalized
    : "unknown";
}

function normalizeAttachmentOrigin(value) {
  return normalizeText(value).toLowerCase() === "quoted" ? "quoted" : "direct";
}

function collapseText(value, limit, { preserveNewlines = false } = {}) {
  const source = String(value || "");
  const normalized = preserveNewlines
    ? source.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n")
    : source.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function normalizeUrl(value) {
  const normalized = normalizeText(value);
  if (!/^https?:\/\//i.test(normalized)) {
    return "";
  }
  return normalized.slice(0, 2_000);
}

function sanitizeFileName(value) {
  return String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .slice(0, 140);
}

function normalizeExtension(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(normalized) ? normalized : "";
}

function normalizePositiveInt(value, fallback, minimum = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function normalizeNonNegativeInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeXorKey(value) {
  if (Number.isInteger(value) && value >= 0 && value <= 255) {
    return value;
  }
  const normalized = normalizeText(value).toLowerCase();
  const parsed = normalized.startsWith("0x")
    ? Number.parseInt(normalized.slice(2), 16)
    : Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 255 ? parsed : null;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  WechatCliInboxSource,
  decodeWechatDatImage,
  persistLocalWechatAttachments,
  readWechatCliSnapshot,
};
