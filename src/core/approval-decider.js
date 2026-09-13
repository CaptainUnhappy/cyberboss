"use strict";

/**
 * The approval decider: ask a *collaborative* DSH session for a verdict on a tool
 * escalation, instead of the SDK client answering directly (which is impossible -
 * server-to-client requests are a dead capability in the SDK protocol).
 *
 * The helper runtime is deliberately constrained:
 *   - it runs `sdk-minimal` with docs/dsh-helper-notools.patch.yml, which
 *     disables all five tool plugins (verified), so the decider cannot execute
 *     anything;
 *   - `sdk-minimal` composes no approval service at all, so a decision session
 *     cannot raise (and therefore cannot approve) its own escalation.
 *
 * Every failure path yields `unavailable`. A decider that cannot answer must
 * never read as permission.
 */

const path = require("node:path");

const { DshRpcClient, defaultDshBin } = require("../adapters/runtime/dsh/rpc-client");

const OUTCOME_ALLOW = "allowed-once";
const OUTCOME_DENY = "rejected";
const OUTCOME_UNAVAILABLE = "unavailable";

const DEFAULT_HELPER_PROFILE = "sdk-minimal";
const DEFAULT_HELPER_PATCH = path.resolve(__dirname, "..", "..", "docs", "dsh-helper-notools.patch.yml");
const DEFAULT_TIMEOUT_MS = 60_000;

const DECISION_SYSTEM_PROMPT = [
  "You are approving or rejecting one automation action on behalf of a human.",
  "You cannot run anything; judge only from the text you are given.",
  "Weigh: is the command narrowly scoped, explained, and free of destructive or",
  "credential-touching behaviour? Approving grants the action exactly once.",
  'Answer with exactly one word on the final line: "ALLOW" or "DENY".',
].join(" ");

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Parse a verdict from the decider's reply.
 *
 * Fails closed on every ambiguity. In particular a reply that contains both
 * words is a refusal even when the final line says ALLOW: the model stated a
 * denial somewhere, and guessing "allow" from ordering would be fail-open. (An
 * earlier revision had exactly that bug - "DENY\nALLOW" returned allowed-once -
 * which is why both-direction ambiguity is checked before any allowance.)
 */
function parseDecision(replyText) {
  const text = normalizeText(replyText);
  if (!text) return OUTCOME_UNAVAILABLE;

  const allowPattern = /\bALLOW\b/iu;
  const denyPattern = /\bDENY\b/iu;
  const textAllows = allowPattern.test(text);
  const textDenies = denyPattern.test(text);

  // Both words anywhere: ambiguous, refuse.
  if (textAllows && textDenies) return OUTCOME_DENY;

  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const tail = lines.length ? lines[lines.length - 1] : "";
  const tailAllows = allowPattern.test(tail);
  const tailDenies = denyPattern.test(tail);

  if (tailDenies) return OUTCOME_DENY;
  if (tailAllows) return OUTCOME_ALLOW;
  // No verdict on the final line: accept a single-word whole reply.
  if (textAllows) return OUTCOME_ALLOW;
  if (textDenies) return OUTCOME_DENY;
  return OUTCOME_UNAVAILABLE;
}

/** Build the text handed to the decider. */
function buildDecisionPrompt({ toolName, command, justification, requestedPermissions, reason } = {}) {
  const lines = ["A tool escalation requested approval.", ""];
  const tool = normalizeText(toolName);
  if (tool) lines.push(`Tool: ${tool}`);
  const permissions = normalizeText(requestedPermissions);
  if (permissions) lines.push(`Requested permissions: ${permissions}`);
  const cmd = normalizeText(command);
  lines.push(`Command: ${cmd || "(not available)"}`);
  const why = normalizeText(justification) || normalizeText(reason);
  if (why) lines.push(`Stated reason: ${why}`);
  lines.push("", 'Reply with "ALLOW" or "DENY".');
  return lines.join("\n");
}

/**
 * Ask a constrained helper runtime for one verdict.
 *
 * @returns {Promise<string>} a closed ApprovalOutcome
 */
async function decideApprovalWithHelper(options = {}) {
  const {
    toolName = "",
    command = "",
    justification = "",
    requestedPermissions = "",
    reason = "",
    dshBin = "",
    helperProfile = DEFAULT_HELPER_PROFILE,
    helperPatchPath = DEFAULT_HELPER_PATCH,
    model = "",
    provider = "deepseek-official",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    logger = console,
    createClient = (config) => new DshRpcClient(config),
  } = options;

  let client = null;
  try {
    client = createClient({
      dshBin: normalizeText(dshBin) || defaultDshBin(),
      profile: helperProfile,
      patchPaths: normalizeText(helperPatchPath) ? [helperPatchPath] : [],
      cwd: process.cwd(),
      provider,
      model,
      logger,
    });

    const replyText = await withTimeout(
      (async () => {
        await client.initialize();
        const sessionId = `cyberboss-approval-${Date.now()}`;
        let collected = "";
        let ended = false;
        client.onNotification((method, params) => {
          if (method !== "session.event") return;
          const event = params?.event || {};
          if (event.type === "assistant/message") {
            for (const block of event.data?.message?.content || []) {
              if (block?.type === "text" && block.text) collected += block.text;
            }
          }
          if (event.type === "turn/end") ended = true;
        });
        await client.prompt(sessionId, [{
          type: "text",
          text: `${DECISION_SYSTEM_PROMPT}\n\n${buildDecisionPrompt({
            toolName, command, justification, requestedPermissions, reason,
          })}`,
        }]);
        const deadline = Date.now() + timeoutMs;
        while (!ended && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (!ended) throw new Error("decision turn never ended");
        return collected;
      })(),
      timeoutMs,
      "decision timed out",
    );

    return parseDecision(replyText);
  } catch (error) {
    logger.error?.(
      `[cyberboss] approval decider failed closed: ${error?.message || error}`,
    );
    return OUTCOME_UNAVAILABLE;
  } finally {
    try {
      await client?.close();
    } catch {
      // Teardown failures must not change the verdict.
    }
  }
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

module.exports = {
  decideApprovalWithHelper,
  parseDecision,
  buildDecisionPrompt,
  DECISION_SYSTEM_PROMPT,
  OUTCOME_ALLOW,
  OUTCOME_DENY,
  OUTCOME_UNAVAILABLE,
  DEFAULT_HELPER_PROFILE,
  DEFAULT_HELPER_PATCH,
};
