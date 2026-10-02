const os = require("os");
const path = require("path");

function readConfig() {
  const argv = process.argv.slice(2);
  const mode = argv[0] || "";
  const stateDir = process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss");
  const weflowInboxChat = readTextEnv("CYBERBOSS_WEFLOW_INBOX_CHAT");
  // Inbound scope: one or more chats. Falls back to the legacy single var.
  const weflowInboxChats = (readTextEnv("CYBERBOSS_WEFLOW_INBOX_CHATS") || weflowInboxChat)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const weflowCanaryChat = readTextEnv("CYBERBOSS_WEFLOW_CANARY_CHAT");
  const weflowCanaryDisplayName = readTextEnv("CYBERBOSS_WEFLOW_CANARY_DISPLAY_NAME");
  // Display name per chat window, used to name that window's DSH session:
  // `talker=名字` pairs, comma separated. Only the operator knows which accounts
  // are 大号 and which are 小号, so the labels are configuration, not inference.
  const weflowWindowLabels = parseWindowLabels(readTextEnv("CYBERBOSS_WEFLOW_WINDOW_LABELS"));
  assertWeFlowCanaryTalkerIsolation({ weflowInboxChat, weflowCanaryChat });

  return {
    mode,
    argv,
    stateDir,
    workspaceId: readTextEnv("CYBERBOSS_WORKSPACE_ID") || "default",
    workspaceRoot: readTextEnv("CYBERBOSS_WORKSPACE_ROOT") || process.cwd(),
    userName: readTextEnv("CYBERBOSS_USER_NAME") || "User",
    userGender: readTextEnv("CYBERBOSS_USER_GENDER") || "female",
    allowedUserIds: readListEnv("CYBERBOSS_ALLOWED_USER_IDS"),
    channel: readTextEnv("CYBERBOSS_CHANNEL") || "weixin",
    // Optional *declaration* of which message channels this machine is meant to
    // run (`ilink`, `weflow-uia`). Empty means "do not filter": every channel
    // stays eligible and availability is derived from the existing keys, so
    // setting this can never change what the bot does — only what `doctor`
    // reports on. See the dual-channel contract note.
    enabledChannels: readListEnv("CYBERBOSS_ENABLED_CHANNELS").map((item) => item.toLowerCase()),
    runtime: readTextEnv("CYBERBOSS_RUNTIME") || "codex",
    timelineCommand: readTextEnv("CYBERBOSS_TIMELINE_COMMAND") || "timeline-for-agent",
    accountId: readTextEnv("CYBERBOSS_ACCOUNT_ID"),
    weixinBaseUrl: readTextEnv("CYBERBOSS_WEIXIN_BASE_URL") || "https://ilinkai.weixin.qq.com",
    weixinCdnBaseUrl: readTextEnv("CYBERBOSS_WEIXIN_CDN_BASE_URL") || "https://novac2c.cdn.weixin.qq.com/c2c",
    weixinConfigFile: path.join(stateDir, "weixin-config.json"),
    weixinMinChunkChars: readIntEnv("CYBERBOSS_WEIXIN_MIN_CHUNK_CHARS"),
    weixinQrBotType: readTextEnv("CYBERBOSS_WEIXIN_QR_BOT_TYPE") || "3",
    accountsDir: path.join(stateDir, "accounts"),
    reminderQueueFile: path.join(stateDir, "reminder-queue.json"),
    systemMessageQueueFile: path.join(stateDir, "system-message-queue.json"),
    pendingInboundQueueFile: path.join(stateDir, "pending-inbound.json"),
    pendingInboundQuietWindowMs: readNonNegativeIntEnv("CYBERBOSS_PENDING_INBOUND_QUIET_WINDOW_MS") ?? 15_000,
    pipelineActivityFile: path.join(stateDir, "cyberboss-pipeline-activity.json"),
    deferredSystemReplyQueueFile: path.join(stateDir, "deferred-system-replies.json"),
    checkinConfigFile: path.join(stateDir, "checkin-config.json"),
    timelineScreenshotQueueFile: path.join(stateDir, "timeline-screenshot-queue.json"),
    projectToolContextFile: path.join(stateDir, "project-tool-runtime-context.json"),
    weixinInstructionsFile: path.join(stateDir, "weixin-instructions.md"),
    weixinOperationsFile: path.resolve(__dirname, "..", "..", "templates", "weixin-operations.md"),
    wechatCliRoot: readTextEnv("CYBERBOSS_WECHAT_CLI_ROOT"),
    wechatCliPythonCommand: readTextEnv("CYBERBOSS_WECHAT_CLI_PYTHON") || "python",
    wechatCliConfigFile: readTextEnv("CYBERBOSS_WECHAT_CLI_CONFIG_FILE"),
    wechatCliInboxChat: readTextEnv("CYBERBOSS_WECHAT_CLI_INBOX_CHAT"),
    wechatCliInboxPollIntervalMs: readIntEnv("CYBERBOSS_WECHAT_CLI_POLL_INTERVAL_MS") || 5_000,
    wechatCliInboxHistoryLimit: readIntEnv("CYBERBOSS_WECHAT_CLI_HISTORY_LIMIT") || 100,
    wechatCliInboxReplayOnStart: readBoolEnv("CYBERBOSS_WECHAT_CLI_REPLAY_ON_START"),
    wechatCliInboxReplayLimit: readIntEnv("CYBERBOSS_WECHAT_CLI_REPLAY_LIMIT") || 20,
    wechatCliInboxReplyUserId: readTextEnv("CYBERBOSS_WECHAT_CLI_REPLY_USER_ID"),
    wechatCliInboxReaderScript: path.resolve(__dirname, "..", "..", "scripts", "wechat-cli-inbox-read.py"),
    wechatCliInboxCursorFile: path.join(stateDir, "wechat-cli-inbox-cursor.json"),
    wechatCliImageKeyFile: path.join(stateDir, "wechat-image-keys.json"),
    wechatCliImageKeyScannerScript: path.resolve(__dirname, "..", "..", "scripts", "wechat-image-key-scan.py"),
    wechatCliImageAesKey: readTextEnv("CYBERBOSS_WECHAT_CLI_IMAGE_AES_KEY"),
    wechatCliImageXorKey: readTextEnv("CYBERBOSS_WECHAT_CLI_IMAGE_XOR_KEY"),
    wechatCliAutoImageKey: readOptionalBoolEnv("CYBERBOSS_WECHAT_CLI_AUTO_IMAGE_KEY") !== false,
    startWithWechatCliInbox: mode === "start"
      && readBoolEnv("CYBERBOSS_ENABLE_WECHAT_CLI_INBOX")
      && Boolean(readTextEnv("CYBERBOSS_WECHAT_CLI_INBOX_CHAT")),
    // RDP-free outbound: drive the WeChat desktop client on THIS session through
    // Cua Driver instead of the UIA bridge that lives in an isolated session.
    // Off by default: it costs one foreground click per conversation switch, so it
    // must be a deliberate operator choice.
    wechatCuaEnabled: readBoolEnv("CYBERBOSS_ENABLE_WECHAT_CUA"),
    wechatCuaChatByTalker: readTextEnv("CYBERBOSS_CUA_CHAT_BY_TALKER"),
    // The inbound half of the same path. Opt-in for the same reason as the
    // outbound one, plus: a "message" here is a changed conversation row, and a
    // deep read costs a foreground click.
    wechatCuaInboxEnabled: mode === "start" && readBoolEnv("CYBERBOSS_ENABLE_WECHAT_CUA_INBOX"),
    wechatCuaInboxDeepRead: readBoolEnv("CYBERBOSS_WECHAT_CUA_INBOX_DEEP_READ"),
    // How often the open conversation is read. This is the FIRST half of the operator's
    // "处理中 is not the first thing that arrives" complaint: at 3000ms a message could
    // sit unread for three seconds before the acknowledgement was even attempted. A
    // poll costs one snapshot (~150ms over the MCP transport), so 1500ms is cheap.
    wechatCuaInboxPollMs: readIntEnv("CYBERBOSS_WECHAT_CUA_POLL_MS") || 1_500,
    wechatCuaAllowPeers: readTextEnv("CYBERBOSS_WECHAT_CUA_ALLOW_PEERS"),
    // Opt-in: never take the foreground, not even for the 150-300ms activation a
    // conversation switch costs. A reply whose conversation is not already open is
    // then deferred instead of being delivered now.
    wechatCuaNoForegroundSwitch: readBoolEnv("CYBERBOSS_WECHAT_CUA_NO_FOREGROUND_SWITCH"),
    weflowBaseUrl: readTextEnv("CYBERBOSS_WEFLOW_BASE_URL") || "http://127.0.0.1:5031",
    weflowBridgeBaseUrl: readTextEnv("CYBERBOSS_WEFLOW_BRIDGE_BASE_URL") || "http://127.0.0.1:8766",
    weflowBridgeTimeoutMs: readIntEnv("CYBERBOSS_WEFLOW_BRIDGE_TIMEOUT_MS") || 30_000,
    weflowToken: readTextEnv("CYBERBOSS_WEFLOW_TOKEN"),
    weflowInboxChat,
    weflowInboxChats,
    weflowWindowLabels,
    weflowInboxDisplayName: readTextEnv("CYBERBOSS_WEFLOW_INBOX_DISPLAY_NAME") || "yourself",
    weflowInboxReplyUserId: readTextEnv("CYBERBOSS_WEFLOW_REPLY_USER_ID"),
    weflowInboxCursorFile: path.join(stateDir, "weflow-inbox-cursor.json"),
    weflowCanaryChat,
    weflowCanaryDisplayName,
    // Model E2E probes are intentionally opt-in and are never scheduled by the
    // ordinary transport heartbeat. An explicit caller must enable this gate
    // before creating and sending a model probe manifest.
    weflowModelCanaryEnabled: readBoolEnv("CYBERBOSS_ENABLE_WEFLOW_MODEL_CANARY"),
    weflowCanaryInboxCursorFile: path.join(stateDir, "weflow-canary-inbox-cursor.json"),
    weflowCanaryMessageLimit: readIntEnv("CYBERBOSS_WEFLOW_CANARY_MESSAGE_LIMIT") || 200,
    weflowMessageLedgerFile: path.join(stateDir, "weflow-message-ledger.json"),
    // The UIA bridge reads outbound images as a different Windows account, so the
    // directory has to be shared and both sides must agree on it. Deployments set
    // this together with the bridge's CYBERBOSS_WEFLOW_UIA_IMAGE_ROOT.
    generatedImageOutboundDir: readTextEnv("CYBERBOSS_GENERATED_IMAGE_OUTBOUND_DIR")
      || path.join(stateDir, "generated-images-outbound"),
    weflowReconnectDelayMs: readIntEnv("CYBERBOSS_WEFLOW_RECONNECT_DELAY_MS") || 1_000,
    weflowOutgoingPollIntervalMs: readIntEnv("CYBERBOSS_WEFLOW_OUTGOING_POLL_INTERVAL_MS") || 2_000,
    weflowOutgoingReplayWindowMs: readIntEnv("CYBERBOSS_WEFLOW_OUTGOING_REPLAY_WINDOW_MS") || 10 * 60_000,
    weflowOutgoingPollMaxRequests: readIntEnv("CYBERBOSS_WEFLOW_OUTGOING_POLL_MAX_REQUESTS") || 64,
    weflowMessageLimit: readIntEnv("CYBERBOSS_WEFLOW_MESSAGE_LIMIT") || 50,
    weflowMediaRoot: readTextEnv("CYBERBOSS_WEFLOW_MEDIA_ROOT")
      || path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "weflow", "cache", "api-media"),
    startWithWeflowInbox: mode === "start"
      && readBoolEnv("CYBERBOSS_ENABLE_WEFLOW_INBOX")
      && Boolean(readTextEnv("CYBERBOSS_WEFLOW_TOKEN"))
      && Boolean(weflowInboxChat),
    startWithWeflowCanaryInbox: mode === "start"
      && readBoolEnv("CYBERBOSS_ENABLE_WEFLOW_INBOX")
      && Boolean(readTextEnv("CYBERBOSS_WEFLOW_TOKEN"))
      && Boolean(weflowCanaryChat)
      && Boolean(weflowCanaryDisplayName),
    // Guarded restarts are announced by the watchdog's durable, ledger-backed
    // notification queue. Keep the older best-effort startup send opt-in so it
    // cannot race that queue or create an unverified duplicate.
    startWithRestartNotification: mode === "start"
      && readBoolEnv("CYBERBOSS_ENABLE_RESTART_NOTIFICATION"),
    restartNotificationText: readTextEnv("CYBERBOSS_RESTART_NOTIFICATION_TEXT")
      || "✅ Cyberboss 已重启，服务已恢复。",
    restartNotificationUserId: readTextEnv("CYBERBOSS_RESTART_NOTIFICATION_USER_ID"),
    systemActionInstructionsFile: readTextEnv("CYBERBOSS_SYSTEM_ACTION_INSTRUCTIONS_FILE")
      || path.resolve(__dirname, "..", "..", "templates", "system-action-instructions.md"),
    stickersDir: path.join(stateDir, "stickers"),
    stickerAssetsDir: path.join(stateDir, "stickers", "assets"),
    stickersIndexFile: path.join(stateDir, "stickers", "index.json"),
    stickerTagsFile: path.join(stateDir, "stickers", "tags.json"),
    stickersTemplateDir: path.resolve(__dirname, "..", "..", "templates", "stickers"),
    stickersTemplateIndexFile: path.resolve(__dirname, "..", "..", "templates", "stickers", "index.json"),
    stickerTagsTemplateFile: path.resolve(__dirname, "..", "..", "templates", "stickers", "tags.json"),
    stickerNormalizeGifScript: path.resolve(__dirname, "..", "..", "scripts", "normalize-sticker-gif.js"),
    diaryDir: path.join(stateDir, "diary"),
    memoryFile: path.join(stateDir, "memory.json"),
    memoryRecallLimit: readIntEnv("CYBERBOSS_MEMORY_RECALL_LIMIT") || 6,
    memoryMaxEntries: readIntEnv("CYBERBOSS_MEMORY_MAX_ENTRIES") || 2_000,
    locationStoreFile: path.join(stateDir, "locations.json"),
    locationHost: readTextEnv("CYBERBOSS_LOCATION_HOST") || "0.0.0.0",
    locationPort: readIntEnv("CYBERBOSS_LOCATION_PORT") || 4318,
    locationToken: readTextEnv("CYBERBOSS_LOCATION_TOKEN"),
    locationHistoryLimit: readIntEnv("CYBERBOSS_LOCATION_HISTORY_LIMIT") || 1000,
    locationMovementEventLimit: readIntEnv("CYBERBOSS_LOCATION_MOVEMENT_EVENT_LIMIT"),
    locationBatteryHistoryLimit: readIntEnv("CYBERBOSS_LOCATION_BATTERY_HISTORY_LIMIT"),
    locationKnownPlaces: readKnownPlacesEnv(),
    locationKnownPlaceRadiusMeters: readIntEnv("CYBERBOSS_LOCATION_PLACE_RADIUS_METERS") || 150,
    locationStayMergeRadiusMeters: readIntEnv("CYBERBOSS_LOCATION_STAY_MERGE_RADIUS_METERS") || 100,
    locationStayBreakConfirmRadiusMeters: readIntEnv("CYBERBOSS_LOCATION_STAY_BREAK_RADIUS_METERS") || 200,
    locationStayBreakConfirmSamples: readIntEnv("CYBERBOSS_LOCATION_STAY_BREAK_SAMPLES") || 2,
    locationMajorMoveThresholdMeters: readIntEnv("CYBERBOSS_LOCATION_MAJOR_MOVE_THRESHOLD_METERS") || 1000,
    startWithLocationServer: resolveLocationServerEnabled({
      mode,
      enabled: readOptionalBoolEnv("CYBERBOSS_ENABLE_LOCATION_SERVER"),
    }),
    syncBufferDir: path.join(stateDir, "sync-buffers"),
    codexEndpoint: readTextEnv("CYBERBOSS_CODEX_ENDPOINT"),
    codexCommand: readTextEnv("CYBERBOSS_CODEX_COMMAND"),
    codexModel: readTextEnv("CYBERBOSS_CODEX_MODEL"),
    codexModelProvider: readTextEnv("CYBERBOSS_CODEX_MODEL_PROVIDER"),
    codexNativeImageInput: readOptionalBoolEnv("CYBERBOSS_CODEX_NATIVE_IMAGE_INPUT"),
    codexAccessMode: readTextEnv("CYBERBOSS_CODEX_ACCESS_MODE") || "trusted",
    visionMode: readTextEnv("CYBERBOSS_VISION_MODE") || "auto",
    visionProvider: readTextEnv("CYBERBOSS_VISION_PROVIDER") || "openai-compatible",
    visionApiBaseUrl: readTextEnv("CYBERBOSS_VISION_API_BASE_URL"),
    visionApiKey: readTextEnv("CYBERBOSS_VISION_API_KEY"),
    visionModel: readTextEnv("CYBERBOSS_VISION_MODEL"),
    visionTimeoutMs: readIntEnv("CYBERBOSS_VISION_TIMEOUT_MS") || 30_000,
    voiceTranscriptionMode: readTextEnv("CYBERBOSS_VOICE_TRANSCRIPTION_MODE") || "auto",
    voiceTranscriptionPythonCommand: readTextEnv("CYBERBOSS_VOICE_TRANSCRIPTION_PYTHON") || "python",
    voiceTranscriptionWorkerScript: readTextEnv("CYBERBOSS_VOICE_TRANSCRIPTION_WORKER_SCRIPT")
      || path.resolve(__dirname, "..", "..", "scripts", "sense-voice-worker.py"),
    voiceTranscriptionModel: readTextEnv("CYBERBOSS_VOICE_TRANSCRIPTION_MODEL")
      || path.join(stateDir, "models", "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"),
    voiceTranscriptionDevice: readTextEnv("CYBERBOSS_VOICE_TRANSCRIPTION_DEVICE") || "cpu",
    voiceTranscriptionComputeType: readTextEnv("CYBERBOSS_VOICE_TRANSCRIPTION_COMPUTE_TYPE") || "int8",
    voiceTranscriptionLanguage: readTextEnv("CYBERBOSS_VOICE_TRANSCRIPTION_LANGUAGE") || "zh",
    voiceTranscriptionHotwords: readTextEnv("CYBERBOSS_VOICE_TRANSCRIPTION_HOTWORDS")
      || "大号 小号 微信 ClawBot Cyberboss WeFlow 引用 转发 回复 总结 图片 语音 文件 链接",
    voiceTranscriptionBeamSize: readIntEnv("CYBERBOSS_VOICE_TRANSCRIPTION_BEAM_SIZE") || 1,
    voiceTranscriptionCpuThreads: readIntEnv("CYBERBOSS_VOICE_TRANSCRIPTION_CPU_THREADS"),
    voiceTranscriptionStartupTimeoutMs: readIntEnv("CYBERBOSS_VOICE_TRANSCRIPTION_STARTUP_TIMEOUT_MS") || 120_000,
    voiceTranscriptionTimeoutMs: readIntEnv("CYBERBOSS_VOICE_TRANSCRIPTION_TIMEOUT_MS") || 120_000,
    voiceTranscriptionLocalFilesOnly: readOptionalBoolEnv("CYBERBOSS_VOICE_TRANSCRIPTION_LOCAL_FILES_ONLY") !== false,
    voiceTranscriptCacheDir: path.join(stateDir, "voice-transcripts"),
    claudeCommand: readTextEnv("CYBERBOSS_CLAUDE_COMMAND") || "claude",
    claudeModel: readTextEnv("CYBERBOSS_CLAUDE_MODEL") || "",
    claudeContextWindow: readIntEnv("CYBERBOSS_CLAUDE_CONTEXT_WINDOW"),
    claudeMaxOutputTokens: readIntEnv("CLAUDE_CODE_MAX_OUTPUT_TOKENS"),
    claudePermissionMode: readTextEnv("CYBERBOSS_CLAUDE_PERMISSION_MODE") || "default",
    claudeDisableVerbose: readBoolEnv("CYBERBOSS_CLAUDE_DISABLE_VERBOSE"),
    claudeExtraArgs: readListEnv("CYBERBOSS_CLAUDE_EXTRA_ARGS"),
    // DSH runtime (`CYBERBOSS_RUNTIME=dsh`). Sessions use their own store file so
    // switching runtimes never mixes Codex thread ids with DSH session ids.
    dshBin: readTextEnv("CYBERBOSS_DSH_BIN"),
    dshProfile: readTextEnv("CYBERBOSS_DSH_PROFILE") || "sdk",
    dshProvider: readTextEnv("CYBERBOSS_DSH_PROVIDER") || "deepseek-official",
    dshModel: readTextEnv("CYBERBOSS_DSH_MODEL") || "deepseek-flash",
    dshReasoningEffort: readTextEnv("CYBERBOSS_DSH_REASONING_EFFORT"),
    dshMaxTokens: readIntEnv("CYBERBOSS_DSH_MAX_TOKENS"),
    dshInitializeTimeoutMs: readIntEnv("CYBERBOSS_DSH_INITIALIZE_TIMEOUT_MS") || 120_000,
    dshRequestTimeoutMs: readIntEnv("CYBERBOSS_DSH_REQUEST_TIMEOUT_MS") || 60_000,
    // Three-state approval policy for the DSH runtime:
    //   session -> a constrained collaborative session decides each escalation
    //   never   -> every escalation is rejected without asking anyone
    //   (unset) -> no answerer is composed, so DSH resolves `unavailable`
    //              (fail closed). This stays the default: enabling a decider is
    //              an explicit opt-in.
    dshApprovalMode: resolveDshApprovalMode(readTextEnv("CYBERBOSS_DSH_APPROVAL")),
    dshApprovalTimeoutMs: readIntEnv("CYBERBOSS_DSH_APPROVAL_TIMEOUT_MS") || 60_000,
    dshSessionsFile: path.join(stateDir, "dsh-sessions.json"),
    sessionsFile: path.join(stateDir, "sessions.json"),
    startWithCheckin: resolveCheckinEnabled({
      mode,
      argv,
      enabled: readOptionalBoolEnv("CYBERBOSS_ENABLE_CHECKIN"),
    }),
  };
}

function readListEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readTextEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function readBoolEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function readOptionalBoolEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  if (!value) {
    return undefined;
  }
  if (value === "1" || value === "true" || value === "yes" || value === "on") {
    return true;
  }
  if (value === "0" || value === "false" || value === "no" || value === "off") {
    return false;
  }
  return undefined;
}

function readIntEnv(name) {
  const value = readTextEnv(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readKnownPlacesEnv() {
  const fromJson = parseKnownPlacesJson(readTextEnv("CYBERBOSS_LOCATION_KNOWN_PLACES"));
  const fromCenters = [
    parseKnownPlaceCenter("home", readTextEnv("CYBERBOSS_LOCATION_HOME_CENTER")),
    parseKnownPlaceCenter("work", readTextEnv("CYBERBOSS_LOCATION_WORK_CENTER")),
  ].filter(Boolean);
  return [...fromJson, ...fromCenters];
}

function parseKnownPlacesJson(value) {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * `talker=名字` pairs, comma separated. Malformed pairs are skipped rather than
 * failing the boot: a missing label only costs a session its display name.
 */
function parseWindowLabels(value) {
  const labels = {};
  for (const part of String(value || "").split(",")) {
    const entry = part.trim();
    if (!entry) {
      continue;
    }
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const talker = entry.slice(0, separator).trim();
    const label = entry.slice(separator + 1).trim();
    if (talker && label) {
      labels[talker] = label;
    }
  }
  return labels;
}

function parseKnownPlaceCenter(tag, value) {
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 2) {
    return null;
  }
  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  return { tag, latitude, longitude };
}

function hasArgFlag(argv, flag) {
  return Array.isArray(argv) && argv.some((item) => String(item || "").trim() === flag);
}

function resolveLocationServerEnabled({ mode, enabled }) {
  if (mode !== "start") {
    return false;
  }
  if (typeof enabled === "boolean") {
    return enabled;
  }
  return false;
}

function readNonNegativeIntEnv(name) {
  const value = readIntEnv(name);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function resolveCheckinEnabled({ mode, argv, enabled }) {
  if (mode !== "start") {
    return false;
  }
  if (enabled === false) {
    return false;
  }
  return enabled === true || hasArgFlag(argv, "--checkin");
}

/**
 * `CYBERBOSS_DSH_APPROVAL` selects how a DSH tool escalation is answered.
 *
 * Returns `""` for anything unrecognised, which means "compose no answerer" and
 * therefore fail closed. An unreadable value must never be quietly promoted to
 * the deciding mode.
 */
function resolveDshApprovalMode(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "session" || normalized === "never") {
    return normalized;
  }
  return "";
}

function assertWeFlowCanaryTalkerIsolation({ weflowInboxChat, weflowCanaryChat } = {}) {
  const primaryTalker = typeof weflowInboxChat === "string" ? weflowInboxChat.trim() : "";
  const canaryTalker = typeof weflowCanaryChat === "string" ? weflowCanaryChat.trim() : "";
  if (!primaryTalker || !canaryTalker || primaryTalker !== canaryTalker) {
    return true;
  }
  const error = new Error(
    "CYBERBOSS_WEFLOW_CANARY_CHAT must differ from CYBERBOSS_WEFLOW_INBOX_CHAT; dedicated canary routing is disabled",
  );
  error.code = "CANARY_TALKER_CONFLICT";
  error.repairable = false;
  throw error;
}

module.exports = {
  assertWeFlowCanaryTalkerIsolation,
  readConfig,
  resolveCheckinEnabled,
  resolveDshApprovalMode,
};
