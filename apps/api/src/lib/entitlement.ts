import { cp } from '@aibuilder/db';
import type {
  Entitlement,
  MembershipRole,
  OrganisationId,
  SessionRow,
  ShardId,
  UserId,
} from '@aibuilder/db';

import type { Env } from '../env';
import { readCookie } from '../middleware/draft-cookie';
import { fromBase64Url } from './encoding';
import { errorResponse, notFoundResponse } from './responses';

/**
 * The paywall, in one function that every protected route calls and no route re-implements.
 *
 * ORDER IS THE SECURITY MODEL, cheapest and most fundamental first: a session, then a MEMBERSHIP,
 * then the role, then the organisation's own status, and only then the entitlement. The membership
 * check is the tenancy isolation invariant (architecture §5.2) — an organisation with zero
 * memberships is unreachable, which is exactly what makes a provisional organisation safe to exist
 * between submit and the webhook. Reversing the last two checks would tell a suspended tenant
 * whether their subscription is live, which is an oracle with no reason to exist.
 *
 * TWO READS, BOTH INDEXED, BOTH BOUNDED. `getMembership` is a covering seek on
 * `idx_memberships_user`; `getEntitlement` is one primary-key row read on `organisations` and never
 * a join into `subscriptions`. That is the entire reason `organisations.entitlement` is a
 * denormalisation at all, and why the Stripe webhook writes it in the same `batch()` as the
 * subscription it was derived from.
 *
 * A DEADLINE THAT IS NEVER CHECKED IS NOT A DEADLINE. `entitlement_until < now` fails as
 * `entitlement_lapsed` even when the column still reads `trialing`: webhooks can be lost, and the
 * nightly reconciliation that corrects such rows against Stripe runs on its own schedule. The gate
 * does not wait for it.
 */

/**
 * The bindings this Worker gains in Phase 2, declared here rather than edited into `../env`.
 *
 * PHASE 2 NOTE (handover): design §8.2 adds these four to `Env` in `src/env.ts`, alongside the
 * auth surface's `RL_AUTH` and `WEBAUTHN_RP_ID`. They are declared as a module augmentation so the
 * billing routes compile against the real interface while that file is being extended for the
 * authentication work; when the members land in `src/env.ts` this block is deleted, and TypeScript
 * says so loudly if it is not.
 */
/** The session cookie minted by `GET /claim` and by `GET /v1/billing/return`. */
export const SESSION_COOKIE_NAME = '__Host-aib_session';

/** Every way the gate can refuse. Each maps to exactly one status code; see `gateFailure()`. */
export type GateFailure =
  | 'no_session'
  | 'no_membership'
  | 'insufficient_role'
  | 'org_suspended'
  | 'not_entitled'
  | 'entitlement_lapsed';

/** What a passed gate hands the route: everything it needs, nothing it has to look up again. */
export interface Gate {
  readonly orgId: OrganisationId;
  readonly userId: UserId;
  readonly role: MembershipRole;
  readonly entitlement: Entitlement;
  /** From the entitlement read, so a route never recomputes a tenant's shard. */
  readonly shardId: ShardId;
}

/** Roles, from most to least capable. A route asks for a minimum and gets it or a 403. */
const ROLE_RANK: Readonly<Record<MembershipRole, number>> = {
  owner: 3,
  admin: 2,
  editor: 1,
  viewer: 0,
};

/** The entitlements a paid feature runs under, and the whole of architecture §3c step 2. */
export const LIVE_ENTITLEMENTS: readonly Entitlement[] = ['trialing', 'active'];

/** True for the six failure strings, false for a `Gate`. */
export function isGateFailure(result: Gate | GateFailure): result is GateFailure {
  return typeof result === 'string';
}

/**
 * Reads the live session behind `__Host-aib_session`.
 *
 * PHASE 2 NOTE (handover): design §8.2 adds `src/middleware/session.ts`, whose `requireSession`
 * does this AND slides `last_seen_at` at most hourly AND puts the row on the Hono context. This is
 * the read-only half, so the entitlement gate and the regenerate route work before that middleware
 * lands; when it does, callers read `c.get('session')` and this function goes away.
 *
 * The token is opaque and only its hash is stored, so a database read cannot mint a cookie. Expiry
 * and revocation are predicates inside the statement, so there is no path on which a live session
 * is read and then separately — or never — validated.
 */
export async function sessionFromRequest(env: Env, request: Request): Promise<SessionRow | null> {
  const cookie = readCookie(request.headers.get('Cookie') ?? undefined, SESSION_COOKIE_NAME);
  if (cookie === null) {
    return null;
  }
  const bytes = fromBase64Url(cookie);
  if (bytes === null || bytes.byteLength !== 32) {
    return null;
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return cp.users.getSessionByTokenHash(env.CP, {
    tokenHash: new Uint8Array(digest),
    now: Date.now(),
  });
}

/**
 * Decides whether this session may perform a paid action in this organisation.
 *
 * Guarantees that a returned `Gate` was backed by a live membership, a sufficient role, an active
 * organisation and an unexpired entitlement in `allow` — checked in that order, against the
 * database, on this request.
 */
export async function requireEntitlement(
  env: Env,
  session: SessionRow | null,
  orgId: OrganisationId,
  opts: {
    readonly minRole: MembershipRole;
    readonly allow?: readonly Entitlement[];
    readonly now?: number;
  },
): Promise<Gate | GateFailure> {
  if (session === null) {
    return 'no_session';
  }

  const membership = await cp.users.getMembership(env.CP, {
    userId: session.user_id,
    orgId,
  });
  if (membership === null) {
    // 404, not 403 (see `gateFailure`): a provisional organisation has no memberships at all, and
    // this is the check that makes it unreachable rather than merely unbilled.
    return 'no_membership';
  }
  if (ROLE_RANK[membership.role] < ROLE_RANK[opts.minRole]) {
    return 'insufficient_role';
  }

  const row = await cp.orgs.getEntitlement(env.CP, orgId);
  if (row === null) {
    return 'no_membership';
  }
  if (row.status !== 'active') {
    return 'org_suspended';
  }

  const allow = opts.allow ?? LIVE_ENTITLEMENTS;
  if (!allow.includes(row.entitlement)) {
    return 'not_entitled';
  }
  const now = opts.now ?? Date.now();
  if (row.entitlement_until !== null && row.entitlement_until < now) {
    return 'entitlement_lapsed';
  }

  return {
    orgId,
    userId: session.user_id,
    role: membership.role,
    entitlement: row.entitlement,
    shardId: row.shard_id,
  };
}

/**
 * Turns a refusal into the response.
 *
 * `no_membership` is a 404 and never a 403, because a 403 confirms that the organisation exists —
 * which turns an id guess into an existence oracle for other tenants. The two paywall failures are
 * 402 and carry the portal link, because "pay to continue" is only useful with a way to pay.
 */
export function gateFailure(env: Env, failure: GateFailure): Response {
  switch (failure) {
    case 'no_session':
      return errorResponse(401, 'no_session', 'Je bent niet ingelogd.', 'You are not signed in.');
    case 'no_membership':
      return notFoundResponse();
    case 'insufficient_role':
      return errorResponse(
        403,
        'insufficient_role',
        'Je hebt hier geen rechten voor.',
        'You do not have permission to do this.',
      );
    case 'org_suspended':
      return errorResponse(
        403,
        'org_suspended',
        'Dit account is geblokkeerd. Neem contact met ons op.',
        'This account is suspended. Please contact us.',
      );
    case 'not_entitled':
    case 'entitlement_lapsed':
      return errorResponse(
        402,
        'payment_required',
        'Je abonnement is niet actief. Werk je betaalgegevens bij om verder te gaan.',
        'Your subscription is not active. Update your payment details to continue.',
        { portalUrl: `${env.DASHBOARD_ORIGIN}/facturatie`, reason: failure },
      );
  }
}
