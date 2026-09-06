import type {
  CustomDomainRow,
  Entitlement,
  MembershipRole,
  OrgPlan,
  OrganisationId,
  ShardId,
  SiteId,
  SiteRow,
  Timestamp,
  UserId,
} from '../types';

/**
 * The dashboard's relational reads — `apps/app`'s loaders and nothing else.
 *
 * WHY THIS MODULE EXISTS AT ALL, when `cp/sites.ts` already lists an organisation's sites.
 * Because the dashboard asks a different question. Every other reader of `sites` already knows
 * which organisation it is acting for: the publisher was handed one, the renderer resolved one from
 * a host. A loader knows only *who is signed in*, and the answer has to come back already filtered
 * by membership.
 *
 * THE ORG ISOLATION INVARIANT IS IN THE SQL, ON PURPOSE. `getSiteForUser` joins `memberships` and
 * returns a row only when the signed-in user has one. It is deliberately impossible to call it
 * without proving membership, because the alternative — read the site, then check the org, then
 * decide — is the shape of every multi-tenant data leak ever written: two statements, one of which
 * a future refactor forgets. Architecture §5.2 states the invariant ("an organisation with zero
 * memberships is unreachable"); this is the statement that makes it true for the read path, and
 * `apps/app/app/__tests__/org-isolation.test.ts` is the test that proves it stays true.
 *
 * There is deliberately NO `getSite(siteId)` here. Adding one would give a loader an unguarded way
 * to reach a tenant row, and the guarded one is no harder to call.
 *
 * EVERY READ GOES THROUGH `live_sites` / `live_domains`, for the reason `cp/sites.ts` states: a
 * partial index on `deleted_at IS NULL` is unusable unless the query text repeats the predicate
 * verbatim, so the predicate lives in the view and the CI `EXPLAIN QUERY PLAN` gate catches the
 * statement that got past it.
 *
 * COLUMNS ARE ENUMERATED, never `SELECT *`, on the two statements that join `organisations`.
 * `sites` and `organisations` share `id`, `status`, `created_at` and `updated_at`; `SELECT s.*, o.*`
 * would hand D1's row object two `status` keys and the winner is not specified anywhere we control.
 */

/* ── The site list ───────────────────────────────────────────────────────────────────────────── */

/**
 * One row of the dashboard's site list: the site, the organisation that owns it, and the role the
 * signed-in user holds there.
 *
 * `entitlement` and `entitlement_until` ride along because the list renders a trial countdown, and
 * the alternative is one `getEntitlement` per row.
 */
export interface DashboardSiteRow {
  readonly id: SiteId;
  readonly org_id: OrganisationId;
  readonly org_name: string;
  readonly shard_id: ShardId;
  readonly slug: string;
  readonly status: SiteRow['status'];
  readonly canonical_host: string;
  readonly index_state: SiteRow['index_state'];
  readonly default_locale: string;
  readonly published_version_id: SiteRow['published_version_id'];
  readonly published_at: Timestamp | null;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly role: MembershipRole;
  readonly plan: OrgPlan;
  readonly entitlement: Entitlement;
  readonly entitlement_until: Timestamp | null;
}

/**
 * Every site the signed-in user can reach, newest first.
 *
 * Driven from `memberships`, not from `sites`: `idx_memberships_user (user_id, org_id, role)` is
 * covering, so "which organisations am I in, and as what" never touches that table's b-tree, and
 * the join into `sites` then seeks `idx_sites_org`. Ordering is a temp b-tree over the handful of
 * rows that survive — a sort, not a scan, which is what the EQP gate cares about.
 */
export const SQL_LIST_SITES_FOR_USER = `
SELECT s.id, s.org_id, o.name AS org_name, s.shard_id, s.slug, s.status, s.canonical_host,
       s.index_state, s.default_locale, s.published_version_id, s.published_at,
       s.created_at, s.updated_at,
       m.role, o.plan, o.entitlement, o.entitlement_until
FROM memberships m
JOIN live_sites s    ON s.org_id = m.org_id
JOIN organisations o ON o.id = m.org_id
WHERE m.user_id = ?1 AND o.deleted_at IS NULL
ORDER BY s.created_at DESC
LIMIT ?2
`;

/** Lists every site the user is a member of an organisation for. */
export async function listSitesForUser(
  db: D1Database,
  args: { readonly userId: UserId; readonly limit: number },
): Promise<readonly DashboardSiteRow[]> {
  const result = await db
    .prepare(SQL_LIST_SITES_FOR_USER)
    .bind(args.userId, args.limit)
    .all<DashboardSiteRow>();
  return result.results;
}

/* ── The isolation read ──────────────────────────────────────────────────────────────────────── */

/** One site, plus the membership that authorised reading it. */
export interface UserSiteRow extends DashboardSiteRow {
  readonly org_status: 'active' | 'suspended' | 'deleted';
  readonly provisional: 0 | 1;
}

/**
 * ONE site, if and only if the user is a member of the organisation that owns it.
 *
 * This is the statement `apps/app` opens every site-scoped loader with. A user of organisation A
 * asking for a site of organisation B gets `null` — indistinguishable from a site id that does not
 * exist, which is the point: the loader answers 404 either way and the dashboard never becomes an
 * existence oracle for other tenants' site ids.
 *
 * Two seeks: `sites` by primary key, `memberships` by its own `(org_id, user_id)` primary key.
 * Nothing here scales with the number of tenants.
 */
export const SQL_GET_SITE_FOR_USER = `
SELECT s.id, s.org_id, o.name AS org_name, s.shard_id, s.slug, s.status, s.canonical_host,
       s.index_state, s.default_locale, s.published_version_id, s.published_at,
       s.created_at, s.updated_at,
       m.role, o.plan, o.entitlement, o.entitlement_until,
       o.status AS org_status, o.provisional
FROM live_sites s
JOIN memberships m   ON m.org_id = s.org_id AND m.user_id = ?2
JOIN organisations o ON o.id = s.org_id
WHERE s.id = ?1 AND o.deleted_at IS NULL
`;

/**
 * Reads one site on behalf of one user.
 *
 * Returns `null` when the site does not exist, was soft-deleted, belongs to a deleted organisation,
 * or — the case this function exists for — belongs to an organisation the user is not a member of.
 * The caller must not try to tell those apart.
 */
export async function getSiteForUser(
  db: D1Database,
  args: { readonly siteId: SiteId; readonly userId: UserId },
): Promise<UserSiteRow | null> {
  return db.prepare(SQL_GET_SITE_FOR_USER).bind(args.siteId, args.userId).first<UserSiteRow>();
}

/* ── The organisation switcher ───────────────────────────────────────────────────────────────── */

/** One organisation the user belongs to, with the role and the billing state the header shows. */
export interface UserOrganisationRow {
  readonly org_id: OrganisationId;
  readonly name: string;
  readonly role: MembershipRole;
  readonly plan: OrgPlan;
  readonly entitlement: Entitlement;
  readonly entitlement_until: Timestamp | null;
  readonly status: 'active' | 'suspended' | 'deleted';
  readonly shard_id: ShardId;
  readonly provisional: 0 | 1;
}

/**
 * Every organisation the user belongs to.
 *
 * Ordered by `org_id` rather than by name, because `preferredOrgId()` in `@aibuilder/auth` picks
 * the session's active organisation from `listMembershipsForUser`, which is ordered the same way.
 * Two different orderings would make "the org the header shows" and "the org the session acts in"
 * disagree for a user with two organisations, intermittently, which is the worst kind of bug to
 * chase.
 */
export const SQL_LIST_ORGS_FOR_USER = `
SELECT m.org_id, o.name, m.role, o.plan, o.entitlement, o.entitlement_until, o.status,
       o.shard_id, o.provisional
FROM memberships m
JOIN organisations o ON o.id = m.org_id
WHERE m.user_id = ?1 AND o.deleted_at IS NULL
ORDER BY m.org_id
LIMIT ?2
`;

/** Lists the organisations the user belongs to. */
export async function listOrganisationsForUser(
  db: D1Database,
  args: { readonly userId: UserId; readonly limit: number },
): Promise<readonly UserOrganisationRow[]> {
  const result = await db
    .prepare(SQL_LIST_ORGS_FOR_USER)
    .bind(args.userId, args.limit)
    .all<UserOrganisationRow>();
  return result.results;
}

/* ── The domain page ─────────────────────────────────────────────────────────────────────────── */

/**
 * Every live custom domain attached to a site.
 *
 * Phase 2 has no way to ADD one — Cloudflare for SaaS is Phase 3 — but the read exists now because
 * the domain page has to tell the truth about what is attached rather than assume "nothing". A site
 * migrated in by an operator has rows here on day one.
 *
 * `live_domains` filters soft deletes only; `status = 'active'` is NOT applied, because a pending
 * domain is exactly what that page needs to show.
 */
export const SQL_LIST_DOMAINS_FOR_SITE = `
SELECT * FROM live_domains WHERE site_id = ?1 ORDER BY created_at DESC LIMIT ?2
`;

/** Lists a site's custom domains, verified or not. */
export async function listDomainsForSite(
  db: D1Database,
  args: { readonly siteId: SiteId; readonly limit: number },
): Promise<readonly CustomDomainRow[]> {
  const result = await db
    .prepare(SQL_LIST_DOMAINS_FOR_SITE)
    .bind(args.siteId, args.limit)
    .all<CustomDomainRow>();
  return result.results;
}
