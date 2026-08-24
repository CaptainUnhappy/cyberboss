const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");

const MAX_SEEN_IDS = 4_000;
const MAX_PENDING_EVENTS = 1_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MESSAGE_LIMIT = 50;
const DEFAULT_OUTGOING_POLL_INTERVAL_MS = 2_000;
const DEFAULT_OUTGOING_REPLAY_WINDOW_MS = 10 * 60_000;
const DEFAULT_OUTGOING_POLL_MAX_REQUESTS = 64;
const DEFAULT_PENDING_RETRY_MAX_MS = 60_000;
const DEFAULT_POLL_STALL_RETRY_MAX_MS = 60_000;
const MEDIA_RETRY_DELAYS_MS = [0, 250, 750, 1_500];

class WeFlowInboxSource {
  constructor({
    config,
    onMessage,
    isReady = () => true,
    fetchImpl = globalThis.fetch,
    logger = console,
    now = () => Date.now(),
  }) {
    this.config = config || {};
    this.onMessage = typeof onMessage === "function" ? onMessage : async () => true;
    this.isReady = typeof isReady === "function" ? isReady : () => true;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.now = typeof now === "function" ? now : () => Date.now();
    this.state = loadCursorState(this.config.weflowInboxCursorFile, {
      chat: this.config.weflowInboxChat,
    });
    this.running = false;
    this.stopping = false;
    this.abortController = null;
    this.loopPromise = null;
    this.outgoingPollAbortController = null;
    this.outgoingPollPromise = null;
    this.pendingEvents = new Map(
      this.state.pendingEvents
        .filter((item) => {
          const chat = normalizeText(item?.push?.sessionId || item?.push?.talker || item?.push?.chatUsername);
          return item?.key
            && !this.state.seenIds.includes(item.key)
            && chat === normalizeText(this.config.weflowInboxChat);
        })
        .map((item) => [item.key, { eventType: item.eventType, push: item.push }])
    );
    this.syncPendingState();
    this.pendingTimer = null;
    this.pendingDrainPromise = null;
    this.pendingRetryAttempt = 0;
    this.pendingRetryNotBeforeMs = 0;
    this.stateWriteChain = Promise.resolve();
  }

  async start() {
    if (this.running) {
      return;
    }
    if (typeof this.fetchImpl !== "function") {
      throw new Error("WeFlow inbox requires fetch support");
    }
    this.stopping = false;
    this.running = true;
    this.loopPromise = this.runLoop().catch((error) => {
      if (this.running && !isAbortError(error)) {
        this.logger.error?.(`[cyberboss] WeFlow inbox stopped: ${formatError(error)}`);
      }
    });
    if (normalizeText(this.config.weflowInboxChat)) {
      this.outgoingPollAbortController = new AbortController();
      this.outgoingPollPromise = this.runOutgoingPollLoop(this.outgoingPollAbortController.signal)
        .catch((error) => {
          if (this.running && !isAbortError(error)) {
            this.logger.error?.(`[cyberboss] WeFlow outgoing poll stopped: ${formatError(error)}`);
          }
        });
    }
  }

  async stop() {
    this.running = false;
    this.stopping = true;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.abortController?.abort();
    this.outgoingPollAbortController?.abort();
    const pendingWork = [
      this.pendingDrainPromise,
      this.loopPromise,
      this.outgoingPollPromise,
      this.stateWriteChain,
    ].filter(Boolean).map((promise) => Promise.resolve(promise).catch(() => {}));
    if (pendingWork.length) {
      let stopTimer = null;
      try {
        await Promise.race([
          Promise.all(pendingWork),
          new Promise((resolve) => {
            stopTimer = setTimeout(resolve, 5_000);
          }),
        ]);
      } finally {
        if (stopTimer) {
          clearTimeout(stopTimer);
        }
      }
    }
    this.abortController = null;
    this.loopPromise = null;
    this.outgoingPollAbortController = null;
    this.outgoingPollPromise = null;
  }

  async runLoop() {
    while (this.running) {
      this.abortController = new AbortController();
      try {
        if (this.pendingEvents.size) {
          await this.drainPendingEvents();
        }
        if (this.pendingEvents.size >= MAX_PENDING_EVENTS) {
          const retryDelayMs = Math.max(
            normalizePositiveInt(
              this.config.weflowReconnectDelayMs,
              DEFAULT_RECONNECT_DELAY_MS,
              100
            ),
            Math.min(
              DEFAULT_PENDING_RETRY_MAX_MS,
              Math.max(0, this.pendingRetryNotBeforeMs - Date.now())
            )
          );
          await delayUntilAbort(retryDelayMs, this.abortController.signal);
          continue;
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

  async runOutgoingPollLoop(signal) {
    let consecutiveFailures = 0;
    while (this.running && !signal.aborted) {
      let retryAfterMs = 0;
      try {
        const result = await this.pollOutgoingMessagesOnce({ signal });
        const nextRetryAtMs = Date.parse(normalizeText(result?.nextRetryAt));
        retryAfterMs = Number.isFinite(nextRetryAtMs)
          ? Math.max(0, nextRetryAtMs - Date.now())
          : 0;
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        if (this.running && !isAbortError(error)) {
          this.logger.error?.(`[cyberboss] WeFlow outgoing poll failed: ${formatError(error)}`);
        }
      }
      if (this.running && !signal.aborted) {
        const baseDelayMs = normalizePositiveInt(
          this.config.weflowOutgoingPollIntervalMs,
          DEFAULT_OUTGOING_POLL_INTERVAL_MS,
          250
        );
        const delayMs = consecutiveFailures
          ? Math.min(60_000, baseDelayMs * (2 ** Math.min(5, consecutiveFailures)))
          : Math.max(baseDelayMs, Math.min(DEFAULT_PENDING_RETRY_MAX_MS, retryAfterMs));
        await delayUntilAbort(delayMs, signal);
      }
    }
  }

  async pollOutgoingMessagesOnce({ signal } = {}) {
    const chat = normalizeText(this.config.weflowInboxChat);
    if (!chat) {
      return { status: "disabled", fetched: 0, queued: 0, processed: 0 };
    }
    if (this.pendingEvents.size >= MAX_PENDING_EVENTS) {
      const pendingResult = await this.drainPendingEvents();
      if (this.pendingEvents.size >= MAX_PENDING_EVENTS) {
        return {
          ...pendingResult,
          status: pendingResult?.status === "cooldown" ? "cooldown" : "backlog",
          fetched: 0,
          queued: 0,
          processed: Number(pendingResult?.processed) || 0,
          backlog: true,
        };
      }
    }
    const rawNowMs = Number(this.now());
    const nowMs = Number.isFinite(rawNowMs) ? rawNowMs : Date.now();
    const nowSeconds = Math.max(0, Math.floor(nowMs / 1_000));
    const replayWindowMs = normalizePositiveInt(
      this.config.weflowOutgoingReplayWindowMs,
      DEFAULT_OUTGOING_REPLAY_WINDOW_MS,
      1_000
    );
    const replayWindowSeconds = Math.max(1, Math.ceil(replayWindowMs / 1_000));
    const cursor = normalizeOutgoingPollCursor(this.state.outgoingPollCursor);
    const cursorRetryNotBeforeMs = Date.parse(cursor.retryNotBefore);
    if (Number.isFinite(cursorRetryNotBeforeMs) && Date.now() < cursorRetryNotBeforeMs) {
      return {
        status: "cooldown",
        fetched: 0,
        queued: 0,
        processed: 0,
        requestCount: 0,
        backfillActive: cursor.backfillActive,
        nextRetryAt: cursor.retryNotBefore,
      };
    }
    const cursorThroughSeconds = cursor.chat === chat ? cursor.polledThrough : 0;
    const replayStartSeconds = cursor.chat === chat && cursor.backfillActive && cursorThroughSeconds
      ? cursorThroughSeconds + 1
      : Math.max(0, (cursorThroughSeconds || nowSeconds) - replayWindowSeconds);
    const limit = normalizePositiveInt(this.config.weflowMessageLimit, DEFAULT_MESSAGE_LIMIT, 1);
    const range = await fetchMessageRangePaginated({
      config: this.config,
      chat,
      startSeconds: replayStartSeconds,
      endSeconds: nowSeconds,
      limit,
      maxRequests: normalizePositiveInt(
        this.config.weflowOutgoingPollMaxRequests,
        DEFAULT_OUTGOING_POLL_MAX_REQUESTS,
        1
      ),
      fetchImpl: this.fetchImpl,
      signal,
    });
    const { rows, requestCount } = range;
    const candidates = rows
      .map((row) => buildPolledMessagePush(row, chat, replayStartSeconds))
      .filter(Boolean)
      .sort(comparePolledPushes);
    let queued = 0;
    let backlog = false;
    let backlogAtSeconds = 0;
    for (const push of candidates) {
      const key = buildEventKey("message.new", push);
      if (!key || this.state.seenIds.includes(key) || this.pendingEvents.has(key)) {
        continue;
      }
      if (this.pendingEvents.size >= MAX_PENDING_EVENTS) {
        backlog = true;
        backlogAtSeconds = normalizeEpochSeconds(push.timestamp);
        break;
      }
      this.pendingEvents.set(key, { eventType: "message.new", push });
      queued += 1;
    }
    const rangeComplete = range.complete && !backlog;
    const safeThrough = backlogAtSeconds
      ? Math.min(range.throughSeconds, Math.max(0, backlogAtSeconds - 1))
      : range.throughSeconds;
    const nextPolledThrough = rangeComplete
      ? nowSeconds
      : Math.max(cursorThroughSeconds, safeThrough);
    const madeCursorProgress = rangeComplete || nextPolledThrough > cursorThroughSeconds;
    const stalled = !rangeComplete && !madeCursorProgress;
    const stallAttempt = stalled ? Math.min(16, cursor.stallAttempt + 1) : 0;
    const retryNotBefore = stalled
      ? new Date(Date.now() + Math.min(
        DEFAULT_POLL_STALL_RETRY_MAX_MS,
        1_000 * (2 ** Math.min(6, stallAttempt - 1))
      )).toISOString()
      : "";
    if (rangeComplete
      || nextPolledThrough > cursorThroughSeconds
      || (!rangeComplete && cursor.chat === chat && !cursor.backfillActive)) {
      this.state.outgoingPollCursor = advanceOutgoingPollCursor({
        previous: cursor.chat === chat ? cursor : null,
        chat,
        polledThrough: nextPolledThrough,
        backfillActive: !rangeComplete,
        candidates,
        stallAttempt,
        retryNotBefore,
      });
    } else if (stalled) {
      this.state.outgoingPollCursor = {
        ...cursor,
        chat,
        backfillActive: true,
        stallAttempt,
        retryNotBefore,
      };
    }
    this.syncPendingState();
    await this.saveState();
    if (!this.pendingEvents.size) {
      return {
        status: backlog ? "backlog" : "ok",
        fetched: rows.length,
        queued: 0,
        processed: 0,
        requestCount,
        backfillActive: !rangeComplete,
        ...(stalled ? { status: "stalled", nextRetryAt: retryNotBefore } : {}),
      };
    }
    const result = await this.drainPendingEvents();
    if (this.pendingEvents.size) {
      this.schedulePendingDrain();
    }
    return {
      ...result,
      fetched: rows.length,
      queued,
      processed: Number(result?.processed) || 0,
      requestCount,
      backlog,
      backfillActive: !rangeComplete,
      ...(stalled ? { status: "stalled", nextRetryAt: retryNotBefore } : {}),
    };
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
    if (this.pendingEvents.size >= MAX_PENDING_EVENTS) {
      this.logger.error?.(
        `[cyberboss] WeFlow pending queue is full (${MAX_PENDING_EVENTS}); reconnecting while poll backfill catches up`
      );
      this.abortController?.abort();
      return { status: "backpressure" };
    }
    this.pendingEvents.set(key, { eventType, push });
    this.syncPendingState();
    await this.saveState();
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
    const delayMs = Math.max(
      250,
      (this.pendingRetryNotBeforeMs || (Date.now() + 1_000)) - Date.now()
    );
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      void this.drainPendingEvents()
        .catch((error) => {
          if (this.running && !isAbortError(error)) {
            this.logger.error?.(`[cyberboss] WeFlow pending retry failed: ${formatError(error)}`);
          }
        })
        .finally(() => {
          if (this.pendingEvents.size) {
            this.schedulePendingDrain();
          }
        });
    }, delayMs);
    this.pendingTimer.unref?.();
  }

  async drainPendingEvents() {
    if (this.pendingDrainPromise) {
      return this.pendingDrainPromise;
    }
    if (this.pendingEvents.size && Date.now() < this.pendingRetryNotBeforeMs) {
      return {
        status: "cooldown",
        processed: 0,
        nextRetryAt: new Date(this.pendingRetryNotBeforeMs).toISOString(),
      };
    }
    const drainPromise = (async () => {
      try {
        const result = await this.drainPendingEventsExclusive();
        this.updatePendingRetryState(result);
        return this.pendingRetryNotBeforeMs && this.pendingEvents.size
          ? { ...result, nextRetryAt: new Date(this.pendingRetryNotBeforeMs).toISOString() }
          : result;
      } catch (error) {
        this.recordPendingRetryFailure();
        throw error;
      }
    })();
    this.pendingDrainPromise = drainPromise;
    try {
      return await drainPromise;
    } finally {
      if (this.pendingDrainPromise === drainPromise) {
        this.pendingDrainPromise = null;
      }
    }
  }

  updatePendingRetryState(result) {
    if (!this.pendingEvents.size || result?.status === "ok") {
      this.pendingRetryAttempt = 0;
      this.pendingRetryNotBeforeMs = 0;
      return;
    }
    if (result?.status === "stopped" || result?.status === "cooldown") {
      return;
    }
    if (Number(result?.processed) > 0) {
      this.pendingRetryAttempt = 0;
    }
    this.recordPendingRetryFailure();
  }

  recordPendingRetryFailure() {
    this.pendingRetryAttempt = Math.min(16, this.pendingRetryAttempt + 1);
    const delayMs = Math.min(
      DEFAULT_PENDING_RETRY_MAX_MS,
      1_000 * (2 ** Math.min(6, this.pendingRetryAttempt - 1))
    );
    this.pendingRetryNotBeforeMs = Date.now() + delayMs;
  }

  async drainPendingEventsExclusive() {
    this.syncPendingState();
    await this.saveState();
    if (!await this.isReady()) {
      return { status: "waiting_for_reply_target", processed: 0 };
    }
    let processed = 0;
    for (const [key, item] of [...this.pendingEvents.entries()]) {
      if (this.state.seenIds.includes(key)) {
        this.pendingEvents.delete(key);
        this.syncPendingState();
        await this.saveState();
        continue;
      }
      if (this.stopping) {
        return { status: "stopped", processed };
      }
      const resolved = await this.resolvePushMessage(item.push);
      if (this.stopping) {
        return { status: "stopped", processed };
      }
      const accepted = await this.onMessage(resolved.message, resolved.snapshot);
      if (this.stopping) {
        return { status: "stopped", processed };
      }
      if (accepted === false) {
        return { status: "deferred", processed };
      }
      processed += 1;
      this.rememberSeen(key);
      this.pendingEvents.delete(key);
      this.syncPendingState();
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
    if (!filePath) {
      return;
    }
    const snapshot = {
      version: 2,
      seenIds: [...this.state.seenIds],
      lastEventAt: this.state.lastEventAt,
      outgoingPollCursor: normalizeOutgoingPollCursor(this.state.outgoingPollCursor),
      pendingEvents: this.state.pendingEvents.map((item) => ({
        key: item.key,
        eventType: item.eventType,
        push: { ...item.push },
      })),
    };
    const write = this.stateWriteChain
      .catch(() => {})
      .then(() => writeJsonAtomic(filePath, snapshot));
    this.stateWriteChain = write;
    await write;
  }

  syncPendingState() {
    this.state.pendingEvents = [...this.pendingEvents.entries()]
      .slice(-MAX_PENDING_EVENTS)
      .map(([key, item]) => ({
        key,
        eventType: normalizeText(item?.eventType) || "message.new",
        push: normalizePushData(item?.push),
      }));
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

function buildPolledMessagePush(row, chat, replayStartSeconds) {
  const rowChat = normalizeText(row?.talker || row?.sessionId || row?.chatUsername);
  if (rowChat && rowChat !== chat) {
    return null;
  }
  const serverId = normalizeText(String(row?.serverId ?? ""));
  const timestamp = normalizeEpochSeconds(row?.createTime || row?.timestamp);
  if (!serverId || !timestamp || timestamp < replayStartSeconds) {
    return null;
  }
  return {
    sessionId: chat,
    talker: chat,
    rawid: serverId,
    serverId,
    timestamp,
    createTime: timestamp,
    localId: Number.parseInt(row?.localId, 10) || 0,
    isSend: isSentMessage(row) ? 1 : 0,
    localType: Number(row?.localType) || 0,
    senderUsername: normalizeText(row?.senderUsername),
    content: normalizeText(row?.content),
    parsedContent: normalizeText(row?.parsedContent),
    rawContent: normalizeText(row?.rawContent),
  };
}

function comparePolledPushes(left, right) {
  return normalizeEpochSeconds(left?.timestamp) - normalizeEpochSeconds(right?.timestamp)
    || (Number(left?.localId) || 0) - (Number(right?.localId) || 0)
    || normalizeText(left?.serverId).localeCompare(normalizeText(right?.serverId));
}

async function fetchMessageRangePaginated({
  config,
  chat,
  startSeconds,
  endSeconds,
  limit,
  maxRequests,
  fetchImpl,
  signal,
}) {
  let requestCount = 0;
  const requestRange = async (rangeStart, rangeEnd, offset = 0) => {
    if (requestCount >= maxRequests) {
      return null;
    }
    requestCount += 1;
    const params = new URLSearchParams({
      talker: chat,
      limit: String(limit),
      start: String(rangeStart),
      end: String(rangeEnd),
    });
    if (offset > 0) {
      params.set("offset", String(offset));
    }
    const response = await fetchImpl(buildApiUrl(config, `/api/v1/messages?${params}`), {
      headers: buildHeaders(config),
      signal,
    });
    assertHttpOk(response, "WeFlow outgoing message poll");
    const payload = await response.json();
    const rows = Array.isArray(payload?.messages)
      ? payload.messages.filter((item) => item && typeof item === "object")
      : [];
    return { rows, hasMore: payload?.hasMore === true };
  };

  const fetchSingleSecond = async (timestamp, firstPage) => {
    const rows = [...firstPage.rows];
    let page = firstPage;
    let offset = page.rows.length;
    while (page.hasMore) {
      page = await requestRange(timestamp, timestamp, offset);
      if (!page) {
        return { rows: [], complete: false, throughSeconds: timestamp - 1 };
      }
      if (!page.rows.length) {
        throw new Error(`WeFlow outgoing pagination made no progress at ${timestamp} offset ${offset}`);
      }
      rows.push(...page.rows);
      offset += page.rows.length;
    }
    return { rows, complete: true, throughSeconds: timestamp };
  };

  const fetchRange = async (rangeStart, rangeEnd) => {
    const page = await requestRange(rangeStart, rangeEnd);
    if (!page) {
      return { rows: [], complete: false, throughSeconds: rangeStart - 1 };
    }
    if (!page.hasMore) {
      return { rows: page.rows, complete: true, throughSeconds: rangeEnd };
    }
    if (rangeStart >= rangeEnd) {
      return fetchSingleSecond(rangeStart, page);
    }
    const midpoint = rangeStart + Math.floor((rangeEnd - rangeStart) / 2);
    const older = await fetchRange(rangeStart, midpoint);
    if (!older.complete) {
      return older;
    }
    const newer = await fetchRange(midpoint + 1, rangeEnd);
    return {
      rows: [...older.rows, ...newer.rows],
      complete: newer.complete,
      throughSeconds: newer.complete ? rangeEnd : newer.throughSeconds,
    };
  };

  const fetched = await fetchRange(startSeconds, Math.max(startSeconds, endSeconds));
  const deduplicated = new Map();
  for (const row of fetched.rows) {
    const serverId = normalizeText(String(row?.serverId ?? row?.rawid ?? row?.id ?? ""));
    const localId = Number.parseInt(row?.localId, 10) || 0;
    const timestamp = normalizeEpochSeconds(row?.createTime || row?.timestamp);
    const key = serverId || `${timestamp}:${localId}:${normalizeText(row?.content || row?.parsedContent)}`;
    if (key && !deduplicated.has(key)) {
      deduplicated.set(key, row);
    }
  }
  return {
    rows: [...deduplicated.values()],
    requestCount,
    complete: fetched.complete,
    throughSeconds: Math.max(0, normalizeEpochSeconds(fetched.throughSeconds)),
  };
}

function normalizeOutgoingPollCursor(value) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    chat: normalizeText(raw.chat),
    polledThrough: normalizeEpochSeconds(raw.polledThrough),
    backfillActive: raw.backfillActive === true,
    latestTimestamp: normalizeEpochSeconds(raw.latestTimestamp),
    latestLocalId: Number.parseInt(raw.latestLocalId, 10) || 0,
    latestServerId: normalizeText(raw.latestServerId),
    stallAttempt: Math.max(0, Number.parseInt(raw.stallAttempt, 10) || 0),
    retryNotBefore: normalizeIsoDate(raw.retryNotBefore),
  };
}

function advanceOutgoingPollCursor({
  previous,
  chat,
  polledThrough,
  backfillActive = false,
  candidates,
  stallAttempt = 0,
  retryNotBefore = "",
}) {
  const prior = normalizeOutgoingPollCursor(previous);
  const latest = [...(Array.isArray(candidates) ? candidates : [])].sort(comparePolledPushes).pop() || null;
  const latestTimestamp = normalizeEpochSeconds(latest?.timestamp);
  const priorTuple = {
    timestamp: prior.latestTimestamp,
    localId: prior.latestLocalId,
    serverId: prior.latestServerId,
  };
  const latestTuple = {
    timestamp: latestTimestamp,
    localId: Number(latest?.localId) || 0,
    serverId: normalizeText(latest?.serverId),
  };
  const selected = latest && comparePolledPushes(latestTuple, priorTuple) >= 0 ? latestTuple : priorTuple;
  return {
    chat: normalizeText(chat),
    polledThrough: normalizeEpochSeconds(polledThrough),
    backfillActive: Boolean(backfillActive),
    latestTimestamp: normalizeEpochSeconds(selected.timestamp),
    latestLocalId: Number(selected.localId) || 0,
    latestServerId: normalizeText(selected.serverId),
    stallAttempt: Math.max(0, Number.parseInt(stallAttempt, 10) || 0),
    retryNotBefore: normalizeIsoDate(retryNotBefore),
  };
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

function loadCursorState(filePath, { chat = "" } = {}) {
  const empty = {
    version: 2,
    seenIds: [],
    lastEventAt: "",
    pendingEvents: [],
    outgoingPollCursor: normalizeOutgoingPollCursor(null),
  };
  const normalizedPath = normalizeText(filePath);
  if (!normalizedPath) return empty;
  try {
    const parsed = JSON.parse(fs.readFileSync(normalizedPath, "utf8"));
    const lastEventAt = normalizeText(parsed?.lastEventAt);
    const persistedPollCursor = normalizeOutgoingPollCursor(parsed?.outgoingPollCursor);
    const migratedPollCursor = !persistedPollCursor.chat && lastEventAt
      ? buildLegacyOutgoingPollCursor({ chat, lastEventAt })
      : persistedPollCursor;
    return {
      ...empty,
      seenIds: Array.isArray(parsed?.seenIds)
        ? parsed.seenIds.map(normalizeText).filter(Boolean).slice(-MAX_SEEN_IDS)
        : [],
      lastEventAt,
      outgoingPollCursor: migratedPollCursor,
      pendingEvents: Array.isArray(parsed?.pendingEvents)
        ? parsed.pendingEvents
          .map((item) => {
            const eventType = normalizeText(item?.eventType) || "message.new";
            const push = normalizePushData(item?.push);
            const key = normalizeText(item?.key) || buildEventKey(eventType, push);
            return eventType === "message.new" && key ? { key, eventType, push } : null;
          })
          .filter(Boolean)
          .slice(-MAX_PENDING_EVENTS)
        : [],
    };
  } catch {
    return empty;
  }
}

function buildLegacyOutgoingPollCursor({ chat, lastEventAt }) {
  const normalizedChat = normalizeText(chat);
  const lastEventMs = Date.parse(normalizeText(lastEventAt));
  if (!normalizedChat || !Number.isFinite(lastEventMs) || lastEventMs <= 0) {
    return normalizeOutgoingPollCursor(null);
  }
  const lastEventSeconds = Math.floor(lastEventMs / 1_000);
  return normalizeOutgoingPollCursor({
    chat: normalizedChat,
    // The v1 cursor only recorded wall-clock receipt time. Start at the same
    // second (rather than the following one) and let persisted serverId keys
    // remove overlap, so an event racing the old save is still recovered.
    polledThrough: Math.max(0, lastEventSeconds - 1),
    backfillActive: true,
  });
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

function delayUntilAbort(ms, signal) {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal?.addEventListener("abort", finish, { once: true });

    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
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

function normalizeIsoDate(value) {
  const normalized = normalizeText(value);
  return normalized && Number.isFinite(Date.parse(normalized)) ? normalized : "";
}

module.exports = {
  WeFlowInboxSource,
  consumeSseStream,
  fetchMessageDetails,
  normalizeWeFlowMessage,
  parseCombinedForward,
  parseSseBlock,
};
