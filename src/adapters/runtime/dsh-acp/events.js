"use strict";

/**
 * Map ACP `session/update` traffic onto the runtime events Cyberboss consumes.
 *
 * ACP streams *chunks*, while the application's contract is whole messages
 * (`runtime.reply.completed` with a `phase`), so this mapper is stateful: it
 * accumulates text and flushes it at the boundaries where a message can be
 * considered finished - immediately before a tool call (that text is an interim
 * note, so `commentary`) and when the turn ends (the final answer). Thinking
 * chunks and token accounting carry no user-visible meaning here and are dropped.
 */

const COMMENTARY_PHASE = "commentary";
const FINAL_PHASE = "final_answer";

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readUpdate(params) {
  return params?.update && typeof params.update === "object" ? params.update : params;
}

function readChunkText(update) {
  const content = update?.content;
  if (content?.type === "text" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

/** A one-line description of a tool call, mirroring the sdk surface's `command`. */
function describeToolCall(toolCall) {
  const rawInput = toolCall?.rawInput;
  if (typeof rawInput === "string" && rawInput.trim()) {
    return rawInput.trim().slice(0, 400);
  }
  if (rawInput && typeof rawInput === "object") {
    const command = normalizeText(rawInput.command);
    if (command) {
      return command.slice(0, 400);
    }
    try {
      return JSON.stringify(rawInput).slice(0, 400);
    } catch {
      return "";
    }
  }
  return normalizeText(toolCall?.title);
}

function buildCommandTokens({ toolName = "", command = "" } = {}) {
  const tokens = [];
  const normalizedTool = normalizeText(toolName);
  if (normalizedTool) {
    tokens.push(normalizedTool);
  }
  for (const token of normalizeText(command).split(/\s+/)) {
    if (token) {
      tokens.push(token);
    }
  }
  return tokens;
}

class AcpTurnMapper {
  /**
   * @param {object} options
   * @param {string} options.threadId  ACP session id
   * @param {string} options.turnId    id this client minted for the prompt
   * @param {Map} [options.pendingToolCalls] callId -> tool call, shared with approvals
   */
  constructor({ threadId = "", turnId = "", pendingToolCalls = null } = {}) {
    this.threadId = normalizeText(threadId);
    this.turnId = normalizeText(turnId);
    this.pendingToolCalls = pendingToolCalls instanceof Map ? pendingToolCalls : new Map();
    this.textBuffer = "";
    this.flushCount = 0;
  }

  flush(text, phase) {
    const trimmed = normalizeText(text);
    if (!trimmed) {
      return null;
    }
    this.flushCount += 1;
    return {
      type: "runtime.reply.completed",
      payload: {
        threadId: this.threadId,
        turnId: this.turnId,
        // ACP has no message ids; a stable per-turn index keeps the delivery
        // idempotency key reproducible for the same turn.
        itemId: `${this.turnId}:text:${this.flushCount}`,
        text: trimmed,
        phase,
      },
    };
  }

  takeBufferedText() {
    const buffered = this.textBuffer;
    this.textBuffer = "";
    return buffered;
  }

  mapUpdate(params) {
    const update = readUpdate(params);
    const kind = normalizeText(update?.sessionUpdate);
    if (!kind) {
      return [];
    }

    if (kind === "agent_message_chunk") {
      this.textBuffer += readChunkText(update);
      return [];
    }

    if (kind === "tool_call") {
      const events = [];
      // Text written before a tool call cannot be the answer: the turn continues.
      const interim = this.flush(this.takeBufferedText(), COMMENTARY_PHASE);
      if (interim) {
        events.push(interim);
      }
      const callId = normalizeText(update?.toolCallId);
      const toolCall = {
        id: callId,
        name: normalizeText(update?.title) || normalizeText(update?.kind),
        arguments: update?.rawInput,
      };
      if (callId) {
        this.pendingToolCalls.set(callId, toolCall);
      }
      events.push({
        type: "runtime.tool.started",
        payload: {
          threadId: this.threadId,
          turnId: this.turnId,
          itemId: callId,
          toolType: toolCall.name,
          command: describeToolCall(update),
        },
      });
      return events;
    }

    if (kind === "session_info_update") {
      const title = normalizeText(update?.title);
      return title
        ? [{ type: "runtime.context.updated", payload: { threadId: this.threadId, title } }]
        : [];
    }

    // agent_thought_chunk, tool_call_update, usage_update, plan, and anything a
    // future protocol revision adds carry nothing this application renders.
    return [];
  }

  /** The prompt returned: whatever text is still buffered is the final answer. */
  finish({ failed = false, reason = "" } = {}) {
    const events = [];
    const finalText = this.flush(this.takeBufferedText(), FINAL_PHASE);
    if (finalText) {
      events.push(finalText);
    }
    if (failed) {
      events.push({
        type: "runtime.turn.failed",
        payload: {
          threadId: this.threadId,
          turnId: this.turnId,
          text: normalizeText(reason) || "ACP turn ended without a reply",
        },
      });
    } else {
      events.push({
        type: "runtime.turn.completed",
        payload: { threadId: this.threadId, turnId: this.turnId },
      });
    }
    return events;
  }
}

/**
 * An ACP permission request, in the shape the approval flow already understands.
 *
 * The sdk surface announced approvals as session events; ACP asks the client
 * directly, so the same payload is built from the tool call the request carries.
 */
function mapPermissionRequest(params, { threadId = "", turnId = "", pendingToolCalls = null } = {}) {
  const toolCall = params?.toolCall || {};
  const callId = normalizeText(toolCall.toolCallId);
  const pending = pendingToolCalls instanceof Map && callId ? pendingToolCalls.get(callId) : null;
  const rawInput = toolCall.rawInput ?? pending?.arguments;
  const command = typeof rawInput === "object" && rawInput !== null
    ? normalizeText(rawInput.command)
    : "";
  const toolName = normalizeText(toolCall.title) || normalizeText(pending?.name);
  return {
    type: "runtime.approval.requested",
    payload: {
      kind: "command",
      threadId: normalizeText(threadId),
      turnId: normalizeText(turnId),
      requestId: normalizeText(params?.requestId),
      reason: normalizeText(toolCall.title) || normalizeText(toolCall.content),
      command: command || (typeof rawInput === "string" ? normalizeText(rawInput) : ""),
      callId,
      toolName,
      requestedPermissions: typeof rawInput === "object" && rawInput !== null
        ? normalizeText(rawInput.sandbox_permissions)
        : "",
      justification: typeof rawInput === "object" && rawInput !== null
        ? normalizeText(rawInput.justification)
        : "",
      commandTokens: buildCommandTokens({ toolName, command }),
      filePath: "",
      filePaths: [],
    },
  };
}

/**
 * Pick the ACP option that expresses a decision.
 *
 * ACP hands the client opaque option ids with semantic `kind`s, so the decision
 * is matched by kind and never by position: an agent may offer only "allow
 * always" or reorder its options between calls.
 */
function selectPermissionOption(options, decision) {
  const list = Array.isArray(options) ? options.filter((option) => option && typeof option === "object") : [];
  const wanted = decision === "allow"
    ? ["allow_once", "allow_always"]
    : ["reject_once", "reject_always"];
  for (const kind of wanted) {
    const match = list.find((option) => normalizeText(option.kind) === kind);
    if (match && normalizeText(match.optionId)) {
      return match.optionId;
    }
  }
  return "";
}

function buildPermissionResponse({ optionId = "", decision = "" } = {}) {
  const selected = normalizeText(optionId);
  if (selected) {
    return { outcome: { outcome: "selected", optionId: selected } };
  }
  // No usable option: cancel rather than pretend the decision was delivered.
  return { outcome: { outcome: decision === "allow" ? "cancelled" : "cancelled" } };
}

function mapPermissionDecision({ requestId = "", optionId = "", decision = "" } = {}) {
  return {
    type: "runtime.approval.decided",
    payload: {
      requestId: normalizeText(requestId),
      decision: normalizeText(decision),
      outcome: normalizeText(optionId),
    },
  };
}

module.exports = {
  AcpTurnMapper,
  COMMENTARY_PHASE,
  FINAL_PHASE,
  buildPermissionResponse,
  describeToolCall,
  mapPermissionDecision,
  mapPermissionRequest,
  selectPermissionOption,
};
