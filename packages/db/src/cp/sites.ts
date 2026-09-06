import { assertSingleChange, changedOne } from '../batch';
import type {
  IndexState,
  LocaleCode,
  OrganisationId,
  ShardId,
  SiteId,
  SiteRow,
  SiteStatus,
  SiteVersionId,
  Timestamp,
} from '../types';

/**
 * Statements over `sites` and `custom_domains`.
 *
 * EVERY read goes through the `live_sites` / `live_domains` views. Architecture §5.4 adopted this:
 * a partial index on `WHERE deleted_at IS NULL` is unusable unless the query text repeats the
 * predicate verbatim, and leaving that to the query author's memory is how the same schema shipped
 * with a full table SCAN on the hottest lookup it had. The predicate is in the view; the CI
 * EXPLAIN QUERY PLAN gate catches anything that gets past it.
 */

/**
 * Creates the routing identity for a generated site.
 *
 * `canonical_host` is passed in rather than composed here: it is `<slug>.${SITES_ROOT_DOMAIN}` in
 * Phase 1 and `www.<customer-domain>` once a custom hostname is verified, and `SITES_ROOT_DOMAIN`
 * is a Worker var, never a constant in a library.
 *
 * Three triggers fire on this insert: reserved-slug enforcement, shard-consistency against the
 * organisation, and nothing else — the `uq_sites_slug_total` index does the rest.
 */
export const SQL_INSERT_SITE = `
INSERT INTO sites (id, org_id, shard_id, slug, status, default_locale, canonical_host,
                   index_state, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'noindex', ?8, ?8)
`;

/**
 * Inserts a site.
 *
 * `index_state` starts at `noindex` unconditionally (architecture §3b step 7): publishing a real
 * third party's verified name, address and hours to an indexable URL before any e-mail verification
 * is an impersonation and a GDPR problem, and one header solves it.
 */
export async function insertSite(
  db: D1Database,
  args: {
    readonly id: SiteId;
    readonly orgId: OrganisationId;
    readonly shardId: ShardId;
    readonly slug: string;
    readonly status: SiteStatus;
    readonly defaultLocale: LocaleCode;
    readonly canonicalHost: string;
    readonly now: Timestamp;
  },
): Promise<void> {
  const result = await db
    .prepare(SQL_INSERT_SITE)
    .bind(
      args.id,
      args.orgId,
      args.shardId,
      args.slug,
      args.status,
      args.defaultLocale,
      args.canonicalHost,
      args.now,
    )
    .run();
  assertSingleChange(result.meta, 'insertSite');
}

/** One live site by id. */
export const SQL_GET_LIVE_SITE = `
SELECT * FROM live_sites WHERE id = ?1
`;

/** Reads a live site by id. */
export async function getLiveSite(db: D1Database, siteId: SiteId): Promise<SiteRow | null> {
  return db.prepare(SQL_GET_LIVE_SITE).bind(siteId).first<SiteRow>();
}

/** Host resolution for `<slug>.${SITES_ROOT_DOMAIN}`. */
export const SQL_GET_LIVE_SITE_BY_SLUG = `
SELECT * FROM live_sites WHERE slug = ?1
`;

/**
 * Reads a live site by slug.
 *
 * Used to BUILD the KV routing manifest, never to serve a request: the renderer resolves a host
 * from KV and never touches D1 on the tenant read path (architecture §3a).
 */
export async function getLiveSiteBySlug(db: D1Database, slug: string): Promise<SiteRow | null> {
  return db.prepare(SQL_GET_LIVE_SITE_BY_SLUG).bind(slug).first<SiteRow>();
}

/** Host resolution for a verified custom hostname. */
export const SQL_GET_LIVE_SITE_BY_HOSTNAME = `
SELECT s.*
FROM live_domains d
JOIN live_sites s ON s.id = d.site_id
WHERE d.hostname = ?1 AND d.status = 'active'
`;

/**
 * Reads the live site a verified custom hostname belongs to.
 *
 * `status = 'active'` is stated here rather than folded into `live_domains`, because a pending
 * domain is still a live row the dashboard must show — the view encapsulates soft delete only.
 */
export async function getLiveSiteByHostname(
  db: D1Database,
  hostname: string,
): Promise<SiteRow | null> {
  return db.prepare(SQL_GET_LIVE_SITE_BY_HOSTNAME).bind(hostname).first<SiteRow>();
}

/** Every live site of an organisation, newest first. */
export const SQL_LIST_LIVE_SITES_FOR_ORG = `
SELECT * FROM live_sites WHERE org_id = ?1 ORDER BY created_at DESC LIMIT ?2
`;

/** Lists an organisation's live sites. */
export async function listLiveSitesForOrg(
  db: D1Database,
  args: { readonly orgId: OrganisationId; readonly limit: number },
): Promise<readonly SiteRow[]> {
  const result = await db
    .prepare(SQL_LIST_LIVE_SITES_FOR_ORG)
    .bind(args.orgId, args.limit)
    .all<SiteRow>();
  return result.results;
}

/**
 * Publishes: points the site at a version and stamps the publish time.
 *
 * The version lives on the SHARD, so there is no foreign key to enforce that it exists or that it
 * belongs to this site. `WHERE org_id = ?2` is therefore not decoration: it is the authorisation
 * predicate, carried in the statement so no caller can forget it. Publish order is R2, then the
 * shard projection, then this row, then the KV pointer LAST.
 */
export const SQL_SET_PUBLISHED_VERSION = `
UPDATE sites
SET published_version_id = ?3, published_at = ?4, status = 'published', updated_at = ?4
WHERE id = ?1 AND org_id = ?2 AND deleted_at IS NULL
`;

/** Points a site at its newly published version. Returns false when the site is gone. */
export async function setPublishedVersion(
  db: D1Database,
  args: {
    readonly siteId: SiteId;
    readonly orgId: OrganisationId;
    readonly versionId: SiteVersionId;
    readonly now: Timestamp;
  },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_SET_PUBLISHED_VERSION)
    .bind(args.siteId, args.orgId, args.versionId, args.now)
    .run();
  return changedOne(result.meta);
}

/** Moves a site's lifecycle status without touching its version pointer. */
export const SQL_SET_SITE_STATUS = `
UPDATE sites SET status = ?2, updated_at = ?3 WHERE id = ?1 AND deleted_at IS NULL
`;

/** Sets a site's status. */
export async function setSiteStatus(
  db: D1Database,
  args: { readonly siteId: SiteId; readonly status: SiteStatus; readonly now: Timestamp },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_SET_SITE_STATUS)
    .bind(args.siteId, args.status, args.now)
    .run();
  return changedOne(result.meta);
}

/**
 * Sets indexability.
 *
 * `eligible` on claim, `indexable` once card-on-file AND a passing quality gate (§7.26), and `gone`
 * as the per-tenant kill switch that makes the renderer answer 410. Every one of those is a
 * deliberate, auditable transition, which is why there is no generic "update site" statement.
 */
export const SQL_SET_INDEX_STATE = `
UPDATE sites SET index_state = ?2, updated_at = ?3 WHERE id = ?1 AND deleted_at IS NULL
`;

/** Sets a site's index state. */
export async function setIndexState(
  db: D1Database,
  args: { readonly siteId: SiteId; readonly indexState: IndexState; readonly now: Timestamp },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_SET_INDEX_STATE)
    .bind(args.siteId, args.indexState, args.now)
    .run();
  return changedOne(result.meta);
}

/**
 * Soft-deletes a site.
 *
 * `trg_sites_retire_slug` fires on this update and copies the slug into `reserved_slugs` with
 * reason `retired`, so the label can never be handed to another tenant even after the row is
 * eventually hard-deleted — its 301s and backlinks outlive it.
 */
export const SQL_SOFT_DELETE_SITE = `
UPDATE sites SET deleted_at = ?2, status = 'deleted', updated_at = ?2
WHERE id = ?1 AND deleted_at IS NULL
`;

/** Soft-deletes a site and retires its slug. */
export async function softDeleteSite(
  db: D1Database,
  args: { readonly siteId: SiteId; readonly now: Timestamp },
): Promise<boolean> {
  const result = await db.prepare(SQL_SOFT_DELETE_SITE).bind(args.siteId, args.now).run();
  return changedOne(result.meta);
}

/** One row of the KV routing manifest. */
export interface RoutingManifestRow {
  readonly id: SiteId;
  readonly shard_id: ShardId;
  readonly slug: string;
  readonly canonical_host: string;
  readonly published_version_id: SiteVersionId;
  readonly index_state: IndexState;
  readonly default_locale: LocaleCode;
}

/**
 * Every published site, for the KV routing manifest rebuild.
 *
 * Keyset-paginated on `id` rather than OFFSET: the manifest rebuild walks the whole table and an
 * OFFSET scan re-reads every earlier row on each page, which on the one table that grows with the
 * business is the difference between a cron that finishes and one that does not.
 */
export const SQL_LIST_ROUTING_MANIFEST = `
SELECT id, shard_id, slug, canonical_host, published_version_id, index_state, default_locale
FROM sites
WHERE deleted_at IS NULL AND published_version_id IS NOT NULL AND id > ?1
ORDER BY id
LIMIT ?2
`;

/** Reads one page of the routing manifest, resuming after `afterId`. */
export async function listRoutingManifest(
  db: D1Database,
  args: { readonly afterId: string; readonly limit: number },
): Promise<readonly RoutingManifestRow[]> {
  const result = await db
    .prepare(SQL_LIST_ROUTING_MANIFEST)
    .bind(args.afterId, args.limit)
    .all<RoutingManifestRow>();
  return result.results;
}

/**
 * The exact origins allowed to POST a lead to this site.
 *
 * Architecture §S4: the tenant `Origin` is looked up in this per-site allowlist and echoed only on
 * an exact match. Never `*`, and never a regex — `/mijnsaas\.com$/` matches `evilmijnsaas.com`, and
 * that is a working CSRF against every tenant at once.
 */
export const SQL_LIST_SITE_ORIGINS = `
SELECT canonical_host AS host FROM live_sites WHERE id = ?1
UNION
SELECT hostname AS host FROM live_domains WHERE site_id = ?1 AND status = 'active'
`;

/** Lists the hostnames whose `Origin` this site's lead endpoint may echo. */
export async function listSiteOrigins(db: D1Database, siteId: SiteId): Promise<readonly string[]> {
  const result = await db.prepare(SQL_LIST_SITE_ORIGINS).bind(siteId).all<{ host: string }>();
  return result.results.map((row) => row.host);
}
