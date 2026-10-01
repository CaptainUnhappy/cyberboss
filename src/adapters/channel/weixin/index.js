const crypto = require("crypto");
const { listWeixinAccounts, resolveSelectedAccount } = require("./account-store");
const { loadPersistedContextTokens, persistContextToken } = require("./context-token-store");
const { runLoginFlow } = require("./login");
const { getConfig, sendTyping } = require("./api");
const { getUpdates, sendText } = require("./api");
const { createInboundFilter } = require("./message-utils");
const { sendWeixinMediaFile } = require("./media-send");
const { loadSyncBuffer, saveSyncBuffer } = require("./sync-buffer-store");
const { loadWeixinConfig, saveWeixinConfig, DEFAULT_MIN_WEIXIN_CHUNK } = require("./config-store");
const { sendWeFlowUiaImage, sendWeFlowUiaText } = require("../../../integrations/weflow-outbound");
const { sendWeChatCuaText } = require("../../../integrations/wechat-cua/outbound");

const LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_WEIXIN_CHUNK = 4000;
const SEND_MESSAGE_CHUNK_INTERVAL_MS = 350;
const WEIXIN_MAX_DELIVERY_MESSAGES = 10;
const PROGRESS_MESSAGE_PREFIX = "【进度】 ";

function createWeixinChannelAdapter(config, { weflowMessageLedger = null } = {}) {
  let selectedAccount = null;
  let contextTokenCache = null;
  const inboundFilter = createInboundFilter();
  let minWeixinChunk = loadWeixinConfig(config).minChunkChars;

  function ensureAccount() {
    if (!selectedAccount) {
      selectedAccount = resolveSelectedAccount(config);
      contextTokenCache = loadPersistedContextTokens(config, selectedAccount.accountId);
    }
    return selectedAccount;
  }

  function ensureContextTokenCache() {
    if (!contextTokenCache) {
      const account = ensureAccount();
      contextTokenCache = loadPersistedContextTokens(config, account.accountId);
    }
    return contextTokenCache;
  }

  function rememberContextToken(userId, contextToken) {
    const account = ensureAccount();
    const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
    const normalizedToken = typeof contextToken === "string" ? contextToken.trim() : "";
    if (!normalizedUserId || !normalizedToken) {
      return "";
    }
    contextTokenCache = persistContextToken(config, account.accountId, normalizedUserId, normalizedToken);
    return normalizedToken;
  }

  function resolveContextToken(userId, explicitToken = "") {
    const normalizedExplicitToken = typeof explicitToken === "string" ? explicitToken.trim() : "";
    if (normalizedExplicitToken) {
      return normalizedExplicitToken;
    }
    const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
    if (!normalizedUserId) {
      return "";
    }
    return ensureContextTokenCache()[normalizedUserId] || "";
  }

  async function sendTextChunks({
    userId,
    text,
    contextToken = "",
    preserveBlock = false,
    omitContextToken = false,
    provider = "",
    messageKind = "",
    idempotencyKey = "",
    weflowContact = "",
    weflowTalker = "",
    weflowExactContact = false,
    requireDesktopIdleSeconds = 0,
    desktopInputLease = null,
  }) {
    const account = ensureAccount();
    const resolvedToken = omitContextToken ? "" : resolveContextToken(userId, contextToken);
    const content = String(text || "");
    if (!content.trim()) {
      return undefined;
    }
    const sendChunks = buildWeixinDeliveryChunks({
      text: content,
      preserveBlock,
      minChunk: minWeixinChunk,
      messageKind,
    });
    let lastResult;
    for (let index = 0; index < sendChunks.length; index += 1) {
      const deliveryChunk = sendChunks[index] || "Completed.";
      const chunkIdempotencyKey = idempotencyKey
        ? (sendChunks.length === 1 ? idempotencyKey : `${idempotencyKey}:chunk:${index + 1}`)
        : "";
      if (provider === "wechat-cua") {
        // RDP-free path: Cua drives this session's WeChat client directly. It
        // returns the same vocabulary as the bridge (dispatched / verified /
        // localId), so the ledger and the stream layer below do not need to know
        // which driver answered.
        lastResult = await sendWeChatCuaText(config, {
          text: deliveryChunk,
          talker: weflowTalker || weflowContact || userId,
          contact: weflowContact,
          messageKind,
          idempotencyKey: chunkIdempotencyKey,
          messageLedger: weflowMessageLedger,
        });
      } else if (provider === "weflow-uia") {
        lastResult = await sendWeFlowUiaText(config, {
          text: deliveryChunk,
          timeoutMs: messageKind === "inbound_ack" ? 5_000 : 0,
          messageKind,
          idempotencyKey: chunkIdempotencyKey,
          messageLedger: weflowMessageLedger,
          contact: weflowContact,
          talker: weflowTalker,
          exactContact: weflowExactContact,
          requireDesktopIdleSeconds,
          desktopInputLease,
        });
      } else {
        lastResult = await sendNativeWeixinTextWithLedger({
          config,
          messageLedger: weflowMessageLedger,
          userId,
          text: deliveryChunk,
          messageKind,
          sendImpl: () => sendText({
            baseUrl: account.baseUrl,
            token: account.token,
            toUserId: userId,
            text: deliveryChunk,
            contextToken: resolvedToken,
            clientId: `cb-${crypto.randomUUID()}`,
          }),
        });
      }
      if (index < sendChunks.length - 1) {
        await sleep(SEND_MESSAGE_CHUNK_INTERVAL_MS);
      }
    }
    return lastResult;
  }

  return {
    describe() {
      return {
        id: "weixin",
        kind: "channel",
        stateDir: config.stateDir,
        baseUrl: config.weixinBaseUrl,
        accountsDir: config.accountsDir,
        syncBufferDir: config.syncBufferDir,
      };
    },
    async login() {
      await runLoginFlow(config);
    },
    printAccounts() {
      const accounts = listWeixinAccounts(config);
      if (!accounts.length) {
        console.log("No saved WeChat account found. Run `npm run login` first.");
        return;
      }
      console.log("Saved accounts:");
      for (const account of accounts) {
        console.log(`- ${account.accountId}`);
        console.log(`  userId: ${account.userId || "(unknown)"}`);
        console.log(`  baseUrl: ${account.baseUrl || config.weixinBaseUrl}`);
        console.log(`  savedAt: ${account.savedAt || "(unknown)"}`);
      }
    },
    resolveAccount() {
      return ensureAccount();
    },
    getKnownContextTokens() {
      return { ...ensureContextTokenCache() };
    },
    loadSyncBuffer() {
      const account = ensureAccount();
      return loadSyncBuffer(config, account.accountId);
    },
    saveSyncBuffer(buffer) {
      const account = ensureAccount();
      saveSyncBuffer(config, account.accountId, buffer);
    },
    rememberContextToken,
    async getUpdates({ syncBuffer = "", timeoutMs = LONG_POLL_TIMEOUT_MS } = {}) {
      const account = ensureAccount();
      const response = await getUpdates({
        baseUrl: account.baseUrl,
        token: account.token,
        getUpdatesBuf: syncBuffer,
        timeoutMs,
      });
      const newBuf = typeof response?.get_updates_buf === "string" ? response.get_updates_buf.trim() : "";
      if (newBuf && newBuf !== syncBuffer) {
        this.saveSyncBuffer(newBuf);
      }
      const messages = Array.isArray(response?.msgs) ? response.msgs : [];
      for (const message of messages) {
        const userId = typeof message?.from_user_id === "string" ? message.from_user_id.trim() : "";
        const contextToken = typeof message?.context_token === "string" ? message.context_token.trim() : "";
        if (userId && contextToken) {
          rememberContextToken(userId, contextToken);
        }
      }
      return response;
    },
    normalizeIncomingMessage(message) {
      const account = ensureAccount();
      return inboundFilter.normalize(message, config, account.accountId);
    },
    async sendText({
      userId,
      text,
      contextToken = "",
      preserveBlock = false,
      omitContextToken = false,
      provider = "",
      messageKind = "",
      idempotencyKey = "",
      weflowContact = "",
      weflowTalker = "",
      weflowExactContact = false,
      requireDesktopIdleSeconds = 0,
      desktopInputLease = null,
    }) {
      return sendTextChunks({
        userId,
        text,
        contextToken,
        preserveBlock,
        omitContextToken,
        provider,
        messageKind,
        idempotencyKey,
        weflowContact,
        weflowTalker,
        weflowExactContact,
        requireDesktopIdleSeconds,
        desktopInputLease,
      });
    },
    async sendTyping({ userId, status = 1, contextToken = "" }) {
      const account = ensureAccount();
      const resolvedToken = resolveContextToken(userId, contextToken);
      if (!resolvedToken) {
        return;
      }
      const configResponse = await getConfig({
        baseUrl: account.baseUrl,
        token: account.token,
        ilinkUserId: userId,
        contextToken: resolvedToken,
      }).catch(() => null);
      const typingTicket = typeof configResponse?.typing_ticket === "string"
        ? configResponse.typing_ticket.trim()
        : "";
      if (!typingTicket) {
        return;
      }
      await sendTyping({
        baseUrl: account.baseUrl,
        token: account.token,
        body: {
          ilink_user_id: userId,
          typing_ticket: typingTicket,
          status,
        },
      });
    },
    async sendFile({
      userId,
      filePath,
      contextToken = "",
      provider = "",
      messageKind = "",
      idempotencyKey = "",
      sha256 = "",
    }) {
      if (provider === "weflow-uia") {
        return sendWeFlowUiaImage(config, {
          filePath,
          sha256,
          idempotencyKey,
          messageKind,
          contentKind: "image",
          messageLedger: weflowMessageLedger,
        });
      }
      const account = ensureAccount();
      const resolvedToken = resolveContextToken(userId, contextToken);
      return sendWeixinMediaFile({
        filePath,
        to: userId,
        contextToken: resolvedToken,
        baseUrl: account.baseUrl,
        token: account.token,
        cdnBaseUrl: config.weixinCdnBaseUrl,
      });
    },
    setMinChunkChars(value) {
      const parsed = Number.parseInt(String(value), 10);
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= MAX_WEIXIN_CHUNK) {
        minWeixinChunk = parsed;
        saveWeixinConfig(config, { minChunkChars: minWeixinChunk });
      }
      return minWeixinChunk;
    },
    getMinChunkChars() {
      return minWeixinChunk;
    },
  };
}

function splitUtf8(text, maxRunes) {
  const runes = Array.from(String(text || ""));
  if (!runes.length || runes.length <= maxRunes) {
    return [String(text || "")];
  }
  const chunks = [];
  while (runes.length) {
    chunks.push(runes.splice(0, maxRunes).join(""));
  }
  return chunks;
}

function normalizeWeixinReplyText(text) {
  return trimOuterBlankLines(normalizeLineEndings(text));
}

function finalizeWeixinDeliveryChunk(text) {
  const normalized = normalizeLineEndings(text);
  if (!normalized.trim()) {
    return "";
  }
  return trimOuterBlankLines(stripChunkTailChineseFullStops(normalized));
}

function stripChunkTailChineseFullStops(text) {
  return String(text || "").replace(/(^|[^。])。(?=(?:\s*["'"”’）)\]\u300d\u300f\u3011》])*\s*$)/u, "$1");
}

function chunkReplyText(text, limit = 3500) {
  const normalized = normalizeWeixinReplyText(text);
  if (!normalized.trim()) {
    return [];
  }

  const chunks = [];
  let remaining = normalized;
  while (remaining.length > limit) {
    const minBoundary = Math.floor(limit * 0.4);
    const cut = findLastPreferredBoundary(remaining, limit, minBoundary) || limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks.filter(Boolean);
}

function chunkReplyTextForWeixin(text, minChunk = DEFAULT_MIN_WEIXIN_CHUNK) {
  const normalized = normalizeWeixinReplyText(text);
  if (!normalized.trim()) {
    return [];
  }

  const boundaries = collectStreamingBoundaries(normalized);
  if (!boundaries.length) {
    return chunkReplyText(normalized, MAX_WEIXIN_CHUNK);
  }

  const units = splitTextAtBoundaries(normalized, boundaries);
  if (!units.length) {
    return chunkReplyText(normalized, MAX_WEIXIN_CHUNK);
  }

  const unitsWithinLimit = [];
  for (const unit of units) {
    if (unit.length <= MAX_WEIXIN_CHUNK) {
      unitsWithinLimit.push(unit);
      continue;
    }
    unitsWithinLimit.push(...chunkReplyText(unit, MAX_WEIXIN_CHUNK));
  }
  return coalesceNaturalChunks(
    unitsWithinLimit.filter(Boolean),
    MAX_WEIXIN_CHUNK,
    normalizeChunkTarget(minChunk, DEFAULT_MIN_WEIXIN_CHUNK),
  );
}

async function sendNativeWeixinTextWithLedger({
  config,
  messageLedger,
  userId,
  text,
  messageKind = "",
  sendImpl,
}) {
  const talker = String(config?.weflowInboxChat || "").trim();
  const expectedUserId = String(config?.weflowInboxReplyUserId || "").trim();
  const normalizedUserId = String(userId || "").trim();
  const shouldTrack = Boolean(
    messageLedger
    && talker
    && normalizedUserId
    && (!expectedUserId || expectedUserId === normalizedUserId)
  );
  let planned = null;
  if (shouldTrack) {
    planned = await messageLedger.planOutbound({
      talker,
      text,
      messageKind: messageKind ? `native_${messageKind}` : "native_reply",
      expectedDirection: "incoming",
    });
    await messageLedger.markSending(planned?.id || planned?.operationId || planned);
  }
  try {
    return await sendImpl();
  } catch (error) {
    if (planned) {
      try {
        await messageLedger.markFailed(planned?.id || planned?.operationId || planned, {
          uncertain: true,
          error,
        });
      } catch {}
    }
    throw error;
  }
}

function buildWeixinDeliveryChunks({ text, preserveBlock = false, minChunk = DEFAULT_MIN_WEIXIN_CHUNK, messageKind = "" } = {}) {
  const normalizedContent = normalizeWeixinReplyText(text);
  const prefix = normalizeMessageKind(messageKind) === "progress" ? PROGRESS_MESSAGE_PREFIX : "";
  const contentLimit = Math.max(1, MAX_WEIXIN_CHUNK - prefix.length);
  const textChunks = preserveBlock ? null : chunkReplyTextForWeixin(normalizedContent, minChunk);
  const rawChunks = preserveBlock
    ? splitUtf8(normalizedContent || "Completed.", contentLimit)
    : packChunksForWeixinDelivery(
      textChunks?.length ? textChunks : ["Completed."],
      WEIXIN_MAX_DELIVERY_MESSAGES,
      contentLimit
    );
  return rawChunks.map((chunk) => decorateWeixinDeliveryChunk(
    finalizeWeixinDeliveryChunk(chunk) || "Completed.",
    messageKind,
  ));
}

function decorateWeixinDeliveryChunk(text, messageKind = "") {
  const normalized = String(text || "");
  if (normalizeMessageKind(messageKind) !== "progress") {
    return normalized;
  }
  return normalized.startsWith(PROGRESS_MESSAGE_PREFIX.trim())
    ? normalized
    : `${PROGRESS_MESSAGE_PREFIX}${normalized}`;
}

function normalizeMessageKind(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function coalesceNaturalChunks(chunks, maxLength, targetLength) {
  if (!chunks.length) {
    return [];
  }
  const merged = [];
  let buffer = "";
  for (const sourceChunk of chunks) {
    for (const chunk of splitUtf8(sourceChunk, maxLength)) {
      const joined = buffer ? `${buffer}${chunk}` : chunk;
      if (buffer && joined.length > maxLength) {
        merged.push(buffer);
        buffer = chunk;
      } else {
        buffer = joined;
      }
      if (buffer.length >= targetLength) {
        merged.push(buffer);
        buffer = "";
      }
    }
  }
  if (buffer) {
    const previous = merged[merged.length - 1] || "";
    if (previous && previous.length + buffer.length <= maxLength) {
      merged[merged.length - 1] = `${previous}${buffer}`;
    } else {
      merged.push(buffer);
    }
  }
  return merged;
}

function normalizeChunkTarget(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= MAX_WEIXIN_CHUNK
    ? parsed
    : fallback;
}

function mergeShortChunks(chunks, maxLength, minLength) {
  if (!chunks.length) {
    return chunks;
  }
  const merged = [];
  let buffer = chunks[0];
  for (let index = 1; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const isShort = buffer.length < minLength && chunk.length < minLength;
    const joined = `${buffer}${chunk}`;
    if (isShort && joined.length <= maxLength) {
      buffer = joined;
    } else {
      merged.push(buffer);
      buffer = chunk;
    }
  }
  merged.push(buffer);
  return merged;
}

function packChunksForWeixinDelivery(chunks, maxMessages = 10, maxChunkChars = 4000) {
  const normalizedChunks = Array.isArray(chunks)
    ? chunks.map((chunk) => normalizeLineEndings(chunk)).filter((chunk) => chunk.trim())
    : [];
  if (!normalizedChunks.length) {
    return [];
  }

  // Greedily fill each bubble up to the documented channel limit while
  // preserving the separators already attached to natural text units.
  const grouped = [];
  let current = "";
  for (const sourceChunk of normalizedChunks) {
    for (const chunk of splitUtf8(sourceChunk, maxChunkChars)) {
      const joined = current ? `${current}${chunk}` : chunk;
      if (current && joined.length > maxChunkChars) {
        grouped.push(current);
        current = chunk;
        continue;
      }
      current = joined;
    }
  }
  if (current) {
    grouped.push(current);
  }
  // maxMessages is a soft target. Content is never discarded when a very long
  // reply inherently needs more bubbles than the target allows.
  void maxMessages;
  return grouped.map((item) => normalizeLineEndings(item) || "Completed.");
}

function splitTextAtBoundaries(text, boundaries) {
  const units = [];
  let start = 0;
  for (const boundary of boundaries) {
    if (boundary <= start) {
      continue;
    }
    const unit = text.slice(start, boundary);
    if (unit.trim()) {
      units.push(unit);
    }
    start = boundary;
  }
  const tail = text.slice(start);
  if (tail.trim()) {
    units.push(tail);
  }
  return units;
}

function findLastPreferredBoundary(text, maxBoundary = text.length, minBoundary = 0) {
  const boundaries = collectStreamingBoundaries(text);
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    const boundary = boundaries[index];
    if (boundary > maxBoundary) {
      continue;
    }
    if (boundary > minBoundary) {
      return boundary;
    }
    break;
  }
  return 0;
}

function collectStreamingBoundaries(text) {
  const boundaries = new Set();

  const regex = /\n\s*\n+/g;
  let match = regex.exec(text);
  while (match) {
    boundaries.add(match.index + match[0].length);
    match = regex.exec(text);
  }

  const listRegex = /\n(?:(?:[-*])\s+|(?:\d+\.)\s+)/g;
  match = listRegex.exec(text);
  while (match) {
    boundaries.add(match.index + 1);
    match = listRegex.exec(text);
  }

  for (let index = 0; index < text.length; index += 1) {
    const endOfPunctuation = findBoundaryPunctuationEnd(text, index);
    if (!endOfPunctuation) {
      continue;
    }

    let end = endOfPunctuation;
    while (end < text.length && /["'"”’）)\]\u300d\u300f\u3011》]/u.test(text[end])) {
      end += 1;
    }
    while (end < text.length && /[\t \n]/.test(text[end])) {
      end += 1;
    }
    boundaries.add(end);
    index = endOfPunctuation - 1;
  }

  return Array.from(boundaries).sort((left, right) => left - right);
}

function findBoundaryPunctuationEnd(text, index) {
  const char = text[index];
  if (/[\u3002\uff01\uff1f!?]/u.test(char)) {
    return consumeRepeatedChar(text, index, char);
  }
  if (char === ".") {
    const end = consumeRepeatedChar(text, index, ".");
    return end - index >= 3 ? end : 0;
  }
  if (char === "…") {
    return consumeRepeatedChar(text, index, "…");
  }
  return 0;
}

function consumeRepeatedChar(text, index, char) {
  let end = index + 1;
  while (end < text.length && text[end] === char) {
    end += 1;
  }
  return end;
}

function trimOuterBlankLines(text) {
  return String(text || "")
    .replace(/^\s*\n+/g, "")
    .replace(/\n+\s*$/g, "");
}

function normalizeLineEndings(text) {
  return String(text || "").replace(/\r\n/g, "\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  createWeixinChannelAdapter,
  sendNativeWeixinTextWithLedger,
  splitUtf8,
  normalizeWeixinReplyText,
  finalizeWeixinDeliveryChunk,
  buildWeixinDeliveryChunks,
  decorateWeixinDeliveryChunk,
  stripChunkTailChineseFullStops,
  chunkReplyText,
  chunkReplyTextForWeixin,
  coalesceNaturalChunks,
  mergeShortChunks,
  packChunksForWeixinDelivery,
  splitTextAtBoundaries,
  findLastPreferredBoundary,
  collectStreamingBoundaries,
  findBoundaryPunctuationEnd,
  trimOuterBlankLines,
};
