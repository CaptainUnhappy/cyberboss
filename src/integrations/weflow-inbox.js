const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");

const MAX_SEEN_IDS = 4_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MESSAGE_LIMIT = 50;
const MEDIA_RETRY_DELAYS_MS = [0, 250, 750, 1_500];

class WeFlowInboxSource {
  constructor({
    config,
    onMessage,
    isReady = () => true,
    fetchImpl = globalThis.fetch,
    logger = console,
  }) {
    this.config = config || {};
    this.onMessage = typeof onMessage === "function" ? onMessage : async () => true;
    this.isReady = typeof isReady === "function" ? isReady : () => true;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.state = loadCursorState(this.config.weflowInboxCursorFile);
    this.running = false;
    this.abortController = null;
    this.loopPromise = null;
    this.pendingEvents = new Map();
    this.pendingTimer = null;
  }

  async start() {
    if (this.running) {
      return;
    }
    if (typeof this.fetchImpl !== "function") {
      throw new Error("WeFlow inbox requires fetch support");
    }
    this.running = true;
    this.loopPromise = this.runLoop().catch((error) => {
      if (this.running && !isAbortError(error)) {
        this.logger.error?.(`[cyberboss] WeFlow inbox stopped: ${formatError(error)}`);
      }
    });
  }

  async stop() {
    this.running = false;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.abortController?.abort();
    await Promise.resolve(this.loopPromise).catch(() => {});
    this.abortController = null;
    this.loopPromise = null;
  }

  async runLoop() {
    while (this.running) {
      this.abortController = new AbortController();
      try {
        if (this.pendingEvents.size) {
          await this.drainPendingEvents();
        }
        await this.consumePushStream(this.abortController.signal);
      } catch (error) {
        if (this.running && !isAbortError(error)) {
          this.logger.error?.(`[cyberboss] WeFlow push reconnecting: ${formatError(error)}`);
        }
      }
      if (this.running) {
        await delay(normalizePositiveInt(
          this.config.weflowReconnectDelayMs,
          DEFAULT_RECONNECT_DELAY_MS,
          100
        ));
      }
    }
  }

  async consumePushStream(signal) {
    const response = await this.fetchImpl(buildApiUrl(this.config, "/api/v1/push/messages"), {
      headers: buildHeaders(this.config, { accept: "text/event-stream" }),
      signal,
    });
    assertHttpOk(response, "WeFlow message push");
    if (!response.body) {
      throw new Error("WeFlow message push returned an empty stream");
    }
    await consumeSseStream(response.body, async (event) => {
      await this.handleSseEvent(event);
    });
  }

  async handleSseEvent(event) {
    const eventType = normalizeText(event?.event) || "message";
    if (eventType !== "message.new") {
      return { status: "ignored_event" };
    }
    const push = normalizePushData(event?.data);
    const chat = normalizeText(push.sessionId || push.talker || push.chatUsername);
    if (!chat || chat !== normalizeText(this.config.weflowInboxChat)) {
      return { status: "ignored_chat" };
    }
    const key = buildEventKey(eventType, push);
    if (!key || this.state.seenIds.includes(key)) {
      return { status: "duplicate" };
    }
    this.pendingEvents.set(key, { eventType, push });
    const result = await this.drainPendingEvents();
    if (this.pendingEvents.size) {
      this.schedulePendingDrain();
    }
    return result;
  }

  schedulePendingDrain() {
    if (!this.running || this.pendingTimer) {
      return;
    }
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      void this.drainPendingEvents().finally(() => {
        if (this.pendingEvents.size) {
          this.schedulePendingDrain();
        }
      });
    }, 1_000);
    this.pendingTimer.unref?.();
  }

  async drainPendingEvents() {
    if (!await this.isReady()) {
      return { status: "waiting_for_reply_target", processed: 0 };
    }
    let processed = 0;
    for (const [key, item] of [...this.pendingEvents.entries()]) {
      if (this.state.seenIds.includes(key)) {
        this.pendingEvents.delete(key);
        continue;
      }
      const resolved = await this.resolvePushMessage(item.push);
      if (resolved.message.direction === "incoming") {
        const accepted = await this.onMessage(resolved.message, resolved.snapshot);
        if (accepted === false) {
          return { status: "deferred", processed };
        }
        processed += 1;
      }
      this.rememberSeen(key);
      this.pendingEvents.delete(key);
      await this.saveState();
    }
    return { status: "ok", processed };
  }

  async resolvePushMessage(push) {
    let details = [];
    for (const retryMs of MEDIA_RETRY_DELAYS_MS) {
      if (retryMs) {
        await delay(retryMs);
      }
      details = await fetchMessageDetails(this.config, push, this.fetchImpl);
      const matched = findPushedMessage(details, push);
      if (matched && (!messageExpectsMedia(matched) || hasUsableMedia(matched))) {
        break;
      }
    }
    const raw = findPushedMessage(details, push) || push;
    const quoteId = normalizeText(raw.replyToMessageId || raw.quote?.platformMessageId);
    let quoteMessage = quoteId
      ? details.find((item) => normalizeText(item?.serverId) === quoteId) || null
      : null;
    if (quoteId && !quoteMessage) {
      quoteMessage = await this.fetchQuotedMessage(raw, push, quoteId);
    }
    return {
      message: normalizeWeFlowMessage(raw, { quoteMessage }),
      snapshot: {
        chat: normalizeText(push.sourceName) || normalizeText(this.config.weflowInboxDisplayName),
        chatUsername: normalizeText(push.sessionId) || normalizeText(this.config.weflowInboxChat),
        messages: details,
        failures: [],
      },
    };
  }

  async fetchQuotedMessage(raw, push, quoteId) {
    const quoteTimestamp = extractQuotedCreateTime(raw?.rawContent);
    if (!quoteTimestamp) {
      return null;
    }
    let quoteMessage = null;
    for (const retryMs of MEDIA_RETRY_DELAYS_MS) {
      if (retryMs) {
        await delay(retryMs);
      }
      const quotedDetails = await fetchMessageDetails(this.config, {
        sessionId: normalizeText(push?.sessionId) || normalizeText(this.config.weflowInboxChat),
        timestamp: quoteTimestamp,
        rawid: quoteId,
      }, this.fetchImpl);
      quoteMessage = quotedDetails.find((item) => normalizeText(item?.serverId) === quoteId) || null;
      if (quoteMessage && (!messageExpectsMedia(quoteMessage) || hasUsableMedia(quoteMessage))) {
        return quoteMessage;
      }
    }
    return quoteMessage;
  }

  rememberSeen(key) {
    this.state.seenIds = this.state.seenIds.filter((item) => item !== key);
    this.state.seenIds.push(key);
    if (this.state.seenIds.length > MAX_SEEN_IDS) {
      this.state.seenIds = this.state.seenIds.slice(-MAX_SEEN_IDS);
    }
    this.state.lastEventAt = new Date().toISOString();
  }

  async saveState() {
    const filePath = normalizeText(this.config.weflowInboxCursorFile);
    if (filePath) {
      await writeJsonAtomic(filePath, this.state);
    }
  }
}

async function fetchMessageDetails(config, push, fetchImpl = globalThis.fetch) {
  const chat = normalizeText(push?.sessionId || config.weflowInboxChat);
  if (!chat) {
    return [];
  }
  const timestamp = normalizeEpochSeconds(push?.timestamp || push?.createTime);
  const params = new URLSearchParams({
    talker: chat,
    limit: String(normalizePositiveInt(config.weflowMessageLimit, DEFAULT_MESSAGE_LIMIT, 1)),
    media: "1",
    image: "1",
    voice: "1",
    video: "1",
    emoji: "1",
  });
  if (timestamp) {
    params.set("start", String(Math.max(0, timestamp - 300)));
    params.set("end", String(timestamp + 30));
  }
  const response = await fetchImpl(buildApiUrl(config, `/api/v1/messages?${params}`), {
    headers: buildHeaders(config),
  });
  assertHttpOk(response, "WeFlow message detail");
  const payload = await response.json();
  return Array.isArray(payload?.messages)
    ? payload.messages.filter((item) => item && typeof item === "object")
    : [];
}

function normalizeWeFlowMessage(value, { quoteMessage = null } = {}) {
  const raw = value && typeof value === "object" ? value : {};
  const timestamp = normalizeEpochSeconds(raw.createTime || raw.timestamp);
  const serverId = normalizeText(raw.serverId || raw.rawid || raw.id);
  const localId = normalizeText(String(raw.localId ?? ""));
  const id = serverId || localId || `weflow-${timestamp || Date.now()}`;
  const rawContent = normalizeText(raw.rawContent);
  const content = normalizeText(raw.parsedContent || raw.content);
  const appType = Number(extractXmlTag(rawContent, "type")) || 0;
  const mediaKind = normalizeMediaKind(raw.mediaType);
  const url = extractMessageUrl(raw, rawContent, content);
  const merged = appType === 19 || /^\[聊天记录\]$/.test(content)
    ? parseCombinedForward(rawContent)
    : null;
  const quote = buildQuotedContext(raw.quote, quoteMessage, rawContent);
  const attachments = [];
  const directAttachment = buildMediaAttachment(raw, "direct", `weflow:${id}:direct:1`);
  if (directAttachment) {
    attachments.push(directAttachment);
  }
  const quotedAttachment = quoteMessage
    ? buildMediaAttachment(quoteMessage, "quoted", `weflow:${id}:quoted:1`)
    : null;
  if (quotedAttachment) {
    attachments.push(quotedAttachment);
    if (quote) {
      quote.attachmentRefs = [quotedAttachment.attachmentRef];
    }
  } else if (quote && ["image", "voice", "video", "file"].includes(quote.kind) && !quote.text) {
    quote.text = `引用${defaultKindTitle(quote.kind)}的本地附件缺失，请勿使用当前线程中的其他附件代替。`;
  }

  let kind = mediaKind;
  if (merged) {
    kind = "text";
  } else if (appType === 57) {
    // A type-57 message is the user's current reply text. Media markers and
    // placeholder URLs inside <refermsg> describe the quoted source, not the
    // current message itself.
    kind = content ? "text" : "unknown";
  } else if (appType === 6) {
    kind = "file";
  } else if (url) {
    kind = "link";
  } else if (!kind || kind === "unknown") {
    kind = inferContentKind(content, rawContent);
  }
  const title = merged?.title
    || cleanMessagePlaceholder(extractXmlTag(rawContent, "title"))
    || cleanMessagePlaceholder(raw.mediaFileName)
    || defaultKindTitle(kind);
  let text = merged?.text || content;
  if (appType === 57) {
    text = cleanMessagePlaceholder(extractXmlTag(rawContent, "title")) || content;
  } else if (kind === "link") {
    const description = cleanMessagePlaceholder(extractXmlTag(rawContent, "des"));
    text = [cleanMessagePlaceholder(extractXmlTag(rawContent, "title")), description]
      .filter(Boolean)
      .join("\n") || content;
  }
  if (kind !== "text" && isPlaceholderText(text)) {
    text = "";
  }

  return {
    id,
    localId: Number.parseInt(localId, 10) || 0,
    timestamp,
    receivedAt: timestamp ? new Date(timestamp * 1000).toISOString() : new Date().toISOString(),
    direction: isSentMessage(raw) ? "outgoing" : "incoming",
    kind,
    isLinkCard: kind === "link" && (appType > 0 || /<appmsg\b/iu.test(rawContent)),
    title: collapseText(title, 500),
    text: collapseText(text, 12_000, { preserveNewlines: true }),
    url,
    quotedContexts: quote ? [quote] : [],
    attachments,
  };
}

function buildQuotedContext(quote, quoteMessage, rawContent) {
  const snapshot = quote && typeof quote === "object" ? quote : {};
  const referXml = extractXmlTag(rawContent, "refermsg");
  const referContent = decodeXmlEntities(extractXmlTag(referXml, "content"));
  const combined = parseQuotedCombinedForward({
    quoteMessage,
    referContent,
    snapshotContent: snapshot.content,
  });
  if (combined) {
    return {
      kind: "text",
      title: collapseText(combined.title || "合并转发的聊天记录", 500),
      text: collapseText(combined.text, 12_000, { preserveNewlines: true }),
      // The URL embedded in a merged-forward card is only WeChat's unsupported
      // viewer placeholder. The useful source material is the record transcript.
      url: "",
      attachmentRefs: [],
    };
  }
  const content = normalizeText(quoteMessage?.parsedContent || quoteMessage?.content)
    || normalizeText(snapshot.content)
    || cleanMessagePlaceholder(referContent);
  const title = normalizeText(snapshot.accountName || snapshot.displayname)
    || cleanMessagePlaceholder(extractXmlTag(referXml, "displayname"));
  const quoteId = normalizeText(snapshot.platformMessageId)
    || normalizeText(quoteMessage?.serverId)
    || cleanMessagePlaceholder(extractXmlTag(referXml, "svrid"));
  if (!quoteId && !content && !title) {
    return null;
  }
  const kind = quoteMessage
    ? (normalizeMediaKind(quoteMessage.mediaType) || inferContentKind(content, quoteMessage.rawContent))
    : inferContentKind(content, referContent);
  return {
    kind,
    title: collapseText(title || defaultKindTitle(kind), 500),
    text: isPlaceholderText(content) ? "" : collapseText(content, 4_000, { preserveNewlines: true }),
    url: extractMessageUrl(quoteMessage || snapshot, normalizeText(quoteMessage?.rawContent) || referContent, content),
    attachmentRefs: [],
  };
}

function parseQuotedCombinedForward({ quoteMessage, referContent, snapshotContent } = {}) {
  const candidates = [
    {
      rawContent: normalizeText(quoteMessage?.rawContent),
      content: normalizeText(quoteMessage?.parsedContent || quoteMessage?.content),
    },
    {
      rawContent: normalizeText(referContent),
      content: normalizeText(snapshotContent),
    },
  ];
  for (const candidate of candidates) {
    if (!isCombinedForwardMessage(candidate.rawContent, candidate.content)) {
      continue;
    }
    const parsed = parseCombinedForward(candidate.rawContent);
    if (parsed?.text && parsed.text !== "[合并转发]") {
      return parsed;
    }
  }
  return null;
}

function isCombinedForwardMessage(rawContent, content) {
  return Number(extractXmlTag(rawContent, "type")) === 19
    || /^\[聊天记录\]$/.test(normalizeText(content));
}

function buildMediaAttachment(raw, origin, attachmentRef) {
  const mediaPath = chooseMediaPath(raw);
  if (!mediaPath) {
    return null;
  }
  return {
    kind: normalizeMediaKind(raw.mediaType) || inferContentKind(raw.content, raw.rawContent),
    path: mediaPath,
    fileName: path.basename(normalizeText(raw.mediaFileName) || mediaPath),
    origin,
    attachmentRef,
  };
}

function chooseMediaPath(raw) {
  const candidates = [
    raw?.mediaLocalPath,
    raw?.imageLocalPath,
    raw?.voiceLocalPath,
    raw?.videoLocalPath,
    raw?.fileLocalPath,
  ]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .map((value) => path.resolve(value))
    .filter((value) => {
      try {
        return fs.statSync(value).isFile();
      } catch {
        return false;
      }
    });
  return candidates.find((value) => !isThumbnailPath(value)) || candidates[0] || "";
}

function parseCombinedForward(rawContent) {
  const record = decodeXmlEntities(extractXmlTag(rawContent, "recorditem"));
  const title = cleanMessagePlaceholder(extractXmlTag(rawContent, "title")) || "合并转发的聊天记录";
  const items = extractXmlBlocks(record, "dataitem");
  const lines = items.map((item) => {
    const source = cleanMessagePlaceholder(extractXmlTag(item, "sourcename"));
    const itemTitle = cleanMessagePlaceholder(extractXmlTag(item, "datatitle"));
    const description = cleanMessagePlaceholder(extractXmlTag(item, "datadesc"));
    const time = cleanMessagePlaceholder(extractXmlTag(item, "sourcetime"));
    const body = [itemTitle, description].filter(Boolean).join(" — ");
    return body ? `${time ? `[${time}] ` : ""}${source ? `${source}: ` : ""}${body}` : "";
  }).filter(Boolean);
  const fallback = cleanMessagePlaceholder(extractXmlTag(record, "info"))
    || cleanMessagePlaceholder(extractXmlTag(rawContent, "des"));
  return {
    title,
    text: lines.length ? `[合并转发]\n${lines.join("\n")}` : (fallback ? `[合并转发]\n${fallback}` : "[合并转发]"),
  };
}

function extractMessageUrl(raw, rawContent, content) {
  const candidates = [
    raw?.url,
    extractXmlTag(rawContent, "url"),
    ...(String(content || "").match(/https?:\/\/[^\s<>'\"]+/gi) || []),
  ];
  for (const candidate of candidates) {
    const normalized = decodeXmlEntities(normalizeText(candidate)).replace(/[）)】\],，。]+$/g, "");
    if (/^https?:\/\//i.test(normalized)) {
      return normalized.slice(0, 2_000);
    }
  }
  return "";
}

function findPushedMessage(messages, push) {
  const rawId = normalizeText(push?.rawid || push?.serverId || push?.id);
  if (rawId) {
    const exact = messages.find((item) => (
      normalizeText(item?.serverId) === rawId || normalizeText(String(item?.localId ?? "")) === rawId
    ));
    if (exact) {
      return exact;
    }
  }
  const timestamp = normalizeEpochSeconds(push?.timestamp || push?.createTime);
  const content = normalizeText(push?.content);
  return messages.find((item) => (
    (!timestamp || normalizeEpochSeconds(item?.createTime) === timestamp)
    && (!content || normalizeText(item?.content) === content || normalizeText(item?.parsedContent) === content)
  )) || null;
}

function extractQuotedCreateTime(rawContent) {
  const referXml = extractXmlTag(rawContent, "refermsg");
  return normalizeEpochSeconds(extractXmlTag(referXml, "createtime"));
}

function messageExpectsMedia(raw) {
  return ["image", "voice", "video", "file"].includes(normalizeMediaKind(raw?.mediaType))
    || [3, 34, 43].includes(Number(raw?.localType));
}

function hasUsableMedia(raw) {
  const mediaPath = chooseMediaPath(raw);
  if (!mediaPath) {
    return false;
  }
  return normalizeMediaKind(raw?.mediaType) !== "image" || !isThumbnailPath(mediaPath);
}

function isThumbnailPath(filePath) {
  return /(?:^|[_-])t(?:\.[^.]+)?$/i.test(path.parse(filePath).name)
    || /(?:^|[\\/])thumb(?:nail)?s?(?:[\\/]|$)/i.test(filePath);
}

function normalizePushData(value) {
  if (value && typeof value === "object") {
    return value.data && typeof value.data === "object" ? value.data : value;
  }
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed?.data && typeof parsed.data === "object" ? parsed.data : parsed;
  } catch {
    return {};
  }
}

async function consumeSseStream(body, onEvent) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const boundary = buffer.match(/\r?\n\r?\n/);
      if (!boundary || boundary.index == null) {
        break;
      }
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const event = parseSseBlock(block);
      if (event) {
        await onEvent(event);
      }
    }
  }
  buffer += decoder.decode();
  const event = parseSseBlock(buffer);
  if (event) {
    await onEvent(event);
  }
}

function parseSseBlock(block) {
  const lines = String(block || "").split(/\r?\n/);
  let event = "message";
  const data = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, "") : "";
    if (field === "event") {
      event = value;
    } else if (field === "data") {
      data.push(value);
    }
  }
  if (!data.length) {
    return null;
  }
  const dataText = data.join("\n");
  try {
    return { event, data: JSON.parse(dataText) };
  } catch {
    return { event, data: dataText };
  }
}

function buildApiUrl(config, pathname) {
  const baseUrl = normalizeText(config?.weflowBaseUrl) || "http://127.0.0.1:5031";
  return new URL(pathname, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function buildHeaders(config, extra = {}) {
  const token = normalizeText(config?.weflowToken);
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

function assertHttpOk(response, label) {
  if (!response?.ok) {
    throw new Error(`${label} returned HTTP ${response?.status || "error"}`);
  }
}

function buildEventKey(eventType, push) {
  const rawId = normalizeText(push?.rawid || push?.serverId || push?.id);
  return rawId ? `${eventType}:${rawId}` : "";
}

function isSentMessage(raw) {
  return raw?.isSend === true || Number(raw?.isSend) === 1;
}

function normalizeMediaKind(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === "audio") {
    return "voice";
  }
  return ["image", "voice", "video", "file"].includes(normalized) ? normalized : "";
}

function inferContentKind(content, rawContent) {
  const text = `${normalizeText(content)}\n${normalizeText(rawContent)}`;
  if (/\[图片\]|<img\b/i.test(text)) return "image";
  if (/\[语音消息?\]|<voicemsg\b/i.test(text)) return "voice";
  if (/\[视频\]|<videomsg\b/i.test(text)) return "video";
  if (/\[文件\]|<appattach>[\s\S]*?<fileext>/i.test(text)) return "file";
  if (/https?:\/\//i.test(text)) return "link";
  return normalizeText(content) ? "text" : "unknown";
}

function defaultKindTitle(kind) {
  return ({ image: "图片", voice: "语音", video: "视频", file: "文件", link: "链接" })[kind] || "";
}

function extractXmlTag(xml, tag) {
  const source = String(xml || "");
  if (!source) return "";
  const escapedTag = String(tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}>`, "i"));
  return match ? decodeXmlEntities(match[1].replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, "")) : "";
}

function extractXmlBlocks(xml, tag) {
  const source = String(xml || "");
  const escapedTag = String(tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...source.matchAll(new RegExp(`<${escapedTag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${escapedTag}>`, "gi"))]
    .map((match) => match[0]);
}

function decodeXmlEntities(value) {
  let text = String(value || "");
  for (let index = 0; index < 3; index += 1) {
    const decoded = text
      .replace(/&#x([0-9a-f]+);/gi, (_match, digits) => decodeXmlCodePoint(digits, 16))
      .replace(/&#([0-9]+);/g, (_match, digits) => decodeXmlCodePoint(digits, 10))
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"")
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
    if (decoded === text) break;
    text = decoded;
  }
  return text;
}

function decodeXmlCodePoint(digits, radix) {
  const codePoint = Number.parseInt(digits, radix);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return "";
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}

function cleanMessagePlaceholder(value) {
  return decodeXmlEntities(String(value || ""))
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function isPlaceholderText(value) {
  return /^\[(?:图片|语音消息?|视频|文件|聊天记录)\]$/.test(normalizeText(value));
}

function collapseText(value, limit, { preserveNewlines = false } = {}) {
  const source = String(value || "");
  const normalized = preserveNewlines
    ? source.split(/\r?\n/).map((line) => line.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n")
    : source.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function normalizeEpochSeconds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed > 10_000_000_000 ? Math.floor(parsed / 1_000) : Math.floor(parsed);
}

function normalizePositiveInt(value, fallback, minimum = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function loadCursorState(filePath) {
  const empty = { version: 1, seenIds: [], lastEventAt: "" };
  const normalizedPath = normalizeText(filePath);
  if (!normalizedPath) return empty;
  try {
    const parsed = JSON.parse(fs.readFileSync(normalizedPath, "utf8"));
    return {
      ...empty,
      seenIds: Array.isArray(parsed?.seenIds)
        ? parsed.seenIds.map(normalizeText).filter(Boolean).slice(-MAX_SEEN_IDS)
        : [],
      lastEventAt: normalizeText(parsed?.lastEventAt),
    };
  } catch {
    return empty;
  }
}

async function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  await fsPromises.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fsPromises.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsPromises.rename(temp, filePath);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error) {
  return error?.name === "AbortError" || /aborted/i.test(String(error?.message || ""));
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  WeFlowInboxSource,
  consumeSseStream,
  fetchMessageDetails,
  normalizeWeFlowMessage,
  parseCombinedForward,
  parseSseBlock,
};
