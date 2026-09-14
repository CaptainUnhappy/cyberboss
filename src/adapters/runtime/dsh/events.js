"use strict";

/**
 * Maps DSH SDK session events onto the runtime event vocabulary Cyberboss
 * consumes (see src/adapters/runtime/codex/events.js for the reference shapes).
 *
 * Two things about the DSH wire that shape this mapper, both taken from the live
 * capture in docs/dsh-sdk-protocol-notes.md:
 *
 * 1. The payload lives at `event.data`, not on `event` itself. The envelope is
 *    `{type, seq, time, data, surfaceOp?}`.
 * 2. `assistant/message` is emitted once per step and may carry no text at all
 *    (a step that only decides to call a tool carries a `tool-call` block). Turn
 *    completion is signalled by `turn/end`, never by `session.status`.
 */

const TURN_END_FAILURE_KINDS = new Set([
  "error",
  "max-tokens",
  "blocked",
  "aborted",
  "interrupted",
]);

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseToolArguments(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  const text = normalizeText(raw);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Extract the visible text of one assistant message, joining text blocks. */
function extractAssistantText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const parts = [];
  for (const block of content) {
    if (block?.type === "text") {
      const text = typeof block.text === "string" ? block.text : "";
      if (text) parts.push(text);
    }
  }
  return parts.join("");
}

function listAssistantToolCalls(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.filter((block) => block?.type === "tool-call");
}

/**
 * Build a short human-readable description of a tool call for logs and approval
 * prompts. Command-bearing tools (pwsh, bash) carry the real command.
 */
function describeToolCall(block) {
  const args = parseToolArguments(block?.arguments);
  const name = normalizeText(block?.name);
  const command = normalizeText(args?.command);
  const description = normalizeText(args?.description);
  const parts = [];
  if (name) parts.push(name);
  if (command) parts.push(command);
  else if (description) parts.push(description);
  return parts.join(": ");
}

function approvalOutcomeToDecision(outcome) {
  const normalized = normalizeText(outcome).toLowerCase();
  if (normalized === "allowed-once") return "approved";
  if (normalized === "rejected") return "denied";
  return normalized || "unknown";
}

/**
 * Map one `session.event` notification into zero or more runtime events.
 *
 * @param {object} params  the `session.event` params: {sessionId, event}
 * @param {object} context {turnId, threadId, pendingToolCalls: Map<callId, block>}
 * @returns {Array<{type: string, payload: object}>}
 */
function mapDshSessionEvent(params, context = {}) {
  const sessionId = normalizeText(params?.sessionId);
  const event = params?.event;
  const type = normalizeText(event?.type);
  const data = event?.data;
  if (!type) return [];

  const threadId = sessionId;
  const turnId = normalizeText(context.turnId) || (data?.turn != null ? String(data.turn) : "");

  if (type === "turn/start") {
    return [{
      type: "runtime.turn.started",
      payload: { threadId, turnId, seq: event.seq ?? null },
    }];
  }

  if (type === "turn/end") {
    const kind = normalizeText(data?.reason?.kind);
    if (TURN_END_FAILURE_KINDS.has(kind)) {
      return [{
        type: "runtime.turn.failed",
        payload: {
          threadId,
          turnId,
          text: kind === "aborted" || kind === "interrupted"
            ? "DSH turn was interrupted before it finished"
            : `DSH turn ended with reason: ${kind || "unknown"}`,
        },
      }];
    }
    return [{
      type: "runtime.turn.completed",
      payload: { threadId, turnId },
    }];
  }

  if (type === "assistant/message") {
    const events = [];
    const message = data?.message;
    const toolCalls = listAssistantToolCalls(message);
    for (const block of toolCalls) {
      const callId = normalizeText(block.id);
      if (context.pendingToolCalls && callId) {
        context.pendingToolCalls.set(callId, block);
      }
      events.push({
        type: "runtime.tool.started",
        payload: {
          threadId,
          turnId,
          itemId: callId,
          toolType: normalizeText(block.name),
          command: describeToolCall(block),
        },
      });
    }
    const text = extractAssistantText(message);
    if (text) {
      events.push({
        type: "runtime.reply.completed",
        payload: {
          threadId,
          turnId,
          itemId: normalizeText(message?.id),
          text,
          // DSH has no Codex-style `phase` field, so it is derived: a message that
          // also asks for a tool call cannot be the final answer - the turn
          // continues past it, so its text is an interim note. Cyberboss renders
          // commentary as a 【进度】 message and never lets it close the reply
          // obligation, which is the same shape Codex already produces.
          phase: toolCalls.length > 0 ? "commentary" : "final_answer",
        },
      });
    }
    return events;
  }

  if (type === "tool/call") {
    const callId = normalizeText(data?.callId);
    if (context.pendingToolCalls && callId) {
      context.pendingToolCalls.set(callId, {
        id: callId,
        name: normalizeText(data?.name),
        arguments: data?.arguments,
      });
    }
    return [{
      type: "runtime.tool.started",
      payload: {
        threadId,
        turnId,
        itemId: callId,
        toolType: normalizeText(data?.name),
        command: describeToolCall({ name: data?.name, arguments: data?.arguments }),
      },
    }];
  }

  if (type === "approval/asked") {
    const callId = normalizeText(data?.callId);
    const pending = context.pendingToolCalls && callId
      ? context.pendingToolCalls.get(callId)
      : null;
    const args = parseToolArguments(pending?.arguments);
    const command = normalizeText(args?.command);
    const requestedPermissions = normalizeText(args?.sandbox_permissions);
    const justification = normalizeText(args?.justification);
    const reason = normalizeText(data?.reason);
    return [{
      type: "runtime.approval.requested",
      payload: {
        kind: "command",
        threadId,
        turnId,
        requestId: normalizeText(data?.id),
        // DSH puts the explanation in `reason`; keep it verbatim so the human
        // sees exactly what the runtime asked for.
        reason,
        command,
        callId,
        toolName: normalizeText(data?.toolName) || normalizeText(pending?.name),
        requestedPermissions,
        justification,
        commandTokens: buildCommandTokens({ toolName: data?.toolName, command }),
        filePath: "",
        filePaths: [],
      },
    }];
  }

  if (type === "approval/decided") {
    return [{
      type: "runtime.approval.decided",
      payload: {
        threadId,
        turnId,
        requestId: normalizeText(data?.id),
        decision: approvalOutcomeToDecision(data?.outcome),
        outcome: normalizeText(data?.outcome),
      },
    }];
  }

  if (type === "session/title") {
    const title = normalizeText(data?.title);
    if (!title) return [];
    return [{
      type: "runtime.context.updated",
      payload: { threadId, title },
    }];
  }

  if (type === "deliverables/presented") {
    return [{ type: "runtime.media.completed", payload: { threadId, turnId, raw: data ?? null } }];
  }

  return [];
}

/**
 * Token list used by the shared approval-command matcher, mirroring how the
 * Codex adapter builds approval match tokens.
 */
function buildCommandTokens({ toolName = "", command = "" } = {}) {
  const tokens = [];
  const normalizedTool = normalizeText(toolName);
  if (normalizedTool) tokens.push(normalizedTool);
  for (const token of normalizeText(command).split(/\s+/)) {
    if (token) tokens.push(token);
  }
  return tokens;
}

module.exports = {
  mapDshSessionEvent,
  extractAssistantText,
  listAssistantToolCalls,
  describeToolCall,
  parseToolArguments,
  approvalOutcomeToDecision,
  buildCommandTokens,
  TURN_END_FAILURE_KINDS,
};
