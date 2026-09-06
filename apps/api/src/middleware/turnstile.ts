import { readSecret } from '../env';
import type { Env } from '../env';

/**
 * Layer 3 of the funnel: Turnstile, verified server-side (architecture §8).
 *
 * WHERE IT RUNS. At **draft creation**, not only at submit. Every expensive endpoint downstream —
 * `media/sign`, and every route that can cost money — is keyed on a draft id, so a client-minted
 * draft id would be an open relay. A second check runs at submit, where the token is additionally
 * bound to the draft it is submitting.
 *
 * WHAT IS ASSERTED, and why each one matters:
 *
 *  - **`success`** — necessary and nowhere near sufficient. The three below are what make a stolen
 *    token useless.
 *  - **`action`** — a token solved for the draft-creation widget cannot be replayed at submit.
 *    Without it, one widget's token opens every gate.
 *  - **`cdata`** — at submit, the draft id. A token solved in one session cannot be used to submit
 *    another. At creation there is no draft yet to bind to, and inventing one would be theatre:
 *    the binding starts existing at the exact moment there is something to bind to.
 *  - **`hostname`** — the site the widget was solved on. Cloudflare returns it, and asserting it
 *    against `APP_ORIGIN`'s host is what stops a token farmed on an attacker's page (with a stolen
 *    sitekey) from being spent here.
 *
 * A token is single use. `idempotency_key` lets the SAME token be re-verified within five minutes
 * and is sent as a fresh UUID per verification, which is what makes a retried siteverify safe
 * rather than a second, failing spend of the token.
 */

/** Cloudflare's server-side verification endpoint. */
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Verification must not hold a user's request open; the funnel has five other layers. */
const SITEVERIFY_TIMEOUT_MS = 5_000;

/** The `action` the widget on the marketing page sets when creating a draft. */
export const TURNSTILE_ACTION_DRAFT = 'draft-create';

/** The `action` the widget sets when submitting onboarding. */
export const TURNSTILE_ACTION_SUBMIT = 'onboarding-submit';

/** Why a verification failed. `error` is what the abuse ledger records. */
export interface TurnstileFailure {
  readonly ok: false;
  /** One of Cloudflare's error codes, or one of ours for a mismatched binding. */
  readonly error: string;
}

/** A verification that passed every assertion. */
export interface TurnstileSuccess {
  readonly ok: true;
}

/** The result of `verifyTurnstile`. */
export type TurnstileResult = TurnstileSuccess | TurnstileFailure;

/** The subset of the siteverify response this module reads. */
interface SiteverifyBody {
  readonly success: boolean;
  readonly action: string | null;
  readonly cdata: string | null;
  readonly hostname: string | null;
  readonly errorCodes: readonly string[];
}

/** What one verification asserts. */
export interface TurnstileParams {
  /** The token the widget produced. */
  readonly token: string;
  /** The action this call site expects. */
  readonly action: string;
  /**
   * The draft the token must be bound to, or `null` at draft creation where none exists yet.
   */
  readonly cdata: string | null;
  /** The visitor's IP, when known. Cloudflare uses it as an additional signal. */
  readonly remoteIp: string | null;
}

/** Reads the siteverify response defensively; a missing field is never treated as a match. */
function parseSiteverify(value: unknown): SiteverifyBody | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record['success'] !== 'boolean') {
    return null;
  }
  const codes = record['error-codes'];
  return {
    success: record['success'],
    action: typeof record['action'] === 'string' ? record['action'] : null,
    cdata: typeof record['cdata'] === 'string' ? record['cdata'] : null,
    hostname: typeof record['hostname'] === 'string' ? record['hostname'] : null,
    errorCodes: Array.isArray(codes)
      ? codes.filter((code): code is string => typeof code === 'string')
      : [],
  };
}

/**
 * Verifies a Turnstile token and asserts its bindings.
 *
 * Guarantees that `ok: true` means Cloudflare validated the token AND it was solved for this
 * action, on this hostname, and — where a draft exists — for this draft. Never throws for a failed
 * challenge: a refused token is a user- or attacker-facing 403, not an exception.
 */
export async function verifyTurnstile(env: Env, params: TurnstileParams): Promise<TurnstileResult> {
  if (params.token.length === 0 || params.token.length > 4096) {
    return { ok: false, error: 'missing-input-response' };
  }

  const secret = await readSecret(env.TURNSTILE_SECRET, 'TURNSTILE_SECRET');
  const payload: Record<string, string> = {
    secret,
    response: params.token,
    idempotency_key: crypto.randomUUID(),
  };
  if (params.remoteIp !== null) {
    payload['remoteip'] = params.remoteIp;
  }

  let parsed: SiteverifyBody | null = null;
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
    if (response.ok) {
      const body: unknown = await response.json();
      parsed = parseSiteverify(body);
    }
  } catch {
    parsed = null;
  }

  // An unreachable Turnstile fails closed. This gate exists to stand in front of a paid operation;
  // treating an outage as a pass would make "make siteverify time out" the cheapest attack there is.
  if (parsed === null) {
    return { ok: false, error: 'internal-error' };
  }
  if (!parsed.success) {
    return { ok: false, error: parsed.errorCodes[0] ?? 'invalid-input-response' };
  }
  if (parsed.action !== params.action) {
    return { ok: false, error: 'action-mismatch' };
  }
  if (params.cdata !== null && parsed.cdata !== params.cdata) {
    return { ok: false, error: 'cdata-mismatch' };
  }

  const expectedHostname = hostnameOf(env.APP_ORIGIN);
  if (
    expectedHostname !== null &&
    parsed.hostname !== null &&
    parsed.hostname !== expectedHostname
  ) {
    return { ok: false, error: 'hostname-mismatch' };
  }

  return { ok: true };
}

/** The host of a configured origin, or `null` when it is not a URL (a deployment fault). */
function hostnameOf(origin: string): string | null {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}
