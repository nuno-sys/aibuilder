import { preferredOrgId } from '@aibuilder/auth';
import { cp, shardById } from '@aibuilder/db';
import type {
  Entitlement,
  MembershipRole,
  OrganisationId,
  SessionRow,
  SiteId,
  Timestamp,
  UserId,
  UserRow,
} from '@aibuilder/db';
import { redirect } from 'react-router';

import type { Env } from '../env';
import { currentSession } from './session.server';

/**
 * The authorisation ladder every loader and action in this app climbs, and the only place it is
 * written down.
 *
 * ORDER IS THE SECURITY MODEL, and it is the same order `apps/api/src/lib/entitlement.ts` uses,
 * deliberately: a session, then a MEMBERSHIP, then the role, then the organisation's status, and
 * only then the paywall. The membership check is the tenancy isolation invariant — an organisation
 * with zero memberships is unreachable, which is exactly what makes a provisional organisation safe
 * to exist between submit and the Stripe webhook.
 *
 * THE ISOLATION CHECK IS ONE SQL STATEMENT, NOT TWO. `cp.dashboard.getSiteForUser` joins
 * `memberships` and returns a row only when the signed-in user has one, so there is no code path on
 * which a site row is read and then separately — or never — checked against the caller. That is the
 * whole reason that statement exists, and `app/__tests__/org-isolation.test.ts` proves a member of
 * organisation A gets `null` for a site of organisation B.
 *
 * WHY A 404 AND NEVER A 403 FOR A FOREIGN SITE. A 403 confirms that the site id exists, which turns
 * a guess into an existence oracle for other tenants. Not found and not yours are the same answer.
 *
 * WHY LOADERS DO NOT CHECK ENTITLEMENT AND ACTIONS DO. A customer whose trial lapsed must still be
 * able to open the dashboard, read the billing page and pay; locking them out of the screen with
 * the payment button on it is a way to lose a customer who was trying to give you money. What the
 * paywall stops is *spending* — regeneration, publishing, anything that costs us Opus tokens — and
 * that is what `requireEntitledSite` gates.
 */

/* ── Who is signed in ────────────────────────────────────────────────────────────────────────── */

/** The signed-in user, their session, and the organisations they can act in. */
export interface Viewer {
  readonly session: SessionRow;
  readonly user: UserRow;
  readonly userId: UserId;
  /** The organisation the session acts in. `null` for a user with no membership yet. */
  readonly activeOrgId: OrganisationId | null;
}

/**
 * Loads the viewer, or `null` when nobody is signed in.
 *
 * NON-THROWING ON PURPOSE, so the test suite can assert what it does *before* it has a session:
 * with no cookie it prepares no statement at all, and with a forged cookie it prepares exactly one
 * — the session lookup — and no tenant statement. A helper that only ever threw a redirect could
 * not be asked that question.
 */
export async function loadViewer(
  env: Env,
  request: Request,
  now: Timestamp,
): Promise<Viewer | null> {
  const session = await currentSession(env, request, now);
  if (session === null) {
    return null;
  }
  const user = await cp.users.getUser(env.CP, session.user_id);
  // A live session whose user row is gone (deleted account, failed cascade) is not a viewer. The
  // session is left alone rather than revoked here: revoking on a read path turns a transient D1
  // error into a logout.
  if (user === null || user.status !== 'active') {
    return null;
  }
  return {
    session,
    user,
    userId: session.user_id,
    activeOrgId: session.active_org_id,
  };
}

/**
 * The path a signed-out visitor is sent to, carrying where they were going.
 *
 * `next` is the path only — never a full URL — and it is re-validated by `safeNextPath` in
 * `@aibuilder/auth` before it is stored on a magic-link token or followed. An open redirect on a
 * login page is how a phishing page borrows your domain's credibility.
 */
export function signInRedirect(request: Request): Response {
  const url = new URL(request.url);
  const next = `${url.pathname}${url.search}`;
  const target = next === '/' ? '/inloggen' : `/inloggen?next=${encodeURIComponent(next)}`;
  return redirect(target);
}

/** Loads the viewer or throws the sign-in redirect. The first line of every protected loader. */
export async function requireViewer(env: Env, request: Request, now: Timestamp): Promise<Viewer> {
  const viewer = await loadViewer(env, request, now);
  if (viewer === null) {
    throw signInRedirect(request);
  }
  return viewer;
}

/**
 * Picks the organisation a viewer with no `active_org_id` should act in.
 *
 * Uses `@aibuilder/auth`'s `preferredOrgId` over the same ordered membership read the login path
 * uses, so "the org the header shows" and "the org the session acts in" cannot disagree.
 */
export async function resolveActiveOrg(env: Env, viewer: Viewer): Promise<OrganisationId | null> {
  if (viewer.activeOrgId !== null) {
    return viewer.activeOrgId;
  }
  const memberships = await cp.users.listMembershipsForUser(env.CP, viewer.userId);
  return preferredOrgId(memberships);
}

/* ── Reaching one site ───────────────────────────────────────────────────────────────────────── */

/** A site the viewer is allowed to see, with everything a loader would otherwise re-read. */
export interface SiteAccess {
  readonly siteId: SiteId;
  readonly orgId: OrganisationId;
  readonly orgName: string;
  readonly shardId: number;
  readonly slug: string;
  readonly canonicalHost: string;
  readonly role: MembershipRole;
  readonly entitlement: Entitlement;
  readonly entitlementUntil: number | null;
  readonly indexState: string;
  readonly status: string;
  readonly defaultLocale: string;
  readonly publishedVersionId: string | null;
  readonly orgSuspended: boolean;
  /** The shard binding, resolved from the STORED `shard_id`. Never recomputed. */
  readonly db: D1Database;
}

/** Roles, most to least capable. A route asks for a minimum and gets it or a refusal. */
const ROLE_RANK: Readonly<Record<MembershipRole, number>> = {
  owner: 3,
  admin: 2,
  editor: 1,
  viewer: 0,
};

/** True when `role` is at least `minimum`. */
export function roleAtLeast(role: MembershipRole, minimum: MembershipRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/**
 * Loads one site on behalf of one viewer, or `null`.
 *
 * `null` covers "no such site", "soft-deleted", "the organisation is gone" and — the case this
 * function exists for — "it belongs to somebody else". The caller must not try to tell them apart.
 */
export async function loadSiteAccess(
  env: Env,
  viewer: Viewer,
  siteId: SiteId,
): Promise<SiteAccess | null> {
  const row = await cp.dashboard.getSiteForUser(env.CP, { siteId, userId: viewer.userId });
  if (row === null) {
    return null;
  }
  return {
    siteId: row.id,
    orgId: row.org_id,
    orgName: row.org_name,
    shardId: row.shard_id,
    slug: row.slug,
    canonicalHost: row.canonical_host,
    role: row.role,
    entitlement: row.entitlement,
    entitlementUntil: row.entitlement_until,
    indexState: row.index_state,
    status: row.status,
    defaultLocale: row.default_locale,
    publishedVersionId: row.published_version_id,
    orgSuspended: row.org_status !== 'active',
    // Resolved from the row's own `shard_id`, which is the only correct source: recomputing it
    // would serve one tenant's data out of another tenant's database the moment a second shard
    // exists.
    db: shardById(row.shard_id, env),
  };
}

/**
 * The site-scoped guard: session, membership, role — in one statement after the session read.
 *
 * Throws the sign-in redirect when there is no session, and a bare 404 for everything else. A
 * refusal here is never a 403 with a message, because the message would be the oracle.
 */
export async function requireSiteAccess(
  env: Env,
  request: Request,
  siteId: string,
  opts: { readonly minRole: MembershipRole; readonly now: Timestamp },
): Promise<{ readonly viewer: Viewer; readonly site: SiteAccess }> {
  const viewer = await requireViewer(env, request, opts.now);
  // The id shape is checked before it reaches a bound parameter. Not for injection — the statement
  // is prepared and bound — but so that a malformed id is a 404 rather than a query.
  if (!/^ste_[0-9A-HJKMNP-TV-Z]{26}$/u.test(siteId)) {
    throw notFound();
  }
  const site = await loadSiteAccess(env, viewer, siteId as SiteId);
  if (site === null || !roleAtLeast(site.role, opts.minRole)) {
    throw notFound();
  }
  return { viewer, site };
}

/** Everything a paid action needs, or a refusal the UI can render honestly. */
export type EntitlementRefusal = 'org_suspended' | 'not_entitled' | 'entitlement_lapsed';

/**
 * The paywall, for actions that spend.
 *
 * Deliberately NOT a thrown response: an editor whose save is refused should render the paywall
 * inline with the customer's work still on screen, not navigate away from it. The one exception is
 * a suspended organisation, which is an account-level state the UI has a page for.
 *
 * `entitlement_until < now` fails as `entitlement_lapsed` even when the column still says
 * `trialing`. Webhooks can be lost; a deadline that is never checked is not a deadline, and the
 * nightly reconciliation runs on its own schedule.
 */
export function checkEntitlement(site: SiteAccess, now: Timestamp): EntitlementRefusal | null {
  if (site.orgSuspended) {
    return 'org_suspended';
  }
  if (site.entitlement !== 'trialing' && site.entitlement !== 'active') {
    return 'not_entitled';
  }
  if (site.entitlementUntil !== null && site.entitlementUntil < now) {
    return 'entitlement_lapsed';
  }
  return null;
}

/** A bare 404. No body worth reading, because there is nothing safe to say. */
export function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}
