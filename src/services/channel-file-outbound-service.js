const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { sendWeFlowUiaFile } = require("../integrations/weflow-outbound");

/**
 * How long the bridge waits for WeFlow to show the file row before reporting it
 * as unverified.
 *
 * Two measured failures shape this. Fixed at 60s it was too short: a 2.7 MiB
 * video was reported `verified: false` although the ledger showed it delivered.
 * Then a 300s window was too long in a different way — the row actually appeared
 * ~14s after the send, but the bridge held the request and its `send_lock` for the
 * full window, so the client hit its own socket limit and a *successful* send
 * surfaced as "fetch failed".
 *
 * So the window only needs to cover the observed appearance lag, with a small size
 * allowance, and must stay well under the transport budget. An unverified result
 * is not cosmetic (it records the send as uncertain and blocks de-duplication),
 * but neither is a five-minute lock.
 */
const VERIFY_TIMEOUT_FLOOR_MS = 60_000;
const VERIFY_TIMEOUT_PER_MIB_MS = 5_000;
const VERIFY_TIMEOUT_CEILING_MS = 180_000;

function resolveVerifyTimeoutMs(sizeBytes, requested) {
  const explicit = Number(requested);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const size = Number(sizeBytes);
  const mebibytes = Number.isFinite(size) && size > 0 ? size / (1024 * 1024) : 0;
  const scaled = VERIFY_TIMEOUT_FLOOR_MS + Math.ceil(mebibytes) * VERIFY_TIMEOUT_PER_MIB_MS;
  return Math.min(VERIFY_TIMEOUT_CEILING_MS, scaled);
}

/**
 * Send arbitrary local files to the user's WeChat window.
 *
 * This is the sibling of `ChannelFileService`: that one goes out over the official
 * bot channel (iLink) and therefore inherits its `context_token` requirement, so it
 * can only ever reply. This one drives the personal-account UIA bridge, whose
 * `/api/send-file` pastes a real attachment, so it works for a file the user asked
 * for at any time.
 *
 * Cross-account constraint: the bridge runs as a different Windows account than
 * the bot, so it can only read paths that account can open. Anything outside the
 * shared outbound directory is therefore staged there first, content-addressed by
 * its sha256 so re-sending the same file cannot collide with or overwrite another.
 */
class ChannelFileOutboundService {
  constructor({ config, messageLedger = null }) {
    this.config = config;
    this.messageLedger = messageLedger;
  }

  /**
   * Copy `sourcePath` into the shared directory the bridge can read.
   *
   * Returns the staged path plus the digest that identifies it. A file already
   * inside the shared directory is used in place: the bridge's account only needs
   * to read it, and re-copying could invalidate a path the caller just handed us.
   *
   * The staged copy keeps its ORIGINAL filename and is de-duplicated by a
   * digest-named subdirectory instead. This is load-bearing, not cosmetic: the
   * bridge confirms a file send by matching WeChat's attachment title against the
   * local basename (`message_matches_file`), and WeChat shows the name it was
   * given. An earlier revision appended the digest to the filename, so the title
   * never matched, every send came back `verified: false` with no localId, and the
   * ledger recorded successful deliveries as uncertain.
   */
  stageForBridge(sourcePath) {
    const resolved = path.resolve(sourcePath);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      throw new Error(`Only files can be sent, not directories: ${resolved}`);
    }
    if (stat.size <= 0) {
      throw new Error(`Refusing to send an empty file: ${resolved}`);
    }

    const bytes = fs.readFileSync(resolved);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");

    const sharedDir = path.resolve(this.config.generatedImageOutboundDir);
    if (isInside(sharedDir, resolved)) {
      return { stagedPath: resolved, sha256, size: stat.size, copied: false };
    }

    const stagingDir = path.join(sharedDir, "staged", sha256.slice(0, 16));
    fs.mkdirSync(stagingDir, { recursive: true });
    const stagedPath = path.join(stagingDir, path.basename(resolved));
    if (!fs.existsSync(stagedPath) || fs.statSync(stagedPath).size !== stat.size) {
      fs.writeFileSync(stagedPath, bytes);
    }
    return { stagedPath, sha256, size: stat.size, copied: true };
  }

  async sendToCurrentChat({ filePath = "", timeoutMs = 0 } = {}) {
    const requested = normalizeText(filePath);
    if (!requested) {
      throw new Error("Missing file path to send.");
    }
    if (!fs.existsSync(path.resolve(requested))) {
      throw new Error(`File does not exist: ${path.resolve(requested)}`);
    }

    const staged = this.stageForBridge(requested);
    const effectiveTimeoutMs = resolveVerifyTimeoutMs(staged.size, timeoutMs);
    const payload = await sendWeFlowUiaFile(this.config, {
      filePath: staged.stagedPath,
      sha256: staged.sha256,
      timeoutMs: effectiveTimeoutMs,
      messageKind: "channel_file_outbound",
      messageLedger: this.messageLedger,
    });
    return {
      ...payload,
      requestedPath: path.resolve(requested),
      stagedPath: staged.stagedPath,
      staged: staged.copied,
      size: staged.size,
      sha256: staged.sha256,
    };
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** True when `candidate` is the directory itself or lives under it. */
function isInside(directory, candidate) {
  const base = path.resolve(directory);
  const target = path.resolve(candidate);
  if (target === base) {
    return true;
  }
  const relative = path.relative(base, target);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

module.exports = { ChannelFileOutboundService };
