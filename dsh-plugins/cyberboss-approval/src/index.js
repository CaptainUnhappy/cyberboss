/**
 * Cyberboss DSH approval answerer — SKELETON, not yet wired or verified.
 *
 * Registers a terminal answerer on the cordis `approval/request` waterfall so a
 * tool escalation is decided by a *collaborative session* instead of failing
 * closed with `unavailable`.
 *
 * ## Why this must live inside the DSH process
 *
 * `@deepseek-ai/dsh-sdk-protocol` documents server-to-client requests as a dead
 * capability - the transport supports them but the server never sends one - so a
 * Cyberboss SDK client cannot answer an approval. See
 * docs/dsh-phase2-approval-spec.md.
 *
 * ## Verified interface facts (do not re-derive)
 *
 * - Dispatch is `waterfall`: returning an `ApprovalOutcome` claims the request,
 *   calling `next()` delegates to the next answerer. A missing or throwing
 *   answerer resolves `unavailable` (fail closed).
 * - `ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`.
 *   `allowed-once` is the only grant; there is no allow-always.
 * - `ApprovalRequestEvent` carries only `{agent, toolName, callId?, reason?, signal?}`
 *   - **no tool arguments**. The deciding side must resolve them from `callId`
 *     against the session's `tool/call` events. The Cyberboss adapter already
 *     records those by callId in `src/adapters/runtime/dsh/events.js`.
 * - A plugin's default export is the Service class; cordis constructs it with
 *   `(ctx, config)` and `super(ctx, '<service-name>')`. Confirmed against
 *   `@deepseek-ai/dsh-user-approval`, which exports `ApprovalService as default`.
 * - Event registration is `ctx.on(name, listener)` returning a disposer
 *   (`() => boolean`); cordis mixes the event-bus methods onto `ctx`
 *   ("Its methods are also mixed onto `ctx` (`ctx.on`, `ctx.emit`, ...)").
 *   The listener type for a waterfall event is exactly
 *   `(req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>`,
 *   so the registration used below matches the declared event type.
 *
 * ## Recursion hazard (the reason for the helper design)
 *
 * If the decider were itself a tool-capable agent it could raise its own
 * `approval/request` and approve itself. The decider therefore runs in a
 * separate runtime built from `sdk-minimal` plus
 * `docs/dsh-helper-notools.patch.yml`, which disables all five tool plugins
 * (verified) and composes no approval service at all, so any request raised
 * there resolves `unavailable`.
 *
 * ## Status
 *
 * Wired and verified: the answerer claims the live `approval/request` waterfall
 * (`mode: never` yields `rejected`, `mode: session` with no transport yields
 * `unavailable`, and a bare profile yields `unavailable`).
 *
 * `decide()` now POSTs to the Cyberboss endpoint created by
 * `src/core/approval-endpoint.js`, which resolves the tool arguments from the
 * `callId` and consults `src/core/approval-decider.js`. When no transport is
 * configured the answerer still fails closed.
 */

import { Service } from '@deepseek-ai/cordis';

/** The closed outcome vocabulary; fail closed on anything else. */
const OUTCOMES = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable']);

export default class CyberbossApprovalAnswerer extends Service {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {{ endpoint?: string, timeoutMs?: number, mode?: 'session'|'never'|'deny' }} config
   */
  constructor(ctx, config = {}) {
    super(ctx, 'cyberbossApproval');
    this.config = config;
    this.mode = config.mode ?? 'session';
    // The endpoint and its bearer token are handed to this process through the
    // environment, because they are per-spawn (ephemeral port + fresh token) and
    // a patch file is static. Config still wins so a test can pin them.
    this.endpoint = String(
      config.endpoint || process.env.CYBERBOSS_DSH_APPROVAL_ENDPOINT || '',
    ).trim();
    this.token = String(
      config.token || process.env.CYBERBOSS_DSH_APPROVAL_TOKEN || '',
    ).trim();
    this.timeoutMs = Number.isFinite(Number(config.timeoutMs)) ? Number(config.timeoutMs) : 30_000;

    // Registered for every agent composing this plugin. Returning an outcome
    // claims the request; next() delegates.
    ctx.on('approval/request', (req, next) => this.answer(req, next));
  }

  /**
   * @param {import('@deepseek-ai/dsh-user-approval/types').ApprovalRequestEvent} req
   * @param {() => Promise<string>} next
   * @returns {Promise<string>} a closed ApprovalOutcome
   */
  async answer(req, next) {
    // 'never' is a deterministic rejection and must not consult anyone.
    if (this.mode === 'never' || this.mode === 'deny') {
      return 'rejected';
    }
    if (!this.endpoint || !this.token) {
      // No transport configured: fail closed rather than pretend to decide.
      this.ctx.logger?.warn?.(
        '[cyberboss-approval] no decider transport configured; failing closed',
      );
      return 'unavailable';
    }

    let decision;
    try {
      decision = await this.withTimeout(
        this.decide(req),
        this.timeoutMs,
        'decider timed out',
      );
    } catch (error) {
      // Every failure path is `unavailable`: a decider that cannot answer must
      // never be read as approval.
      this.ctx.logger?.warn?.(
        `[cyberboss-approval] decider failed closed: ${error?.message || error}`,
      );
      return 'unavailable';
    }
    if (!OUTCOMES.has(decision)) {
      this.ctx.logger?.warn?.(
        `[cyberboss-approval] decider returned a value outside the vocabulary: ${String(decision)}`,
      );
      return 'unavailable';
    }
    return decision;
  }

  /**
   * Ask Cyberboss for a verdict.
   *
   * Only `{toolName, callId, reason}` crosses the wire. The event carries no tool
   * arguments, and forwarding arguments we do not have would be guesswork; the
   * endpoint resolves them itself from the paired `tool/call` it already
   * recorded for this callId.
   *
   * @returns {Promise<string>} a closed ApprovalOutcome
   */
  async decide(req) {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        toolName: String(req?.toolName ?? ''),
        callId: String(req?.callId ?? ''),
        reason: String(req?.reason ?? ''),
      }),
      signal: req?.signal,
    });
    if (!response.ok) {
      throw new Error(`decider endpoint returned HTTP ${response.status}`);
    }
    const payload = await response.json();
    return typeof payload?.outcome === 'string' ? payload.outcome : 'unavailable';
  }

  withTimeout(promise, timeoutMs, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  }
}
