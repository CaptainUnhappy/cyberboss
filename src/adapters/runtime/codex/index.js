const { CodexRpcClient } = require("./rpc-client");
const { buildOpeningTurnText, buildInstructionRefreshText } = require("../shared-instructions");
const { mapCodexMessageToRuntimeEvent } = require("./events");
const {
  extractAssistantText,
  extractFailureText,
  extractThreadId,
  extractTurnId,
  extractThreadIdFromParams,
  extractTurnIdFromParams,
  isAssistantItemCompleted,
} = require("./message-utils");
const { findModelByQuery } = require("./model-catalog");
const { SessionStore } = require("./session-store");
const { resolveCodexProjectToolMcpServerConfig } = require("./mcp-config");
const { extractGeneratedImageArtifacts } = require("../../../core/generated-image-artifact");
const {
  MODEL_CANARY_EXECUTION_POLICY,
  MODEL_CANARY_PROMPT,
} = require("../../../integrations/weflow-model-canary");

function createCodexRuntimeAdapter(config) {
  const sessionStore = new SessionStore({ filePath: config.sessionsFile, runtimeId: "codex" });
  let client = null;
  let modelCanaryClient = null;
  let readyState = null;
  let modelCanaryReady = false;
  const eventListeners = new Set();
  const clientEventUnsubscribers = new Map();
  const modelCanaryThreadIds = new Set();
  const modelCanaryApprovalRequestIds = new Set();
  const configuredModel = normalizeText(config.codexModel);
  const configuredModelProvider = normalizeText(config.codexModelProvider);

  function resolveModel(model = "", storedParams = null) {
    if (configuredModel) {
      return configuredModel;
    }
    if (storedParams && normalizeText(storedParams.modelProvider) !== configuredModelProvider) {
      return "";
    }
    return normalizeText(model);
  }

  function ensureClient() {
    if (!client) {
      client = new CodexRpcClient({
        endpoint: config.codexEndpoint,
        codexCommand: config.codexCommand,
        env: process.env,
        extraWritableRoots: [config.stateDir],
        mcpServerConfig: resolveCodexProjectToolMcpServerConfig(),
      });
      attachClientEvents(client, false);
    }
    return client;
  }

  function ensureModelCanaryClient() {
    if (!modelCanaryClient) {
      // Model probes always use a separate spawned app-server. They never reuse
      // the ordinary websocket endpoint or its MCP/plugin/tool configuration.
      modelCanaryClient = new CodexRpcClient({
        endpoint: "",
        codexCommand: config.codexCommand,
        env: process.env,
        extraWritableRoots: [],
        mcpServerConfig: null,
        isolatedProfile: true,
      });
      attachClientEvents(modelCanaryClient, true);
    }
    return modelCanaryClient;
  }

  function attachClientEvents(runtimeClient, isolatedModelCanary) {
    if (!runtimeClient || clientEventUnsubscribers.has(runtimeClient)) return;
    const unsubscribe = runtimeClient.onMessage((message) => {
      const event = mapCodexMessageToRuntimeEvent(message);
      if (!event) return;
      if (isolatedModelCanary) {
        const threadId = normalizeText(event?.payload?.threadId);
        if (threadId) modelCanaryThreadIds.add(threadId);
        if (event.type === "runtime.approval.requested" && event?.payload?.requestId != null) {
          modelCanaryApprovalRequestIds.add(String(event.payload.requestId));
        }
      }
      for (const listener of eventListeners) {
        listener(event, message);
      }
    });
    clientEventUnsubscribers.set(runtimeClient, unsubscribe);
  }

  async function initializeModelCanaryRuntime() {
    const runtimeClient = ensureModelCanaryClient();
    if (modelCanaryReady && runtimeClient.isReady && runtimeClient.isTransportReady()) {
      return runtimeClient;
    }
    await runtimeClient.connect();
    await runtimeClient.initialize();
    modelCanaryReady = true;
    return runtimeClient;
  }

  return {
    describe() {
      return {
        id: "codex",
        kind: "runtime",
        endpoint: config.codexEndpoint || "(spawn)",
        sessionsFile: config.sessionsFile,
        model: configuredModel,
        modelProvider: configuredModelProvider,
      };
    },
    createClient() {
      return ensureClient();
    },
    supportsExecutionPolicy(executionPolicy) {
      return normalizeText(executionPolicy) === MODEL_CANARY_EXECUTION_POLICY;
    },
    onEvent(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }
      ensureClient();
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    getSessionStore() {
      return sessionStore;
    },
    getTurnCapabilities({ model = "" } = {}) {
      const forcedNativeImageInput = config.codexNativeImageInput;
      if (typeof forcedNativeImageInput === "boolean") {
        return {
          nativeImageInput: forcedNativeImageInput,
          toolImageRead: false,
        };
      }
      const effectiveModel = normalizeText(configuredModel) || normalizeText(model);
      const catalog = sessionStore.getAvailableModelCatalog();
      const catalogModel = findModelByQuery(catalog?.models, effectiveModel);
      return {
        nativeImageInput: hasImageInputModality(catalogModel),
        toolImageRead: false,
      };
    },
    async initialize() {
      const runtimeClient = ensureClient();
      if (readyState && runtimeClient.isReady && runtimeClient.isTransportReady()) {
        return readyState;
      }
      await runtimeClient.connect();
      await runtimeClient.initialize();
      const modelResponse = await runtimeClient.listModels().catch(() => null);
      const models = Array.isArray(modelResponse?.result?.data)
        ? modelResponse.result.data
        : [];
      if (models.length) {
        sessionStore.setAvailableModelCatalog(models);
      }
      readyState = {
        endpoint: config.codexEndpoint || "(spawn)",
        models,
      };
      return readyState;
    },
    async close() {
      if (client) {
        await client.close();
      }
      if (modelCanaryClient) {
        await modelCanaryClient.close();
      }
      for (const unsubscribe of clientEventUnsubscribers.values()) {
        try { unsubscribe?.(); } catch {}
      }
      clientEventUnsubscribers.clear();
      eventListeners.clear();
      modelCanaryThreadIds.clear();
      modelCanaryApprovalRequestIds.clear();
      readyState = null;
      modelCanaryReady = false;
      client = null;
      modelCanaryClient = null;
    },
    async startFreshThreadDraft() {
      return {};
    },
    async respondApproval({ requestId, decision, result = null }) {
      if (requestId == null || String(requestId).trim() === "") {
        throw new Error("approval response requires a requestId");
      }
      const isolatedRequest = modelCanaryApprovalRequestIds.has(String(requestId));
      const runtimeClient = isolatedRequest
        ? await initializeModelCanaryRuntime()
        : ensureClient();
      if (!isolatedRequest) await this.initialize();
      const responsePayload = result && typeof result === "object"
        ? result
        : { decision: decision === "accept" ? "accept" : "decline" };
      await runtimeClient.sendResponse(requestId, responsePayload);
      if (isolatedRequest) modelCanaryApprovalRequestIds.delete(String(requestId));
      return {
        requestId,
        ...(result && typeof result === "object"
          ? { result: responsePayload }
          : { decision: responsePayload.decision }),
      };
    },
    async cancelTurn({ threadId, turnId }) {
      const isolatedThread = modelCanaryThreadIds.has(normalizeText(threadId));
      const runtimeClient = isolatedThread
        ? await initializeModelCanaryRuntime()
        : ensureClient();
      if (!isolatedThread) await this.initialize();
      await runtimeClient.cancelTurn({ threadId, turnId });
      return { threadId, turnId };
    },
    async resumeThread({ threadId }) {
      const runtimeClient = ensureClient();
      await this.initialize();
      return runtimeClient.resumeThread({
        threadId,
        model: configuredModel,
        modelProvider: configuredModelProvider,
      });
    },
    async compactThread({ threadId }) {
      const runtimeClient = ensureClient();
      await this.initialize();
      return runtimeClient.compactThread({ threadId });
    },
    async listTurnGeneratedImages({ threadId, turnId = "" } = {}) {
      const runtimeClient = ensureClient();
      await this.initialize();
      const response = await runtimeClient.listThreadItems({
        threadId,
        turnId,
        sortDirection: "asc",
      }).catch(() => runtimeClient.readThread({ threadId, includeTurns: true }));
      return extractGeneratedImageArtifacts(response, { turnId });
    },
    async refreshThreadInstructions({ threadId, workspaceRoot, model = "", modelProvider = "" }) {
      const runtimeClient = ensureClient();
      await this.initialize();
      const refreshText = buildInstructionRefreshText(config);
      const desiredModel = resolveModel(model, { modelProvider });
      await runtimeClient.resumeThread({
        threadId,
        model: desiredModel,
        modelProvider: configuredModelProvider,
      });
      const completion = waitForTurnCompletion(runtimeClient, threadId);
      await runtimeClient.sendUserMessage({
        threadId,
        text: refreshText,
        model: desiredModel,
        modelProvider: configuredModelProvider,
        workspaceRoot,
        accessMode: config.codexAccessMode,
      });
      const result = await completion;
      return { threadId, ...result };
    },
    async sendTextTurn(args) {
      return this.sendTurn(args);
    },
    async sendTurn({
      bindingKey,
      workspaceRoot,
      text,
      attachments = [],
      metadata = {},
      model = "",
      executionPolicy = "",
    }) {
      const normalizedExecutionPolicy = normalizeText(executionPolicy);
      const isolatedModelCanary = normalizedExecutionPolicy === MODEL_CANARY_EXECUTION_POLICY;
      if (normalizedExecutionPolicy && !isolatedModelCanary) {
        throw new Error(`unsupported Codex execution policy: ${normalizedExecutionPolicy}`);
      }
      if (isolatedModelCanary) {
        if (metadata?.modelCanaryDenySideEffects !== true
          || normalizeText(text) !== MODEL_CANARY_PROMPT
          || (Array.isArray(attachments) && attachments.length > 0)) {
          throw new Error("model canary isolated turn metadata, prompt, or attachment boundary is invalid");
        }
      }
      const runtimeClient = isolatedModelCanary
        ? await initializeModelCanaryRuntime()
        : ensureClient();
      if (!isolatedModelCanary) await this.initialize();
      const rpcWorkspaceRoot = isolatedModelCanary
        ? runtimeClient.getIsolatedWorkspaceRoot()
        : workspaceRoot;

      let threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      const storedParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
      const desiredModel = resolveModel(model, storedParams);
      const desiredModelProvider = configuredModelProvider;
      if (threadId && !runtimeParamsMatch(storedParams, {
        model: desiredModel,
        modelProvider: desiredModelProvider,
      })) {
        sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
        threadId = "";
      }
      sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
        model: desiredModel,
        modelProvider: desiredModelProvider,
      });
      let outboundText = isolatedModelCanary ? MODEL_CANARY_PROMPT : text;
      if (!threadId) {
        const response = await runtimeClient.startThread({
          cwd: rpcWorkspaceRoot,
          model: desiredModel,
          modelProvider: desiredModelProvider,
          ...(isolatedModelCanary ? { dynamicTools: [], environments: [] } : {}),
        });
        threadId = extractThreadId(response);
        if (!threadId) {
          throw new Error("thread/start did not return a thread id");
        }
        sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, metadata);
        if (!isolatedModelCanary) {
          outboundText = buildOpeningTurnText(config, text);
        }
      } else {
        await runtimeClient.resumeThread({
          threadId,
          model: desiredModel,
          modelProvider: desiredModelProvider,
        }).catch(async () => {
          sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
          const recreated = await runtimeClient.startThread({
            cwd: rpcWorkspaceRoot,
            model: desiredModel,
            modelProvider: desiredModelProvider,
            ...(isolatedModelCanary ? { dynamicTools: [], environments: [] } : {}),
          });
          threadId = extractThreadId(recreated);
          if (!threadId) {
            throw new Error("thread/start did not return a thread id");
          }
          sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, metadata);
          sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
            model: desiredModel,
            modelProvider: desiredModelProvider,
          });
          outboundText = isolatedModelCanary ? MODEL_CANARY_PROMPT : buildOpeningTurnText(config, text);
        });
      }

      const response = await runtimeClient.sendUserMessage({
        threadId,
        text: outboundText,
        attachments,
        model: desiredModel,
        modelProvider: desiredModelProvider,
        workspaceRoot: rpcWorkspaceRoot,
        accessMode: isolatedModelCanary ? null : config.codexAccessMode,
        executionPolicy: normalizedExecutionPolicy,
      });
      if (isolatedModelCanary) modelCanaryThreadIds.add(threadId);
      return {
        threadId,
        turnId: extractTurnId(response),
        ...(isolatedModelCanary ? { executionPolicy: MODEL_CANARY_EXECUTION_POLICY } : {}),
      };
    },
  };
}

module.exports = { createCodexRuntimeAdapter };

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function runtimeParamsMatch(storedParams, desiredParams) {
  return normalizeText(storedParams?.model) === normalizeText(desiredParams?.model)
    && normalizeText(storedParams?.modelProvider) === normalizeText(desiredParams?.modelProvider);
}

function hasImageInputModality(model) {
  const modalities = Array.isArray(model?.inputModalities) ? model.inputModalities : [];
  return modalities.some((item) => normalizeText(item).toLowerCase() === "image");
}

function waitForTurnCompletion(client, threadId) {
  return new Promise((resolve, reject) => {
    let activeTurnId = "";
    const itemOrder = [];
    const completedTextByItemId = new Map();

    const cleanup = () => {
      unsubscribe();
      clearTimeout(timer);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("codex turn timed out"));
    }, 10 * 60_000);

    const unsubscribe = client.onMessage((message) => {
      const params = message?.params || {};
      if (extractThreadIdFromParams(params) !== threadId) {
        return;
      }

      if ((message?.method === "turn/started" || message?.method === "turn/start") && !activeTurnId) {
        activeTurnId = extractTurnIdFromParams(params);
        return;
      }

      if (isAssistantItemCompleted(message)) {
        const itemId = typeof params?.item?.id === "string" ? params.item.id.trim() : `item-${itemOrder.length + 1}`;
        if (!completedTextByItemId.has(itemId)) {
          itemOrder.push(itemId);
        }
        completedTextByItemId.set(itemId, extractAssistantText(params));
        return;
      }

      if (message?.method === "turn/failed") {
        cleanup();
        reject(new Error(extractFailureText(params)));
        return;
      }

      if (message?.method === "turn/completed") {
        const completedTurnId = extractTurnIdFromParams(params);
        if (activeTurnId && completedTurnId && completedTurnId !== activeTurnId) {
          return;
        }
        cleanup();
        const text = itemOrder
          .map((itemId) => completedTextByItemId.get(itemId) || "")
          .filter(Boolean)
          .join("\n\n")
          .trim();
        resolve({
          turnId: completedTurnId || activeTurnId,
          text: text || "Completed.",
        });
      }
    });
  });
}
