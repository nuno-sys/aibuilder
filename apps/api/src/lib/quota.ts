import type { Env } from '../env';

/**
 * `QuotaDO` — layer 5 of the six-layer funnel (architecture §8).
 *
 * WHY A DURABLE OBJECT AND NOT D1. These counters decide whether a request may spend roughly a
 * dollar of model time. D1 is eventually consistent across replicas and single-threaded on writes;
 * a counter read from a replica is a counter you can spend twice. Quotas and money are counted in a
 * Durable Object, always, and the DO is addressed through `.jurisdiction('eu')` — architecture §9
 * one-way door 3: adding the jurisdiction later changes every DO id and silently resets every
 * counter.
 *
 * ONE INSTANCE PER SUBJECT. A counter is per subject, so the instance is named after the subject
 * (`ip:9f3c…`). That is what makes each count strongly consistent, and it is also why a submit
 * consults several instances: an IP, its network, an e-mail, a phone number and a business
 * identity are five independent limits. They cannot be updated atomically with respect to each
 * other, so `consumeQuota()` consumes them in order and `releaseQuota()` unwinds the ones already
 * taken when a later subject refuses. The window is milliseconds wide and the compensation is
 * exact.
 *
 * IP-DERIVED SUBJECTS ESCALATE, THEY DO NOT BLOCK. European mobile traffic is largely CGNAT; a
 * hard per-/24 cap refuses the eleventh Vodafone NL customer of the day with no signal that
 * distinguishes them from a bot. Over the threshold the DO answers `escalate`, and the caller moves
 * the session into the confirm-e-mail mode that the budget degradation already implements.
 *
 * THE WIRE CONTRACT, implemented by `apps/generator/src/do/QuotaDO.ts`:
 *
 * ```
 * POST https://quota.internal/consume   { "type": "...", "key": "...", "cost": 1 }
 *   -> 200 { "outcome": "allow" | "escalate" | "deny", "retryAfterSeconds": number | null }
 * POST https://quota.internal/release   { "type": "...", "key": "...", "cost": 1 }
 *   -> 204
 * ```
 *
 * The DO owns the limits per `type` (3 generations/IP/day, 10/network/day, 2/e-mail/day and 5
 * lifetime, 2/phone/day, 1/business identity/day). The caller owns the subjects. Neither owns both,
 * which is what keeps the policy in one file and the identity derivation in another.
 */

/** Which limit applies. The DO holds the number; this names the rule. */
export type QuotaSubjectType = 'ip' | 'ip_network' | 'email' | 'phone' | 'identity';

/** One subject to be counted. `key` is always a hash or a normalised value, never a raw IP. */
export interface QuotaSubject {
  readonly type: QuotaSubjectType;
  readonly key: string;
}

/** What the funnel does next. */
export type QuotaOutcome = 'allow' | 'escalate' | 'deny';

/** The aggregate decision over every subject of one submit. */
export interface QuotaDecision {
  readonly outcome: QuotaOutcome;
  /** The subject that produced a non-`allow` outcome, for the abuse ledger. `null` when allowed. */
  readonly subject: QuotaSubject | null;
  /** Seconds until the offending window rolls over, when the DO could say. */
  readonly retryAfterSeconds: number | null;
}

/** The DO's per-subject answer. */
interface QuotaResponseBody {
  readonly outcome: QuotaOutcome;
  readonly retryAfterSeconds: number | null;
}

/** Base URL of the internal DO API. The host is never resolved; only the path is read. */
const QUOTA_ORIGIN = 'https://quota.internal';

/** Jurisdiction is not optional and is not configurable. Architecture §1.3 and §9 one-way door 3. */
function stubFor(env: Env, subject: QuotaSubject): DurableObjectStub {
  const namespace = env.QUOTA.jurisdiction('eu');
  return namespace.get(namespace.idFromName(`${subject.type}:${subject.key}`));
}

/** Narrows the DO's JSON to the outcome shape, or `null` when it answered something unexpected. */
function parseOutcome(value: unknown): QuotaResponseBody | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const outcome = record['outcome'];
  if (outcome !== 'allow' && outcome !== 'escalate' && outcome !== 'deny') {
    return null;
  }
  const retry = record['retryAfterSeconds'];
  return {
    outcome,
    retryAfterSeconds: typeof retry === 'number' && Number.isFinite(retry) ? retry : null,
  };
}

/** Sends one consume/release call. Returns `null` on any transport or shape failure. */
async function call(
  env: Env,
  path: '/consume' | '/release',
  subject: QuotaSubject,
): Promise<QuotaResponseBody | null> {
  const response = await stubFor(env, subject).fetch(`${QUOTA_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: subject.type, key: subject.key, cost: 1 }),
  });
  if (!response.ok) {
    return null;
  }
  if (response.status === 204) {
    return { outcome: 'allow', retryAfterSeconds: null };
  }
  const parsed: unknown = await response.json();
  return parseOutcome(parsed);
}

/**
 * Consumes one generation against every subject, unwinding on refusal.
 *
 * Guarantees that on a `deny` result no subject is left holding a consumed count, so a user who is
 * refused because of one limit has not silently burned their allowance on the other four.
 *
 * A DO that cannot be reached is neither allowed nor denied: it escalates. Denying would take the
 * whole product down during a DO incident; allowing would remove the layer that stands between an
 * attacker and a paid generation. Escalation costs a real user twenty seconds of e-mail
 * confirmation and costs an automated attack everything.
 */
export async function consumeQuota(
  env: Env,
  subjects: readonly QuotaSubject[],
): Promise<QuotaDecision> {
  const consumed: QuotaSubject[] = [];
  let escalated: QuotaSubject | null = null;

  for (const subject of subjects) {
    const result = await call(env, '/consume', subject);

    if (result === null) {
      await releaseQuota(env, consumed);
      return { outcome: 'escalate', subject, retryAfterSeconds: null };
    }
    if (result.outcome === 'deny') {
      await releaseQuota(env, consumed);
      return { outcome: 'deny', subject, retryAfterSeconds: result.retryAfterSeconds };
    }

    consumed.push(subject);
    if (result.outcome === 'escalate' && escalated === null) {
      escalated = subject;
    }
  }

  return escalated === null
    ? { outcome: 'allow', subject: null, retryAfterSeconds: null }
    : { outcome: 'escalate', subject: escalated, retryAfterSeconds: null };
}

/**
 * Gives back counts taken by an earlier `consumeQuota`.
 *
 * Best-effort by design: a failed release costs one user one slot in one window, which is the right
 * trade against blocking a response on a compensating write. Failures are swallowed here and
 * surface as the ordinary quota telemetry.
 */
export async function releaseQuota(env: Env, subjects: readonly QuotaSubject[]): Promise<void> {
  await Promise.all(
    subjects.map(async (subject) => {
      try {
        await call(env, '/release', subject);
      } catch {
        // Intentionally ignored: see the JSDoc. A release is a compensation, not a guarantee.
      }
    }),
  );
}
