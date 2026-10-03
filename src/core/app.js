const os = require("os");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const { createWeixinChannelAdapter } = require("../adapters/channel/weixin");
const { probeChannels, summarizeChannels } = require("./doctor-probes");
const { DEFAULT_MIN_WEIXIN_CHUNK, MAX_MIN_WEIXIN_CHUNK } = require("../adapters/channel/weixin/config-store");
const { persistIncomingWeixinAttachments } = require("../adapters/channel/weixin/media-receive");
const { createCodexRuntimeAdapter } = require("../adapters/runtime/codex");
const { createClaudeCodeRuntimeAdapter } = require("../adapters/runtime/claudecode");
const { createDshRuntimeAdapter } = require("../adapters/runtime/dsh");
const { createDshAcpRuntimeAdapter } = require("../adapters/runtime/dsh-acp");
const { findModelByQuery } = require("../adapters/runtime/codex/model-catalog");
const { createTimelineIntegration } = require("../integrations/timeline");
const {
  WechatCliInboxSource,
  persistLocalWechatAttachments,
} = require("../integrations/wechat-cli-inbox");
const { WeFlowInboxSource } = require("../integrations/weflow-inbox");
const { WeFlowCanaryInboxSource } = require("../integrations/weflow-canary-inbox");
const { WeFlowMessageLedgerStore } = require("../integrations/weflow-message-ledger-store");
const { WeFlowHeartbeatCanary } = require("../integrations/weflow-heartbeat-canary");
const {
  MODEL_CANARY_DELIVERY_POLICY,
  MODEL_CANARY_EXECUTION_POLICY,
  WeFlowModelCanary,
} = require("../integrations/weflow-model-canary");
const {
  executeWeFlowControlCommand,
  formatWeFlowControlConfirmation,
  isWeFlowControlConfirmation,
  isWeFlowControlCommand,
  resolveWeFlowSendSource,
} = require("../integrations/weflow-outbound");
const {
  assembleRuntimeTurnText,
  buildInboundDraft,
  buildImplicitReferencedPrepared,
  buildMergedInboundPrepared,
  clonePreparedInboundMessage,
  isSharedContentOnlyPreparedMessage,
  resolveLocalInboxIdentity,
  resolveReplyProvider,
  shouldBatchImageOnlyInbound,
  takeImageOnlyBatchMessages,
} = require("./inbound-turn");
const { resolveVisionContext } = require("../services/vision-context");
const {
  VoiceTranscriptionService,
  enrichMessageWithVoiceTranscripts,
} = require("../services/voice-transcription");
const {
  buildWeixinHelpText,
} = require("./command-registry");
const { CheckinConfigStore, parseCheckinRangeMinutes, resolveDefaultCheckinRange } = require("./checkin-config-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("./default-targets");
const { StreamDelivery } = require("./stream-delivery");
const { ThreadStateStore } = require("./thread-state-store");
const { DeferredSystemReplyStore } = require("./deferred-system-reply-store");
const { DeferredReplyRetryScheduler } = require("./deferred-reply-retry-scheduler");
const { SystemMessageQueueStore } = require("./system-message-queue-store");
const { SystemMessageDispatcher } = require("./system-message-dispatcher");
const { TimelineScreenshotQueueStore } = require("./timeline-screenshot-queue-store");
const { TurnGateStore } = require("./turn-gate-store");
const { PendingInboundStore } = require("./pending-inbound-store");
const { materializeGeneratedImageArtifact } = require("./generated-image-artifact");
const { PipelineActivityStore } = require("./pipeline-activity-store");
const { ReplyObligationStore } = require("./reply-obligation-store");
const { assertWeFlowCanaryTalkerIsolation } = require("./config");
const { ReminderQueueStore } = require("../adapters/channel/weixin/reminder-queue-store");
const {
  matchesCommandPrefix,
  canonicalizeCommandTokens,
  extractApprovalFilePaths,
  isPathWithinRoot,
  normalizeCommandTokens,
  splitCommandLine,
} = require("../adapters/runtime/shared/approval-command");
const { runSystemCheckinPoller } = require("../app/system-checkin-poller");
const { createProjectTooling } = require("../tools/create-project-tooling");
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MIN_LONG_POLL_TIMEOUT_MS = 2_000;
const SESSION_EXPIRED_ERRCODE = -14;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const INBOUND_ACK_CERTAIN_RETRY_DELAY_MS = 750;
const MAX_INBOUND_STICKER_IMAGE_BATCH = 10;
const MAX_PENDING_INBOUND_BATCH_MESSAGES = 20;
const MAX_PENDING_INBOUND_BATCH_TEXT_CHARS = 24_000;
const MAX_PENDING_INBOUND_BATCH_ATTACHMENTS = 10;
const PENDING_INBOUND_COMMIT_RETRY_BASE_MS = 15_000;
const PENDING_INBOUND_COMMIT_RETRY_MAX_MS = 5 * 60_000;
const WEFLOW_STARTUP_REVOKE_RECONCILE_TIMEOUT_MS = 2_000;
// Orphaned atomic-write temporaries older than this are collected at startup
// and then periodically, because this process runs for days at a time.
// Generous so an in-flight write from another process is never mistaken for one.
const STALE_TEMP_FILE_GRACE_MS = 60 * 60_000;
// How often the long-running loop re-runs that collection. The startup sweep
// alone let a multi-day run accumulate temporaries between restarts.
const STALE_TEMP_FILE_SWEEP_INTERVAL_MS = 60 * 60_000;
const WEFLOW_PENDING_REVOKE_GATE_POLL_MS = 100;
const WEFLOW_UIA_INBOUND_ACK_TEXT = "处理中";
const REMINDER_INBOUND_ACK_TEXT = "已记录";
// Consecutive messages from one chat each claimed their own acknowledgement, so a
// burst answered every message with "处理中". The first ack is what tells the user the
// bot is working; the rest of one collected burst is the same logical message and must
// not answer twice (operator request 2026-09-29: 第一时间回，但同一条连续消息只回一条).
// The burst is exactly the collection window that decides the dispatched batch
// (pendingInboundQuietWindowMs), so the ack always covers what the turn really gets.
// Suppression runs before the claim so no message is left half-handled.
const WEFLOW_UIA_INBOUND_ACK_QUIET_WINDOW_FALLBACK_MS = 15_000;
const SILENT_DELIVERY_POLICY = "silent";
// An inbound attachment the source could not obtain at all (see
// resolveUnexportableMediaReason in the WeFlow inbox). The operator gets a direct
// notice instead of a turn that depends on the model explaining the failure.
const UNREADABLE_INTAKE_FAILURE_CODE = "media_export_unavailable";

function createRuntimeAdapter(config) {
  if (config.runtime === "claudecode") {
    return createClaudeCodeRuntimeAdapter(config);
  }
  if (config.runtime === "dsh-acp") {
    // The ACP surface keeps one resumable session per chat window; the legacy
    // `dsh` surface stays available for a one-variable rollback.
    return createDshAcpRuntimeAdapter(config);
  }
  if (config.runtime === "dsh") {
    return createDshRuntimeAdapter(config);
  }
  return createCodexRuntimeAdapter(config);
}

class CyberbossApp {
  constructor(config) {
    this.config = config;
    this.weflowMessageLedger = new WeFlowMessageLedgerStore({
      filePath: config.weflowMessageLedgerFile || path.join(config.stateDir, "weflow-message-ledger.json"),
    });
    this.replyObligationStore = new ReplyObligationStore({
      filePath: config.replyObligationFile || path.join(config.stateDir, "reply-obligations.json"),
      noReplyTimeoutMs: config.replyObligationTimeoutMs,
    });
    this.channelAdapter = createWeixinChannelAdapter(config, {
      weflowMessageLedger: this.weflowMessageLedger,
    });
    this.weflowHeartbeatCanary = new WeFlowHeartbeatCanary({
      config,
      channelAdapter: this.channelAdapter,
      messageLedger: this.weflowMessageLedger,
    });
    this.weflowModelCanary = new WeFlowModelCanary({
      config,
      onTrigger: (payload) => this.handleWeFlowModelCanaryTrigger(payload),
    });
    this.timelineIntegration = createTimelineIntegration(config);
    const projectTooling = createProjectTooling(config, {
      channelAdapter: this.channelAdapter,
      timelineIntegration: this.timelineIntegration,
      weflowMessageLedger: this.weflowMessageLedger,
    });
    this.projectServices = projectTooling.services;
    this.projectToolHost = projectTooling.toolHost;
    this.runtimeContextStore = projectTooling.runtimeContextStore;
    this.runtimeAdapter = createRuntimeAdapter(config);
    this.threadStateStore = new ThreadStateStore();
    this.systemMessageQueue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
    this.deferredSystemReplyQueue = new DeferredSystemReplyStore({ filePath: config.deferredSystemReplyQueueFile });
    this.checkinConfigStore = new CheckinConfigStore({ filePath: config.checkinConfigFile });
    this.timelineScreenshotQueue = new TimelineScreenshotQueueStore({ filePath: config.timelineScreenshotQueueFile });
    this.reminderQueue = new ReminderQueueStore({ filePath: config.reminderQueueFile });
    this.turnGateStore = new TurnGateStore();
    this.pendingInboundStore = new PendingInboundStore({
      filePath: config.pendingInboundQueueFile || path.join(config.stateDir, "pending-inbound.json"),
      quietWindowMs: config.pendingInboundQuietWindowMs,
    });
    this.pendingInboundByScope = this.pendingInboundStore.snapshotMap();
    this.pendingInboundFlushScopeKeys = new Set();
    this.pendingInboundFlushTimers = new Map();
    this.pendingInboundPostDispatchCommits = new Map();
    this.pendingSharedContentInboundByScope = this.pendingInboundStore.snapshotSharedMap();
    this.turnBoundaryScopeKeys = new Set();
    this.systemMessageDispatcher = null;
    this.wechatCliInboxSource = null;
    this.weflowInboxSource = null;
    this.wechatCuaInboxSource = null;
    this.wechatDbInboxSource = null;
    this.wechatDbWorker = null;
    this.weflowCanaryInboxSource = null;
    this.voiceTranscriptionService = new VoiceTranscriptionService({ config });
    this.streamDelivery = new StreamDelivery({
      channelAdapter: this.channelAdapter,
      sessionStore: this.runtimeAdapter.getSessionStore(),
      runtimeId: this.runtimeAdapter.describe().id,
      onDeferredSystemReply: (payload) => this.deferSystemReply(payload),
      onReplyDeliveryStarted: (payload) => this.replyObligationStore.markFinalDeliveryStarted(
        payload.replyObligationId,
        payload
      ),
      onReplyDeliveryVerified: (payload) => this.replyObligationStore.markVerified(
        payload.replyObligationId,
        payload
      ),
      onReplyDeliveryDeferred: (payload) => this.replyObligationStore.markDeferred(
        payload.replyObligationId,
        payload
      ),
      onReplyDeliveryFailed: (payload) => this.replyObligationStore.markDeliveryFailure(
        payload.replyObligationId,
        payload
      ),
      onReplyTurnCompleted: (payload) => {
        const entry = this.replyObligationStore.markTurnCompleted(
          payload.replyObligationId,
          payload
        );
        // A turn can complete while producing no final reply at all - most
        // commonly when the runtime itself is unusable (expired credentials, a
        // dead connection). Nothing else on this path tells the user, so the
        // message would otherwise vanish right after the processing
        // acknowledgement. Report it instead of failing silently; background and
        // probe turns are suppressed inside sendFailureToThread.
        if (entry && entry.terminalOutcome === "turn_completed_without_final") {
          this.notifyTerminalReplyFailure(entry).catch(() => {});
        }
        return entry;
      },
      onReplyTurnFailed: (payload) => this.replyObligationStore.markRuntimeFailed(
        payload.replyObligationId,
        payload
      ),
      onReplyExplicitSilent: (payload) => this.replyObligationStore.markExplicitSilent(
        payload.replyObligationId
      ),
      onModelCanaryEvent: (payload) => this.weflowModelCanary.handleDeliveryEvent(payload),
    });
    this.pendingOperationByRunKey = new Map();
    this.pipelineActivity = new PipelineActivityStore({
      filePath: config.pipelineActivityFile || path.join(config.stateDir, "cyberboss-pipeline-activity.json"),
      snapshotProvider: () => this.buildPipelineActivitySnapshot(),
    });
    this.runtimeEventChain = Promise.resolve();
    this.runtimeAdapter.onEvent((event) => {
      this.threadStateStore.applyRuntimeEvent(event);
      this.runtimeEventChain = this.runtimeEventChain
        .catch(() => {})
        .then(async () => {
          try {
            await this.handleRuntimeEvent(event);
          } finally {
            if (event?.type === "runtime.turn.completed" || event?.type === "runtime.turn.failed") {
              this.pipelineActivity.markTurnCompleted();
            } else if (event?.type === "runtime.turn.started") {
              this.pipelineActivity.refresh();
            }
          }
        })
        .catch((error) => {
          const message = error instanceof Error ? error.stack || error.message : String(error);
          console.error(`[cyberboss] runtime event handling failed type=${event?.type || "(unknown)"} ${message}`);
        });
    });
  }

  /**
   * Static configuration snapshot + read-only channel readiness.
   *
   * The snapshot answers "where is this pointing"; the probe answers "which
   * channel can actually deliver right now". Both are printed because a
   * mismatch between them is the interesting case (correct config, dead
   * reader). Returns true when every enabled channel is ready.
   */
  async printDoctor() {
    const channels = await probeChannels(this.config);
    const summary = summarizeChannels(channels);
    console.log(JSON.stringify({
      stateDir: this.config.stateDir,
      channel: this.channelAdapter.describe(),
      channels,
      channelsSummary: summary,
      runtime: this.runtimeAdapter.describe(),
      timeline: this.timelineIntegration.describe(),
      threads: this.threadStateStore.snapshot(),
    }, null, 2));
    if (!summary.ok) {
      console.error(`[cyberboss] doctor: channel(s) not ready: ${summary.notReady.join(", ")}`);
    }
    return summary.ok;
  }

  async login() {
    await this.channelAdapter.login();
  }

  printAccounts() {
    this.channelAdapter.printAccounts();
  }

  async start() {
    this.sweepStaleTemporaryFiles();
    const account = this.channelAdapter.resolveAccount();
    this.activeAccountId = account.accountId;
    this.systemMessageDispatcher = new SystemMessageDispatcher({
      queueStore: this.systemMessageQueue,
      config: this.config,
      accountId: account.accountId,
    });
    const runtimeState = await this.runtimeAdapter.initialize();
    const knownContextTokens = Object.keys(this.channelAdapter.getKnownContextTokens()).length;
    const syncBuffer = this.channelAdapter.loadSyncBuffer();
    this.restoreReplyObligationTargets();
    await this.restoreBoundThreadSubscriptions();
    await this.recoverPendingInboundAtStartup();
    this.pipelineActivity.start();

    console.log("[cyberboss] bootstrap ok");
    console.log(`[cyberboss] channel=${this.channelAdapter.describe().id}`);
    console.log(`[cyberboss] runtime=${this.runtimeAdapter.describe().id}`);
    console.log(`[cyberboss] timeline=${this.timelineIntegration.describe().id}`);
    console.log(`[cyberboss] account=${account.accountId}`);
    console.log(`[cyberboss] baseUrl=${account.baseUrl}`);
    console.log(`[cyberboss] workspaceRoot=${this.config.workspaceRoot}`);
    console.log(`[cyberboss] knownContextTokens=${knownContextTokens}`);
    console.log(`[cyberboss] syncBuffer=${syncBuffer ? "ready" : "empty"}`);
    console.log(`[cyberboss] runtimeEndpoint=${runtimeState.endpoint || runtimeState.command || "(spawn)"}`);
    console.log(`[cyberboss] runtimeModels=${runtimeState.models?.length || 0}`);
    if (this.config.startWithLocationServer) {
      await this.ensureLocationServerStarted();
    }
    console.log("[cyberboss] bridge loop started; waiting for WeChat messages.");
    // Timers live in memory, the deferred backlog lives on disk: without re-arming
    // here a restart puts every queued reply back to "wait for the next inbound".
    try {
      const rearmed = this.deferredReplyRetryScheduler().rehydrate();
      if (rearmed) {
        console.log(`[cyberboss] deferred retry re-armed senders=${rearmed}`);
      }
    } catch (rehydrateError) {
      console.warn(`[cyberboss] deferred retry rehydrate failed: ${rehydrateError.message}`);
    }
    if (this.config.startWithCheckin) {
      console.log("[cyberboss] checkin: enabled");
      void runSystemCheckinPoller(this.config).catch((error) => {
        console.error(`[cyberboss] checkin poller stopped: ${error.message}`);
      });
    }
    await this.ensureWechatCliInboxStarted();
    void this.warmVoiceTranscription().catch((error) => {
      console.warn(`[cyberboss] voice transcription warmup failed: ${formatErrorMessage(error)}`);
    });
    await this.ensureWeFlowCanaryInboxStarted();
    await this.ensureWechatDbInboxStarted();
    await this.ensureWeChatCuaInboxStarted();
    if (this.config.startWithRestartNotification) {
      void this.sendRestartNotification().catch((error) => {
        console.warn(`[cyberboss] restart notification failed: ${formatErrorMessage(error)}`);
      });
    }

    const shutdown = createShutdownController(async () => {
      this.pipelineActivity.stop();
      this.clearPendingInboundFlushTimers();
      this.clearPendingSharedContentInboundTimers();
      await this.closeWechatCliInbox();
      await this.closeWeFlowInbox();
      await this.closeWeFlowCanaryInbox();
      // The CUA inbox polls a timer and the db inbox owns a Python child: both
      // outlive a graceful stop unless they are closed here. The db one matters
      // most - an orphaned reader keeps a decrypted snapshot on disk.
      await this.closeWeChatCuaInbox();
      await this.closeWechatDbInbox();
      await this.closeVoiceTranscription();
      await this.closeLocationServer();
      await this.runtimeAdapter.close();
    });

    try {
      let consecutiveFailures = 0;
      while (!shutdown.stopped) {
        try {
          this.sweepReplyObligations();
          this.sweepStaleTemporaryFilesIfDue();
          await Promise.all([
            this.flushDueReminders(account),
            this.flushPendingInboundMessages(),
            this.flushPendingSystemMessages(),
            this.flushPendingTimelineScreenshots(account),
          ]);
          const response = await this.channelAdapter.getUpdates({
            syncBuffer: this.channelAdapter.loadSyncBuffer(),
            timeoutMs: this.resolveLongPollTimeoutMs(),
          });
          assertWeixinUpdateResponse(response);
          consecutiveFailures = 0;
          const messages = sortInboundUpdateMessages(Array.isArray(response?.msgs) ? response.msgs : []);
          for (const message of messages) {
            if (shutdown.stopped) {
              break;
            }
            await this.handleIncomingMessage(message);
          }
          this.sweepReplyObligations();
          this.sweepStaleTemporaryFilesIfDue();
          await Promise.all([
            this.flushDueReminders(account),
            this.flushPendingInboundMessages(),
            this.flushPendingSystemMessages(),
            this.flushPendingTimelineScreenshots(account),
          ]);
        } catch (error) {
          if (shutdown.stopped) {
            break;
          }

          if (isSessionExpiredError(error)) {
            throw new Error("The WeChat session has expired. Run `npm run login` again.");
          }

          consecutiveFailures += 1;
          console.error(`[cyberboss] poll failed: ${formatErrorMessage(error)}`);
          await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
        }
      }
    } finally {
      shutdown.dispose();
      this.pipelineActivity.stop();
      this.clearPendingInboundFlushTimers();
      this.clearPendingSharedContentInboundTimers();
      await this.closeWechatCliInbox();
      await this.closeWeFlowInbox();
      await this.closeWeFlowCanaryInbox();
      await this.closeWeChatCuaInbox();
      await this.closeWechatDbInbox();
      await this.closeVoiceTranscription();
      await this.closeLocationServer();
      await this.runtimeAdapter.close();
    }
  }

  async ensureLocationServerStarted() {
    if (!this.projectServices?.whereabouts) {
      return null;
    }
    await this.projectServices.whereabouts.startServer({
      onAccepted: (result) => this.handleLocationAccepted(result),
    });
    console.log(
      `[cyberboss] locationServer=http://${this.config.locationHost}:${this.config.locationPort} store=${this.config.locationStoreFile}`
    );
    return this.projectServices.whereabouts.server || null;
  }

  async closeLocationServer() {
    if (!this.projectServices?.whereabouts) {
      return;
    }
    await this.projectServices.whereabouts.closeServer();
  }

  async ensureWechatCliInboxStarted() {
    if (!this.config.startWithWechatCliInbox || this.wechatCliInboxSource) {
      return this.wechatCliInboxSource;
    }
    this.wechatCliInboxSource = new WechatCliInboxSource({
      config: this.config,
      isReady: () => Boolean(this.resolveWechatCliInboxReplyTarget()),
      onMessage: (message, snapshot) => this.handleWechatCliInboxMessage(message, snapshot),
    });
    await this.wechatCliInboxSource.start();
    console.log(
      `[cyberboss] wechat-cli inbox enabled chat=${this.config.wechatCliInboxChat} intervalMs=${this.config.wechatCliInboxPollIntervalMs}`
    );
    return this.wechatCliInboxSource;
  }

  async closeWechatCliInbox() {
    const source = this.wechatCliInboxSource;
    this.wechatCliInboxSource = null;
    if (source) {
      await source.stop();
    }
  }

  async ensureWeFlowInboxStarted() {
    if (!this.config.startWithWeflowInbox || this.weflowInboxSource) {
      return this.weflowInboxSource;
    }
    this.weflowInboxSource = new WeFlowInboxSource({
      config: this.config,
      // Let the callback classify Cyberboss-owned outgoing rows even before a
      // reply binding exists. Genuine inbound/manual rows return false below
      // and remain pending until the binding becomes available.
      isReady: () => true,
      onMessage: (message, snapshot) => this.handleWeFlowInboxMessage(message, snapshot),
      onActivity: (activity, snapshot) => this.handleWeFlowBatchActivity(activity, snapshot),
    });
    await this.weflowInboxSource.start();
    console.log(
      `[cyberboss] WeFlow inbox enabled chat=${this.config.weflowInboxChat} baseUrl=${this.config.weflowBaseUrl}`
    );
    return this.weflowInboxSource;
  }

  /**
   * The RDP-free inbound source: poll the WeChat chat list through Cua and feed
   * observed messages into the SAME handler the WeFlow source uses, so the turn
   * pipeline, the ledger classification, the canary and the pending-inbound store
   * are all reused rather than reimplemented.
   *
   * Opt-in, and it must be: on this path a "message" is a changed conversation
   * row, our own sends are separated only by the echo ledger, and a deep read
   * costs a foreground click.
   */
  /**
   * The database inbound source: read the account's own SQLCipher files.
   *
   * It supersedes the CUA *reader* when it is on - same conversations, but with
   * the sender's wxid, the full body and a real direction, and without a
   * foreground click - while the CUA *writer* still sends the replies. Running
   * both readers at once would deliver every message twice under two different
   * ids, so `ensureWeChatCuaInboxStarted` refuses to start the CUA one when this
   * is enabled.
   */
  async ensureWechatDbInboxStarted() {
    if (!this.config.wechatDbInboxEnabled || this.wechatDbInboxSource) {
      return this.wechatDbInboxSource;
    }
    if (!this.config.wechatDbKey) {
      console.error(
        "[cyberboss] wechat-db inbox is enabled but CYBERBOSS_WECHAT_DB_KEY is empty; "
        + "the database cannot be decrypted. See docs/wechat-db-inbox.md."
      );
      return null;
    }
    if (!this.config.wechatDbInboxChats.length) {
      console.error(
        "[cyberboss] wechat-db inbox is enabled but no chat is configured "
        + "(CYBERBOSS_WECHAT_DB_INBOX_CHATS or CYBERBOSS_WEFLOW_INBOX_CHAT); not reading anyone."
      );
      return null;
    }
    const { WechatDbWorker } = require("../integrations/wechat-db/worker");
    const { WechatDbInboxSource } = require("../integrations/wechat-db/inbox");
    const { sharedLedger } = require("../integrations/wechat-cua/outbound");
    this.wechatDbWorker = new WechatDbWorker({
      pythonCommand: this.config.wechatDbPythonCommand,
      scriptPath: this.config.wechatDbReaderScript,
      env: {
        CYBERBOSS_WECHAT_DB_KEY: this.config.wechatDbKey,
        CYBERBOSS_WECHAT_DB_DIR: this.config.wechatDbDataDir,
        CYBERBOSS_WECHAT_DB_WXID: this.config.wechatDbWxid,
        CYBERBOSS_WECHAT_DB_ACCOUNT_DIR: this.config.wechatDbAccountDir,
        CYBERBOSS_WECHAT_DB_SELF_WXID: this.config.wechatDbSelfWxid,
        CYBERBOSS_WECHAT_DB_CACHE_DIR: this.config.wechatDbCacheDir,
        CYBERBOSS_STATE_DIR: this.config.stateDir,
      },
    });
    this.wechatDbInboxSource = new WechatDbInboxSource({
      config: this.config,
      worker: this.wechatDbWorker,
      chats: this.config.wechatDbInboxChats,
      // The same echo ledger the CUA writer records into: it is how an outgoing
      // row we sent is told apart from the operator typing in the same account.
      ledger: sharedLedger,
      pollIntervalMs: this.config.wechatDbInboxPollMs,
      historyLimit: this.config.wechatDbInboxHistoryLimit,
      replayOnStart: this.config.wechatDbInboxReplayOnStart,
      replayLimit: this.config.wechatDbInboxReplayLimit,
      onMessage: (message, snapshot) => this.handleWeFlowInboxMessage(message, snapshot),
    });
    await this.wechatDbInboxSource.start();
    return this.wechatDbInboxSource;
  }

  async closeWechatDbInbox() {
    const source = this.wechatDbInboxSource;
    const worker = this.wechatDbWorker;
    this.wechatDbInboxSource = null;
    this.wechatDbWorker = null;
    if (source) {
      await source.stop();
    }
    if (worker) {
      await worker.stop().catch(() => {});
    }
    return source;
  }

  async ensureWeChatCuaInboxStarted() {
    if (!this.config.wechatCuaInboxEnabled || this.wechatCuaInboxSource) {
      return this.wechatCuaInboxSource;
    }
    if (this.config.wechatDbInboxEnabled) {
      // Two readers over the same conversations would deliver every message
      // twice under different ids, and both would be answered.
      console.log(
        "[cyberboss] cua inbox skipped: the wechat-db inbox reads the same conversations with more detail"
      );
      return null;
    }
    const { WeChatCuaInboxSource, sharedLedger } = (() => {
      const inboxModule = require("../integrations/wechat-cua/inbox");
      const outboundModule = require("../integrations/wechat-cua/outbound");
      return { ...inboxModule, sharedLedger: outboundModule.sharedLedger };
    })();
    this.wechatCuaInboxSource = new WeChatCuaInboxSource({
      config: this.config,
      // Same ledger the outbound sender writes to: that is what stops the loop
      // from answering its own replies.
      ledger: sharedLedger,
      deepRead: this.config.wechatCuaInboxDeepRead,
      pollMs: this.config.wechatCuaInboxPollMs,
      onMessage: (message, snapshot) => this.handleWeFlowInboxMessage(message, snapshot),
    });
    await this.wechatCuaInboxSource.start();
    return this.wechatCuaInboxSource;
  }

  async closeWeChatCuaInbox() {
    const source = this.wechatCuaInboxSource;
    this.wechatCuaInboxSource = null;
    if (source) {
      source.stop();
    }
    return source;
  }

  async recoverPendingInboundAtStartup() {
    // A revoke and the message it cancels are persisted in different durable
    // queues. Start the WeFlow source first and give its revoke queue a bounded
    // reconciliation pass before an already-expired core batch is eligible to
    // dispatch. Any revoke still in retry/cooldown remains an explicit gate on
    // the primary WeFlow scope; startup itself is never held indefinitely.
    await this.ensureWeFlowInboxStarted();
    await this.reconcilePendingWeFlowRevokesBeforeRecovery();
    this.restorePendingSharedContentInboundTimers();
    this.restorePendingInboundFlushTimers();
    await this.flushPendingInboundMessages();
  }

  async reconcilePendingWeFlowRevokesBeforeRecovery({
    timeoutMs = WEFLOW_STARTUP_REVOKE_RECONCILE_TIMEOUT_MS,
  } = {}) {
    const source = this.weflowInboxSource;
    if (!source || !listPendingWeFlowRevokes(source, this.config).length
      || typeof source.drainPendingEvents !== "function") {
      return { status: "not_needed", remaining: 0 };
    }

    let timeoutHandle = null;
    const boundedTimeoutMs = Math.max(0, Number(timeoutMs) || 0);
    const drain = Promise.resolve()
      .then(() => source.drainPendingEvents())
      .then(
        (result) => ({ status: "drained", result }),
        (error) => ({ status: "failed", error })
      );
    const outcome = boundedTimeoutMs
      ? await Promise.race([
        drain,
        new Promise((resolve) => {
          timeoutHandle = setTimeout(() => resolve({ status: "timeout" }), boundedTimeoutMs);
        }),
      ])
      : await drain;
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    // Persisted per-item retryNotBefore values do not make start() wait. Make
    // sure the source owns a future retry while the app-level scope gate keeps
    // the corresponding core batch from overtaking it.
    if (source.running !== false && source.pendingEvents?.size) {
      source.schedulePendingDrain?.();
    }
    const remaining = listPendingWeFlowRevokes(source, this.config).length;
    if (outcome.status === "failed") {
      console.warn(
        `[cyberboss] startup WeFlow revoke reconciliation deferred: ${formatErrorMessage(outcome.error)}`
      );
    } else if (outcome.status === "timeout" && remaining) {
      console.warn(`[cyberboss] startup WeFlow revoke reconciliation timed out; gated=${remaining}`);
    }
    return { ...outcome, remaining };
  }

  resolvePrimaryWeFlowPendingScopeKey() {
    const target = this.resolveWeFlowInboxReplyTarget?.();
    const sessionStore = this.runtimeAdapter?.getSessionStore?.();
    if (!target?.userId || !this.activeAccountId || typeof sessionStore?.buildBindingKey !== "function") {
      return "";
    }
    try {
      const bindingKey = sessionStore.buildBindingKey({
        workspaceId: this.config?.workspaceId,
        accountId: this.activeAccountId,
        senderId: target.userId,
      });
      return buildScopeKey(bindingKey, this.resolveWorkspaceRoot(bindingKey));
    } catch {
      return "";
    }
  }

  resolvePendingWeFlowRevokeGate(scopeKey) {
    const normalizedScopeKey = normalizeText(scopeKey);
    const primaryScopeKey = this.resolvePrimaryWeFlowPendingScopeKey?.();
    if (!normalizedScopeKey || !primaryScopeKey || normalizedScopeKey !== primaryScopeKey) {
      return null;
    }
    const source = this.weflowInboxSource;
    const revokes = listPendingWeFlowRevokes(source, this.config);
    if (!revokes.length) {
      return null;
    }

    const nowMs = Date.now();
    const earliestItemRetryAtMs = revokes.reduce((earliest, item) => {
      const retryAtMs = Date.parse(normalizeText(item?.retryNotBefore));
      return Math.min(earliest, Number.isFinite(retryAtMs) ? retryAtMs : nowMs);
    }, Number.POSITIVE_INFINITY);
    const globalRetryAtMs = Number(source?.pendingRetryNotBeforeMs);
    return {
      blocked: true,
      count: revokes.length,
      retryAtMs: Math.max(
        nowMs + WEFLOW_PENDING_REVOKE_GATE_POLL_MS,
        Number.isFinite(earliestItemRetryAtMs) ? earliestItemRetryAtMs : 0,
        Number.isFinite(globalRetryAtMs) ? globalRetryAtMs : 0
      ),
    };
  }

  async closeWeFlowInbox() {
    const source = this.weflowInboxSource;
    this.weflowInboxSource = null;
    this.wechatCuaInboxSource = null;
    if (source) {
      await source.stop();
    }
  }

  async handleWeFlowBatchActivity(activity, snapshot = {}) {
    if (normalizeText(activity?.kind).toLowerCase() !== "revoke") {
      return true;
    }
    const rawRevokedMessageId = String(activity?.revokedMessageId ?? "").trim();
    const revokedPendingId = normalizeWeFlowPendingId(rawRevokedMessageId);
    if (!revokedPendingId) {
      return true;
    }
    const receivedAt = resolveInboundActivityTime(activity);
    this.markPipelineUserInbound?.(receivedAt);

    const target = this.resolveWeFlowInboxReplyTarget();
    if (!target || !this.activeAccountId) {
      return true;
    }
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: this.config.workspaceId,
      accountId: this.activeAccountId,
      senderId: target.userId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    const chatUsername = normalizeWeFlowTalker(
      normalizeText(snapshot?.chatUsername) || normalizeText(this.config.weflowInboxChat)
    );
    const sharedScopeKey = chatUsername
      ? buildSharedContentScopeKey(bindingKey, workspaceRoot, `weflow:${chatUsername}`)
      : "";
    const hasPendingBatch = Boolean(scopeKey && this.pendingInboundByScope?.has(scopeKey));
    const hasPendingSharedContent = Boolean(
      sharedScopeKey && this.pendingSharedContentInboundByScope?.has(sharedScopeKey)
    );
    if (!hasPendingBatch && !hasPendingSharedContent) {
      return true;
    }

    let updatedDraft = null;
    let removedPendingIds = [];
    if (hasPendingBatch && this.pendingInboundStore) {
      const result = this.pendingInboundStore.recordActivity(scopeKey, {
        receivedAt,
        matchingMessageIds: [rawRevokedMessageId, revokedPendingId],
      });
      updatedDraft = result.draft;
      removedPendingIds = result.removedPendingIds;
    } else if (hasPendingBatch) {
      const current = this.pendingInboundByScope.get(scopeKey);
      const retained = (Array.isArray(current?.messages) ? current.messages : []).filter((message) => {
        const matches = [
          normalizeText(message?.pendingId),
          normalizeText(message?.messageId),
          ...normalizeSourceMessageIds(message?.sourceMessageIds),
        ].some((id) => id === rawRevokedMessageId || id === revokedPendingId);
        if (matches) removedPendingIds.push(resolvePendingInboundId(message));
        return !matches;
      });
      if (retained.length) {
        const nowMs = Date.now();
        const parsedActivityAtMs = Date.parse(receivedAt);
        const activityAtMs = Number.isFinite(parsedActivityAtMs) && parsedActivityAtMs > 0
          ? Math.min(nowMs, parsedActivityAtMs)
          : nowMs;
        const previousActivityAtMs = Date.parse(normalizeText(current.lastActivityAt));
        const lastActivityAtMs = Math.max(
          Number.isFinite(previousActivityAtMs) ? previousActivityAtMs : 0,
          activityAtMs
        );
        updatedDraft = {
          ...current,
          messages: retained,
          lastActivityAt: new Date(lastActivityAtMs).toISOString(),
          quietUntil: new Date(lastActivityAtMs + resolvePendingInboundQuietWindowMs(this)).toISOString(),
          generation: Math.max(0, Number(current.generation) || 0) + 1,
        };
      }
    }

    if (hasPendingBatch) {
      if (updatedDraft) {
        this.pendingInboundByScope.set(scopeKey, updatedDraft);
        this.schedulePendingInboundFlush(scopeKey);
      } else {
        this.pendingInboundByScope.delete(scopeKey);
        this.clearPendingInboundFlushTimer(scopeKey);
      }
    }

    let removedSharedPendingIds = [];
    if (hasPendingSharedContent) {
      let updatedSharedDraft = null;
      let sharedActivityApplied = false;
      if (this.pendingInboundStore
        && typeof this.pendingInboundStore.recordSharedActivity === "function") {
        const result = this.pendingInboundStore.recordSharedActivity(sharedScopeKey, {
          receivedAt,
          matchingMessageIds: [rawRevokedMessageId, revokedPendingId],
        });
        updatedSharedDraft = result.draft;
        removedSharedPendingIds = result.removedPendingIds;
        sharedActivityApplied = result.found;
      } else {
        const current = this.pendingSharedContentInboundByScope.get(sharedScopeKey);
        const retained = (Array.isArray(current?.messages) ? current.messages : []).filter((message) => {
          const matches = [
            normalizeText(message?.pendingId),
            normalizeText(message?.messageId),
            ...normalizeSourceMessageIds(message?.sourceMessageIds),
          ].some((id) => id === rawRevokedMessageId || id === revokedPendingId);
          if (matches) removedSharedPendingIds.push(resolvePendingInboundId(message));
          return !matches;
        });
        sharedActivityApplied = Boolean(current);
        if (retained.length) {
          const nowMs = Date.now();
          const parsedActivityAtMs = Date.parse(receivedAt);
          const activityAtMs = Number.isFinite(parsedActivityAtMs) && parsedActivityAtMs > 0
            ? Math.min(nowMs, parsedActivityAtMs)
            : nowMs;
          updatedSharedDraft = {
            ...current,
            messages: retained,
            lastContentAtMs: Math.max(Number(current?.lastContentAtMs) || 0, activityAtMs),
          };
        }
      }

      if (sharedActivityApplied) {
        const clearSharedTimer = typeof this.clearPendingSharedContentInboundTimer === "function"
          ? this.clearPendingSharedContentInboundTimer
          : CyberbossApp.prototype.clearPendingSharedContentInboundTimer;
        clearSharedTimer.call(this, sharedScopeKey);
        if (updatedSharedDraft) {
          this.pendingSharedContentInboundByScope.set(sharedScopeKey, {
            ...updatedSharedDraft,
            timer: null,
          });
          const scheduleSharedExpiry = typeof this.schedulePendingSharedContentInboundExpiry === "function"
            ? this.schedulePendingSharedContentInboundExpiry
            : CyberbossApp.prototype.schedulePendingSharedContentInboundExpiry;
          scheduleSharedExpiry.call(this, sharedScopeKey);
        } else {
          this.pendingSharedContentInboundByScope.delete(sharedScopeKey);
        }
      }
    }
    this.pipelineActivity?.refresh();
    console.log(
      `[cyberboss] WeFlow revoke extended pending batch scope=${scopeKey}`
      + ` revoked=${revokedPendingId} removed=${removedPendingIds.length}`
      + ` sharedRemoved=${removedSharedPendingIds.length}`
      + ` chat=${chatUsername}`
    );
    return true;
  }

  async ensureWeFlowCanaryInboxStarted() {
    if (!this.config.startWithWeflowCanaryInbox) {
      return this.weflowCanaryInboxSource;
    }
    assertWeFlowCanaryTalkerIsolation(this.config);
    if (this.weflowCanaryInboxSource) {
      return this.weflowCanaryInboxSource;
    }
    this.weflowCanaryInboxSource = new WeFlowCanaryInboxSource({
      config: this.config,
      onMessage: (message, snapshot) => this.handleWeFlowCanaryInboxMessage(message, snapshot),
    });
    await this.weflowCanaryInboxSource.start();
    console.log(
      `[cyberboss] WeFlow canary inbox enabled chat=${this.config.weflowCanaryChat}`
      + ` contact=${this.config.weflowCanaryDisplayName}`
    );
    return this.weflowCanaryInboxSource;
  }

  async closeWeFlowCanaryInbox() {
    const source = this.weflowCanaryInboxSource;
    this.weflowCanaryInboxSource = null;
    if (source) {
      await source.stop();
    }
  }

  async warmVoiceTranscription() {
    const service = this.voiceTranscriptionService;
    if (!service) return;
    const result = await service.warm();
    const description = service.describe();
    if (result.status === "ready") {
      console.log(`[cyberboss] voice transcription ready model=${description.model} device=${description.device}/${description.computeType}`);
    } else if (result.status === "model_missing") {
      console.warn(`[cyberboss] voice transcription model missing: ${description.model}`);
    }
  }

  async closeVoiceTranscription() {
    await this.voiceTranscriptionService?.close?.();
  }

  /**
   * Remove orphaned atomic-write temporaries from the state directory.
   *
   * Every durable store writes through a `.<name>.<pid>.<timestamp>.tmp` sibling
   * and then renames it into place. A rename that fails - the live state showed
   * EPERM during the canary poll - leaves that sibling behind, and nothing ever
   * collected them (91 had accumulated since 2026-08-28).
   *
   * Deliberately conservative: only files matching the exact atomic-write shape
   * whose embedded timestamp is older than the grace period are removed, so an
   * in-flight write from a running process is never touched.
   */
  sweepStaleTemporaryFiles({ graceMs = STALE_TEMP_FILE_GRACE_MS } = {}) {
    const stateDir = normalizeText(this.config?.stateDir);
    if (!stateDir) return 0;
    let removed = 0;
    let entries = [];
    try {
      entries = fs.readdirSync(stateDir, { withFileTypes: true });
    } catch {
      return 0;
    }
    const cutoffMs = Date.now() - graceMs;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = /^\..+\.(\d+)\.(\d{10,})\.tmp$/u.exec(entry.name);
      if (!match) continue;
      const writtenAtMs = Number(match[2]);
      if (!Number.isFinite(writtenAtMs) || writtenAtMs > cutoffMs) continue;
      try {
        fs.unlinkSync(path.join(stateDir, entry.name));
        removed += 1;
      } catch {
        // Another process may have collected it, or it is momentarily locked.
      }
    }
    if (removed > 0) {
      console.log(`[cyberboss] removed ${removed} stale atomic-write temp file(s) from the state directory`);
    }
    this.lastStaleTempSweepAtMs = Date.now();
    return removed;
  }

  /**
   * Re-run the stale-temporary collection at most once per interval. The bridge
   * loop runs for days, so a startup-only sweep let temporaries from failed
   * renames accumulate again between restarts.
   */
  sweepStaleTemporaryFilesIfDue({
    intervalMs = STALE_TEMP_FILE_SWEEP_INTERVAL_MS,
    graceMs = STALE_TEMP_FILE_GRACE_MS,
  } = {}) {
    const lastSweepMs = Number(this.lastStaleTempSweepAtMs);
    if (Number.isFinite(lastSweepMs) && Date.now() - lastSweepMs < intervalMs) {
      return 0;
    }
    return this.sweepStaleTemporaryFiles({ graceMs });
  }

  buildPipelineActivitySnapshot() {
    const threadStates = this.threadStateStore?.snapshot?.() || [];
    const activeTurnCount = threadStates.filter((state) => (
      state?.status === "running" || state?.status === "waiting_approval"
    )).length;
    // Drop gates that can never be released by an event before reporting the
    // count. A gate that was opened but never attached to a thread has no
    // terminal event coming, and leaving it counted made the pipeline look busy
    // forever - which silently blocked the watchdog's repair path.
    const staleGates = this.turnGateStore?.releaseStaleGates?.() || [];
    for (const gate of staleGates) {
      console.error(
        `[cyberboss] released a stale turn gate with no attached thread `
        + `scope=${gate.scopeKey} ageMs=${gate.ageMs}`
      );
    }
    const pending = this.turnGateStore?.describePending?.();
    const turnGateCount = pending
      ? pending.live.length
      : (Number(this.turnGateStore?.pendingScopeKeys?.size) || 0);
    const activeDeliveryCount = Number(this.streamDelivery?.stateByRunKey?.size) || 0;
    const pendingInboundCount = countPendingInboundMessages(this.pendingInboundByScope)
      + countPendingInboundMessages(this.pendingSharedContentInboundByScope)
      + (Number(this.pendingInboundPostDispatchCommits?.size) || 0);
    return {
      activeTurnCount,
      turnGateCount,
      activeDeliveryCount,
      pendingInboundCount,
    };
  }

  markPipelineUserInbound(receivedAt = "") {
    const timestamp = Date.parse(normalizeIsoTime(receivedAt));
    this.pipelineActivity?.markUserInbound(Number.isFinite(timestamp) ? timestamp : Date.now());
  }

  resolveWechatCliInboxReplyTarget() {
    return this.resolveLocalWechatReplyTarget(this.config.wechatCliInboxReplyUserId);
  }

  resolveWeFlowInboxReplyTarget() {
    return this.resolveLocalWechatReplyTarget(this.config.weflowInboxReplyUserId);
  }

  async sendRestartNotification() {
    const explicitUserId = normalizeCommandArgument(this.config.restartNotificationUserId)
      || normalizeCommandArgument(this.config.weflowInboxReplyUserId);
    const target = this.resolveLocalWechatReplyTarget(explicitUserId);
    const text = normalizeCommandArgument(this.config.restartNotificationText)
      || "✅ Cyberboss 已重启，服务已恢复。";
    if (!target) {
      await this.sendRestartNotificationViaWeFlow(text);
      console.log("[cyberboss] restart notification sent via weflow-uia");
      return { userId: explicitUserId, text };
    }
    const payload = {
      userId: target.userId,
      text,
      contextToken: target.contextToken,
      preserveBlock: true,
    };
    try {
      await this.channelAdapter.sendText(payload);
    } catch (error) {
      try {
        if (!isStaleWeixinContextError(error)) {
          throw error;
        }
        await this.channelAdapter.sendText({
          ...payload,
          contextToken: "",
          omitContextToken: true,
        });
      } catch (nativeError) {
        await this.sendRestartNotificationViaWeFlow(text);
        console.log("[cyberboss] restart notification sent via weflow-uia");
        return { userId: target.userId, text };
      }
    }
    console.log(`[cyberboss] restart notification sent via bot user=${target.userId}`);
    return { userId: target.userId, text };
  }

  async sendRestartNotificationViaWeFlow(text) {
    return this.channelAdapter.sendText({
      userId: normalizeCommandArgument(this.config.weflowInboxReplyUserId),
      text,
      preserveBlock: true,
      provider: "weflow-uia",
    });
  }

  async resolveWeFlowReplySource() {
    // On the RDP-free path there is no bridge to ask: the CUA driver IS the
    // outbound. Asking the bridge here made every inbound turn die at
    // `waiting for a single reply route: fetch failed` once WeFlow and the bridge
    // were shut down (measured 2026-10-01) - the reply route still depended on
    // exactly the components this work removed.
    if (this.config.wechatCuaEnabled) {
      return "azzy";
    }
    return resolveWeFlowSendSource(this.config);
  }

  resolveLocalWechatReplyTarget(replyUserId = "") {
    if (!this.activeAccountId) {
      return null;
    }
    const knownTokens = this.channelAdapter.getKnownContextTokens();
    const explicitUserId = normalizeCommandArgument(replyUserId);
    if (explicitUserId) {
      return {
        userId: explicitUserId,
        contextToken: knownTokens[explicitUserId] || "",
        provider: "weixin",
      };
    }

    const knownUserIds = Object.keys(knownTokens).filter((userId) => normalizeCommandArgument(userId));
    if (knownUserIds.length === 1) {
      return {
        userId: knownUserIds[0],
        contextToken: knownTokens[knownUserIds[0]],
        provider: "weixin",
      };
    }

    const userId = resolvePreferredSenderId({
      config: this.config,
      accountId: this.activeAccountId,
      explicitUser: explicitUserId,
      sessionStore: this.runtimeAdapter.getSessionStore(),
    });
    const contextToken = knownTokens[userId] || "";
    return userId ? { userId, contextToken, provider: "weixin" } : null;
  }

  async handleWechatCliInboxMessage(message, snapshot = {}) {
    const target = this.resolveWechatCliInboxReplyTarget();
    if (!target) {
      return false;
    }
    this.markPipelineUserInbound?.(message?.receivedAt);
    const persisted = await persistLocalWechatAttachments({
      attachments: message.attachments,
      stateDir: this.config.stateDir,
      messageId: message.id,
      receivedAt: message.receivedAt,
      config: this.config,
    });
    const sharedContent = isSharedInboxContentMessage(message, {
      assumeLinkCard: normalizeSharedContentKind(message.kind) === "link",
    });
    const explicitPrompt = isExplicitInboxPromptMessage(message, {
      assumeLinkCard: normalizeSharedContentKind(message.kind) === "link",
    });
    const normalized = {
      provider: "weixin",
      accountId: this.activeAccountId,
      workspaceId: this.config.workspaceId,
      senderId: target.userId,
      chatId: `wechat-cli:${normalizeCommandArgument(snapshot.chatUsername) || normalizeCommandArgument(this.config.wechatCliInboxChat)}`,
      messageId: `wechat-cli:${message.id}`,
      contextToken: target.contextToken,
      text: buildWechatCliInboxTurnText(message, snapshot, this.config),
      quotedContexts: Array.isArray(message.quotedContexts) ? message.quotedContexts : [],
      attachments: [],
      persistedAttachments: persisted.saved,
      persistedAttachmentFailures: persisted.failed,
      contentKind: normalizeSharedContentKind(message.kind),
      contentTitle: normalizeCommandArgument(message.title),
      contentText: normalizeCommandArgument(message.text),
      contentUrl: normalizeHttpUrl(message.url),
      sharedContent,
      explicitPrompt,
      receivedAt: normalizeIsoTime(message.receivedAt)
        || (message.timestamp ? new Date(message.timestamp * 1000).toISOString() : new Date().toISOString()),
    };
    await this.handlePreparedMessage(normalized, { allowCommands: false });
    return true;
  }

  async handleWeFlowInboxMessage(message, snapshot = {}) {
    const chatUsername = normalizeCommandArgument(snapshot.chatUsername)
      || normalizeCommandArgument(this.config.weflowInboxChat);
    let effectiveMessage = message;
    let classification;
    try {
      classification = await this.weflowMessageLedger?.classifyObservedOutgoing({
        talker: chatUsername,
        localId: message.localId,
        messageId: message.id,
        text: message.text,
        contentKind: message.contentKind || message.kind,
        direction: message.direction,
        observedAt: message.receivedAt,
      });
    } catch (error) {
      console.warn(`[cyberboss] WeFlow message waiting for ledger classification: ${formatErrorMessage(error)}`);
      return false;
    }
    let canary;
    try {
      canary = await this.weflowHeartbeatCanary?.handleObservedMessage({
        message,
        classification,
        talker: chatUsername,
      });
    } catch (error) {
      console.warn(`[cyberboss] WeFlow heartbeat canary waiting for retry: ${formatErrorMessage(error)}`);
      return false;
    }
    if (canary?.handled) {
      if (canary.accepted === false) {
        return false;
      }
      console.log(
        `[cyberboss] WeFlow heartbeat canary consumed status=${canary.status || "handled"}`
        + ` localId=${message?.localId || "(unknown)"}`
      );
      return true;
    }
    if (classification?.origin === "cyberboss" || classification?.classification === "cyberboss") {
      console.log(
        `[cyberboss] WeFlow echo consumed direction=${message?.direction || "unknown"}`
        + ` localId=${message?.localId || "(unknown)"}`
        + ` matchedBy=${classification.matchedBy || "ledger"}`
      );
      return true;
    }
    if (message?.direction === "outgoing") {
      // Same-account manual input stays supported: an outgoing row only reaches
      // this point when the ledger did NOT attribute it to us, so it is the
      // operator typing in the bot's own account rather than our own echo.
      // Echoes are suppressed above by the ledger's own attribution - see
      // .agents/notes/implemented/bug-fix/2026-09-18-weflow-self-echo-attribution.md
      effectiveMessage = { ...message, origin: "self_manual" };
    }
    this.markPipelineUserInbound?.(message?.receivedAt);
    // Which channel answers an inbound personal-account message.
    //
    // `resolveWeFlowInboxReplyTarget()` predates the CUA path and always returns
    // `provider: "weixin"` (the official iLink channel), because it resolves a
    // *context token*. On this machine exactly one token exists, so it is picked
    // "correctly" and the reply is routed to iLink even though the message came
    // from the desktop client on this very session (measured 2026-10-01: a real
    // turn ended in the official path's deferred queue, user=o9cq…@im.wechat).
    //
    // So when the RDP-free path is enabled, the reply goes back through Cua to the
    // conversation the message came from - the chat's label is the only address a
    // UIA writer has, and the snapshot carries it.
    //
    // The target carries the CHAT'S DISPLAY NAME as its `userId`, not an empty
    // string. It is tempting to treat `userId` as "the wxid we do not have" and
    // leave it blank - but it is also the message's `senderId`, and the pending
    // inbound store requires one, so an empty value turns a real message into
    // "invalid pending inbound message" while the user is never answered at all
    // (measured 2026-10-01, the first live inbound on this path). On a UIA-read
    // path the display name is both the identity and the reply address, which is
    // what the CUA writer resolves through CYBERBOSS_CUA_CHAT_BY_TALKER.
    const cuaChatUsername = normalizeCommandArgument(snapshot.chatUsername);
    const cuaTarget = this.config.wechatCuaEnabled && cuaChatUsername
      ? { userId: cuaChatUsername, contextToken: "", provider: "wechat-cua" }
      : null;
    const target = cuaTarget || this.resolveWeFlowInboxReplyTarget();
    if (!target) {
      return false;
    }
    const persisted = await persistLocalWechatAttachments({
      attachments: effectiveMessage.attachments,
      stateDir: this.config.stateDir,
      messageId: effectiveMessage.id,
      receivedAt: effectiveMessage.receivedAt,
      config: this.config,
    });
    const voice = await enrichMessageWithVoiceTranscripts({
      message: effectiveMessage,
      attachments: persisted.saved,
      transcriptionService: this.voiceTranscriptionService,
    });
    const enrichedMessage = voice.message;
    if (isWeFlowControlConfirmation(enrichedMessage.text)) {
      console.log(`[cyberboss] WeFlow control confirmation consumed: ${enrichedMessage.text}`);
      return true;
    }
    if (isWeFlowControlCommand(enrichedMessage.text)) {
      console.log(`[cyberboss] WeFlow control command handled by bridge: ${enrichedMessage.text}`);
      return true;
    }
    let sendSource;
    try {
      sendSource = await this.resolveWeFlowReplySource();
    } catch (error) {
      console.warn(`[cyberboss] WeFlow message waiting for a single reply route: ${formatErrorMessage(error)}`);
      return false;
    }
    const sharedContent = isSharedInboxContentMessage(enrichedMessage);
    const explicitPrompt = isExplicitInboxPromptMessage(enrichedMessage);
    // An attachment the source could never obtain (an appmsg file the reader cannot
    // export) is reported to the operator here, at the point the failure is first
    // known, instead of hoping the model explains it or threading it through the
    // prepare pipeline: measured 2026-09-30, the model answered a bare
    // "[附件接收失败]" note with a silent action, leaving only a 处理中 in the chat.
    const unreadableIntake = (Array.isArray(enrichedMessage.attachmentFailures)
      ? enrichedMessage.attachmentFailures
      : []
    ).filter((failure) => normalizeText(failure?.code) === UNREADABLE_INTAKE_FAILURE_CODE);
    if (unreadableIntake.length) {
      // The route matters: without `provider` and the WeFlow chat fields this goes to
      // the official WeChat bot API, which answers "sendMessage ret=-2 ... prepare
      // failed" (measured 2026-09-30) while the chat it must reach is the WeFlow one.
      const noticePayload = applyWeFlowInboundReplyRoute({
        userId: target.userId,
        text: [
          "⚠️ 附件读取失败",
          ...unreadableIntake.map((failure) => `- ${failure.sourceFileName || failure.kind || "附件"}: ${failure.reason}`),
          "可以改用截图，或把内容直接贴成文字发我。",
        ].join("\n"),
        contextToken: target.contextToken,
        provider: "weflow-uia",
        messageKind: "intake_failure_notice",
        preserveBlock: true,
      }, { provider: "weflow-uia", chatId: `weflow:${chatUsername}` });
      await this.channelAdapter.sendText(noticePayload).catch((error) => {
        console.warn(`[cyberboss] intake failure notice could not be sent: ${formatErrorMessage(error)}`);
      });
      return true;
    }
    // The reply must return to the chat this message came from. The UIA bridge
    // resolves the displayed name from the talker, so the chat's own wxid is the
    // route; it rides chatId ("weflow:<talker>"), which every prepared-message hop
    // already carries. It deliberately does not reuse the canary's replyWeflow*
    // fields - stripModelCanaryPreparedFields removes those from ordinary turns.
    //
    // `wechat-cua` is the RDP-free driver (see src/integrations/wechat-cua): it
    // drives the desktop client on this session instead of a bridge living in an
    // isolated one. Opt-in, because it costs a foreground click whenever the
    // conversation is not already open.
    const localProvider = sendSource === "azzy"
      ? (this.config.wechatCuaEnabled ? "wechat-cua" : "weflow-uia")
      : "weixin";
    const identity = resolveLocalInboxIdentity({
      provider: localProvider,
      chatUsername,
      replyUserId: target.userId,
      messageId: enrichedMessage.id,
    });
    const normalized = {
      provider: identity.provider,
      accountId: this.activeAccountId,
      workspaceId: this.config.workspaceId,
      senderId: identity.senderId,
      chatId: identity.chatId,
      messageId: identity.messageId,
      sourceMessageIds: normalizeSourceMessageIds(enrichedMessage.sourceMessageIds),
      contextToken: target.contextToken,
      sessionScope: isTestSessionRequest(enrichedMessage.text) ? TEST_SESSION_KEY : "",
      text: buildWeFlowInboxTurnText(enrichedMessage, snapshot, this.config),
      quotedContexts: Array.isArray(enrichedMessage.quotedContexts) ? enrichedMessage.quotedContexts : [],
      attachments: [],
      persistedAttachments: persisted.saved,
      // `persisted.failed` only covers attachments that arrived and could not be
      // stored; the inbox also reports media it could never obtain (an appmsg file
      // the reader cannot export). Dropping those here is what left the operator
      // with a 处理中 and no explanation (measured 2026-09-30).
      persistedAttachmentFailures: [
        ...persisted.failed,
        ...voice.failures,
        ...(Array.isArray(enrichedMessage.attachmentFailures) ? enrichedMessage.attachmentFailures : []),
      ],
      contentKind: normalizeSharedContentKind(enrichedMessage.kind),
      contentTitle: normalizeCommandArgument(enrichedMessage.title),
      contentText: normalizeCommandArgument(enrichedMessage.text),
      contentUrl: normalizeHttpUrl(enrichedMessage.url),
      sharedContent,
      explicitPrompt,
      receivedAt: normalizeIsoTime(enrichedMessage.receivedAt)
        || (enrichedMessage.timestamp ? new Date(enrichedMessage.timestamp * 1000).toISOString() : new Date().toISOString()),
    };
    await this.handlePreparedMessage(normalized, { allowCommands: false });
    return true;
  }

  async handleWeFlowModelCanaryTrigger({ prepared } = {}) {
    if (!this.config.weflowModelCanaryEnabled || !prepared) {
      return { accepted: false };
    }
    if (normalizeText(prepared.modelCanaryExecutionPolicy) !== MODEL_CANARY_EXECUTION_POLICY
      || typeof this.runtimeAdapter.supportsExecutionPolicy !== "function"
      || this.runtimeAdapter.supportsExecutionPolicy(MODEL_CANARY_EXECUTION_POLICY) !== true) {
      throw new Error("model canary side-effect containment policy is unavailable");
    }
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: prepared.workspaceId,
      accountId: prepared.accountId,
      senderId: prepared.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    await this.handlePreparedMessage(prepared, {
      allowCommands: false,
      internalModelCanary: true,
    });
    return { accepted: true, bindingKey, workspaceRoot };
  }

  async handleWeFlowCanaryInboxMessage(message, snapshot = {}) {
    const chatUsername = normalizeCommandArgument(snapshot.chatUsername);
    if (!chatUsername || chatUsername !== normalizeCommandArgument(this.config.weflowCanaryChat)) {
      console.warn("[cyberboss] WeFlow canary marker ignored from an unexpected talker");
      return true;
    }
    let classification;
    try {
      classification = await this.weflowMessageLedger?.classifyObservedOutgoing({
        talker: chatUsername,
        localId: message.localId,
        messageId: message.id,
        text: message.text,
        contentKind: message.contentKind || message.kind,
        direction: message.direction,
        observedAt: message.receivedAt,
      });
    } catch (error) {
      console.warn(`[cyberboss] WeFlow canary waiting for ledger classification: ${formatErrorMessage(error)}`);
      return false;
    }
    let canary;
    try {
      canary = await this.weflowModelCanary?.handleObservedMessage({
        message,
        classification,
        talker: chatUsername,
      });
    } catch (error) {
      console.warn(`[cyberboss] WeFlow model canary waiting for retry: ${formatErrorMessage(error)}`);
      return false;
    }
    if (canary?.handled) {
      if (canary.accepted === false) return false;
      console.log(
        `[cyberboss] WeFlow dedicated model canary consumed status=${canary.status || "handled"}`
        + ` localId=${message?.localId || "(unknown)"}`
      );
      return true;
    }
    try {
      canary = await this.weflowHeartbeatCanary?.handleObservedMessage({
        message,
        classification,
        talker: chatUsername,
      });
    } catch (error) {
      console.warn(`[cyberboss] WeFlow heartbeat canary waiting for retry: ${formatErrorMessage(error)}`);
      return false;
    }
    if (!canary?.handled) {
      // The lightweight source only forwards the reserved prefix. Any future
      // parser mismatch is consumed here and never reaches the user/model path.
      console.warn("[cyberboss] unrecognized WeFlow canary marker consumed without model routing");
      return true;
    }
    if (canary.accepted === false) {
      return false;
    }
    console.log(
      `[cyberboss] WeFlow dedicated heartbeat canary consumed status=${canary.status || "handled"}`
      + ` localId=${message?.localId || "(unknown)"}`
    );
    return true;
  }

  handleLocationAccepted(result) {
    if (!this.activeAccountId) {
      return;
    }

    const point = result?.appended?.point || null;
    const movementEvent = result?.appended?.movementEvent || null;
    const triggerText = buildLocationTriggerSystemText(point?.trigger);
    if (!triggerText && !movementEvent) {
      return;
    }

    const sessionStore = this.runtimeAdapter.getSessionStore();
    const senderId = resolvePreferredSenderId({
      config: this.config,
      accountId: this.activeAccountId,
      sessionStore,
    });
    const workspaceRoot = resolvePreferredWorkspaceRoot({
      config: this.config,
      accountId: this.activeAccountId,
      senderId,
      sessionStore,
    });
    if (!senderId || !workspaceRoot) {
      return;
    }

    if (triggerText && point?.id) {
      this.systemMessageQueue.enqueue({
        id: `location-trigger:${point.id}`,
        accountId: this.activeAccountId,
        senderId,
        workspaceRoot,
        text: triggerText,
        createdAt: normalizeIsoTime(point?.receivedAt) || normalizeIsoTime(point?.timestamp) || new Date().toISOString(),
      });
    }

    if (movementEvent) {
      this.systemMessageQueue.enqueue({
        id: `location-move:${movementEvent.id}`,
        accountId: this.activeAccountId,
        senderId,
        workspaceRoot,
        text: buildLocationMovementSystemText(movementEvent),
        createdAt: normalizeIsoTime(movementEvent?.movedAt) || new Date().toISOString(),
      });
    }
  }

  async sendTimelineScreenshot({
    senderId = "",
    outputFile = "",
    selector = "",
    range = "",
    date = "",
    week = "",
    month = "",
    category = "",
    subcategory = "",
    width = 0,
    height = 0,
    sidePadding = undefined,
    locale = "",
  } = {}) {
    return this.projectServices.timeline.queueScreenshot({
      userId: senderId,
      outputFile,
      selector,
      range,
      date,
      week,
      month,
      category,
      subcategory,
      width,
      height,
      sidePadding,
      locale,
    }, {});
  }

  async sendLocalFileToCurrentChat({ senderId = "", filePath = "" } = {}) {
    return this.projectServices.channelFile.sendToCurrentChat({
      userId: senderId,
      filePath,
    }, {});
  }

  async handleIncomingMessage(message) {
    const normalized = this.channelAdapter.normalizeIncomingMessage(message);
    if (!normalized) {
      return;
    }

    if (isWeFlowControlConfirmation(normalized.text)) {
      console.log(`[cyberboss] native control confirmation consumed: ${normalized.text}`);
      return;
    }
    this.markPipelineUserInbound?.(normalized.receivedAt);
    if (isWeFlowControlCommand(normalized.text)) {
      await this.handleWeFlowControlCommand(normalized);
      return;
    }

    this.primeDeferredRepliesForSender(normalized);
    await this.handlePreparedMessage(normalized, { allowCommands: true });
  }

  async handleWeFlowControlCommand(normalized) {
    try {
      const result = await executeWeFlowControlCommand(this.config, {
        command: normalized.text,
        contact: "yourself",
        notify: false,
      });
      const confirmation = formatWeFlowControlConfirmation(result);
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: confirmation,
        contextToken: normalized.contextToken,
      });
      console.log(
        `[cyberboss] native control command ${normalized.text} -> ${result.send_source}`
      );
    } catch (error) {
      const detail = formatErrorMessage(error);
      console.warn(`[cyberboss] native control command failed: ${detail}`);
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⚠️ 发信源切换失败：${detail}`,
        contextToken: normalized.contextToken,
      }).catch(() => {});
    }
  }

  deferSystemReply({
    threadId = "",
    userId = "",
    text = "",
    error = null,
    kind = "plain_reply",
    provider = "",
    contextToken = "",
    weflowContact = "",
    weflowTalker = "",
    weflowExactContact = false,
  }) {
    const accountId = this.activeAccountId || this.channelAdapter.resolveAccount().accountId;
    const deferred = this.deferredSystemReplyQueue.enqueue({
      id: `${normalizeCommandArgument(threadId) || "system"}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      accountId,
      senderId: userId,
      threadId,
      text,
      kind,
      createdAt: new Date().toISOString(),
      failedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error || ""),
      // Captured now because the retry has no inbound to rebuild them from.
      provider,
      contextToken,
      weflowContact,
      weflowTalker,
      weflowExactContact: weflowExactContact === true,
    });
    // The queue used to wait for the sender's next inbound, so a failure cost as much
    // as the user's silence. Arm the retry timer instead (see the scheduler module).
    try {
      this.deferredReplyRetryScheduler().schedule(accountId, userId);
    } catch (scheduleError) {
      console.warn(`[cyberboss] deferred retry could not be armed: ${scheduleError.message}`);
    }
    return deferred;
  }

  /** Lazily created so the reply path is untouched when nothing was ever deferred. */
  deferredReplyRetryScheduler() {
    if (!this.deferredReplyRetrySchedulerInstance) {
      this.deferredReplyRetrySchedulerInstance = new DeferredReplyRetryScheduler({
        store: this.deferredSystemReplyQueue,
        format: formatDeferredRepliesForRetry,
        log: (message) => console.warn(`[cyberboss] ${message}`),
        onGiveUp: (entry) => console.warn(`[cyberboss] deferred reply gave up id=${entry.id} error=${entry.lastError}`),
        send: ({ senderId, text, entries }) => this.deliverDeferredReplyBatch({ senderId, text, entries }),
      });
    }
    return this.deferredReplyRetrySchedulerInstance;
  }

  /**
   * Send one drained batch directly, rebuilding the route from the entry.
   *
   * `channelAdapter.sendText` is the same call the normal reply path makes, so the
   * retry keeps the ledger entry, the echo attribution and the delivery
   * verification instead of becoming an untracked same-account message.
   */
  async deliverDeferredReplyBatch({ senderId, text, entries }) {
    const route = Array.isArray(entries) && entries.length ? entries[0] : {};
    const knownTokens = this.channelAdapter.getKnownContextTokens?.() || {};
    const payload = {
      userId: senderId,
      text,
      contextToken: route.contextToken || knownTokens[senderId] || "",
    };
    // Route the retry back over the channel the reply came from. Only `weflow-uia`
    // used to be copied here, so a deferred CUA reply was re-sent with no provider at
    // all, fell through to the official iLink branch and was addressed with a WeChat
    // DISPLAY NAME: `sendMessage ret=-3 errmsg=invalid arguments` (measured
    // 2026-10-02, the fourth experiment). Deferring worked; the retry went out of the
    // wrong door. This is the same migration miss as the reply route, the inbound ack,
    // the deferral gate and the leftover prefix - the fifth.
    if (isDesktopProvider(route.provider)) {
      payload.provider = route.provider;
    }
    if (route.weflowContact) {
      payload.weflowContact = route.weflowContact;
    }
    if (route.weflowTalker) {
      payload.weflowTalker = route.weflowTalker;
    }
    if (route.weflowExactContact === true) {
      payload.weflowExactContact = true;
    }
    return this.channelAdapter.sendText(payload);
  }

  primeDeferredRepliesForSender(normalized) {
    if (!normalized?.accountId || !normalized?.senderId || !normalized?.contextToken) {
      return;
    }
    const pendingReplies = this.deferredSystemReplyQueue.drainForSender(normalized.accountId, normalized.senderId);
    if (!pendingReplies.length) {
      return;
    }
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    this.streamDelivery.setDeferredReplyPrefix(bindingKey, formatDeferredRepliesForRetry(pendingReplies));
    console.warn(
      `[cyberboss] queued deferred reply prefix sender=${normalized.senderId} count=${pendingReplies.length}`
    );
  }

  async handlePreparedMessage(normalized, { allowCommands, internalModelCanary = false }) {
    if (!internalModelCanary) {
      normalized = stripModelCanaryPreparedFields(normalized);
    }
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const deliveryPolicy = internalModelCanary
      && normalized.deliveryPolicy === MODEL_CANARY_DELIVERY_POLICY
      ? MODEL_CANARY_DELIVERY_POLICY
      : (isReminderCreationRequestText(normalized.text) ? SILENT_DELIVERY_POLICY : "");
    const initialReplyTarget = buildReplyTargetFromPrepared({
      ...normalized,
      deliveryPolicy,
    });
    this.streamDelivery.setReplyTarget(bindingKey, initialReplyTarget);

    const command = parseChannelCommand(normalized.text);
    if (allowCommands && command) {
      await this.dispatchChannelCommand(normalized, command);
      return;
    }

    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const prepared = await this.prepareIncomingMessageForRuntime(normalized, workspaceRoot);
    if (!prepared) {
      return;
    }
    if (deliveryPolicy) prepared.deliveryPolicy = deliveryPolicy;
    if (typeof this.isCompletedPendingInbound === "function"
      && this.isCompletedPendingInbound(bindingKey, workspaceRoot, prepared.messageId)) {
      return;
    }

    if (isSharedContentOnlyPreparedMessage(prepared)) {
      if (typeof this.enqueuePendingSharedContentInbound === "function") {
        this.enqueuePendingSharedContentInbound({ bindingKey, workspaceRoot, prepared });
        return;
      }
    }

    const hasPendingSharedContent = typeof this.hasPendingSharedContentInbound === "function"
      && this.hasPendingSharedContentInbound(bindingKey, workspaceRoot, prepared.chatId);
    if (hasPendingSharedContent) {
      const merged = await this.consumePendingSharedContentInbound({
        bindingKey,
        workspaceRoot,
        trailingPrepared: prepared,
      });
      if (merged) {
        return;
      }
    }

    await this.routePreparedInbound({ bindingKey, workspaceRoot, prepared });
  }

  hasPendingSharedContentInbound(bindingKey, workspaceRoot, chatId = "") {
    return this.pendingSharedContentInboundByScope.has(
      buildSharedContentScopeKey(bindingKey, workspaceRoot, chatId)
    );
  }

  enqueuePendingSharedContentInbound({ bindingKey, workspaceRoot, prepared }) {
    const scopeKey = buildSharedContentScopeKey(bindingKey, workspaceRoot, prepared?.chatId);
    if (!scopeKey || !prepared) {
      return;
    }

    const current = this.pendingSharedContentInboundByScope.get(scopeKey) || {
      bindingKey,
      workspaceRoot,
      chatId: normalizeText(prepared.chatId),
      messages: [],
      timer: null,
      lastContentAtMs: 0,
    };
    let updatedDraft;
    if (this.pendingInboundStore) {
      const stored = this.pendingInboundStore.enqueueSharedContent({
        bindingKey,
        workspaceRoot,
        chatId: prepared.chatId,
        message: clonePreparedInboundMessage(prepared),
        lastContentAtMs: resolvePreparedMessageTimeMs(prepared) || Date.now(),
      });
      updatedDraft = { ...stored.draft, timer: current.timer || null };
      this.pendingSharedContentInboundByScope.set(scopeKey, updatedDraft);
    } else {
      current.messages.push(clonePreparedInboundMessage(prepared));
      current.lastContentAtMs = resolvePreparedMessageTimeMs(prepared) || Date.now();
      updatedDraft = current;
      this.pendingSharedContentInboundByScope.set(scopeKey, current);
    }
    this.schedulePendingSharedContentInboundExpiry(scopeKey);
    console.log(
      `[cyberboss] shared content waiting for prompt scope=${scopeKey} count=${updatedDraft.messages.length}`
    );
  }

  schedulePendingSharedContentInboundExpiry(scopeKey, delayMs = null) {
    const draft = this.pendingSharedContentInboundByScope.get(scopeKey);
    if (!draft) {
      return;
    }
    if (draft.timer) {
      clearTimeout(draft.timer);
    }
    const remainingMs = delayMs == null
      ? Math.max(0, draft.lastContentAtMs + resolvePendingInboundQuietWindowMs(this) - Date.now())
      : Math.max(0, Number(delayMs) || 0);
    draft.timer = setTimeout(async () => {
      const weflowBackfillActive = this.weflowInboxSource?.state?.outgoingPollCursor?.backfillActive === true;
      if (this.weflowInboxSource?.pendingEvents?.size || weflowBackfillActive) {
        this.schedulePendingSharedContentInboundExpiry(scopeKey, RETRY_DELAY_MS);
        return;
      }
      try {
        const promoteSharedContent = typeof this.promotePendingSharedContentInbound === "function"
          ? this.promotePendingSharedContentInbound
          : CyberbossApp.prototype.promotePendingSharedContentInbound;
        await promoteSharedContent.call(this, scopeKey);
      } catch (error) {
        console.error(
          `[cyberboss] shared content promotion failed scope=${scopeKey} error=${formatErrorMessage(error)}`
        );
        this.schedulePendingSharedContentInboundExpiry(scopeKey, RETRY_DELAY_MS);
      }
    }, remainingMs);
    draft.timer.unref?.();
    this.pendingSharedContentInboundByScope.set(scopeKey, draft);
  }

  clearPendingSharedContentInboundTimer(scopeKey) {
    const draft = this.pendingSharedContentInboundByScope.get(scopeKey);
    if (!draft?.timer) {
      return;
    }
    clearTimeout(draft.timer);
    draft.timer = null;
  }

  clearPendingSharedContentInboundTimers() {
    for (const [scopeKey] of this.pendingSharedContentInboundByScope.entries()) {
      this.clearPendingSharedContentInboundTimer(scopeKey);
    }
    this.pendingSharedContentInboundByScope.clear();
  }

  restorePendingSharedContentInboundTimers() {
    for (const [scopeKey] of this.pendingSharedContentInboundByScope.entries()) {
      // Resume the persisted source-time deadline; restart must not grant a new
      // full quiet window to content that was already silent before shutdown.
      this.schedulePendingSharedContentInboundExpiry(scopeKey);
    }
  }

  async promotePendingSharedContentInbound(scopeKey) {
    const draft = scopeKey ? this.pendingSharedContentInboundByScope.get(scopeKey) || null : null;
    if (!draft?.bindingKey || !draft?.workspaceRoot) {
      return false;
    }
    const quietUntilMs = Number(draft.lastContentAtMs || 0) + resolvePendingInboundQuietWindowMs(this);
    if (quietUntilMs > Date.now()) {
      this.schedulePendingSharedContentInboundExpiry(scopeKey);
      return false;
    }

    this.clearPendingSharedContentInboundTimer(scopeKey);
    const queued = Array.isArray(draft.messages)
      ? draft.messages
        .filter((message) => message && typeof message === "object")
        .slice()
        .sort(comparePendingInboundMessages)
      : [];
    if (!queued.length) {
      this.dropPendingSharedContentInboundByScopeKey(scopeKey, "empty");
      return false;
    }

    const promoted = buildMergedInboundPrepared({
      bindingKey: draft.bindingKey,
      workspaceRoot: draft.workspaceRoot,
      messages: queued,
    });
    promoted.messageId = buildSharedContentBatchMessageId(
      { messageId: "weflow:shared-standalone" },
      queued
    );
    promoted.sourceMessageIds = normalizeSourceMessageIds(queued.flatMap((message) => [
      message?.messageId,
      ...(Array.isArray(message?.sourceMessageIds) ? message.sourceMessageIds : []),
    ]));

    let movedAtomically = false;
    if (this.pendingInboundStore
      && typeof this.pendingInboundStore.promoteSharedContent === "function") {
      const moved = this.pendingInboundStore.promoteSharedContent(scopeKey, {
        message: promoted,
        consumedIds: queued.map(resolvePendingInboundId).filter(Boolean),
      });
      movedAtomically = true;
      if (moved.draft) {
        this.pendingInboundByScope.set(moved.scopeKey, moved.draft);
      }
      if (moved.sharedDraft) {
        this.pendingSharedContentInboundByScope.set(scopeKey, {
          ...moved.sharedDraft,
          timer: null,
        });
        this.schedulePendingSharedContentInboundExpiry(scopeKey);
      } else {
        this.pendingSharedContentInboundByScope.delete(scopeKey);
      }
    }

    await this.routePreparedInbound({
      bindingKey: draft.bindingKey,
      workspaceRoot: draft.workspaceRoot,
      prepared: promoted,
    });
    if (!movedAtomically) {
      const commitPendingSharedContent = typeof this.commitPendingSharedContentConsumption === "function"
        ? this.commitPendingSharedContentConsumption
        : CyberbossApp.prototype.commitPendingSharedContentConsumption;
      commitPendingSharedContent.call(
        this,
        scopeKey,
        queued.map(resolvePendingInboundId).filter(Boolean)
      );
    }
    console.log(
      `[cyberboss] shared content promoted after quiet window scope=${scopeKey} count=${queued.length}`
    );
    return true;
  }

  dropPendingSharedContentInbound({ bindingKey = "", workspaceRoot = "", chatId = "", reason = "cleared" } = {}) {
    const scopeKey = buildSharedContentScopeKey(bindingKey, workspaceRoot, chatId);
    return this.dropPendingSharedContentInboundByScopeKey(scopeKey, reason);
  }

  dropPendingSharedContentInboundByScopeKey(scopeKey, reason = "cleared") {
    const draft = scopeKey ? this.pendingSharedContentInboundByScope.get(scopeKey) || null : null;
    if (!draft) {
      return false;
    }
    this.clearPendingSharedContentInboundTimer(scopeKey);
    if (this.pendingInboundStore) {
      this.pendingInboundStore.removeSharedScope(scopeKey);
    }
    this.pendingSharedContentInboundByScope.delete(scopeKey);
    console.log(
      `[cyberboss] shared content cleared scope=${scopeKey} reason=${reason} count=${draft.messages?.length || 0}`
    );
    return true;
  }

  commitPendingSharedContentConsumption(scopeKey, consumedIds, {
    remainingMessages = [],
    activePromptId = "",
    promptAcknowledged = false,
    completeSourcePendingId = "",
  } = {}) {
    const consumed = new Set((Array.isArray(consumedIds) ? consumedIds : []).map(normalizeText).filter(Boolean));
    const latest = this.pendingSharedContentInboundByScope.get(scopeKey) || null;
    if (latest?.timer) {
      clearTimeout(latest.timer);
    }
    let retainedDraft = null;
    if (this.pendingInboundStore) {
      retainedDraft = this.pendingInboundStore.commitSharedContent(scopeKey, [...consumed], {
        remainingMessages,
        activePromptId,
        promptAcknowledged,
        completeSourcePendingId,
      });
    } else if (latest) {
      const retainedMessages = (Array.isArray(latest.messages) ? latest.messages : [])
        .filter((message) => !consumed.has(resolvePendingInboundId(message)));
      const retainedIds = new Set(retainedMessages.map(resolvePendingInboundId));
      for (const message of Array.isArray(remainingMessages) ? remainingMessages : []) {
        const pendingId = resolvePendingInboundId(message);
        if (pendingId && consumed.has(pendingId) && !retainedIds.has(pendingId)) {
          retainedMessages.push(message);
          retainedIds.add(pendingId);
        }
      }
      if (retainedMessages.length) {
        retainedDraft = {
          ...latest,
          timer: null,
          messages: retainedMessages,
          lastContentAtMs: resolvePreparedMessageTimeMs(retainedMessages[retainedMessages.length - 1])
            || Date.now(),
          activePromptId: completeSourcePendingId ? "" : normalizeText(activePromptId),
          promptAcknowledged: completeSourcePendingId ? false : Boolean(promptAcknowledged),
        };
      }
    }
    if (!retainedDraft) {
      this.pendingSharedContentInboundByScope.delete(scopeKey);
      return null;
    }
    this.pendingSharedContentInboundByScope.set(scopeKey, { ...retainedDraft, timer: null });
    this.schedulePendingSharedContentInboundExpiry(scopeKey);
    return retainedDraft;
  }

  async consumePendingSharedContentInbound({ bindingKey = "", workspaceRoot = "", trailingPrepared = null } = {}) {
    const scopeKey = buildSharedContentScopeKey(bindingKey, workspaceRoot, trailingPrepared?.chatId);
    const draft = scopeKey ? this.pendingSharedContentInboundByScope.get(scopeKey) || null : null;
    if (!draft?.bindingKey || !draft?.workspaceRoot || !trailingPrepared) {
      return false;
    }

    this.clearPendingSharedContentInboundTimer(scopeKey);
    const promptAtMs = resolvePreparedMessageTimeMs(trailingPrepared) || Date.now();
    const elapsedMs = promptAtMs - Number(draft.lastContentAtMs || 0);
    if (elapsedMs < 0 || elapsedMs > resolvePendingInboundQuietWindowMs(this)) {
      const dropPendingSharedContent = typeof this.dropPendingSharedContentInboundByScopeKey === "function"
        ? this.dropPendingSharedContentInboundByScopeKey
        : CyberbossApp.prototype.dropPendingSharedContentInboundByScopeKey;
      dropPendingSharedContent.call(this, scopeKey, "missed_window");
      console.log(`[cyberboss] shared content prompt missed window scope=${scopeKey} elapsedMs=${elapsedMs}`);
      return false;
    }

    const queued = Array.isArray(draft.messages)
      ? draft.messages
        .filter((message) => message && typeof message === "object")
        .slice()
        .sort(comparePendingInboundMessages)
      : [];
    if (!queued.length) {
      return false;
    }

    const commitPendingSharedContent = typeof this.commitPendingSharedContentConsumption === "function"
      ? this.commitPendingSharedContentConsumption
      : CyberbossApp.prototype.commitPendingSharedContentConsumption;
    const sourcePromptId = normalizeText(trailingPrepared.messageId);
    const promptAcknowledged = draft.activePromptId === sourcePromptId && draft.promptAcknowledged === true;
    let remaining = queued;
    let batchIndex = 0;
    let consumedCount = 0;
    while (remaining.length) {
      const { batchMessages, remainingMessages } = takeBoundedPendingInboundMessages(remaining, {
        splitOversizedFirstAttachments: false,
      });
      if (!batchMessages.length) {
        break;
      }
      const preparedWithReference = buildImplicitReferencedPrepared({
        messages: batchMessages,
        prompt: trailingPrepared,
      });
      preparedWithReference.messageId = buildSharedContentBatchMessageId(trailingPrepared, batchMessages);
      // This key lets the durable store temporarily exceed its capacity while
      // the same shared items are being replaced transactionally. It is
      // metadata only: it must not split otherwise contiguous quiet-window
      // input into separate model turns.
      preparedWithReference.sharedHandoffScopeKey = scopeKey;
      if (batchIndex > 0 || promptAcknowledged) {
        // The first durable batch owns the single user-facing processing ack.
        // Later batches belong to the same prompt and must not emit duplicates.
        preparedWithReference.acknowledgementStatus = "sent";
        preparedWithReference.acknowledgementAt = normalizeIsoTime(trailingPrepared.receivedAt)
          || new Date().toISOString();
      }
      try {
        await this.routePreparedInbound({
          bindingKey: draft.bindingKey,
          workspaceRoot: draft.workspaceRoot,
          prepared: preparedWithReference,
        });
      } catch (error) {
        this.schedulePendingSharedContentInboundExpiry(scopeKey);
        throw error;
      }
      commitPendingSharedContent.call(
        this,
        scopeKey,
        batchMessages.map(resolvePendingInboundId).filter(Boolean),
        {
          remainingMessages,
          activePromptId: sourcePromptId,
          promptAcknowledged: true,
          completeSourcePendingId: remainingMessages.length ? "" : sourcePromptId,
        }
      );
      consumedCount += batchMessages.length;
      remaining = remainingMessages;
      batchIndex += 1;
    }
    console.log(
      `[cyberboss] shared content attached to prompt scope=${scopeKey} count=${consumedCount}`
      + ` batches=${batchIndex} elapsedMs=${elapsedMs}`
    );
    return true;
  }

  isTurnDispatchBlocked(
    bindingKey,
    workspaceRoot,
    { ignoreBoundary = false, ignorePendingFlush = false } = {}
  ) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!ignorePendingFlush && scopeKey && this.pendingInboundFlushScopeKeys?.has(scopeKey)) {
      return true;
    }
    if (!ignoreBoundary && scopeKey && this.turnBoundaryScopeKeys?.has(scopeKey)) {
      return true;
    }
    if (this.turnGateStore.isPending(bindingKey, workspaceRoot)) {
      return true;
    }
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    return threadState?.status === "running" || hasRpcId(threadState?.pendingApproval?.requestId);
  }

  restoreReplyObligationTargets() {
    if (!this.replyObligationStore || !this.streamDelivery) {
      return 0;
    }
    this.replyObligationStore.reconcileWithLedger(this.weflowMessageLedger);
    this.replyObligationStore.expireOverdue();
    let restored = 0;
    for (const entry of this.replyObligationStore.listOpen()) {
      if (!entry.threadId || !entry.senderId) continue;
      const target = {
        userId: entry.senderId,
        contextToken: entry.contextToken,
        provider: "weflow-uia",
        replyObligationId: entry.id,
      };
      if (entry.turnId) {
        this.streamDelivery.bindReplyTargetForTurn({
          threadId: entry.threadId,
          turnId: entry.turnId,
          target,
        });
      } else {
        this.streamDelivery.queueReplyTargetForThread(entry.threadId, target);
      }
      restored += 1;
    }
    if (restored > 0) {
      console.log(`[cyberboss] restored reply obligations count=${restored}`);
    }
    return restored;
  }

  sweepReplyObligations() {
    if (!this.replyObligationStore) {
      return { reconciled: 0, expired: 0 };
    }
    const reconciled = this.replyObligationStore.reconcileWithLedger(this.weflowMessageLedger);
    const expired = this.replyObligationStore.expireOverdue();
    if (expired > 0) {
      console.error(`[cyberboss] reply obligations reached no-reply timeout count=${expired}`);
    }
    return { reconciled, expired };
  }

  async dispatchPreparedTurn({
    bindingKey,
    workspaceRoot,
    prepared,
    sourceMessageIds = [],
    suppressFailureReply = false,
  }) {
    const pendingScopeKey = this.turnGateStore.begin(bindingKey, workspaceRoot);
    this.pipelineActivity?.refresh();
    let replyObligation = null;
    const obligationSourceIds = normalizeSourceMessageIds([
      ...(Array.isArray(sourceMessageIds) ? sourceMessageIds : [sourceMessageIds]),
      ...(Array.isArray(prepared?.sourceMessageIds) ? prepared.sourceMessageIds : [prepared?.sourceMessageIds]),
    ]);
    if (!obligationSourceIds.length && normalizeText(prepared?.messageId)) {
      obligationSourceIds.push(normalizeText(prepared.messageId));
    }
    if (
      this.replyObligationStore
      // Every desktop provider: an inbound turn on any of them deserves a durable
      // reply obligation. Without one there is no deferSystemReply branch at all, so a
      // certain send failure drops the reply instead of retrying it (measured 2026-10-02).
      && isDesktopProvider(prepared.provider)
      && prepared.deliveryPolicy !== SILENT_DELIVERY_POLICY
      && prepared.deliveryPolicy !== MODEL_CANARY_DELIVERY_POLICY
      && obligationSourceIds.length
    ) {
      try {
        replyObligation = this.replyObligationStore.begin({
          sourceMessageIds: obligationSourceIds,
          provider: prepared.provider,
          talker: normalizeWeFlowTalker(prepared.chatId),
          accountId: prepared.accountId,
          senderId: prepared.senderId,
          contextToken: prepared.contextToken,
          bindingKey,
          workspaceRoot,
        });
      } catch (error) {
        this.turnGateStore.releaseScope(bindingKey, workspaceRoot);
        this.pipelineActivity?.refresh();
        console.error(`[cyberboss] reply obligation handoff persistence failed: ${formatErrorMessage(error)}`);
        return false;
      }
      const existing = replyObligation.entry;
      if (!replyObligation.created && existing.terminal) {
        this.turnGateStore.releaseScope(bindingKey, workspaceRoot);
        this.pipelineActivity?.refresh();
        console.warn(
          `[cyberboss] duplicate reply obligation suppressed id=${existing.id} outcome=${existing.terminalOutcome}`
        );
        return true;
      }
      if (
        !replyObligation.created
        && existing.handoffAcceptedAt
        && existing.threadId
      ) {
        const target = {
          userId: existing.senderId,
          contextToken: existing.contextToken,
          provider: "weflow-uia",
          replyObligationId: existing.id,
        };
        if (existing.turnId) {
          this.streamDelivery.bindReplyTargetForTurn({
            threadId: existing.threadId,
            turnId: existing.turnId,
            target,
          });
        } else {
          this.streamDelivery.queueReplyTargetForThread(existing.threadId, target);
        }
        this.turnGateStore.releaseScope(bindingKey, workspaceRoot);
        this.pipelineActivity?.refresh();
        console.warn(`[cyberboss] duplicate runtime handoff suppressed replyObligation=${existing.id}`);
        return true;
      }
    }
    if (prepared.provider !== "weflow-uia") {
      await this.channelAdapter.sendTyping({
        userId: prepared.senderId,
        status: 1,
        contextToken: prepared.contextToken,
      }).catch(() => {});
    }

    try {
      const model = this.runtimeAdapter.getSessionStore().getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model;
      const runtimeTurn = await this.buildRuntimeTurn({ prepared, model });
      const sendTurn = typeof this.runtimeAdapter.sendTurn === "function"
        ? this.runtimeAdapter.sendTurn.bind(this.runtimeAdapter)
        : this.runtimeAdapter.sendTextTurn.bind(this.runtimeAdapter);
      const turn = await sendTurn({
        bindingKey,
        workspaceRoot,
        text: runtimeTurn.text,
        attachments: runtimeTurn.attachments,
        model,
        executionPolicy: normalizeText(prepared.modelCanaryExecutionPolicy),
        metadata: {
          workspaceId: prepared.workspaceId,
          accountId: prepared.accountId,
          senderId: prepared.senderId,
          modelCanaryDenySideEffects:
            normalizeText(prepared.modelCanaryExecutionPolicy) === MODEL_CANARY_EXECUTION_POLICY,
          // One DSH session per chat window: the window travels as an explicit
          // conversation key so the runtime can keep (and resume) one session per
          // conversation instead of minting a new id per process.
          conversationKey: resolveConversationKeyForPrepared(prepared),
          sessionName: resolveSessionNameForPrepared(this.config, prepared),
        },
      });
      this.runtimeContextStore?.setActiveContext?.({
        workspaceRoot,
        runtimeId: this.runtimeAdapter.describe().id,
        threadId: turn.threadId,
        bindingKey,
        accountId: prepared.accountId,
        senderId: prepared.senderId,
      });
      this.turnGateStore.attachThread(pendingScopeKey, turn.threadId);
      const replyTarget = buildReplyTargetFromPrepared(prepared);
      if (prepared.deliveryPolicy === MODEL_CANARY_DELIVERY_POLICY) {
        const handoffReceipt = await this.weflowModelCanary.handleDeliveryEvent({
          type: "runtime_handoff_accepted",
          target: replyTarget,
          threadId: turn.threadId,
          turnId: turn.turnId,
          bindingKey,
          workspaceRoot,
        }).catch(() => ({ accepted: false }));
        if (handoffReceipt?.accepted !== true) {
          console.error(
            `[cyberboss] model canary runtime handoff receipt failed runId=${prepared.modelCanaryRunId || "(unknown)"}`
          );
        }
      }
      if (replyObligation?.entry?.id) {
        replyTarget.replyObligationId = replyObligation.entry.id;
        this.replyObligationStore.markTurnAccepted(replyObligation.entry.id, {
          threadId: turn.threadId,
          turnId: turn.turnId,
        });
      }
      if (turn.turnId) {
        this.streamDelivery.bindReplyTargetForTurn({
          threadId: turn.threadId,
          turnId: turn.turnId,
          target: replyTarget,
        });
      } else {
        this.streamDelivery.queueReplyTargetForThread(turn.threadId, replyTarget);
      }
      return true;
    } catch (error) {
      if (replyObligation?.entry?.id) {
        try {
          this.replyObligationStore.markHandoffFailure(replyObligation.entry.id, error);
        } catch (obligationError) {
          console.error(
            `[cyberboss] failed to record runtime handoff failure obligation=${replyObligation.entry.id}: `
            + formatErrorMessage(obligationError)
          );
        }
      }
      this.turnGateStore.releaseScope(bindingKey, workspaceRoot);
      this.pipelineActivity?.refresh();
      const messageText = error instanceof Error ? error.message : String(error || "unknown error");
      if (isSilentRuntimeDeliveryPolicy(prepared.deliveryPolicy)) {
        console.error(`[cyberboss] background/probe turn failed without user delivery: ${messageText}`);
        return false;
      }
      if (suppressFailureReply) {
        console.error(`[cyberboss] repeated runtime handoff failure reply suppressed: ${messageText}`);
        return false;
      }
      await this.channelAdapter.sendText(applyWeFlowInboundReplyRoute({
        userId: prepared.senderId,
        text: `❌ Request failed\n${messageText}`,
        contextToken: prepared.contextToken,
        provider: prepared.provider,
      }, prepared)).catch(() => {});
      return false;
    }
  }

  async buildRuntimeTurn({ prepared, model = "" }) {
    if (prepared?.deliveryPolicy === MODEL_CANARY_DELIVERY_POLICY) {
      return {
        text: String(prepared.text || "").trim(),
        attachments: [],
        memoryContext: { entries: [], items: [] },
      };
    }
    const memoryContext = typeof this.resolveRelevantMemory === "function"
      ? this.resolveRelevantMemory(prepared)
      : { entries: [], items: [] };
    if (prepared?.provider === "system") {
      return {
        text: injectSystemMemoryContext(String(prepared.text || "").trim(), memoryContext.items),
        attachments: [],
        memoryContext,
      };
    }
    const visionContext = await resolveVisionContext({
      prepared,
      config: this.config,
      runtimeAdapter: this.runtimeAdapter,
      model,
    });
    return {
      text: assembleRuntimeTurnText({
        prepared,
        config: this.config,
        visionContext,
        memoryContext,
      }),
      attachments: Array.isArray(visionContext.runtimeAttachments) ? visionContext.runtimeAttachments : [],
      visionContext,
      memoryContext,
    };
  }

  resolveRelevantMemory(prepared) {
    const service = this.projectServices?.memory;
    if (!service || typeof service.search !== "function") {
      return { entries: [], items: [] };
    }
    const quotedText = (Array.isArray(prepared?.quotedContexts) ? prepared.quotedContexts : [])
      .flatMap((item) => [item?.title, item?.text])
      .filter(Boolean)
      .join("\n");
    const query = prepared?.provider === "system"
      ? `主动联系 定时唤醒 check-in 用户偏好 近期计划 ${String(prepared?.text || "")}`
      : [prepared?.originalText, prepared?.text, quotedText].filter(Boolean).join("\n");
    const result = service.search({
      query,
      limit: this.config.memoryRecallLimit,
    });
    return {
      ...result,
      items: Array.isArray(result?.entries) ? result.entries : [],
    };
  }

  async acknowledgeWeFlowUiaInbound(prepared) {
    const isReminderRequest = prepared?.deliveryPolicy === SILENT_DELIVERY_POLICY;
    if (!shouldAcknowledgeInbound(prepared)) {
      return false;
    }
    const payload = applyWeFlowInboundReplyRoute({
      userId: prepared.senderId,
      text: isReminderRequest ? REMINDER_INBOUND_ACK_TEXT : WEFLOW_UIA_INBOUND_ACK_TEXT,
      contextToken: prepared.contextToken,
      provider: prepared.provider,
      messageKind: isReminderRequest ? "reminder_ack" : "inbound_ack",
    }, prepared);
    const ackStartedAtMs = Date.now();
    const ackReceivedAtMs = Date.parse(normalizeText(prepared?.receivedAt)) || 0;
    try {
      await this.channelAdapter.sendText(payload);
      // The split matters: `latencyMs` is the operator's complaint measured from the
      // moment the message was READ, `sendMs` is how much of it the write path cost.
      // Without these two numbers "处理中 is late" is unfalsifiable.
      console.log(
        `[cyberboss] inbound acknowledged message=${prepared.messageId || "(unknown)"}`
        + ` latencyMs=${ackReceivedAtMs ? Date.now() - ackReceivedAtMs : "?"} sendMs=${Date.now() - ackStartedAtMs}`
      );
      if (isInboundTimestampRequest(prepared?.originalText)
          || isInboundTimestampRequest(prepared?.contentText)
          || isInboundTimestampRequest(prepared?.text)) {
        // "[test]" → deterministic reply with the three timestamps the operator asked for
        // (received → 处理中 sent → this report). Sent as its own message so it never
        // depends on the runtime turn finishing.
        const ackSentAtMs = Date.now();
        const receivedAtText = normalizeText(prepared?.receivedAt);
        const receivedAtMs = Date.parse(receivedAtText) || 0;
        const replyAtMs = Date.now();
        const delta = (value) => (receivedAtMs ? ` (+${value - receivedAtMs} ms)` : "");
        const reportText = [
          "【测试】时间戳",
          `收到消息：${receivedAtText || "(未知)"}` ,
          `处理中已发出：${new Date(ackSentAtMs).toISOString()}${delta(ackSentAtMs)}`,
          `正式回复发出：${new Date(replyAtMs).toISOString()}${delta(replyAtMs)}`,
        ].join("\n");
        try {
        await this.channelAdapter.sendText(applyWeFlowInboundReplyRoute({
          userId: prepared.senderId,
          text: reportText,
          contextToken: prepared.contextToken,
          provider: prepared.provider,
          messageKind: "inbound_timestamp_report",
        }, prepared));
        } catch (reportError) {
          console.warn(`[cyberboss] inbound timestamp report failed: ${formatErrorMessage(reportError)}`);
        }
      }
      return true;
    } catch (error) {
      if (error?.deliveryUncertain === false) {
        console.warn(
          `[cyberboss] inbound acknowledgement failed before dispatch; retrying once: ${formatErrorMessage(error)}`
        );
        await sleep(INBOUND_ACK_CERTAIN_RETRY_DELAY_MS);
        try {
          await this.channelAdapter.sendText(payload);
          console.log(`[cyberboss] inbound acknowledged after bounded retry message=${prepared.messageId || "(unknown)"}`);
          return true;
        } catch (retryError) {
          error = retryError;
        }
      }
      console.warn(`[cyberboss] WeFlow UIA inbound acknowledgement failed: ${formatErrorMessage(error)}`);
      return false;
    }
  }

  async routePreparedInbound({ bindingKey, workspaceRoot, prepared }) {
    const alreadyDispatched = typeof this.isCompletedPendingInbound === "function"
      && this.isCompletedPendingInbound(bindingKey, workspaceRoot, prepared?.messageId);
    if (alreadyDispatched) {
      return false;
    }
    // A durable handoff must precede both acknowledgement and inbox cursor
    // advancement. Routing every ordinary inbound through the store also keeps
    // a newly arrived message behind older queued work for the same scope.
    if (this.pendingInboundStore) {
      const buffered = this.bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared });
      if (typeof this.acknowledgeBufferedInboundOnce === "function") {
        await this.acknowledgeBufferedInboundOnce({ buffered, prepared });
      }
      if (!this.isTurnDispatchBlocked(bindingKey, workspaceRoot)
        && typeof this.flushPendingInboundMessages === "function") {
        await this.flushPendingInboundMessages({ bindingKey, workspaceRoot });
      }
      return false;
    }
    const existingPending = typeof this.findPendingInboundMessage === "function"
      ? this.findPendingInboundMessage(bindingKey, workspaceRoot, prepared?.messageId)
      : null;
    if (existingPending) {
      if (typeof this.acknowledgeBufferedInboundOnce === "function") {
        await this.acknowledgeBufferedInboundOnce({
          buffered: {
            added: false,
            scopeKey: buildScopeKey(bindingKey, workspaceRoot),
            message: existingPending,
          },
          prepared,
        });
      }
      if (!this.isTurnDispatchBlocked(bindingKey, workspaceRoot)
        && typeof this.flushPendingInboundMessages === "function") {
        await this.flushPendingInboundMessages({ bindingKey, workspaceRoot });
      }
      return false;
    }
    const pendingAhead = (
      typeof this.hasPendingInboundMessage === "function"
      && this.hasPendingInboundMessage(bindingKey, workspaceRoot)
    ) || this.pendingInboundPostDispatchCommits?.has?.(buildScopeKey(bindingKey, workspaceRoot));
    if (pendingAhead) {
      const buffered = this.bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared });
      if (typeof this.acknowledgeBufferedInboundOnce === "function") {
        await this.acknowledgeBufferedInboundOnce({ buffered, prepared });
      } else if (typeof this.acknowledgeWeFlowUiaInbound === "function") {
        await this.acknowledgeWeFlowUiaInbound(prepared);
      }
      if (!this.isTurnDispatchBlocked(bindingKey, workspaceRoot)
        && typeof this.flushPendingInboundMessages === "function") {
        await this.flushPendingInboundMessages({ bindingKey, workspaceRoot });
      }
      return false;
    }
    if (this.isTurnDispatchBlocked(bindingKey, workspaceRoot)) {
      const buffered = this.bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared });
      if (typeof this.acknowledgeBufferedInboundOnce === "function") {
        await this.acknowledgeBufferedInboundOnce({ buffered, prepared });
      } else if (typeof this.acknowledgeWeFlowUiaInbound === "function") {
        await this.acknowledgeWeFlowUiaInbound(prepared);
      }
      return false;
    }
    const acknowledgement = typeof this.acknowledgeWeFlowUiaInbound === "function"
      ? this.acknowledgeWeFlowUiaInbound(prepared)
      : Promise.resolve(false);
    const dispatch = this.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared });
    await acknowledgement;
    return dispatch;
  }

  restorePendingInboundFlushTimers() {
    for (const scopeKey of this.pendingInboundByScope.keys()) {
      this.schedulePendingInboundFlush(scopeKey);
    }
  }

  schedulePendingInboundFlush(scopeKey) {
    const normalizedScopeKey = normalizeText(scopeKey);
    const draft = this.pendingInboundByScope.get(normalizedScopeKey);
    if (!normalizedScopeKey || !draft) {
      this.clearPendingInboundFlushTimer(normalizedScopeKey);
      return false;
    }
    const quietUntilMs = Date.parse(normalizeText(draft.quietUntil));
    const nextDispatchAtMs = Date.parse(normalizeText(draft.nextDispatchAt));
    const revokeGate = typeof this.resolvePendingWeFlowRevokeGate === "function"
      ? this.resolvePendingWeFlowRevokeGate(normalizedScopeKey)
      : null;
    const deadlineMs = Math.max(
      Number.isFinite(quietUntilMs) ? quietUntilMs : 0,
      Number.isFinite(nextDispatchAtMs) ? nextDispatchAtMs : 0,
      Number.isFinite(revokeGate?.retryAtMs) ? revokeGate.retryAtMs : 0
    );
    this.clearPendingInboundFlushTimer(normalizedScopeKey);
    if (!deadlineMs || deadlineMs <= Date.now()) {
      return false;
    }

    const generation = Math.max(0, Number(draft.generation) || 0);
    const delayMs = Math.min(0x7fffffff, Math.max(1, deadlineMs - Date.now()));
    const timer = setTimeout(() => {
      const scheduled = this.pendingInboundFlushTimers?.get(normalizedScopeKey);
      if (!scheduled || scheduled.timer !== timer) {
        return;
      }
      this.pendingInboundFlushTimers.delete(normalizedScopeKey);
      const latest = this.pendingInboundByScope.get(normalizedScopeKey);
      if (!latest) {
        return;
      }
      if (Math.max(0, Number(latest.generation) || 0) !== generation) {
        this.schedulePendingInboundFlush(normalizedScopeKey);
        return;
      }
      void this.flushPendingInboundMessages({
        bindingKey: latest.bindingKey,
        workspaceRoot: latest.workspaceRoot,
      }).then(() => {
        this.schedulePendingInboundFlush(normalizedScopeKey);
      }).catch((error) => {
        console.error(
          `[cyberboss] pending inbound quiet-window flush failed scope=${normalizedScopeKey} `
          + `error=${formatErrorMessage(error)}`
        );
        this.schedulePendingInboundFlush(normalizedScopeKey);
      });
    }, delayMs);
    timer.unref?.();
    this.pendingInboundFlushTimers.set(normalizedScopeKey, { deadlineMs, generation, timer });
    return true;
  }

  clearPendingInboundFlushTimer(scopeKey) {
    const normalizedScopeKey = normalizeText(scopeKey);
    const scheduled = this.pendingInboundFlushTimers?.get(normalizedScopeKey);
    if (!scheduled) {
      return false;
    }
    clearTimeout(scheduled.timer || scheduled);
    this.pendingInboundFlushTimers.delete(normalizedScopeKey);
    return true;
  }

  clearPendingInboundFlushTimers() {
    for (const scopeKey of [...(this.pendingInboundFlushTimers?.keys?.() || [])]) {
      this.clearPendingInboundFlushTimer(scopeKey);
    }
  }

  bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared }) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey || !prepared) {
      throw new Error("pending inbound requires a binding, workspace, and prepared message");
    }
    const message = {
      ...clonePreparedInboundMessage(prepared),
      deliveryPolicy: prepared.deliveryPolicy,
    };
    if (this.pendingInboundStore) {
      const result = this.pendingInboundStore.enqueue({ bindingKey, workspaceRoot, message });
      this.pendingInboundByScope.set(scopeKey, result.draft);
      if (typeof this.schedulePendingInboundFlush === "function") {
        this.schedulePendingInboundFlush(scopeKey);
      }
      if (result.added && prepared.suppressAcknowledgement !== true) {
        void this.channelAdapter.sendTyping({
          userId: prepared.senderId,
          status: 1,
          contextToken: prepared.contextToken,
        }).catch(() => {});
      }
      return result;
    }
    const current = this.pendingInboundByScope.get(scopeKey) || {
      bindingKey,
      workspaceRoot,
      messages: [],
      lastActivityAt: "",
      quietUntil: "",
      generation: 0,
    };
    const existing = current.messages.find((item) => (
      normalizeText(item?.messageId) && normalizeText(item.messageId) === normalizeText(message.messageId)
    ));
    if (existing) {
      return { added: false, scopeKey, message: existing, draft: current };
    }
    current.messages.push(message);
    const nowMs = Date.now();
    const receivedAtMs = Date.parse(normalizeText(message.receivedAt));
    const activityAtMs = Number.isFinite(receivedAtMs) && receivedAtMs > 0
      ? Math.min(nowMs, receivedAtMs)
      : nowMs;
    const previousActivityAtMs = Date.parse(normalizeText(current.lastActivityAt));
    const lastActivityAtMs = Math.max(
      Number.isFinite(previousActivityAtMs) ? previousActivityAtMs : 0,
      activityAtMs
    );
    current.lastActivityAt = new Date(lastActivityAtMs).toISOString();
    current.quietUntil = new Date(
      lastActivityAtMs + resolvePendingInboundQuietWindowMs(this)
    ).toISOString();
    current.generation = Math.max(0, Number(current.generation) || 0) + 1;
    this.pendingInboundByScope.set(scopeKey, current);
    if (typeof this.schedulePendingInboundFlush === "function") {
      this.schedulePendingInboundFlush(scopeKey);
    }
    if (prepared.suppressAcknowledgement !== true) {
      void this.channelAdapter.sendTyping({
        userId: prepared.senderId,
        status: 1,
        contextToken: prepared.contextToken,
      }).catch(() => {});
    }
    return { added: true, scopeKey, message, draft: current };
  }

  findPendingInboundMessage(bindingKey, workspaceRoot, messageId) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    const normalizedMessageId = normalizeText(messageId);
    if (!scopeKey || !normalizedMessageId) {
      return null;
    }
    const draft = this.pendingInboundByScope.get(scopeKey);
    return (Array.isArray(draft?.messages) ? draft.messages : []).find((message) => (
      normalizeText(message?.messageId) === normalizedMessageId
      || normalizeText(message?.pendingId) === normalizedMessageId
    )) || null;
  }

  isCompletedPendingInbound(bindingKey, workspaceRoot, messageId) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    const pendingId = normalizeText(messageId);
    return Boolean(scopeKey && pendingId && this.pendingInboundStore?.isCompleted(scopeKey, pendingId));
  }

  async acknowledgeBufferedInboundOnce({ buffered, prepared }) {
    if (!shouldAcknowledgeInbound(prepared)) {
      return false;
    }
    const ackScopeKey = normalizeText(buffered?.scopeKey) || normalizeText(prepared?.senderId);
    const ackActivityAtMs = resolveInboundAckActivityAtMs({
      buffered,
      prepared,
      nowMs: Date.now(),
    });
    if (ackScopeKey) {
      if (!(this.inboundAckActivityAtMs instanceof Map)) {
        this.inboundAckActivityAtMs = new Map();
      }
      const quietWindowMs = resolvePendingInboundQuietWindowMs(this);
      const ackedActivityAtMs = Number(this.inboundAckActivityAtMs.get(ackScopeKey) || 0);
      // One collected burst = one acknowledgement. The window is anchored on the
      // activity time of the message that already answered, so a follow-up inside it
      // is the same logical message (it is also the same dispatched batch). A scope
      // that was closed and opened again by a fresh message has a strictly newer
      // activity, so a new burst always answers immediately.
      const continuesAckedBurst = quietWindowMs > 0
        && ackedActivityAtMs > 0
        && ackActivityAtMs > 0
        && ackActivityAtMs <= ackedActivityAtMs + quietWindowMs;
      if (continuesAckedBurst) {
        return false;
      }
      this.inboundAckActivityAtMs.set(
        ackScopeKey,
        Math.max(ackedActivityAtMs, ackActivityAtMs || Date.now())
      );
    }
    const scopeKey = normalizeText(buffered?.scopeKey);
    const pendingId = normalizeText(buffered?.message?.pendingId)
      || normalizeText(buffered?.message?.messageId)
      || normalizeText(prepared?.messageId);
    let claimed = buffered?.added !== false;
    if (this.pendingInboundStore) {
      this.pendingInboundStore.claimAcknowledgement(scopeKey, pendingId);
      if (claimed) {
        const claimedDraft = this.pendingInboundStore.getScope(scopeKey);
        if (claimedDraft) {
          this.pendingInboundByScope.set(scopeKey, claimedDraft);
        }
      }
    } else if (buffered?.message) {
      if (buffered.message.acknowledgementStatus) {
        claimed = false;
      } else {
        buffered.message.acknowledgementStatus = "sending";
      }
    }
    if (!claimed) {
      return false;
    }
    const success = await this.acknowledgeWeFlowUiaInbound(prepared);
    if (this.pendingInboundStore) {
      this.pendingInboundStore.completeAcknowledgement(scopeKey, pendingId, { success });
      const completedDraft = this.pendingInboundStore.getScope(scopeKey);
      if (completedDraft) {
        this.pendingInboundByScope.set(scopeKey, completedDraft);
      }
    } else if (buffered?.message) {
      buffered.message.acknowledgementStatus = success ? "sent" : "failed";
    }
    return success;
  }

  commitPendingInboundDispatch(scopeKey, consumedIds, { remainingMessages = [] } = {}) {
    if (this.pendingInboundStore) {
      const stored = this.pendingInboundStore.commitDispatch(scopeKey, consumedIds, { remainingMessages });
      if (stored) {
        this.pendingInboundByScope.set(scopeKey, stored);
        if (typeof this.schedulePendingInboundFlush === "function") {
          this.schedulePendingInboundFlush(scopeKey);
        }
      } else {
        this.pendingInboundByScope.delete(scopeKey);
        if (typeof this.clearPendingInboundFlushTimer === "function") {
          this.clearPendingInboundFlushTimer(scopeKey);
        }
      }
      return stored;
    }
    const consumed = new Set((Array.isArray(consumedIds) ? consumedIds : []).map(normalizeText).filter(Boolean));
    const latest = this.pendingInboundByScope.get(scopeKey);
    if (!latest) {
      return null;
    }
    const retained = latest.messages.filter((message) => !consumed.has(resolvePendingInboundId(message)));
    const retainedIds = new Set(retained.map(resolvePendingInboundId));
    for (const message of Array.isArray(remainingMessages) ? remainingMessages : []) {
      const pendingId = resolvePendingInboundId(message);
      if (pendingId && consumed.has(pendingId) && !retainedIds.has(pendingId)) {
        retained.push(message);
        retainedIds.add(pendingId);
      }
    }
    if (retained.length) {
      const next = { ...latest, messages: retained };
      this.pendingInboundByScope.set(scopeKey, next);
      if (typeof this.schedulePendingInboundFlush === "function") {
        this.schedulePendingInboundFlush(scopeKey);
      }
      return next;
    }
    this.pendingInboundByScope.delete(scopeKey);
    if (typeof this.clearPendingInboundFlushTimer === "function") {
      this.clearPendingInboundFlushTimer(scopeKey);
    }
    return null;
  }

  removePendingInboundScope(scopeKey) {
    if (this.pendingInboundStore) {
      this.pendingInboundStore.removeScope(scopeKey);
    }
    if (typeof this.clearPendingInboundFlushTimer === "function") {
      this.clearPendingInboundFlushTimer(scopeKey);
    }
    return this.pendingInboundByScope.delete(scopeKey);
  }

  hasPendingInboundMessage(bindingKey, workspaceRoot) {
    return this.pendingInboundByScope.has(buildScopeKey(bindingKey, workspaceRoot));
  }

  async flushPendingInboundMessages({ bindingKey = "", workspaceRoot = "", ignoreBoundary = false } = {}) {
    const targetScopeKey = buildScopeKey(bindingKey, workspaceRoot);
    const scopeEntries = targetScopeKey
      ? [[targetScopeKey, this.pendingInboundByScope.get(targetScopeKey) || null]]
      : [...this.pendingInboundByScope.entries()];
    const flushingScopeKeys = this.pendingInboundFlushScopeKeys
      || (this.pendingInboundFlushScopeKeys = new Set());
    const postDispatchCommits = this.pendingInboundPostDispatchCommits
      || (this.pendingInboundPostDispatchCommits = new Map());

    for (const [scopeKey, draft] of scopeEntries) {
      if (flushingScopeKeys.has(scopeKey)) {
        continue;
      }
      flushingScopeKeys.add(scopeKey);
      try {
        let activeDraft = draft;
        const pendingCommit = postDispatchCommits.get(scopeKey);
        if (pendingCommit) {
          if (Date.now() < pendingCommit.nextRetryAtMs) {
            continue;
          }
          try {
            this.commitPendingInboundDispatch(scopeKey, pendingCommit.consumedIds, {
              remainingMessages: pendingCommit.remainingMessages,
            });
            postDispatchCommits.delete(scopeKey);
            console.log(`[cyberboss] pending inbound durable commit recovered scope=${scopeKey}`);
            activeDraft = this.pendingInboundByScope.get(scopeKey) || null;
            if (!activeDraft) {
              continue;
            }
          } catch (error) {
            pendingCommit.attemptCount += 1;
            pendingCommit.nextRetryAtMs = Date.now() + Math.min(
              PENDING_INBOUND_COMMIT_RETRY_MAX_MS,
              PENDING_INBOUND_COMMIT_RETRY_BASE_MS * (2 ** Math.min(4, pendingCommit.attemptCount - 1)),
            );
            continue;
          }
        }
        if (!activeDraft?.bindingKey || !activeDraft?.workspaceRoot) {
          if (typeof this.removePendingInboundScope === "function") {
            this.removePendingInboundScope(scopeKey);
          } else {
            this.pendingInboundByScope.delete(scopeKey);
          }
          continue;
        }
        const revokeGate = typeof this.resolvePendingWeFlowRevokeGate === "function"
          ? this.resolvePendingWeFlowRevokeGate(scopeKey)
          : null;
        if (revokeGate?.blocked) {
          if (typeof this.schedulePendingInboundFlush === "function") {
            this.schedulePendingInboundFlush(scopeKey);
          }
          continue;
        }
        const quietUntilMs = Date.parse(normalizeText(activeDraft.quietUntil));
        if (Number.isFinite(quietUntilMs) && quietUntilMs > Date.now()) {
          if (typeof this.schedulePendingInboundFlush === "function") {
            this.schedulePendingInboundFlush(scopeKey);
          }
          continue;
        }
        if (typeof this.acknowledgeBufferedInboundOnce === "function") {
          for (const message of Array.isArray(activeDraft.messages) ? activeDraft.messages : []) {
            if (!message?.acknowledgementStatus && shouldAcknowledgeInbound(message)) {
              await this.acknowledgeBufferedInboundOnce({
                // The burst is acknowledged from its collected activity, not from the
                // individual message: a restart that lost the in-process burst anchor
                // must still answer a whole collected scope once, not once per message.
                buffered: { added: false, scopeKey, message, draft: activeDraft },
                prepared: message,
              });
            }
          }
          activeDraft = this.pendingInboundByScope.get(scopeKey) || activeDraft;
        }
        const refreshedQuietUntilMs = Date.parse(normalizeText(activeDraft.quietUntil));
        if (Number.isFinite(refreshedQuietUntilMs) && refreshedQuietUntilMs > Date.now()) {
          if (typeof this.schedulePendingInboundFlush === "function") {
            this.schedulePendingInboundFlush(scopeKey);
          }
          continue;
        }
        const nextDispatchAtMs = Date.parse(normalizeText(activeDraft.nextDispatchAt));
        if (Number.isFinite(nextDispatchAtMs) && nextDispatchAtMs > Date.now()) {
          if (typeof this.schedulePendingInboundFlush === "function") {
            this.schedulePendingInboundFlush(scopeKey);
          }
          continue;
        }
        if (this.isTurnDispatchBlocked(activeDraft.bindingKey, activeDraft.workspaceRoot, {
          ignoreBoundary,
          ignorePendingFlush: true,
        })) {
          continue;
        }
        const pendingDispatch = this.mergePendingInboundDraft(activeDraft);
        if (!pendingDispatch?.prepared) {
          if (typeof this.removePendingInboundScope === "function") {
            this.removePendingInboundScope(scopeKey);
          } else {
            this.pendingInboundByScope.delete(scopeKey);
          }
          continue;
        }
        const dispatched = await this.dispatchPreparedTurn({
          bindingKey: pendingDispatch.prepared.bindingKey,
          workspaceRoot: pendingDispatch.prepared.workspaceRoot,
          sourceMessageIds: pendingDispatch.consumedIds,
          prepared: {
            workspaceId: pendingDispatch.prepared.workspaceId,
            accountId: pendingDispatch.prepared.accountId,
            senderId: pendingDispatch.prepared.senderId,
            chatId: pendingDispatch.prepared.chatId,
            sourceMessageIds: pendingDispatch.prepared.sourceMessageIds,
            contextToken: pendingDispatch.prepared.contextToken,
            provider: pendingDispatch.prepared.provider,
            deliveryPolicy: pendingDispatch.prepared.deliveryPolicy,
            suppressAcknowledgement: pendingDispatch.prepared.suppressAcknowledgement,
            modelCanaryExecutionPolicy: pendingDispatch.prepared.modelCanaryExecutionPolicy,
            modelCanaryRunId: pendingDispatch.prepared.modelCanaryRunId,
            modelCanaryNonce: pendingDispatch.prepared.modelCanaryNonce,
            modelCanaryObligationFingerprint: pendingDispatch.prepared.modelCanaryObligationFingerprint,
            replyUserId: pendingDispatch.prepared.replyUserId,
            replyWeflowContact: pendingDispatch.prepared.replyWeflowContact,
            replyWeflowTalker: pendingDispatch.prepared.replyWeflowTalker,
            replyWeflowExactContact: pendingDispatch.prepared.replyWeflowExactContact,
            replyMessageKind: pendingDispatch.prepared.replyMessageKind,
            replyIdempotencyKey: pendingDispatch.prepared.replyIdempotencyKey,
            replyCanonicalText: pendingDispatch.prepared.replyCanonicalText,
            replyDesktopInputLease: pendingDispatch.prepared.replyDesktopInputLease,
            originalText: pendingDispatch.prepared.originalText,
            text: pendingDispatch.prepared.text,
            quotedContexts: Array.isArray(pendingDispatch.prepared.quotedContexts)
              ? pendingDispatch.prepared.quotedContexts
              : [],
            attachments: pendingDispatch.prepared.attachments,
            attachmentFailures: pendingDispatch.prepared.attachmentFailures,
            receivedAt: pendingDispatch.prepared.receivedAt,
            sharedHandoffScopeKey: pendingDispatch.prepared.sharedHandoffScopeKey,
          },
          suppressFailureReply: Number(activeDraft.dispatchAttemptCount) > 0,
        });
        if (!dispatched) {
          if (this.pendingInboundStore) {
            const deferred = this.pendingInboundStore.recordDispatchFailure(scopeKey, {
              error: "runtime handoff returned false",
            });
            if (deferred) {
              this.pendingInboundByScope.set(scopeKey, deferred);
              if (typeof this.schedulePendingInboundFlush === "function") {
                this.schedulePendingInboundFlush(scopeKey);
              }
              console.warn(
                `[cyberboss] pending inbound retry deferred scope=${scopeKey} `
                + `attempt=${deferred.dispatchAttemptCount} next=${deferred.nextDispatchAt}`
              );
            }
          } else {
            activeDraft.dispatchAttemptCount = Math.min(16, Number(activeDraft.dispatchAttemptCount || 0) + 1);
            activeDraft.nextDispatchAt = new Date(
              Date.now() + Math.min(15 * 60_000, 15_000 * (2 ** Math.min(6, activeDraft.dispatchAttemptCount - 1)))
            ).toISOString();
            this.pendingInboundByScope.set(scopeKey, activeDraft);
            if (typeof this.schedulePendingInboundFlush === "function") {
              this.schedulePendingInboundFlush(scopeKey);
            }
          }
          continue;
        }
        if (typeof this.commitPendingInboundDispatch === "function") {
          try {
            this.commitPendingInboundDispatch(scopeKey, pendingDispatch.consumedIds, {
              remainingMessages: pendingDispatch.remainingMessages,
            });
          } catch (error) {
            postDispatchCommits.set(scopeKey, {
              consumedIds: pendingDispatch.consumedIds.slice(),
              remainingMessages: pendingDispatch.remainingMessages.slice(),
              attemptCount: 1,
              nextRetryAtMs: Date.now() + PENDING_INBOUND_COMMIT_RETRY_BASE_MS,
            });
            console.error(
              `[cyberboss] pending inbound dispatch accepted but durable commit failed; `
              + `automatic redispatch suppressed scope=${scopeKey} error=${formatErrorMessage(error)}`
            );
          }
        } else {
          const consumed = new Set(pendingDispatch.consumedIds);
          const latest = this.pendingInboundByScope.get(scopeKey) || activeDraft;
          const remaining = latest.messages.filter((message) => !consumed.has(resolvePendingInboundId(message)));
          if (remaining.length) {
            this.pendingInboundByScope.set(scopeKey, { ...latest, messages: remaining });
          } else {
            this.pendingInboundByScope.delete(scopeKey);
          }
        }
      } finally {
        flushingScopeKeys.delete(scopeKey);
      }
    }
  }

  mergePendingInboundDraft(draft) {
    const queued = Array.isArray(draft?.messages)
      ? draft.messages
        .filter((message) => message && typeof message === "object")
        .slice()
        .sort(comparePendingInboundMessages)
      : [];
    if (!queued.length) {
      return null;
    }
    // Shared-content handoff metadata exists for durable capacity accounting,
    // not as a semantic turn boundary. Every message collected in this scope
    // before the inactivity deadline remains eligible for the same batch.
    const dispatchable = queued;
    const boundarySuffix = [];

    if (dispatchable.every((message) => shouldBatchImageOnlyInbound(message))) {
      const { batchMessages, remainingMessages } = takeImageOnlyBatchMessages(
        dispatchable,
        MAX_INBOUND_STICKER_IMAGE_BATCH,
      );
      return {
        prepared: buildMergedInboundPrepared({
          bindingKey: draft.bindingKey,
          workspaceRoot: draft.workspaceRoot,
          messages: batchMessages,
        }),
        consumedIds: batchMessages.map(resolvePendingInboundId).filter(Boolean),
        remainingMessages: [...remainingMessages, ...boundarySuffix],
      };
    }

    const { batchMessages, remainingMessages } = takeBoundedPendingInboundMessages(dispatchable);
    const queuedRemainder = [...remainingMessages, ...boundarySuffix];

    if (batchMessages.length === 1) {
      return {
        prepared: {
          bindingKey: draft.bindingKey,
          workspaceRoot: draft.workspaceRoot,
          ...batchMessages[0],
        },
        consumedIds: [resolvePendingInboundId(batchMessages[0])].filter(Boolean),
        remainingMessages: queuedRemainder,
      };
    }

    const deliveryPolicy = batchMessages.every(
      (message) => message.deliveryPolicy === SILENT_DELIVERY_POLICY
    ) ? SILENT_DELIVERY_POLICY : "";
    const blocks = batchMessages
      .map((message) => String(message.text || "").trim())
      .filter(Boolean);
    const batchText = [
      "Multiple newer WeChat messages arrived within one collection window.",
      "Treat the following blocks as one ordered batch of fresh user input and respond once after considering all of them.",
      "",
      blocks.join("\n\n"),
    ].join("\n").trim();
    const mergedPrepared = buildMergedInboundPrepared({
      bindingKey: draft.bindingKey,
      workspaceRoot: draft.workspaceRoot,
      messages: batchMessages,
    });

    return {
      prepared: {
        ...mergedPrepared,
        deliveryPolicy,
        originalText: batchText,
        text: batchText,
      },
      consumedIds: batchMessages.map(resolvePendingInboundId).filter(Boolean),
      remainingMessages: queuedRemainder,
    };
  }

  async prepareIncomingMessageForRuntime(normalized, workspaceRoot) {
    if (normalized?.provider === "system") {
      return {
        ...normalized,
        originalText: normalized.text,
        text: String(normalized.text || "").trim(),
        attachments: [],
        attachmentFailures: [],
      };
    }

    // Guard for any other source that hands over an unreadable intake: the WeFlow
    // arrival path already reported it and returned before reaching this method, so
    // this is a safety net for the same contract, not a second notice.
    const unreadableIntake = [
      ...(Array.isArray(normalized?.attachmentFailures) ? normalized.attachmentFailures : []),
      ...(Array.isArray(normalized?.persistedAttachmentFailures) ? normalized.persistedAttachmentFailures : []),
    ].filter((failure) => normalizeText(failure?.code) === UNREADABLE_INTAKE_FAILURE_CODE);
    if (unreadableIntake.length) {
      await this.channelAdapter.sendText(applyWeFlowInboundReplyRoute({
        userId: normalized.senderId,
        text: [
          "⚠️ 附件读取失败",
          ...unreadableIntake.map((failure) => `- ${failure.sourceFileName || failure.kind || "附件"}: ${failure.reason}`),
          "可以改用截图，或把内容直接贴成文字发我。",
        ].join("\n"),
        contextToken: normalized.contextToken,
        provider: "weflow-uia",
        messageKind: "intake_failure_notice",
        preserveBlock: true,
      }, { provider: "weflow-uia", chatId: normalizeText(normalized.chatId) })).catch((error) => {
        console.warn(`[cyberboss] intake failure notice could not be sent: ${formatErrorMessage(error)}`);
      });
      return null;
    }

    if (Array.isArray(normalized?.persistedAttachments)
      || Array.isArray(normalized?.persistedAttachmentFailures)) {
      return buildInboundDraft(normalized, {
        attachments: Array.isArray(normalized.persistedAttachments)
          ? normalized.persistedAttachments
          : [],
        attachmentFailures: Array.isArray(normalized.persistedAttachmentFailures)
          ? normalized.persistedAttachmentFailures
          : [],
      });
    }

    const attachments = Array.isArray(normalized.attachments) ? normalized.attachments : [];
    if (!attachments.length) {
      return buildInboundDraft(normalized);
    }

    const persisted = await persistIncomingWeixinAttachments({
      attachments,
      stateDir: this.config.stateDir,
      cdnBaseUrl: this.config.weixinCdnBaseUrl,
      messageId: normalized.messageId,
      receivedAt: normalized.receivedAt,
    });

    if (!persisted.saved.length && persisted.failed.length && !String(normalized.text || "").trim()) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⚠️ Failed to receive image or attachment\n${persisted.failed.map((item) => item.reason).join("\n")}`,
        contextToken: normalized.contextToken,
        preserveBlock: true,
      }).catch(() => {});
      return null;
    }

    const prepared = buildInboundDraft(normalized, {
      attachments: persisted.saved,
      attachmentFailures: persisted.failed,
    });
    if (!prepared.originalText && !prepared.attachments.length && prepared.attachmentFailures.length) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⚠️ Failed to receive image or attachment\n${persisted.failed.map((item) => item.reason).join("\n")}`,
        contextToken: normalized.contextToken,
        preserveBlock: true,
      }).catch(() => {});
      return null;
    }

    return prepared;
  }

  async flushPendingSystemMessages() {
    const pendingMessages = this.systemMessageDispatcher?.drainPending() || [];
    for (const message of pendingMessages) {
      try {
        const dispatched = await this.dispatchSystemMessage(message);
        if (!dispatched) {
          this.systemMessageDispatcher.requeue(message);
        }
      } catch {
        this.systemMessageDispatcher?.requeue(message);
      }
    }
  }

  async flushPendingTimelineScreenshots(account) {
    const pendingJobs = this.timelineScreenshotQueue.drainForAccount(account.accountId);
    for (const job of pendingJobs) {
      try {
        const captured = await this.projectServices.timeline.captureScreenshot({
          outputFile: job.outputFile,
          selector: job.selector,
          range: job.range,
          date: job.date,
          week: job.week,
          month: job.month,
          category: job.category,
          subcategory: job.subcategory,
          width: job.width,
          height: job.height,
          sidePadding: job.sidePadding,
          locale: job.locale,
        });
        await this.sendLocalFileToCurrentChat({
          senderId: job.senderId,
          filePath: captured.outputFile,
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error || "unknown error");
        console.error(`[cyberboss] timeline screenshot failed job=${job.id} ${messageText}`);
        await this.channelAdapter.sendTyping({
          userId: job.senderId,
          status: 0,
        }).catch(() => {});
        await this.channelAdapter.sendText({
          userId: job.senderId,
          text: `❌ Timeline screenshot failed\n${messageText}`,
          preserveBlock: true,
        }).catch(() => {});
      }
    }
  }

  resolveLongPollTimeoutMs() {
    if (this.systemMessageDispatcher?.hasPending()) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }
    if (this.activeAccountId && this.timelineScreenshotQueue.hasPendingForAccount(this.activeAccountId)) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }

    const nextDueAtMs = this.reminderQueue.peekNextDueAtMs();
    if (!nextDueAtMs) {
      return DEFAULT_LONG_POLL_TIMEOUT_MS;
    }

    const remainingMs = nextDueAtMs - Date.now();
    if (remainingMs <= MIN_LONG_POLL_TIMEOUT_MS) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }
    return Math.max(MIN_LONG_POLL_TIMEOUT_MS, Math.min(DEFAULT_LONG_POLL_TIMEOUT_MS, remainingMs));
  }

  async flushDueReminders(account) {
    const dueReminders = this.reminderQueue
      .listDue(Date.now())
      .filter((reminder) => reminder.accountId === account.accountId);

    for (const reminder of dueReminders) {
      try {
        this.systemMessageQueue.enqueue({
          id: `reminder:${reminder.id}`,
          accountId: reminder.accountId,
          senderId: reminder.senderId,
          workspaceRoot: this.resolveReminderWorkspaceRoot(reminder),
          text: buildReminderSystemTrigger(reminder, this.config),
          createdAt: new Date().toISOString(),
        });
      } catch {
        this.reminderQueue.enqueue({
          ...reminder,
          dueAtMs: Date.now() + 5_000,
        });
      }
    }
  }

  resolveReminderWorkspaceRoot(reminder) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: this.config.workspaceId,
      accountId: reminder.accountId,
      senderId: reminder.senderId,
    });
    return this.runtimeAdapter.getSessionStore().getActiveWorkspaceRoot(bindingKey) || this.config.workspaceRoot;
  }

  async dispatchSystemMessage(message) {
    const knownContextTokens = this.channelAdapter.getKnownContextTokens();
    const requestedSenderId = normalizeCommandArgument(message?.senderId);
    let resolvedSenderId = requestedSenderId;
    let contextToken = knownContextTokens[resolvedSenderId] || "";
    const liveUserIds = Object.keys(knownContextTokens).filter((userId) => normalizeCommandArgument(userId));
    if (!contextToken && liveUserIds.length === 1) {
      resolvedSenderId = liveUserIds[0];
      contextToken = knownContextTokens[resolvedSenderId];
      console.warn(
        `[cyberboss] system message target remapped from ${requestedSenderId || "(empty)"} to live ClawBot user ${resolvedSenderId}`
      );
    }
    if (!resolvedSenderId) {
      console.warn(
        `[cyberboss] system message waiting id=${message?.id || ""} reason=no_target_user`
      );
      return false;
    }
    const prepared = this.systemMessageDispatcher?.buildPreparedMessage({
      ...message,
      senderId: resolvedSenderId,
    }, contextToken);
    if (!prepared) {
      throw new Error("system message could not be prepared");
    }
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: prepared.workspaceId,
      accountId: prepared.accountId,
      senderId: prepared.senderId,
    });
    const workspaceRoot = prepared.workspaceRoot || this.resolveWorkspaceRoot(bindingKey);
    if (this.isTurnDispatchBlocked(bindingKey, workspaceRoot)) {
      return false;
    }
    return this.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared });
  }

  async dispatchChannelCommand(normalized, command) {
    switch (command.name) {
      case "bind":
        await this.handleBindCommand(normalized, command);
        return;
      case "status":
        await this.handleStatusCommand(normalized);
        return;
      case "new":
        await this.handleNewCommand(normalized);
        return;
      case "reread":
        await this.handleRereadCommand(normalized);
        return;
      case "compact":
        await this.handleCompactCommand(normalized);
        return;
      case "switch":
        await this.handleSwitchCommand(normalized, command);
        return;
      case "stop":
        await this.handleStopCommand(normalized);
        return;
      case "checkin":
        await this.handleCheckinCommand(normalized, command);
        return;
      case "chunk":
        await this.handleChunkCommand(normalized, command);
        return;
      case "yes":
      case "always":
      case "no":
        await this.handleApprovalCommand(normalized, command);
        return;
      case "model":
        await this.handleModelCommand(normalized, command);
        return;
      case "star":
        await this.handleStarCommand(normalized);
        return;
      case "help":
        await this.handleHelpCommand(normalized);
        return;
      default:
        await this.channelAdapter.sendText({
          userId: normalized.senderId,
          text: buildWeixinHelpText(),
          contextToken: normalized.contextToken,
        });
    }
  }

  async handleBindCommand(normalized, command) {
    const workspaceRoot = normalizeWorkspacePath(command.args);
    if (!workspaceRoot) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /bind /absolute/path",
        contextToken: normalized.contextToken,
      });
      return;
    }

    if (!isAbsoluteWorkspacePath(workspaceRoot)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ Only absolute paths are supported for /bind.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    if (!isPathWithinAllowedDirectories(workspaceRoot)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ The path must be within your home directory or the current working directory.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const stats = await fs.promises.stat(workspaceRoot).catch(() => null);
    if (!stats?.isDirectory()) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Workspace does not exist\n${workspaceRoot}`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    this.runtimeAdapter.getSessionStore().setActiveWorkspaceRoot(bindingKey, workspaceRoot);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Workspace bound\nworkspace: ${workspaceRoot}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleStatusCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    const runtimeName = this.runtimeAdapter.describe().id || "runtime";
    const context = threadState?.context?.runtimeId === runtimeName
      ? threadState.context
      : this.threadStateStore.getLatestContext(runtimeName);
    const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
    const storedModel = runtimeParams.model || "";
    const storedModelProvider = runtimeParams.modelProvider || this.runtimeAdapter.describe().modelProvider || "";
    const effectiveModel = this.runtimeAdapter.describe().model || storedModel;

    const lines = [
      `📍 workspace: ${workspaceRoot}`,
      `🧵 thread: ${threadId || "(none)"}`,
      `📊 status: ${threadState?.status || "idle"}`,
      `🤖 runtime: ${runtimeName}`,
      `🤖 model: ${effectiveModel || "(default)"}`,
      `🤖 provider: ${storedModelProvider || "(default)"}`,
    ];
    lines.push(formatContextStatusLine({
      runtimeName,
      context,
      claudeContextWindow: this.config.claudeContextWindow,
      claudeMaxOutputTokens: this.config.claudeMaxOutputTokens,
    }));
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: lines.join("\n"),
      contextToken: normalized.contextToken,
    });
  }

  async handleNewCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    // The conversation key is what a WeChat window's thread is actually stored
    // under, so it must be passed through: without it `startFreshThreadDraft` falls
    // back to clearing the workspace slot, the conversation binding survives, and
    // the next turn resumes the old session — leaving a stale tool list in place.
    const conversationKey = resolveConversationKeyForSource(normalized);
    if (typeof this.runtimeAdapter.startFreshThreadDraft === "function") {
      await this.runtimeAdapter.startFreshThreadDraft({ bindingKey, workspaceRoot, conversationKey });
    }
    this.runtimeAdapter.getSessionStore().clearThreadIdForWorkspace(bindingKey, workspaceRoot);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Switched to a fresh thread draft\nworkspace: ${workspaceRoot}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleRereadCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    if (!threadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no active thread yet. Send a normal message first.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    try {
      this.streamDelivery.queueReplyTargetForThread(threadId, {
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        provider: normalized.provider,
      });
      const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
      await this.runtimeAdapter.refreshThreadInstructions({
        threadId,
        workspaceRoot,
        model: runtimeParams.model,
        modelProvider: runtimeParams.modelProvider,
      });
    } catch (error) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Reread failed\n${error instanceof Error ? error.message : String(error || "unknown error")}`,
        contextToken: normalized.contextToken,
      }).catch(() => {});
    }
  }

  async handleCompactCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    if (!threadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no active thread yet. Send a normal message first.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    try {
      this.streamDelivery.queueReplyTargetForThread(threadId, {
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        provider: normalized.provider,
      });
      const compactResult = await this.runtimeAdapter.compactThread({
        threadId,
        workspaceRoot,
        model: sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model,
      });
      const compactTurnId = normalizeCommandArgument(compactResult?.turnId);
      if (compactTurnId) {
        this.pendingOperationByRunKey.set(buildRunKey(threadId, compactTurnId), {
          kind: "compact",
          userId: normalized.senderId,
          contextToken: normalized.contextToken,
        });
      }
      // A runtime may answer "I cannot compact" instead of throwing. Reporting
      // "request sent" for that would be a false success the user cannot detect,
      // so surface the refusal with the runtime's own reason.
      if (compactResult?.compacted === false) {
        await this.channelAdapter.sendText({
          userId: normalized.senderId,
          text: [
            "⚠️ 当前 runtime 不支持主动压缩上下文，未做任何改动",
            `thread: ${threadId}`,
            `reason: ${normalizeCommandArgument(compactResult.reason) || "unsupported"}`,
          ].join("\n"),
          contextToken: normalized.contextToken,
        });
        return;
      }
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `🗜️ Compact request sent\nthread: ${threadId}`,
        contextToken: normalized.contextToken,
      });
    } catch (error) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Compact failed\n${error instanceof Error ? error.message : String(error || "unknown error")}`,
        contextToken: normalized.contextToken,
      }).catch(() => {});
    }
  }

  async handleSwitchCommand(normalized, command) {
    const targetThreadId = normalizeThreadId(command.args);
    if (!targetThreadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /switch <threadId>",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
    const resumed = await this.runtimeAdapter.resumeThread({
      threadId: targetThreadId,
      workspaceRoot,
      model: runtimeParams.model,
      modelProvider: runtimeParams.modelProvider,
    });
    sessionStore.setThreadIdForWorkspace(
      bindingKey,
      workspaceRoot,
      resumed?.threadId || targetThreadId,
    );
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Thread switched\nworkspace: ${workspaceRoot}\nthread: ${resumed?.threadId || targetThreadId}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleStopCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    if (!threadId || !threadState?.turnId || !["running", "waiting_approval"].includes(threadState.status)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no running thread right now.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    await this.runtimeAdapter.cancelTurn({
      threadId,
      turnId: threadState.turnId,
      workspaceRoot,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `⏹️ Stop request sent\nthread: ${threadId}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleCheckinCommand(normalized, command) {
    const rangeInput = normalizeCommandArgument(command.args);
    if (!rangeInput) {
      const currentRange = this.checkinConfigStore.getRange(resolveDefaultCheckinRange());
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⏰ Current check-in interval is ${Math.round(currentRange.minIntervalMs / 60000)}-${Math.round(currentRange.maxIntervalMs / 60000)} minutes.`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    const parsedRange = parseCheckinRangeMinutes(rangeInput);
    if (!parsedRange) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /checkin <min>-<max>",
        contextToken: normalized.contextToken,
      });
      return;
    }

    this.checkinConfigStore.setRange({
      minIntervalMs: parsedRange.minMinutes * 60_000,
      maxIntervalMs: parsedRange.maxMinutes * 60_000,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Check-in interval reset to ${parsedRange.minMinutes}-${parsedRange.maxMinutes} minutes and will apply on the next polling cycle.`,
      contextToken: normalized.contextToken,
    });
  }

  async handleChunkCommand(normalized, command) {
    const arg = normalizeCommandArgument(command.args);
    if (!arg) {
      const current = this.channelAdapter.getMinChunkChars?.() ?? DEFAULT_MIN_WEIXIN_CHUNK;
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `💡 Current natural-boundary chunk target is ${current} characters. Usage: /chunk <number> (e.g. /chunk 3600)`,
        contextToken: normalized.contextToken,
      });
      return;
    }
    const parsed = Number.parseInt(arg, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_MIN_WEIXIN_CHUNK) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⚠️  Invalid value. Please provide a number between 1 and ${MAX_MIN_WEIXIN_CHUNK}.`,
        contextToken: normalized.contextToken,
      });
      return;
    }
    const updated = this.channelAdapter.setMinChunkChars?.(parsed) ?? parsed;
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Natural-boundary chunk target set to ${updated} characters. Adjacent fragments are coalesced up to WeChat's 4000-character limit.`,
      contextToken: normalized.contextToken,
    });
  }

  async handleApprovalCommand(normalized, command) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    const approval = threadState?.pendingApproval || null;
    if (!threadId || approval?.requestId == null || String(approval.requestId).trim() === "") {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no pending approval request right now.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const approvalResponse = buildApprovalResponsePayload(approval, command.name);
    if (!approvalResponse) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ This Codex MCP request cannot be answered from WeChat yet.",
        contextToken: normalized.contextToken,
      });
      return;
    }
    console.log(
      `[cyberboss] approval response requested thread=${threadId} requestId=${approval.requestId} mode=${approvalResponse.result ? "result" : "decision"} workspace=${workspaceRoot}`
    );
    await this.runtimeAdapter.respondApproval(approvalResponse);
    this.runtimeAdapter.getSessionStore().clearApprovalPrompt(threadId);
    console.log(
      `[cyberboss] approval response delivered thread=${threadId} requestId=${approval.requestId}`
    );
    if (command.name === "always" && isApprovalAcceptResponse(approvalResponse)) {
      this.runtimeAdapter.getSessionStore().rememberApprovalPrefixForWorkspace(workspaceRoot, approval.commandTokens);
    }
    this.threadStateStore.resolveApproval(threadId, "running");
    const text = buildApprovalResponseText(approval, command.name, approvalResponse);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text,
      contextToken: normalized.contextToken,
    });
  }

  async handleModelCommand(normalized, command) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const query = normalizeCommandArgument(command.args);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const catalog = sessionStore.getAvailableModelCatalog();
    const currentModel = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model;

    if (!query) {
      const lines = [
        `Current model: ${currentModel || "(default)"}`,
      ];
      if (catalog?.models?.length) {
        lines.push(`Available models: ${catalog.models.map((item) => item.model).join(", ")}`);
      } else {
        lines.push("Available models: (not available)");
      }
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: lines.join("\n"),
        contextToken: normalized.contextToken,
      });
      return;
    }

    const runtimeId = this.runtimeAdapter.describe().id || "runtime";
    let matched = findModelByQuery(catalog?.models || [], query);
    if (!matched && runtimeId !== "codex" && !catalog?.models?.length) {
      matched = { model: query };
    }
    if (!matched) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Model not found\n${query}`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
      model: matched.model,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Model switched\nworkspace: ${workspaceRoot}\nmodel: ${matched.model}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleStarCommand(normalized) {
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: [
        "⭐️ Liked this project? Throw me a star on GitHub!",
        "It really means a lot to an indie dev working on passion projects 💖",
        "",
        "https://github.com/WenXiaoWendy/cyberboss",
      ].join("\n"),
      contextToken: normalized.contextToken,
    });
    await this.channelAdapter.sendFile({
      userId: normalized.senderId,
      filePath: path.join(__dirname, "../../assets/star-guide.jpg"),
      contextToken: normalized.contextToken,
    }).catch(() => {});
  }

  async handleHelpCommand(normalized) {
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: buildWeixinHelpText(),
      contextToken: normalized.contextToken,
    });
  }

  resolveWorkspaceRoot(bindingKey) {
    const sessionStore = this.runtimeAdapter.getSessionStore();
    return sessionStore.getActiveWorkspaceRoot(bindingKey) || this.config.workspaceRoot;
  }

  async handleRuntimeEvent(event) {
    const eventThreadId = normalizeText(event?.payload?.threadId);
    const eventSessionStore = this.runtimeAdapter.getSessionStore();
    const eventLinkedBinding = eventThreadId
      ? eventSessionStore.findBindingForThreadId(eventThreadId)
      : null;
    const eventReplyTarget = event?.payload?.threadId
      && typeof this.streamDelivery.resolveReplyTargetForRun === "function"
      ? this.streamDelivery.resolveReplyTargetForRun({
          threadId: event?.payload?.threadId,
          turnId: event?.payload?.turnId,
        })
      : null;
    const modelCanaryEvent = eventReplyTarget?.deliveryPolicy === MODEL_CANARY_DELIVERY_POLICY
      || isModelCanarySenderId(eventLinkedBinding?.senderId);
    if (
      event?.type === "runtime.turn.completed"
      && !modelCanaryEvent
      && typeof this.reconcileGeneratedImagesForTurn === "function"
    ) {
      await this.reconcileGeneratedImagesForTurn(event);
    }
    if (event?.type === "runtime.media.completed") {
      const preparedMediaEvent = this.prepareGeneratedImageRuntimeEvent(event);
      if (!preparedMediaEvent) {
        return;
      }
      await this.streamDelivery.handleRuntimeEvent(preparedMediaEvent);
    } else {
      await this.streamDelivery.handleRuntimeEvent(event);
    }
    if (!event) {
      return;
    }
    if (event.type === "runtime.tool.started") {
      if (!modelCanaryEvent) return;
      await this.weflowModelCanary.handleDeliveryEvent({
        type: "tool_attempted",
        target: eventReplyTarget,
        threadId: event.payload.threadId,
        turnId: event.payload.turnId,
        itemId: event.payload.itemId,
        toolType: event.payload.toolType,
      }).catch(() => ({ accepted: false }));
      if (typeof this.runtimeAdapter.cancelTurn === "function") {
        await this.runtimeAdapter.cancelTurn({
          threadId: event.payload.threadId,
          turnId: event.payload.turnId,
          workspaceRoot: eventLinkedBinding?.workspaceRoot || "",
        }).catch(() => {});
      }
      console.error(
        `[cyberboss] model canary tool attempt cancelled thread=${event.payload.threadId}`
        + ` toolType=${event.payload.toolType || "(unknown)"}`
      );
      return;
    }
    if (event.type === "runtime.turn.completed" || event.type === "runtime.turn.failed") {
      const completedRunKey = buildRunKey(event.payload.threadId, event.payload.turnId);
      const pendingOperations = this.pendingOperationByRunKey;
      const pendingOperation = pendingOperations?.get?.(completedRunKey) || null;
      if (pendingOperation && pendingOperations?.delete) {
        pendingOperations.delete(completedRunKey);
      }
      const sessionStore = eventSessionStore;
      sessionStore.clearApprovalPrompt(event.payload.threadId);
      const linked = eventLinkedBinding || eventSessionStore.findBindingForThreadId(event.payload.threadId);
      const scopeKey = linked?.bindingKey && linked?.workspaceRoot
        ? buildScopeKey(linked.bindingKey, linked.workspaceRoot)
        : "";
      if (scopeKey) {
        this.turnBoundaryScopeKeys.add(scopeKey);
      }
      try {
        let gateRelease = this.turnGateStore.releaseThread(event.payload.threadId);
        if (gateRelease?.released !== true
          && linked?.bindingKey
          && linked?.workspaceRoot
          && typeof this.turnGateStore.releaseScope === "function") {
          gateRelease = this.turnGateStore.releaseScope(linked.bindingKey, linked.workspaceRoot);
        }
        const gateReleaseVerified = gateRelease?.released === true
          && Boolean(scopeKey)
          && gateRelease.scopeKey === scopeKey
          && this.turnGateStore.isPending(linked.bindingKey, linked.workspaceRoot) === false;
        if (modelCanaryEvent) {
          await this.weflowModelCanary.handleDeliveryEvent({
            type: gateReleaseVerified ? "turn_released" : "turn_release_failed",
            target: eventReplyTarget,
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            expectedScopeKey: scopeKey,
            releasedScopeKey: normalizeText(gateRelease?.scopeKey),
          });
        }
        if (event.type === "runtime.turn.failed") {
          await this.sendFailureToThread(
            event.payload.threadId,
            event.payload.text || "❌ Execution failed",
            eventReplyTarget,
          );
        }
        if (linked?.bindingKey && linked?.workspaceRoot) {
          await this.flushPendingInboundMessages({
            bindingKey: linked.bindingKey,
            workspaceRoot: linked.workspaceRoot,
            ignoreBoundary: true,
          });
        } else {
          await this.flushPendingInboundMessages();
        }
        await this.flushPendingSystemMessages();
        if (pendingOperation?.kind === "compact" && event.type === "runtime.turn.completed") {
          await this.channelAdapter.sendText({
            userId: pendingOperation.userId,
            text: `✅ Compact finished\nthread: ${event.payload.threadId}`,
            contextToken: pendingOperation.contextToken,
          }).catch(() => {});
        }
        const shouldKeepTyping = linked?.bindingKey && linked?.workspaceRoot
          ? (
            this.turnGateStore.isPending(linked.bindingKey, linked.workspaceRoot)
            || this.hasPendingInboundMessage(linked.bindingKey, linked.workspaceRoot)
          )
          : false;
        if (!shouldKeepTyping) {
          await this.stopTypingForThread(event.payload.threadId);
        }
      } finally {
        if (scopeKey) {
          this.turnBoundaryScopeKeys.delete(scopeKey);
        }
      }
      return;
    }
    if (event.type !== "runtime.approval.requested") {
      return;
    }
    const approvalReplyTarget = typeof this.streamDelivery.resolveReplyTargetForRun === "function"
      ? this.streamDelivery.resolveReplyTargetForRun({
          threadId: event.payload.threadId,
          turnId: event.payload.turnId,
        })
      : null;
    const sessionStore = eventSessionStore;
    const linked = eventLinkedBinding || sessionStore.findBindingForThreadId(event.payload.threadId);
    if (!linked?.workspaceRoot) {
      return;
    }
    if (modelCanaryEvent) {
      await this.weflowModelCanary.handleDeliveryEvent({
        type: "approval_denied",
        target: eventReplyTarget,
        threadId: event.payload.threadId,
        turnId: event.payload.turnId,
        requestId: event.payload.requestId,
      });
      const denial = buildApprovalResponsePayload(event.payload, "no");
      let denied = false;
      if (denial) {
        denied = await this.runtimeAdapter.respondApproval(denial)
          .then(() => true)
          .catch(() => false);
        if (denied) this.threadStateStore.resolveApproval(event.payload.threadId, "running");
      }
      if (!denied && typeof this.runtimeAdapter.cancelTurn === "function") {
        await this.runtimeAdapter.cancelTurn({
          threadId: event.payload.threadId,
          turnId: event.payload.turnId,
          workspaceRoot: linked.workspaceRoot,
        }).catch(() => {});
      }
      sessionStore.clearApprovalPrompt(event.payload.threadId);
      console.error(
        `[cyberboss] model canary approval denied thread=${event.payload.threadId}`
        + ` requestId=${event.payload.requestId || "(unknown)"}`
      );
      return;
    }
    const allowlist = sessionStore.getApprovalCommandAllowlistForWorkspace(linked.workspaceRoot);
    const shouldAutoApprove = isAutoApprovedStateDirOperation(event.payload, this.config)
      || matchesBuiltInCommandPrefix(event.payload.commandTokens)
      || matchesCommandPrefix(event.payload.commandTokens, allowlist);
    if (!shouldAutoApprove) {
      const promptState = sessionStore.getApprovalPromptState(event.payload.threadId);
      const promptSignature = buildApprovalPromptSignature(event.payload);
      if (promptState?.signature && promptState.signature === promptSignature) {
        sessionStore.rememberApprovalPrompt(event.payload.threadId, event.payload.requestId, promptSignature);
        console.log(
          `[cyberboss] approval prompt deduped thread=${event.payload.threadId} requestId=${event.payload.requestId}`
        );
        return;
      }
      sessionStore.rememberApprovalPrompt(event.payload.threadId, event.payload.requestId, promptSignature);
      await this.sendApprovalPrompt({
        bindingKey: linked.bindingKey,
        approval: event.payload,
        replyTarget: approvalReplyTarget,
      }).catch((error) => {
        sessionStore.clearApprovalPrompt(event.payload.threadId);
        throw error;
      });
      return;
    }
    const approvalResponse = buildApprovalResponsePayload(event.payload, "yes");
    if (!approvalResponse) {
      sessionStore.clearApprovalPrompt(event.payload.threadId);
      await this.sendApprovalPrompt({
        bindingKey: linked.bindingKey,
        approval: event.payload,
        replyTarget: approvalReplyTarget,
      }).catch(() => {});
      return;
    }
    await this.runtimeAdapter.respondApproval(approvalResponse).catch(() => {});
    this.threadStateStore.resolveApproval(event.payload.threadId, "running");
  }

  async reconcileGeneratedImagesForTurn(event) {
    if (typeof this.runtimeAdapter.listTurnGeneratedImages !== "function") {
      return;
    }
    const threadId = normalizeText(event?.payload?.threadId);
    const turnId = normalizeText(event?.payload?.turnId);
    if (!threadId || !turnId) {
      return;
    }

    let artifacts;
    try {
      artifacts = await this.runtimeAdapter.listTurnGeneratedImages({ threadId, turnId });
    } catch (error) {
      console.warn(
        `[cyberboss] generated image discovery failed thread=${threadId} turn=${turnId}: ${formatErrorMessage(error)}`
      );
      return;
    }
    for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
      const mediaEvent = this.prepareGeneratedImageRuntimeEvent({
        type: "runtime.media.completed",
        payload: {
          threadId,
          turnId,
          itemId: artifact?.itemId,
          kind: "image",
          filePath: artifact?.savedPath,
          result: artifact?.result,
          mimeType: "image/png",
        },
      });
      if (mediaEvent) {
        await this.streamDelivery.handleRuntimeEvent(mediaEvent);
      }
    }
  }

  prepareGeneratedImageRuntimeEvent(event) {
    const threadId = normalizeText(event?.payload?.threadId);
    const turnId = normalizeText(event?.payload?.turnId);
    const itemId = normalizeText(event?.payload?.itemId);
    if (!threadId || !turnId || !itemId) {
      return null;
    }
    try {
      const outputDir = this.config.generatedImageOutboundDir
        || path.join(this.config.stateDir, "generated-images-outbound");
      const codexHome = normalizeText(process.env.CODEX_HOME) || path.join(os.homedir(), ".codex");
      const materialized = materializeGeneratedImageArtifact({
        itemId,
        savedPath: event?.payload?.filePath,
        result: event?.payload?.result,
      }, {
        outputDir,
        threadId,
        turnId,
        allowedSourceRoots: [
          path.join(codexHome, "generated_images", threadId),
          outputDir,
        ],
      });
      return {
        type: "runtime.media.completed",
        payload: {
          threadId,
          turnId,
          itemId,
          kind: "image",
          filePath: materialized.filePath,
          mimeType: "image/png",
          sha256: materialized.sha256,
          idempotencyKey: materialized.idempotencyKey,
        },
      };
    } catch (error) {
      console.error(
        `[cyberboss] generated image materialization failed thread=${threadId} turn=${turnId} item=${itemId}: ${formatErrorMessage(error)}`
      );
      return null;
    }
  }

  async stopTypingForThread(threadId) {
    const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(threadId);
    if (normalizeText(linked?.senderId).startsWith("cyberboss-model-canary:")) {
      return;
    }
    const target = linked?.bindingKey ? this.resolveReplyTargetForBinding(linked.bindingKey) : null;
    if (!target) {
      return;
    }
    await this.channelAdapter.sendTyping({
      userId: target.userId,
      status: 0,
      contextToken: target.contextToken,
    }).catch(() => {});
  }

  /**
   * Tell the user that their turn ended without any reply. The store atomically
   * claims the notification so it fires at most once per obligation, even across
   * restarts; background/probe turns are filtered out by sendFailureToThread.
   */
  async notifyTerminalReplyFailure(entry) {
    const threadId = normalizeText(entry?.threadId);
    if (!threadId) return;
    if (this.replyObligationStore.markFailureNotified?.(entry.id) !== true) return;
    const runtimeId = normalizeText(this.runtimeAdapter?.describe?.().id);
    console.error(
      `[cyberboss] turn produced no final reply; notifying user `
      + `thread=${threadId} runtime=${runtimeId || "(unknown)"}`
    );
    await this.sendFailureToThread(
      threadId,
      "❌ 这一轮没有产生任何回复。\n"
        + "通常是运行时不可用（登录凭据过期或连接失败）。你的消息已被记录，但内容无法送达，请检查后重发。",
    );
  }

  async sendFailureToThread(threadId, text, fallbackTarget = null) {
    const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(threadId);
    const fallback = normalizeReplyTarget(fallbackTarget);
    if (isSilentRuntimeDeliveryPolicy(fallback?.deliveryPolicy)) {
      console.error(`[cyberboss] suppressed background/probe turn failure thread=${threadId}`);
      return;
    }
    const target = normalizeReplyTarget(
      linked?.bindingKey ? this.resolveReplyTargetForBinding(linked.bindingKey) : null
    ) || fallback;
    if (!target) {
      return;
    }
    if (isSilentRuntimeDeliveryPolicy(target.deliveryPolicy)) {
      console.error(`[cyberboss] suppressed background/probe turn failure thread=${threadId}`);
      return;
    }
    await this.channelAdapter.sendText({
      userId: target.userId,
      text: normalizeText(text) || "❌ Execution failed",
      contextToken: target.contextToken,
    }).catch(() => {});
  }

  async sendApprovalPrompt({ bindingKey, approval, replyTarget = null }) {
    const target = normalizeReplyTarget(replyTarget) || this.resolveReplyTargetForBinding(bindingKey);
    if (!target) {
      console.warn(
        `[cyberboss] approval prompt skipped binding=${bindingKey} requestId=${approval?.requestId || ""} reason=no_reply_target`
      );
      return;
    }
    if (isSilentRuntimeDeliveryPolicy(target.deliveryPolicy)) {
      console.log(
        `[cyberboss] approval prompt suppressed for background/probe turn binding=${bindingKey} requestId=${approval?.requestId || ""}`
      );
      return;
    }
    console.log(
      `[cyberboss] approval prompt sending binding=${bindingKey} user=${target.userId} requestId=${approval?.requestId || ""}`
    );
    await this.channelAdapter.sendTyping({
      userId: target.userId,
      status: 0,
      contextToken: target.contextToken,
    }).catch(() => {});
    await this.channelAdapter.sendText({
      userId: target.userId,
      text: buildApprovalPromptText(approval),
      contextToken: target.contextToken,
      preserveBlock: true,
    });
    console.log(
      `[cyberboss] approval prompt delivered binding=${bindingKey} user=${target.userId} requestId=${approval?.requestId || ""}`
    );
  }

  async restoreBoundThreadSubscriptions() {
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const bindings = sessionStore.listBindings();
    const seenThreadIds = new Set();

    for (const binding of bindings) {
      const bindingKey = normalizeText(binding?.bindingKey);
      if (!bindingKey) {
        continue;
      }
      if (isModelCanarySenderId(binding?.senderId)) {
        // The canonical target is manifest-bound and intentionally not stored
        // in the generic session binding. After a crash, fail closed: do not
        // synthesize an ordinary Weixin target and do not resume the probe.
        console.warn(`[cyberboss] model canary binding left dormant after restart binding=${bindingKey}`);
        continue;
      }

      const target = this.resolveReplyTargetForBinding(bindingKey);
      if (target) {
        this.streamDelivery.setReplyTarget(bindingKey, target);
      }

      for (const workspaceRoot of sessionStore.listWorkspaceRoots(bindingKey)) {
        const normalizedWorkspaceRoot = normalizeCommandArgument(workspaceRoot);
        const normalizedThreadId = normalizeCommandArgument(
          sessionStore.getThreadIdForWorkspace(bindingKey, normalizedWorkspaceRoot)
        );
        if (!normalizedThreadId || seenThreadIds.has(normalizedThreadId)) {
          continue;
        }
        seenThreadIds.add(normalizedThreadId);
        await this.runtimeAdapter.resumeThread({
          threadId: normalizedThreadId,
          workspaceRoot: normalizedWorkspaceRoot,
        }).catch(() => {});
      }
    }
  }

  resolveReplyTargetForBinding(bindingKey) {
    const binding = this.runtimeAdapter.getSessionStore().getBinding(bindingKey) || null;
    const userId = normalizeCommandArgument(binding?.senderId);
    if (!userId || isModelCanarySenderId(userId)) {
      return null;
    }
    // The provider is NOT always iLink. Answering every binding with "weixin" sent
    // a CUA-path turn's reply to the official API with a WeChat display name as the
    // recipient (`ret=-3 errmsg=invalid arguments`), so the reply was lost even
    // though the message had been received and processed. See resolveReplyProvider.
    const provider = resolveReplyProvider({
      senderId: userId,
      cuaEnabled: this.config.wechatCuaEnabled,
    });
    const contextToken = provider === "weixin"
      ? (this.channelAdapter.getKnownContextTokens()[userId] || "")
      : "";
    return { userId, contextToken, provider };
  }
}

function buildRunKey(threadId, turnId) {
  return `${normalizeCommandArgument(threadId)}:${normalizeCommandArgument(turnId)}`;
}

function buildReplyTargetFromPrepared(prepared = {}) {
  const modelCanary = prepared.deliveryPolicy === MODEL_CANARY_DELIVERY_POLICY;
  const target = {
    userId: modelCanary ? normalizeText(prepared.replyUserId) : normalizeText(prepared.senderId),
    contextToken: normalizeText(prepared.contextToken),
    provider: normalizeText(prepared.provider),
  };
  const deliveryPolicy = normalizeText(prepared.deliveryPolicy);
  if (deliveryPolicy) target.deliveryPolicy = deliveryPolicy;
  // Per-chat reply routing: an inbound turn answers the chat it came from, so the
  // UIA route carries that chat's own wxid as both contact and talker. The bridge
  // resolves the displayed name from the talker on every dispatch.
  const perChatUiaRoute = resolveWeFlowUiaReplyChat(prepared);
  if (perChatUiaRoute) {
    target.weflowContact = perChatUiaRoute;
    target.weflowTalker = perChatUiaRoute;
  }
  if (modelCanary) {
    target.modelCanaryExecutionPolicy = normalizeText(prepared.modelCanaryExecutionPolicy);
    target.modelCanaryRunId = normalizeText(prepared.modelCanaryRunId);
    target.modelCanaryNonce = normalizeText(prepared.modelCanaryNonce);
    target.modelCanaryObligationFingerprint = normalizeText(prepared.modelCanaryObligationFingerprint);
    target.weflowContact = normalizeText(prepared.replyWeflowContact);
    target.weflowTalker = normalizeText(prepared.replyWeflowTalker);
    target.weflowExactContact = prepared.replyWeflowExactContact === true;
    target.messageKind = normalizeText(prepared.replyMessageKind);
    target.idempotencyKey = normalizeText(prepared.replyIdempotencyKey);
    target.canonicalText = normalizeText(prepared.replyCanonicalText);
    target.desktopInputLease = normalizeDesktopInputLease(prepared.replyDesktopInputLease);
  }
  return target;
}

function resolveWeFlowUiaReplyChat(source = {}) {
  if (normalizeText(source.provider) !== "weflow-uia") {
    return "";
  }
  const match = /^weflow:(.+)$/.exec(normalizeText(source.chatId));
  return match ? normalizeText(match[1]) : "";
}

const TEST_SESSION_KEY = "test-session";

/**
 * A `[test]` marker moves one turn into the reserved test session.
 *
 * Testing a real window would otherwise write fabricated messages into that
 * conversation's context, so the marker is the operator's way of saying "this
 * turn is a drill".
 */
function isInboundTimestampRequest(text) {
  // Operator probe: sending "[test]" makes the bot answer with the three timestamps of
  // that very message instead of going through the model.
  return normalizeText(text).toLowerCase() === "[test]";
}

function isTestSessionRequest(text) {
  return /\[test\]/iu.test(normalizeText(text));
}

/**
 * Which DSH conversation this turn belongs to.
 *
 * The chat window (one WeChat conversation) is the unit a session is kept for;
 * `test-session` is the reserved window used by `[test]` messages so a test run
 * never mixes into a real conversation's context.
 */
function resolveConversationKeyForPrepared(prepared = {}) {
  return resolveConversationKeyForSource(prepared);
}

/**
 * Conversation scope for either a prepared turn or a raw inbound.
 *
 * Both shapes carry the same two fields, and the command path (`/new`, `/bind`)
 * receives the raw inbound rather than a prepared turn. Resolving the key the same
 * way in both places matters: `startFreshThreadDraft` stores a WeChat window's
 * thread under the CONVERSATION map, so clearing only the workspace slot leaves the
 * conversation binding intact and the next turn resumes the very session the
 * operator just tried to leave. That is exactly what happened on 2026-09-30 — a
 * `/new` reported success and the runtime logged `resumed session ...` afterwards.
 */
function resolveConversationKeyForSource(source = {}) {
  // Derived from the message content, not from a parallel field: the inbound
  // travels through several strict field lists (pending queue, prepared clone)
  // that silently drop anything not on their list, while the text itself always
  // survives. A `[test]` marker therefore cannot be lost on the way.
  if (preparedRequestsTestSession(source)) {
    return TEST_SESSION_KEY;
  }
  const scope = normalizeText(source.sessionScope);
  if (scope) {
    return scope;
  }
  return normalizeText(source.chatId);
}

function preparedRequestsTestSession(prepared = {}) {
  return isTestSessionRequest(prepared.contentText)
    || isTestSessionRequest(prepared.originalText)
    || isTestSessionRequest(prepared.text)
    || normalizeText(prepared.sessionScope) === TEST_SESSION_KEY;
}

function resolveSessionNameForPrepared(config = {}, prepared = {}) {
  if (preparedRequestsTestSession(prepared)) {
    return TEST_SESSION_KEY;
  }
  const scope = normalizeText(prepared.sessionScope);
  if (scope) {
    return scope;
  }
  const match = /^weflow:(.+)$/u.exec(normalizeText(prepared.chatId));
  const talker = match ? normalizeText(match[1]) : "";
  if (!talker) {
    return "";
  }
  // The operator names each window explicitly (大-/小-/收-/发-), because only they
  // know which accounts are 大号 and which are 小号.
  const labels = config?.weflowWindowLabels;
  const label = labels && typeof labels === "object" ? normalizeText(labels[talker]) : "";
  return label || talker;
}

function applyWeFlowInboundReplyRoute(payload, source = {}) {  const chat = resolveWeFlowUiaReplyChat(source);
  if (chat) {
    payload.weflowContact = chat;
    payload.weflowTalker = chat;
  }
  return payload;
}

function stripModelCanaryPreparedFields(prepared = {}) {
  const sanitized = { ...prepared };
  for (const key of [
    "suppressAcknowledgement",
    "modelCanaryExecutionPolicy",
    "modelCanaryRunId",
    "modelCanaryNonce",
    "modelCanaryObligationFingerprint",
    "replyUserId",
    "replyWeflowContact",
    "replyWeflowTalker",
    "replyWeflowExactContact",
    "replyMessageKind",
    "replyIdempotencyKey",
    "replyCanonicalText",
    "replyDesktopInputLease",
  ]) {
    delete sanitized[key];
  }
  if (sanitized.deliveryPolicy === MODEL_CANARY_DELIVERY_POLICY) {
    delete sanitized.deliveryPolicy;
  }
  return sanitized;
}

function isSilentRuntimeDeliveryPolicy(value) {
  const policy = normalizeText(value);
  return policy === SILENT_DELIVERY_POLICY || policy === MODEL_CANARY_DELIVERY_POLICY;
}

function normalizeReplyTarget(target) {
  if (!target?.userId) {
    return null;
  }
  const normalized = {
    userId: String(target.userId).trim(),
    contextToken: normalizeText(target.contextToken),
    provider: normalizeText(target.provider),
  };
  const deliveryPolicy = normalizeText(target.deliveryPolicy);
  if (deliveryPolicy) {
    normalized.deliveryPolicy = deliveryPolicy;
  }
  for (const key of [
    "replyObligationId",
    "modelCanaryRunId",
    "modelCanaryNonce",
    "modelCanaryObligationFingerprint",
    "modelCanaryExecutionPolicy",
    "weflowContact",
    "weflowTalker",
    "messageKind",
    "idempotencyKey",
    "canonicalText",
  ]) {
    const value = normalizeText(target[key]);
    if (value) normalized[key] = value;
  }
  if (target.weflowExactContact === true) normalized.weflowExactContact = true;
  const desktopInputLease = normalizeDesktopInputLease(target.desktopInputLease);
  if (desktopInputLease) normalized.desktopInputLease = desktopInputLease;
  const requireDesktopIdleSeconds = normalizePositiveInteger(target.requireDesktopIdleSeconds);
  if (requireDesktopIdleSeconds) normalized.requireDesktopIdleSeconds = requireDesktopIdleSeconds;
  return normalized;
}

function normalizeDesktopInputLease(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    version: Number(raw.version),
    mode: normalizeText(raw.mode),
    runId: normalizeText(raw.runId).toLowerCase(),
    nonce: normalizeText(raw.nonce).toLowerCase(),
    targetFingerprint: normalizeText(raw.targetFingerprint).toLowerCase(),
    replyIdempotencyKey: normalizeText(raw.replyIdempotencyKey),
    expiresAt: normalizeText(raw.expiresAt),
    token: normalizeText(raw.token).toLowerCase(),
  };
}

function isModelCanarySenderId(value) {
  return normalizeText(value).startsWith("cyberboss-model-canary:");
}

function normalizePositiveInteger(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function formatCompactNumber(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return "0";
  }
  if (normalized >= 1_000_000) {
    return `${Math.round(normalized / 100_000) / 10}m`;
  }
  if (normalized >= 1_000) {
    return `${Math.round(normalized / 100) / 10}k`;
  }
  return String(Math.round(normalized));
}

function formatContextStatusLine({ runtimeName, context, claudeContextWindow, claudeMaxOutputTokens }) {
  if (runtimeName === "claudecode") {
    const configuredWindow = Number(claudeContextWindow);
    if (!Number.isFinite(configuredWindow) || configuredWindow <= 0) {
      return "📦 context: set CYBERBOSS_CLAUDE_CONTEXT_WINDOW";
    }
    const reservedOutputTokens = Math.max(0, Number(claudeMaxOutputTokens) || 0);
    const availableMessageWindow = configuredWindow - reservedOutputTokens;
    if (availableMessageWindow <= 0) {
      return "📦 context: reduce CLAUDE_CODE_MAX_OUTPUT_TOKENS";
    }
    if (!context || !Number.isFinite(Number(context.currentTokens))) {
      return "📦 context: unavailable";
    }
    const summary = formatContextUsage(Number(context.currentTokens), availableMessageWindow);
    if (reservedOutputTokens > 0) {
      return `📦 context: approx ${summary} | reserve ${formatCompactNumber(reservedOutputTokens)}`;
    }
    return `📦 context: approx ${summary}`;
  }
  if (!context) {
    return "📦 context: unavailable";
  }
  const currentTokens = Number(context.currentTokens);
  const contextWindow = Number(context.contextWindow);
  if (!Number.isFinite(currentTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return "📦 context: unavailable";
  }
  return `📦 context: ${formatContextUsage(currentTokens, contextWindow)}`;
}

function formatContextUsage(currentTokens, contextWindow) {
  const safeCurrent = Math.max(0, Number(currentTokens) || 0);
  const safeWindow = Math.max(1, Number(contextWindow) || 1);
  const clampedCurrent = Math.min(safeCurrent, safeWindow);
  const leftPercent = Math.max(0, Math.min(100, Math.round(((safeWindow - clampedCurrent) / safeWindow) * 100)));
  return `${formatCompactNumber(clampedCurrent)}/${formatCompactNumber(safeWindow)} | ${leftPercent}% left`;
}

function buildLocationMovementSystemText(event) {
  const distanceText = `${formatCompactNumber(event?.distanceMeters || 0)}m`;
  const fromLabel = normalizeText(event?.fromAddress) || formatLatLng(event?.fromCenterLat, event?.fromCenterLng);
  const toLabel = normalizeText(event?.toAddress) || formatLatLng(event?.toCenterLat, event?.toCenterLng);
  const movedAt = normalizeText(event?.movedAt) || new Date().toISOString();
  return [
    "System context: the user's location appears to have changed significantly.",
    `Distance: about ${distanceText}.`,
    fromLabel ? `From: ${fromLabel}` : "",
    toLabel ? `To: ${toLabel}` : "",
    `Observed at: ${movedAt}.`,
  ].filter(Boolean).join("\n");
}

function buildLocationTriggerSystemText(trigger) {
  switch (normalizeText(trigger)) {
    case "arrive_home":
      return "User arrives home.";
    case "leave_home":
      return "User leaves home.";
    default:
      return "";
  }
}

function formatLatLng(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return "";
  }
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}
function createShutdownController(onStop) {
  let stopped = false;
  let stoppingPromise = null;

  const stop = async () => {
    if (stopped) {
      return stoppingPromise;
    }
    stopped = true;
    stoppingPromise = Promise.resolve().then(onStop);
    return stoppingPromise;
  };

  const handleSignal = () => {
    stop().finally(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  return {
    get stopped() {
      return stopped;
    },
    dispose() {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
    },
  };
}

function assertWeixinUpdateResponse(response) {
  const ret = normalizeErrorCode(response?.ret);
  const errcode = normalizeErrorCode(response?.errcode);
  if ((ret !== 0 && ret !== null) || (errcode !== 0 && errcode !== null)) {
    const error = new Error(
      `weixin getUpdates ret=${ret ?? ""} errcode=${errcode ?? ""} errmsg=${normalizeText(response?.errmsg) || ""}`
    );
    error.ret = ret;
    error.errcode = errcode;
    throw error;
  }
}

function isSessionExpiredError(error) {
  const ret = normalizeErrorCode(error?.ret);
  const errcode = normalizeErrorCode(error?.errcode);
  return ret === SESSION_EXPIRED_ERRCODE
    || errcode === SESSION_EXPIRED_ERRCODE
    || String(error?.message || "").includes("session expired")
    || String(error?.message || "").includes("session invalidated");
}

function normalizeErrorCode(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatErrorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error || "unknown error");
  if (isSessionExpiredError(error)) {
    return "The WeChat session has expired. Run `npm run login` again.";
  }
  return raw;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function injectSystemMemoryContext(text, items) {
  const source = String(text || "").trim();
  const memories = (Array.isArray(items) ? items : [])
    .map((item) => {
      const content = normalizeText(item?.content).replace(/\s+/g, " ").slice(0, 2_000);
      if (!content) {
        return "";
      }
      const category = normalizeText(item?.category) || "memory";
      const key = normalizeText(item?.key);
      return `- [${key ? `${category}/${key}` : category}] ${content}`;
    })
    .filter(Boolean);
  if (!source || !memories.length) {
    return source;
  }
  const section = [
    "Relevant durable memory:",
    ...memories,
    "Use this as background; do not mention memory mechanics in the outgoing message.",
  ].join("\n");
  const marker = "\n\nTrigger:\n";
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) {
    return `${source}\n\n${section}`;
  }
  return `${source.slice(0, markerIndex)}\n\n${section}${source.slice(markerIndex)}`;
}

function buildWechatCliInboxTurnText(message, snapshot = {}, config = {}) {
  const chat = normalizeText(snapshot.chat) || normalizeText(config.wechatCliInboxChat) || "main account";
  const header = `本地微信入站（来自大号会话 ${chat}）`;
  const text = normalizeText(message?.text);
  const title = normalizeText(message?.title);
  const url = normalizeText(message?.url);
  const body = [];
  if (text) {
    body.push(text);
  } else if (title) {
    body.push(`[${formatWechatCliKind(message?.kind)}] ${title}`);
  }
  if (url && !body.some((item) => item.includes(url))) {
    body.push(url);
  }
  return [header, ...body].join("\n").trim();
}

function buildWeFlowInboxTurnText(message, snapshot = {}, config = {}) {
  const chat = normalizeText(snapshot.chat)
    || normalizeText(config.weflowInboxDisplayName)
    || normalizeText(config.weflowInboxChat)
    || "main account";
  const header = message?.origin === "self_manual"
    ? `WeFlow 同号人工控制输入（来自手机或桌面会话 ${chat}）`
    : `WeFlow 微信入站（来自大号会话 ${chat}）`;
  const text = normalizeText(message?.text);
  const title = normalizeText(message?.title);
  const url = normalizeText(message?.url);
  const body = [];
  if (text) {
    body.push(message?.voiceTranscript ? `[语音转写]\n${text}` : text);
  } else if (title) {
    body.push(`[${formatWechatCliKind(message?.kind)}] ${title}`);
  }
  if (url && !body.some((item) => item.includes(url))) {
    body.push(url);
  }
  return [header, ...body].join("\n").trim();
}

function formatWechatCliKind(value) {
  switch (normalizeText(value).toLowerCase()) {
    case "image":
      return "图片";
    case "voice":
      return "语音";
    case "video":
      return "视频";
    case "file":
      return "文件";
    case "link":
      return "链接";
    default:
      return "资料";
  }
}

function countPendingInboundMessages(scopeMap) {
  if (!(scopeMap instanceof Map)) {
    return 0;
  }
  let count = 0;
  for (const scope of scopeMap.values()) {
    count += Array.isArray(scope?.messages) ? scope.messages.length : 0;
  }
  return count;
}

function listPendingWeFlowRevokes(source, config = {}) {
  if (!(source?.pendingEvents instanceof Map)) {
    return [];
  }
  const configuredChat = normalizeText(config?.weflowInboxChat);
  return [...source.pendingEvents.values()].filter((item) => {
    if (normalizeText(item?.eventType) !== "message.revoke") {
      return false;
    }
    const push = item?.push || {};
    const chat = normalizeText(push.sessionId || push.talker || push.chatUsername);
    return !configuredChat || !chat || chat === configuredChat;
  });
}

module.exports = { CyberbossApp, formatDeferredRepliesForRetry, shouldAcknowledgeInbound };

function parseChannelCommand(text) {
  const normalized = typeof text === "string" ? text.trim() : "";
  if (!normalized.startsWith("/")) {
    return null;
  }
  const [rawName, ...rest] = normalized.slice(1).split(/\s+/);
  const name = normalizeCommandName(rawName);
  if (!name) {
    return null;
  }
  return {
    name,
    args: rest.join(" ").trim(),
  };
}

function normalizeCommandName(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

const WINDOWS_DRIVE_PATH_RE = /^[A-Za-z]:\//;
const WINDOWS_DRIVE_ROOT_RE = /^[A-Za-z]:\/$/;
const WINDOWS_UNC_PREFIX_RE = /^\/\/\?\//;

function normalizeWorkspacePath(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }

  const fromFileUri = extractPathFromFileUri(normalized);
  const rawPath = fromFileUri || normalized;
  const withForwardSlashes = rawPath.replace(/\\/g, "/").replace(WINDOWS_UNC_PREFIX_RE, "");
  const normalizedDrivePrefix = /^\/[A-Za-z]:\//.test(withForwardSlashes)
    ? withForwardSlashes.slice(1)
    : withForwardSlashes;

  if (WINDOWS_DRIVE_ROOT_RE.test(normalizedDrivePrefix)) {
    return normalizedDrivePrefix;
  }
  if (WINDOWS_DRIVE_PATH_RE.test(normalizedDrivePrefix)) {
    return normalizedDrivePrefix.replace(/\/+$/g, "");
  }
  return normalizedDrivePrefix.replace(/\/+$/g, "");
}

function isAbsoluteWorkspacePath(value) {
  const normalized = normalizeWorkspacePath(value);
  if (!normalized) {
    return false;
  }
  if (WINDOWS_DRIVE_PATH_RE.test(normalized)) {
    return true;
  }
  return path.posix.isAbsolute(normalized);
}

function extractPathFromFileUri(value) {
  const input = String(value || "").trim();
  if (!/^file:\/\//i.test(input)) {
    return "";
  }

  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "file:") {
      return "";
    }
    const pathname = decodeURIComponent(parsed.pathname || "");
    const withHost = parsed.host && parsed.host !== "localhost"
      ? `//${parsed.host}${pathname}`
      : pathname;
    return withHost;
  } catch {
    return "";
  }
}

function isPathWithinAllowedDirectories(rawPath) {
  const resolved = path.resolve(rawPath);
  const normalized = resolved.replace(/\\/g, "/") + "/";
  const allowedDirs = [
    os.homedir(),
    process.cwd(),
    this?.config?.workspaceRoot,
  ]
    .filter(Boolean)
    .map((dir) => path.resolve(dir).replace(/\\/g, "/") + "/");
  return allowedDirs.some((prefix) => normalized.startsWith(prefix));
}

function normalizeCommandArgument(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isStaleWeixinContextError(error) {
  const message = String(error?.message || error || "");
  return Number(error?.ret) === -2
    || Number(error?.errcode) === -2
    || message.includes("sendMessage ret=-2")
    || message.includes("errcode=-2");
}

function normalizeThreadId(value) {
  const normalized = normalizeCommandArgument(value);
  if (!normalized) {
    return "";
  }
  return normalized.replace(/\s+/g, "");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSourceMessageIds(value) {
  const seen = new Set();
  const normalized = [];
  for (const item of Array.isArray(value) ? value : [value]) {
    const id = normalizeText(item);
    if (id && !seen.has(id)) {
      seen.add(id);
      normalized.push(id);
    }
  }
  return normalized;
}

function normalizeWeFlowTalker(value) {
  const normalized = normalizeText(value);
  return normalized.startsWith("weflow:") ? normalized.slice("weflow:".length).trim() : normalized;
}

function normalizeWeFlowPendingId(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "";
  }
  return normalized.startsWith("weflow:") ? normalized : `weflow:${normalized}`;
}

function resolveInboundActivityTime(activity) {
  const receivedAt = normalizeIsoTime(activity?.receivedAt);
  if (receivedAt) {
    return receivedAt;
  }
  const timestampMs = Number(activity?.timestamp) * 1_000;
  return Number.isFinite(timestampMs) && timestampMs > 0
    ? new Date(timestampMs).toISOString()
    : "";
}

function resolvePendingInboundQuietWindowMs(app) {
  const configured = Number(app?.config?.pendingInboundQuietWindowMs);
  return Number.isSafeInteger(configured) && configured >= 0
    ? configured
    : WEFLOW_UIA_INBOUND_ACK_QUIET_WINDOW_FALLBACK_MS;
}

/**
 * Activity time of the message asking for an acknowledgement, on the same clock the
 * collection window uses.
 *
 * The draft already carries `max(previous activity, this message)`, which keeps a
 * follow-up that is older than the head of the burst (out-of-order source timestamps)
 * inside the same window. `prepared.receivedAt` is the fallback for callers without a
 * store-backed draft, and "now" is the last resort so a missing timestamp can never
 * turn into "suppress everything".
 */
function resolveInboundAckActivityAtMs({ buffered, prepared, nowMs }) {
  const draftActivityAtMs = Date.parse(normalizeText(buffered?.draft?.lastActivityAt));
  if (Number.isFinite(draftActivityAtMs) && draftActivityAtMs > 0) {
    return draftActivityAtMs;
  }
  const messageActivityAtMs = Date.parse(
    normalizeText(buffered?.message?.receivedAt) || normalizeText(prepared?.receivedAt)
  );
  if (Number.isFinite(messageActivityAtMs) && messageActivityAtMs > 0) {
    return Math.min(nowMs, messageActivityAtMs);
  }
  return nowMs;
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Date(parsed).toISOString();
}

function matchesBuiltInCommandPrefix(commandTokens) {
  const normalized = normalizeCommandTokensForMatching(commandTokens);
  if (!normalized.length) {
    return false;
  }

  if (normalized[0] === "view_image") {
    return true;
  }

   if (normalized[0] === "mcp_tool" && normalized[1] === "cyberboss_tools") {
    return true;
  }

  return false;
}

function normalizeCommandTokensForMatching(commandTokens) {
  return canonicalizeCommandTokens(commandTokens);
}

function buildApprovalPromptText(approval) {
  if (approval?.kind === "mcp_elicitation") {
    return buildElicitationApprovalPromptText(approval);
  }
  const reasonText = normalizeText(approval?.reason);
  const commandText = normalizeText(approval?.command);
  const toolName = extractToolNameFromReason(reasonText) || "";
  const commandLines = commandText ? commandText.split("\n") : [];
  const firstCommandLine = normalizeText(commandLines[0]);
  const restCommandLines = commandLines.slice(1);
  const shouldShowReason = reasonText && normalizeText(reasonText) !== normalizeText(`Tool: ${firstCommandLine}`);

  const out = [];
  out.push(`🔐 【Approval】${toolName || "Tool request"}`);

  if (shouldShowReason) {
    out.push(`📋 ${reasonText}`);
  }

  if (commandText) {
    if (firstCommandLine) {
      out.push(`⌨️ ${firstCommandLine}`);
    }
    if (restCommandLines.length) {
      out.push(restCommandLines.map((line) => `  ${line}`).join("\n"));
    }
  }

  if (!reasonText && !commandText) {
    out.push("❓ (unknown)");
  }

  out.push("━━━━━━━━━━━━━");
  out.push("💬 Reply with:");
  out.push("👉 /yes    allow once");
  out.push("👉 /always auto-allow");
  out.push("👉 /no     deny");

  return out.join("\n");
}

function extractToolNameFromReason(reason) {
  const normalized = normalizeText(reason);
  if (!normalized) return "";
  if (normalized.toLowerCase().startsWith("tool:")) {
    return normalized.slice(5).trim();
  }
  return normalized;
}

function buildApprovalPromptSignature(approval) {
  const reasonText = normalizeText(approval?.reason);
  const commandText = normalizeText(approval?.command);
  const commandTokens = Array.isArray(approval?.commandTokens)
    ? approval.commandTokens.map((token) => normalizeCommandArgument(token)).filter(Boolean)
    : [];
  return JSON.stringify({
    kind: normalizeText(approval?.kind),
    reason: reasonText,
    command: commandText,
    commandTokens,
    responseTemplate: approval?.responseTemplate || null,
  });
}

function buildApprovalResponsePayload(approval, commandName) {
  const requestId = approval?.requestId;
  if (requestId == null || String(requestId).trim() === "") {
    return null;
  }
  if (approval?.kind === "mcp_tool_call" || approval?.kind === "mcp_elicitation") {
    const responseByCommand = approval?.responseTemplate?.responseByCommand;
    const effectiveCommandName = commandName === "always" ? "yes" : commandName;
    const result = responseByCommand && typeof responseByCommand === "object"
      ? (responseByCommand[commandName] || responseByCommand[effectiveCommandName])
      : null;
    if (!result || typeof result !== "object") {
      return null;
    }
    return { requestId, result };
  }
  const decision = commandName === "no" ? "decline" : "accept";
  return { requestId, decision };
}

function buildApprovalResponseText(approval, commandName, approvalResponse) {
  if (approval?.kind === "mcp_tool_call" || approval?.kind === "mcp_elicitation") {
    if (commandName === "always" && isApprovalAcceptResponse(approvalResponse)) {
      return "💡 Auto-approve enabled for this MCP tool in the current workspace.";
    }
    if (commandName === "yes") {
      return "✅ This request has been approved.";
    }
    return "❌ This request has been cancelled.";
  }
  return commandName === "always"
    ? "💡 Auto-approve enabled for this command prefix in the current workspace."
    : (commandName === "yes" ? "✅ This request has been approved." : "❌ This request has been denied.");
}

function isApprovalAcceptResponse(approvalResponse) {
  if (!approvalResponse || typeof approvalResponse !== "object") {
    return false;
  }
  if (approvalResponse.decision === "accept") {
    return true;
  }
  return normalizeText(approvalResponse.result?.action) === "accept";
}

function buildElicitationApprovalPromptText(approval) {
  const elicitation = approval?.elicitation || {};
  const messageText = normalizeText(elicitation?.message);
  const commandText = normalizeText(approval?.command);
  const approvalKind = normalizeText(elicitation?.approvalKind);
  const out = [];
  out.push(`🔐 【Approval】${normalizeText(approval?.reason) || "MCP request"}`);
  if (messageText) {
    out.push(`📋 ${messageText.split("\n")[0]}`);
  }
  if (commandText) {
    const commandLines = commandText.split("\n").map((line) => normalizeText(line)).filter(Boolean);
    if (commandLines.length) {
      out.push(`⌨️ ${commandLines[0]}`);
      if (commandLines.length > 1) {
        out.push(commandLines.slice(1).map((line) => `  ${line}`).join("\n"));
      }
    }
  }

  const toolDescription = normalizeText(elicitation?.toolDescription);
  if (toolDescription && approvalKind === "mcp_tool_call") {
    out.push("━━━━━━━━━━━━━");
    out.push(`🧾 ${toolDescription}`);
  }

  const supportedCommands = new Set(
    Array.isArray(approval?.responseTemplate?.supportedCommands)
      ? approval.responseTemplate.supportedCommands
      : []
  );
  out.push("━━━━━━━━━━━━━");
  out.push("💬 Reply with:");
  if (supportedCommands.has("yes")) {
    out.push("👉 /yes    allow once");
  }
  if (supportedCommands.has("always") || (supportedCommands.has("yes") && approval?.kind === "mcp_tool_call")) {
    out.push("👉 /always auto-allow");
  }
  if (supportedCommands.has("no")) {
    out.push("👉 /no     cancel this request");
  }
  if (!supportedCommands.size) {
    out.push("⚠️ This Codex MCP request cannot be answered from WeChat yet.");
  }

  return out.join("\n");
}

function buildReminderSystemTrigger(reminder, config = {}) {
  const reminderText = String(reminder?.text || "").trim();
  const userName = String(config?.userName || "").trim() || "the user";
  return `Due reminder for ${userName}: ${reminderText}`;
}

function shouldAcknowledgeInbound(prepared) {
  // Our OWN message never earns a 处理中. An outgoing row is the account's own bubble
  // (the ledger did not attribute it, so it is the operator - or another signed-in
  // device - typing as this account); the pipeline records it as `self_manual` and
  // suppresses the reply, so the acknowledgement would be pure noise in that chat.
  // Measured 2026-10-02: a self-check message sent through the outbound path put a
  // 处理中 into the operator's own chat while the reply itself was correctly suppressed.
  if (prepared?.direction === "outgoing" || prepared?.origin === "self_manual") {
    return false;
  }
  // The immediate "处理中" acknowledgement exists so the user knows the message
  // arrived while the model works. It used to be gated on the WeFlow UIA bridge -
  // the provider a desktop-driven reply travelled under - so when the channel moved
  // to Cua (provider "wechat-cua") the acknowledgement silently stopped being sent
  // at all: this condition was never updated. Both desktop providers behave the same
  // way (they can send into the conversation the message came from), so both count.
  const desktopProvider = isDesktopProvider(prepared?.provider);
  return prepared?.suppressAcknowledgement !== true
    && (desktopProvider || prepared?.deliveryPolicy === SILENT_DELIVERY_POLICY);
}

function resolvePendingInboundId(message) {
  return normalizeText(message?.pendingId) || normalizeText(message?.messageId);
}

function buildSharedContentBatchMessageId(prompt, messages) {
  const promptId = normalizeText(prompt?.messageId) || "shared-prompt";
  const material = (Array.isArray(messages) ? messages : []).map((message) => ({
    id: resolvePendingInboundId(message),
    receivedAt: normalizeText(message?.receivedAt),
    text: normalizeText(message?.originalText || message?.text),
    url: normalizeText(message?.contentUrl),
    attachments: (Array.isArray(message?.attachments) ? message.attachments : []).map((attachment) => (
      normalizeText(
        attachment?.attachmentRef
        || attachment?.absolutePath
        || attachment?.path
        || attachment?.sourceFileName
      )
    )),
  }));
  const digest = crypto.createHash("sha256")
    .update(JSON.stringify([promptId, material]), "utf8")
    .digest("hex")
    .slice(0, 16);
  return `${promptId}:shared:${digest}`;
}

function takeBoundedPendingInboundMessages(messages, {
  maxMessages = MAX_PENDING_INBOUND_BATCH_MESSAGES,
  maxTextChars = MAX_PENDING_INBOUND_BATCH_TEXT_CHARS,
  maxAttachments = MAX_PENDING_INBOUND_BATCH_ATTACHMENTS,
  splitOversizedFirstAttachments = true,
} = {}) {
  const queued = Array.isArray(messages)
    ? messages.filter((message) => message && typeof message === "object")
    : [];
  const messageLimit = Math.max(1, Math.floor(Number(maxMessages) || 1));
  const textLimit = Math.max(1, Math.floor(Number(maxTextChars) || 1));
  const attachmentLimit = Math.max(1, Math.floor(Number(maxAttachments) || 1));
  const batchMessages = [];
  let textChars = 0;
  let attachmentCount = 0;

  for (let index = 0; index < queued.length; index += 1) {
    const message = queued[index];
    const nextTextChars = resolvePendingInboundTextFootprint(message);
    const nextAttachmentCount = Array.isArray(message.attachments) ? message.attachments.length : 0;
    if (!batchMessages.length && nextAttachmentCount > attachmentLimit) {
      if (!splitOversizedFirstAttachments) {
        return {
          batchMessages: [message],
          remainingMessages: queued.slice(index + 1),
        };
      }
      const split = takeImageOnlyBatchMessages([message], attachmentLimit);
      const attachmentRemainder = split.remainingMessages[0]
        ? stripDeliveredFieldsFromAttachmentRemainder(split.remainingMessages[0])
        : null;
      return {
        batchMessages: split.batchMessages,
        remainingMessages: [
          ...(attachmentRemainder ? [attachmentRemainder] : []),
          ...queued.slice(index + 1),
        ],
      };
    }
    const wouldExceedLimit = batchMessages.length > 0 && (
      batchMessages.length >= messageLimit
      || textChars + nextTextChars > textLimit
      || attachmentCount + nextAttachmentCount > attachmentLimit
    );
    if (wouldExceedLimit) {
      break;
    }
    // Always admit the first durable message. A single oversized source item
    // must make forward progress instead of poisoning every later flush.
    batchMessages.push(message);
    textChars += nextTextChars;
    attachmentCount += nextAttachmentCount;
  }

  return {
    batchMessages,
    remainingMessages: queued.slice(batchMessages.length),
  };
}

function resolvePendingInboundTextFootprint(message) {
  const originalText = typeof message?.originalText === "string" ? message.originalText : "";
  const primaryText = originalText || (typeof message?.text === "string" ? message.text : "");
  const values = [primaryText, message?.contentTitle, message?.contentText, message?.contentUrl];
  for (const context of Array.isArray(message?.quotedContexts) ? message.quotedContexts : []) {
    values.push(context?.title, context?.text, context?.url);
  }
  for (const failure of Array.isArray(message?.attachmentFailures) ? message.attachmentFailures : []) {
    values.push(failure?.sourceFileName, failure?.reason);
  }
  return values.reduce((total, value) => (
    total + (typeof value === "string" ? value.length : 0)
  ), 0);
}

function stripDeliveredFieldsFromAttachmentRemainder(message) {
  return {
    ...message,
    originalText: "",
    text: "",
    attachmentFailures: [],
    contentTitle: "",
    contentText: "",
    contentUrl: "",
  };
}

function buildScopeKey(bindingKey, workspaceRoot) {
  const normalizedBindingKey = normalizeText(bindingKey);
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  if (!normalizedBindingKey || !normalizedWorkspaceRoot) {
    return "";
  }
  return `${normalizedBindingKey}::${normalizedWorkspaceRoot}`;
}

function isReminderCreationRequestText(value) {
  const text = normalizeText(value);
  if (!text || /^(?:为什么|为何|怎么|如何|是否|能否|可不可以|(?:请)?(?:查|检查|解释|列出|显示|取消|删除|修改))/u.test(text)) {
    return false;
  }
  const hasReminderAction = /(?:提醒(?:我|一下|下|[：:])|(?:设置|新建|创建|新增|安排|定(?:个)?)\S{0,8}提醒|记得(?:叫|喊|提醒)?我|到时(?:叫|喊|提醒)我|届时(?:叫|喊|提醒)我|别忘了(?:叫|喊|提醒)我|叫我|喊我)/u.test(text);
  if (!hasReminderAction) {
    return false;
  }
  return /(?:今天|明天|后天|大后天|今晚|今早|明早|明晚|早上|上午|中午|下午|傍晚|晚上|夜里|凌晨|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|这周|本周|下周|下下周|这个月|本月|下个月|每天|每日|每周|每月|\d{1,2}号|\d{1,2}[：:]\d{2}|\d{1,2}\s*点(?:\d{1,2}\s*分)?|\d+\s*(?:秒|分钟|分|小时|天|周|个月|月)后|\d{4}[年/-]\d{1,2}[月/-]\d{1,2}日?)/u.test(text);
}

function buildSharedContentScopeKey(bindingKey, workspaceRoot, chatId = "") {
  const baseScopeKey = buildScopeKey(bindingKey, workspaceRoot);
  const normalizedChatId = normalizeText(chatId);
  if (!baseScopeKey || !normalizedChatId) {
    return "";
  }
  return `${baseScopeKey}::${normalizedChatId}`;
}

function resolvePreparedMessageTimeMs(prepared) {
  const parsed = Date.parse(String(prepared?.receivedAt || ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeSharedContentKind(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === "audio") {
    return "voice";
  }
  return ["image", "voice", "video", "file", "link"].includes(normalized)
    ? normalized
    : "";
}

function isSharedInboxContentMessage(message, { assumeLinkCard = false } = {}) {
  const kind = normalizeSharedContentKind(message?.kind);
  if (!kind) {
    return false;
  }
  if (kind !== "link") {
    return true;
  }
  return Boolean(assumeLinkCard || message?.isLinkCard || isUrlOnlyText(message?.text));
}

function isExplicitInboxPromptMessage(message, { assumeLinkCard = false } = {}) {
  const text = normalizeText(message?.text);
  if (!text) {
    return false;
  }
  const kind = normalizeSharedContentKind(message?.kind);
  if (!kind) {
    return true;
  }
  if (kind === "voice" && message?.voiceTranscript) {
    return false;
  }
  if (kind === "link") {
    return !(assumeLinkCard || message?.isLinkCard || isUrlOnlyText(text));
  }
  const title = normalizeText(message?.title);
  return normalizeComparableInboxText(text) !== normalizeComparableInboxText(title);
}

function normalizeComparableInboxText(value) {
  return normalizeText(value).replace(/\s+/gu, " ").trim().toLowerCase();
}

function isUrlOnlyText(value) {
  const normalized = normalizeText(value);
  if (!normalized || !/https?:\/\//iu.test(normalized)) {
    return false;
  }
  const withoutUrls = normalized
    .replace(/https?:\/\/[^\s<>"']+/giu, " ")
    .replace(/[\s,，。.!！?？;；:：()（）\[\]【】<>《》]+/gu, "");
  return withoutUrls.length === 0;
}

function normalizeHttpUrl(value) {
  const normalized = normalizeText(value);
  return /^https?:\/\//iu.test(normalized) ? normalized : "";
}

function isAutoApprovedStateDirOperation(approval, config = {}) {
  const stateDir = normalizeText(config?.stateDir);
  if (!stateDir) {
    return false;
  }

  const filePaths = extractApprovalFilePaths(approval);
  if (!filePaths.length) {
    return false;
  }

  return filePaths.every((filePath) => isPathWithinRoot(filePath, stateDir));
}

function sortInboundUpdateMessages(messages) {
  return Array.isArray(messages)
    ? messages.slice().sort(compareRawInboundUpdateMessages)
    : [];
}

function compareRawInboundUpdateMessages(left, right) {
  const leftTime = resolveRawInboundMessageTimeMs(left);
  const rightTime = resolveRawInboundMessageTimeMs(right);
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  const leftMessageId = parseMessageIdForOrdering(left?.message_id);
  const rightMessageId = parseMessageIdForOrdering(right?.message_id);
  if (leftMessageId !== rightMessageId) {
    return leftMessageId - rightMessageId;
  }

  const leftSeq = parseNumericOrderValue(left?.seq);
  const rightSeq = parseNumericOrderValue(right?.seq);
  if (leftSeq !== rightSeq) {
    return leftSeq - rightSeq;
  }

  return String(left?.client_id || "").localeCompare(String(right?.client_id || ""));
}

function resolveRawInboundMessageTimeMs(message) {
  const createdAtMs = parseNumericOrderValue(message?.create_time_ms);
  if (createdAtMs > 0) {
    return createdAtMs;
  }
  const createdAtSeconds = parseNumericOrderValue(message?.create_time);
  return createdAtSeconds > 0 ? createdAtSeconds * 1000 : 0;
}

function comparePendingInboundMessages(left, right) {
  const leftTime = Date.parse(String(left?.receivedAt || "")) || 0;
  const rightTime = Date.parse(String(right?.receivedAt || "")) || 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  const leftMessageId = parseMessageIdForOrdering(left?.messageId);
  const rightMessageId = parseMessageIdForOrdering(right?.messageId);
  if (leftMessageId !== rightMessageId) {
    return leftMessageId - rightMessageId;
  }

  return String(left?.text || "").localeCompare(String(right?.text || ""));
}

function parseMessageIdForOrdering(value) {
  const numeric = parseNumericOrderValue(value);
  return numeric > 0 ? numeric : Number.MAX_SAFE_INTEGER;
}

function parseNumericOrderValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const DEFERRED_REPLY_NOTICE = "上轮有一条回复当时没能发出去，现在补上。";
const DEFERRED_PLAIN_REPLY_HEADER = "===== 上轮对话遗留内容 =====";
const DEFERRED_SYSTEM_REPLY_HEADER = "===== 期间模型主动联系 =====";

function formatDeferredSystemReplyBatch(replies) {
  const grouped = groupDeferredReplies(replies);
  if (!grouped.plain.length && !grouped.system.length) {
    return DEFERRED_REPLY_NOTICE;
  }
  const parts = [
    DEFERRED_REPLY_NOTICE,
  ];
  if (grouped.plain.length) {
    parts.push("", DEFERRED_PLAIN_REPLY_HEADER, grouped.plain.join("\n\n"));
  }
  if (grouped.system.length) {
    parts.push("", DEFERRED_SYSTEM_REPLY_HEADER, grouped.system.join("\n\n"));
  }
  return parts.join("\n");
}

function groupDeferredReplies(replies) {
  const grouped = { plain: [], system: [] };
  for (const reply of Array.isArray(replies) ? replies : []) {
    const normalizedText = String(reply?.text || "").trim();
    if (!normalizedText) {
      continue;
    }
    if (reply?.kind === "system_reply") {
      grouped.system.push(normalizedText);
      continue;
    }
    grouped.plain.push(normalizedText);
  }
  return grouped;
}

/** The channels the bot drives itself on the personal account (no reply window). */
function isDesktopProvider(provider) {
  // `wechat-db` is the database reader for the SAME desktop client: the message
  // came in through the account's own database and the reply goes out through
  // Cua. Treating it as a desktop provider is what keeps the "处理中"
  // acknowledgement firing - the last time a channel's provider was not added
  // here, the acknowledgement silently stopped being sent at all (see the comment
  // in shouldAcknowledgeInbound).
  return provider === "weflow-uia" || provider === "wechat-cua" || provider === "wechat-db";
}

/**
 * Format one drained deferred batch for the channel it is going back to.
 *
 * The notice and the `===== 上轮对话遗留内容 =====` header are an artifact of the
 * OFFICIAL channel: there a reply only exists inside a reply window, so a leftover has
 * to be glued in front of the next answer, and the reader has to be told which part is
 * old. The desktop channel has no window - the leftover can simply be sent as itself -
 * so the wrapper must not be used there. It was, and the user saw it verbatim in their
 * own chat ("小号消息渠道不应该出现「上轮有一条回复当时没能发出去，现在补上」",
 * operator report 2026-10-02). Same migration family as the provider gates: this
 * formatter is passed to the scheduler as a plain callback, so nothing about it
 * announced which channel it was formatting for.
 */
function formatDeferredRepliesForRetry(entries) {
  const replies = Array.isArray(entries) ? entries : [];
  if (replies.some((entry) => isDesktopProvider(entry?.provider))) {
    return replies
      .map((entry) => String(entry?.text || "").trim())
      .filter(Boolean)
      .join("\n\n");
  }
  return formatDeferredSystemReplyBatch(replies);
}

function formatWechatLocalTime(receivedAt) {
  const value = typeof receivedAt === "string" ? receivedAt.trim() : "";
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed).replace(/\//g, "-");
}

function stringifyRpcId(value) {
  if (value == null) {
    return "";
  }
  return String(value).trim();
}

function hasRpcId(value) {
  return stringifyRpcId(value) !== "";
}
