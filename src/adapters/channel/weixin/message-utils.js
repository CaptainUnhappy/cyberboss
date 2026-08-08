const MESSAGE_TYPE_USER = 1;
const MESSAGE_TYPE_BOT = 2;
const MESSAGE_ITEM_TEXT = 1;
const MESSAGE_ITEM_IMAGE = 2;
const MESSAGE_ITEM_VOICE = 3;
const MESSAGE_ITEM_FILE = 4;
const MESSAGE_ITEM_VIDEO = 5;
const DEDUP_TTL_MS = 5 * 60_000;

function createInboundFilter() {
  const seen = new Map();

  return {
    normalize(message, config, accountId) {
      if (!message || typeof message !== "object") {
        return null;
      }
      const messageType = Number(message.message_type);
      if (messageType === MESSAGE_TYPE_BOT) {
        return null;
      }
      if (messageType !== 0 && messageType !== MESSAGE_TYPE_USER) {
        return null;
      }

      const senderId = normalizeText(message.from_user_id);
      if (!senderId) {
        return null;
      }

      const createdAtMs = normalizeMessageTimestampMs(message);

      const dedupKey = buildDedupKey(message, senderId, createdAtMs);
      pruneSeen(seen);
      if (dedupKey && seen.has(dedupKey)) {
        return null;
      }
      if (dedupKey) {
        seen.set(dedupKey, Date.now());
      }

      const itemList = Array.isArray(message.item_list) ? message.item_list : [];
      const messageId = normalizeMessageId(message);
      const text = bodyFromItemList(itemList, { includeQuotedText: false });
      const directAttachments = extractAttachmentItems(itemList, { origin: "direct" });
      const quoted = extractQuotedItems(itemList, {
        referenceScope: messageId || String(createdAtMs || "message"),
      });
      const attachments = [...directAttachments, ...quoted.attachments];
      const sharedContent = extractDirectSharedContentMetadata(itemList, text, directAttachments);
      if (!text && !attachments.length && !quoted.contexts.length && !sharedContent.sharedContent) {
        return null;
      }

      return {
        provider: "weixin",
        accountId,
        workspaceId: config.workspaceId,
        senderId,
        chatId: senderId,
        messageId,
        threadKey: normalizeText(message.session_id),
        text,
        attachments,
        quotedContexts: quoted.contexts,
        ...sharedContent,
        contextToken: normalizeText(message.context_token),
        receivedAt: createdAtMs > 0 ? new Date(createdAtMs).toISOString() : new Date().toISOString(),
      };
    },
  };
}

function bodyFromItemList(items, { includeQuotedText = true } = {}) {
  if (!Array.isArray(items) || !items.length) {
    return "";
  }
  for (const item of items) {
    const itemType = Number(item?.type);
    if (itemType === MESSAGE_ITEM_TEXT) {
      const text = normalizeText(item?.text_item?.text);
      if (!text) {
        continue;
      }
      const ref = includeQuotedText ? item?.ref_msg : null;
      if (!ref || !ref.message_item || isMediaItemType(Number(ref.message_item.type))) {
        return text;
      }
      const parts = [];
      const refTitle = normalizeText(ref.title);
      if (refTitle) {
        parts.push(refTitle);
      }
      const refBody = bodyFromItemList([ref.message_item]);
      if (refBody) {
        parts.push(refBody);
      }
      if (!parts.length) {
        return text;
      }
      return `[Quoted: ${parts.join(" | ")}]\n${text}`;
    }
    if (itemType === MESSAGE_ITEM_VOICE) {
      const voiceText = normalizeText(item?.voice_item?.text);
      if (voiceText) {
        return voiceText;
      }
    }
  }
  return "";
}

function extractQuotedItems(itemList, { referenceScope = "" } = {}) {
  const contexts = [];
  const attachments = [];
  if (!Array.isArray(itemList) || !itemList.length) {
    return { contexts, attachments };
  }

  for (const item of itemList) {
    const ref = item?.ref_msg;
    const messageItem = ref?.message_item;
    if (!ref || !messageItem || typeof messageItem !== "object") {
      continue;
    }

    const quoteIndex = contexts.length;
    const normalizedScope = normalizeReferenceScope(referenceScope);
    const attachmentRef = `quoted:${normalizedScope ? `${normalizedScope}:` : ""}${quoteIndex}`;
    const attachment = normalizeAttachmentItem(messageItem, attachments.length, {
      origin: "quoted",
      quoteIndex,
      attachmentRef,
    });
    if (attachment) {
      attachments.push(attachment);
    }

    const link = extractKnownLink(messageItem);
    const text = extractQuotedText(messageItem, link);
    const title = normalizeText(ref.title) || link.title;
    contexts.push({
      kind: inferQuotedKind(messageItem, link),
      title,
      text,
      url: link.url,
      attachmentRefs: attachment ? [attachmentRef] : [],
    });
  }

  return { contexts, attachments };
}

function inferQuotedKind(messageItem, link) {
  if (link.url) {
    return "link";
  }
  const itemType = Number(messageItem?.type);
  if (itemType === MESSAGE_ITEM_TEXT) {
    return "text";
  }
  if (itemType === MESSAGE_ITEM_IMAGE) {
    return "image";
  }
  if (itemType === MESSAGE_ITEM_VOICE) {
    return "voice";
  }
  if (itemType === MESSAGE_ITEM_FILE) {
    return "file";
  }
  if (itemType === MESSAGE_ITEM_VIDEO) {
    return "video";
  }
  return "unknown";
}

function extractQuotedText(messageItem, link) {
  const itemType = Number(messageItem?.type);
  if (itemType === MESSAGE_ITEM_TEXT || itemType === MESSAGE_ITEM_VOICE) {
    return bodyFromItemList([messageItem], { includeQuotedText: false });
  }
  return normalizeText(
    link.description
    || messageItem?.file_item?.file_name
    || messageItem?.file_item?.filename
    || messageItem?.video_item?.file_name
    || messageItem?.video_item?.filename
  );
}

function extractKnownLink(messageItem) {
  const candidates = [
    messageItem?.link_item,
    messageItem?.url_item,
    messageItem?.app_item,
    messageItem?.text_item?.link,
  ].filter((value) => value && typeof value === "object");

  let url = "";
  let title = "";
  let description = "";
  for (const candidate of candidates) {
    url ||= normalizeHttpUrl(candidate.url || candidate.link || candidate.href || candidate.web_url);
    title ||= normalizeText(candidate.title || candidate.name);
    description ||= normalizeText(candidate.description || candidate.desc || candidate.summary);
  }

  const text = normalizeText(messageItem?.text_item?.text);
  url ||= extractHttpUrl(text);
  return { url, title, description };
}

function extractDirectSharedContentMetadata(itemList, text, directAttachments) {
  const items = Array.isArray(itemList) ? itemList : [];
  const attachments = Array.isArray(directAttachments) ? directAttachments : [];
  const structuredLink = items
    .map((item) => extractKnownLink(item))
    .find((item) => item.url) || { url: "", title: "", description: "" };
  const plainUrl = structuredLink.url || extractHttpUrl(text);
  const attachmentKind = attachments.map((item) => normalizeText(item?.kind).toLowerCase()).find(Boolean) || "";
  const hasVoiceItem = items.some((item) => Number(item?.type) === MESSAGE_ITEM_VOICE);
  const contentKind = attachmentKind || (hasVoiceItem ? "voice" : "") || (plainUrl ? "link" : "");
  if (!contentKind) {
    return {
      contentKind: "",
      contentTitle: "",
      contentText: "",
      contentUrl: "",
      sharedContent: false,
      explicitPrompt: Boolean(normalizeText(text)),
    };
  }

  const textItems = items
    .filter((item) => Number(item?.type) === MESSAGE_ITEM_TEXT)
    .map((item) => normalizeText(item?.text_item?.text))
    .filter(Boolean);
  const linkContentText = normalizeText(structuredLink.description || structuredLink.title || text);
  const structuredLinkText = new Set([
    normalizeComparableText(structuredLink.title),
    normalizeComparableText(structuredLink.description),
    normalizeComparableText([structuredLink.title, structuredLink.description].filter(Boolean).join(" ")),
  ].filter(Boolean));
  const explicitPrompt = textItems.some((itemText) => {
    const withoutUrls = normalizeComparableText(itemText.replace(/https?:\/\/[^\s<>"']+/giu, " "));
    if (!withoutUrls) {
      return false;
    }
    return !structuredLinkText.has(withoutUrls);
  });

  return {
    contentKind,
    contentTitle: normalizeText(structuredLink.title || attachments[0]?.fileName),
    contentText: contentKind === "link" || contentKind === "voice" ? linkContentText : "",
    contentUrl: plainUrl,
    sharedContent: true,
    explicitPrompt,
  };
}

function extractHttpUrl(value) {
  const match = normalizeText(value).match(/https?:\/\/[^\s<>"']+/iu);
  return match ? normalizeHttpUrl(match[0]) : "";
}

function normalizeHttpUrl(value) {
  const normalized = normalizeText(value);
  return /^https?:\/\//iu.test(normalized) ? normalized : "";
}

function normalizeReferenceScope(value) {
  return normalizeText(value).replace(/[^a-z0-9_.-]+/giu, "_").slice(0, 80);
}

function isMediaItemType(type) {
  return type === MESSAGE_ITEM_IMAGE || type === MESSAGE_ITEM_VOICE || type === MESSAGE_ITEM_FILE || type === MESSAGE_ITEM_VIDEO;
}

function extractAttachmentItems(itemList, metadata = {}) {
  if (!Array.isArray(itemList) || !itemList.length) {
    return [];
  }

  const attachments = [];
  for (let index = 0; index < itemList.length; index += 1) {
    const normalized = normalizeAttachmentItem(itemList[index], index, metadata);
    if (normalized) {
      attachments.push(normalized);
    }
  }
  return attachments;
}

function normalizeAttachmentItem(item, index, {
  origin = "direct",
  quoteIndex = null,
  attachmentRef = "",
} = {}) {
  const itemType = Number(item?.type);
  const payload = resolveAttachmentPayload(itemType, item);
  if (!payload) {
    return null;
  }

  const media = payload.media && typeof payload.media === "object"
    ? payload.media
    : {};

  return {
    kind: payload.kind,
    origin: origin === "quoted" ? "quoted" : "direct",
    quoteIndex: Number.isInteger(quoteIndex) && quoteIndex >= 0 ? quoteIndex : null,
    attachmentRef: normalizeText(attachmentRef),
    itemType,
    index,
    fileName: normalizeText(
      payload.body?.file_name
      || payload.body?.filename
      || item?.file_name
      || item?.filename
    ),
    sizeBytes: parseOptionalInt(
      payload.body?.len
      || payload.body?.file_size
      || payload.body?.size
      || payload.body?.video_size
      || item?.len
    ),
    directUrls: collectStringValues([
      payload.body?.url,
      payload.body?.download_url,
      payload.body?.cdn_url,
      media?.url,
      media?.download_url,
      media?.cdn_url,
    ]),
    mediaRef: {
      encryptQueryParam: normalizeText(
        media?.encrypt_query_param
        || media?.encrypted_query_param
        || payload.body?.encrypt_query_param
        || payload.body?.encrypted_query_param
        || item?.encrypt_query_param
        || item?.encrypted_query_param
      ),
      aesKey: normalizeText(
        media?.aes_key
        || payload.body?.aes_key
        || item?.aes_key
      ),
      aesKeyHex: normalizeText(
        payload.body?.aeskey
        || payload.body?.aes_key_hex
        || item?.aeskey
      ),
      encryptType: Number(
        media?.encrypt_type
        ?? payload.body?.encrypt_type
        ?? item?.encrypt_type
        ?? 1
      ),
      fileKey: normalizeText(
        media?.filekey
        || payload.body?.filekey
        || item?.filekey
      ),
    },
  };
}

function resolveAttachmentPayload(itemType, item) {
  if (itemType === MESSAGE_ITEM_IMAGE && item?.image_item && typeof item.image_item === "object") {
    return { kind: "image", body: item.image_item, media: item.image_item.media };
  }
  if (itemType === MESSAGE_ITEM_FILE && item?.file_item && typeof item.file_item === "object") {
    return { kind: "file", body: item.file_item, media: item.file_item.media };
  }
  if (itemType === MESSAGE_ITEM_VIDEO && item?.video_item && typeof item.video_item === "object") {
    return { kind: "video", body: item.video_item, media: item.video_item.media };
  }
  return null;
}

function collectStringValues(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function parseOptionalInt(value) {
  if (value == null || value === "") {
    return 0;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeMessageId(message) {
  const raw = message?.message_id;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }
  if (typeof raw === "string") {
    return raw.trim();
  }
  return "";
}

function normalizeMessageTimestampMs(message) {
  const rawMs = Number(message?.create_time_ms);
  if (Number.isFinite(rawMs) && rawMs > 0) {
    return rawMs;
  }
  const rawSeconds = Number(message?.create_time);
  if (Number.isFinite(rawSeconds) && rawSeconds > 0) {
    return rawSeconds * 1000;
  }
  return 0;
}

function buildDedupKey(message, senderId, createdAtMs) {
  const seq = normalizeNumeric(message?.seq);
  const messageId = normalizeNumeric(message?.message_id);
  const clientId = normalizeText(message?.client_id);
  const parts = [senderId, messageId, seq, createdAtMs || 0, clientId];
  return parts.join("|");
}

function normalizeNumeric(value) {
  const num = Number(value);
  return Number.isFinite(num) ? String(num) : "0";
}

function pruneSeen(seen) {
  const now = Date.now();
  for (const [key, timestamp] of seen.entries()) {
    if (now - timestamp > DEDUP_TTL_MS) {
      seen.delete(key);
    }
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeComparableText(value) {
  return normalizeText(value).replace(/\s+/gu, " ").toLowerCase();
}

module.exports = {
  createInboundFilter,
  bodyFromItemList,
  extractQuotedItems,
};
