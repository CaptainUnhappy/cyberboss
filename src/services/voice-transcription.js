const crypto = require("crypto");
const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 120_000;

class VoiceTranscriptionService {
  constructor({ config = {}, spawnImpl = spawn, transcribeImpl = null } = {}) {
    this.config = config;
    this.spawnImpl = spawnImpl;
    this.transcribeImpl = typeof transcribeImpl === "function" ? transcribeImpl : null;
    this.child = null;
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
    this.stdoutBuffer = "";
    this.stderrTail = "";
    this.pending = new Map();
    this.inFlightByCacheKey = new Map();
    this.nextRequestId = 1;
    this.closed = false;
  }

  describe() {
    const model = normalizeText(this.config.voiceTranscriptionModel);
    return {
      enabled: this.isEnabled(),
      model,
      modelAvailable: Boolean(model) && (fs.existsSync(model) || !looksLikeLocalPath(model)),
      device: normalizeText(this.config.voiceTranscriptionDevice) || "cpu",
      computeType: normalizeText(this.config.voiceTranscriptionComputeType) || "int8",
    };
  }

  isEnabled() {
    const mode = normalizeText(this.config.voiceTranscriptionMode).toLowerCase() || "auto";
    return !["off", "disabled", "0"].includes(mode);
  }

  async warm() {
    if (!this.isEnabled()) {
      return { status: "off" };
    }
    if (this.transcribeImpl) {
      return { status: "ready" };
    }
    const model = normalizeText(this.config.voiceTranscriptionModel);
    if (!model || (looksLikeLocalPath(model) && !fs.existsSync(model))) {
      return { status: "model_missing", model };
    }
    await this.ensureWorker();
    return { status: "ready" };
  }

  async transcribeAttachment(attachment) {
    if (!this.isEnabled()) {
      throw new Error("voice transcription is disabled");
    }
    const absolutePath = normalizeText(attachment?.absolutePath);
    if (!absolutePath || !fs.existsSync(absolutePath)) {
      throw new Error("voice attachment has no readable local file");
    }
    const cacheKey = await buildTranscriptCacheKey({
      absolutePath,
      model: normalizeText(this.config.voiceTranscriptionModel),
      language: normalizeText(this.config.voiceTranscriptionLanguage) || "zh",
    });
    const cached = await this.readCache(cacheKey);
    if (cached?.text) {
      return { ...cached, cached: true };
    }
    if (this.inFlightByCacheKey.has(cacheKey)) {
      return this.inFlightByCacheKey.get(cacheKey);
    }
    const task = this.transcribeFile(absolutePath)
      .then(async (result) => {
        const normalized = {
          text: collapseText(result?.text, 12_000),
          language: collapseText(result?.language, 40),
          duration: normalizeOptionalNumber(result?.duration),
          cached: false,
        };
        if (!normalized.text) {
          throw new Error("voice transcription returned no text");
        }
        await this.writeCache(cacheKey, normalized);
        return normalized;
      })
      .finally(() => this.inFlightByCacheKey.delete(cacheKey));
    this.inFlightByCacheKey.set(cacheKey, task);
    return task;
  }

  async transcribeFile(absolutePath) {
    if (this.transcribeImpl) {
      return this.transcribeImpl(absolutePath, this.config);
    }
    await this.ensureWorker();
    if (!this.child?.stdin?.writable) {
      throw new Error("voice transcription worker is not writable");
    }
    const id = String(this.nextRequestId++);
    const timeoutMs = normalizePositiveInt(this.config.voiceTranscriptionTimeoutMs, DEFAULT_TRANSCRIPTION_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`voice transcription timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      const payload = {
        id,
        path: absolutePath,
        language: normalizeText(this.config.voiceTranscriptionLanguage) || "zh",
      };
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(error);
        }
      });
    });
  }

  async ensureWorker() {
    if (this.closed) {
      throw new Error("voice transcription service is closed");
    }
    if (this.readyPromise) {
      return this.readyPromise;
    }
    const python = normalizeText(this.config.voiceTranscriptionPythonCommand) || "python";
    const script = normalizeText(this.config.voiceTranscriptionWorkerScript);
    const model = normalizeText(this.config.voiceTranscriptionModel);
    if (!script || !fs.existsSync(script)) {
      throw new Error("voice transcription worker script is missing");
    }
    if (!model || (looksLikeLocalPath(model) && !fs.existsSync(model))) {
      throw new Error("voice transcription model is missing");
    }

    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    const args = [
      "-u", script,
      "--model", model,
      "--device", normalizeText(this.config.voiceTranscriptionDevice) || "cpu",
      "--compute-type", normalizeText(this.config.voiceTranscriptionComputeType) || "int8",
      "--language", normalizeText(this.config.voiceTranscriptionLanguage) || "zh",
      "--beam-size", String(normalizePositiveInt(this.config.voiceTranscriptionBeamSize, 1)),
    ];
    const hotwords = normalizeText(this.config.voiceTranscriptionHotwords);
    if (hotwords) {
      args.push("--hotwords", hotwords);
    }
    const cpuThreads = normalizePositiveInt(this.config.voiceTranscriptionCpuThreads, 0, 0);
    if (cpuThreads > 0) {
      args.push("--cpu-threads", String(cpuThreads));
    }
    if (this.config.voiceTranscriptionLocalFilesOnly !== false) {
      args.push("--local-files-only");
    }

    const child = this.spawnImpl(python, args, {
      cwd: path.dirname(script),
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout?.on("data", (chunk) => this.handleStdout(chunk));
    child.stderr?.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${String(chunk || "")}`.slice(-4_000);
    });
    child.once("error", (error) => this.handleWorkerExit(error));
    child.once("exit", (code, signal) => {
      const detail = this.stderrTail.trim();
      this.handleWorkerExit(new Error(
        `voice transcription worker exited (${code ?? signal ?? "unknown"})${detail ? `: ${detail}` : ""}`
      ));
    });

    const timeoutMs = normalizePositiveInt(this.config.voiceTranscriptionStartupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
    const timer = setTimeout(() => {
      this.handleWorkerExit(new Error(`voice transcription worker startup timed out after ${timeoutMs}ms`));
      child.kill();
    }, timeoutMs);
    timer.unref?.();
    this.readyPromise.finally(() => clearTimeout(timer)).catch(() => {});
    return this.readyPromise;
  }

  handleStdout(chunk) {
    this.stdoutBuffer += String(chunk || "");
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let payload = null;
      try {
        payload = JSON.parse(line);
      } catch {
        this.stderrTail = `${this.stderrTail}\n${line}`.slice(-4_000);
        continue;
      }
      if (payload.type === "ready") {
        const resolve = this.resolveReady;
        this.resolveReady = null;
        this.rejectReady = null;
        resolve?.(payload);
        continue;
      }
      if (payload.type === "fatal") {
        this.handleWorkerExit(new Error(normalizeText(payload.error) || "voice transcription worker failed"));
        continue;
      }
      const id = normalizeText(String(payload.id ?? ""));
      const pending = this.pending.get(id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (payload.error) pending.reject(new Error(normalizeText(payload.error)));
      else pending.resolve(payload);
    }
  }

  handleWorkerExit(error) {
    const child = this.child;
    this.child = null;
    const rejectReady = this.rejectReady;
    this.resolveReady = null;
    this.rejectReady = null;
    this.readyPromise = null;
    rejectReady?.(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (child?.stdin?.writable) child.stdin.end();
  }

  async readCache(cacheKey) {
    const filePath = this.cachePath(cacheKey);
    if (!filePath) return null;
    try {
      const parsed = JSON.parse(await fsPromises.readFile(filePath, "utf8"));
      const text = collapseText(parsed?.text, 12_000);
      return text ? {
        text,
        language: collapseText(parsed?.language, 40),
        duration: normalizeOptionalNumber(parsed?.duration),
      } : null;
    } catch {
      return null;
    }
  }

  async writeCache(cacheKey, value) {
    const filePath = this.cachePath(cacheKey);
    if (!filePath) return;
    const dir = path.dirname(filePath);
    await fsPromises.mkdir(dir, { recursive: true });
    const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    await fsPromises.writeFile(temp, `${JSON.stringify({ version: 1, ...value }, null, 2)}\n`, "utf8");
    await fsPromises.rename(temp, filePath);
  }

  cachePath(cacheKey) {
    const dir = normalizeText(this.config.voiceTranscriptCacheDir);
    return dir && cacheKey ? path.join(dir, `${cacheKey}.json`) : "";
  }

  async close() {
    this.closed = true;
    const child = this.child;
    this.child = null;
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("voice transcription service closed"));
    }
    this.pending.clear();
    if (child) {
      child.stdin?.end();
      child.kill();
    }
  }
}

async function enrichMessageWithVoiceTranscripts({ message, attachments, transcriptionService }) {
  const sourceMessage = message && typeof message === "object" ? message : {};
  const savedAttachments = Array.isArray(attachments) ? attachments : [];
  if (!transcriptionService || typeof transcriptionService.transcribeAttachment !== "function") {
    return { message: sourceMessage, failures: [], transcripts: [] };
  }
  const voiceAttachments = savedAttachments.filter((item) => normalizeText(item?.kind).toLowerCase() === "voice");
  if (!voiceAttachments.length) {
    return { message: sourceMessage, failures: [], transcripts: [] };
  }

  const transcripts = [];
  const failures = [];
  for (const attachment of voiceAttachments) {
    try {
      const result = await transcriptionService.transcribeAttachment(attachment);
      transcripts.push({
        attachmentRef: normalizeText(attachment.attachmentRef),
        origin: normalizeOrigin(attachment.origin),
        sourceFileName: normalizeText(attachment.sourceFileName || attachment.fileName),
        text: collapseText(result?.text, 12_000),
        language: collapseText(result?.language, 40),
        duration: normalizeOptionalNumber(result?.duration),
        cached: Boolean(result?.cached),
      });
    } catch (error) {
      failures.push({
        kind: "voice",
        origin: normalizeOrigin(attachment.origin),
        attachmentRef: normalizeText(attachment.attachmentRef),
        sourceFileName: normalizeText(attachment.sourceFileName || attachment.fileName),
        reason: error instanceof Error ? error.message : String(error || "voice transcription failed"),
      });
    }
  }

  const directText = transcripts
    .filter((item) => item.origin === "direct" && item.text)
    .map((item) => item.text)
    .join("\n");
  const quotedContexts = (Array.isArray(sourceMessage.quotedContexts) ? sourceMessage.quotedContexts : [])
    .map((context) => {
      if (!context || typeof context !== "object") return context;
      const refs = Array.isArray(context.attachmentRefs) ? context.attachmentRefs.map(normalizeText) : [];
      const quotedText = transcripts
        .filter((item) => item.origin === "quoted" && item.text && refs.includes(item.attachmentRef))
        .map((item) => item.text)
        .join("\n");
      return quotedText ? { ...context, text: quotedText } : context;
    });
  const enriched = { ...sourceMessage, quotedContexts };
  if (directText) {
    enriched.text = directText;
    enriched.voiceTranscript = directText;
  }
  return { message: enriched, failures, transcripts };
}

async function buildTranscriptCacheKey({ absolutePath, model, language }) {
  const bytes = await fsPromises.readFile(absolutePath);
  return crypto.createHash("sha256")
    .update(normalizeText(model)).update("\0")
    .update(normalizeText(language)).update("\0")
    .update(bytes).digest("hex");
}

function looksLikeLocalPath(value) {
  const normalized = normalizeText(value);
  return path.isAbsolute(normalized) || normalized.startsWith(".") || normalized.includes("\\");
}

function normalizeOrigin(value) {
  return normalizeText(value).toLowerCase() === "quoted" ? "quoted" : "direct";
}

function normalizeOptionalNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizePositiveInt(value, fallback, minimum = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function collapseText(value, limit) {
  const normalized = normalizeText(value).replace(/\s+/gu, " ");
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { VoiceTranscriptionService, enrichMessageWithVoiceTranscripts };
