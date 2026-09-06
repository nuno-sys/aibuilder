import type { Env } from '../env';

/**
 * The only place in this Worker that mints a Durable Object id.
 *
 * THIS IS A ONE-WAY DOOR (architecture §9, one-way door 3). `.jurisdiction('eu')` is not a filter
 * applied to an existing id — it changes the id itself. An object addressed as
 * `NS.idFromName('ip:9f3c…')` and an object addressed as
 * `NS.jurisdiction('eu').idFromName('ip:9f3c…')` are two different objects with two different
 * storage volumes. Adding the jurisdiction later therefore does not "move" anything: it silently
 * resets every quota counter, orphans every open budget reservation, and disconnects every live
 * SSE stream from the log it was reading. Removing it does the same in reverse.
 *
 * Which is why there is one function per object and no exported helper that takes a namespace: a
 * call site cannot forget the jurisdiction, because a call site never sees a namespace. The same
 * discipline is applied on the other side of the wire in `apps/api/src/lib/{budget,quota}.ts`, and
 * the two must agree exactly — they address the same objects.
 *
 * The EU jurisdiction is also what makes the residency claim in §1.3 true for the three stores that
 * hold spend, quotas and progress: D1 and R2 carry it at creation, and a DO carries it in its id.
 */

/** The jurisdiction every Durable Object in this product lives in. Never a parameter. */
const JURISDICTION = 'eu';

/**
 * The per-job progress hub.
 *
 * Named after the job id, so the SSE endpoint's authorisation (the draft cookie must resolve to the
 * job's draft) and the object's identity are derived from the same value.
 */
export function jobHubStub(env: Env, jobId: string): DurableObjectStub {
  const namespace = env.JOB_HUB.jurisdiction(JURISDICTION);
  return namespace.get(namespace.idFromName(jobId));
}

/** The single global instance's name. Never derived from a request value. */
const BUDGET_INSTANCE = 'global';

/**
 * The global spend ceiling.
 *
 * ONE instance for the whole product, because spend is one number. That single object is the
 * serialisation point for every reservation; the cost of counting money correctly, and worth it.
 */
export function budgetStub(env: Env): DurableObjectStub {
  const namespace = env.BUDGET.jurisdiction(JURISDICTION);
  return namespace.get(namespace.idFromName(BUDGET_INSTANCE));
}

/** Which limit a quota subject is counted against. Mirrors `apps/api/src/lib/quota.ts`. */
export type QuotaSubjectType = 'ip' | 'ip_network' | 'email' | 'phone' | 'identity';

/**
 * One quota subject's counter.
 *
 * The instance name is `${type}:${key}`, so an IP and an e-mail that happened to hash to the same
 * hex string are still two objects. `key` is always a hash or a normalised value; no raw IP and no
 * raw e-mail address ever reaches a Durable Object (§8, GDPR posture).
 */
export function quotaStub(env: Env, type: QuotaSubjectType, key: string): DurableObjectStub {
  const namespace = env.QUOTA.jurisdiction(JURISDICTION);
  return namespace.get(namespace.idFromName(`${type}:${key}`));
}
