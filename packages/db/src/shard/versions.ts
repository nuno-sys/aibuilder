import { assertSingleChange, changedOne } from '../batch';
import { toArrayBuffer } from '../bytes';
import type {
  GenerationJobId,
  LocaleCode,
  NavGroup,
  OrganisationId,
  PageId,
  PageRole,
  PageRow,
  PageSlugAliasId,
  PageSlugAliasRow,
  PageTranslationId,
  PageTranslationRow,
  QualityState,
  SiteId,
  SiteLocaleRow,
  SiteVersionId,
  SiteVersionRow,
  SlugAliasReason,
  Timestamp,
  TranslationStatus,
  VersionOrigin,
  VersionStatus,
} from '../types';

/**
 * Statements over `site_versions`, `site_locales`, `pages`, `page_translations` and
 * `page_slug_aliases` on a shard.
 *
 * NONE of these is on the tenant read path. Architecture §3a: a visitor's request is KV -> Cache ->
 * R2 and never touches D1. These rows exist so the publish pipeline, the sitemap builder, the
 * hreflang cluster builder and the editor can filter, sort and join — which is exactly the set of
 * things R2 cannot do.
 *
 * Two invariants are enforced by the database and therefore absent from this file: a translation
 * cannot attach to a page in another version (composite foreign key), and nothing can be written to
 * a sealed version (the triggers in `migrations/shard/0006_triggers.sql`). Both surface here as an
 * exception from `run()`, which is the correct outcome — a caller cannot forget a constraint.
 */

/** Creates a version. Draft and unsealed; `sealVersion` freezes it at publish. */
export const SQL_INSERT_SITE_VERSION = `
INSERT INTO site_versions (id, site_id, org_id, version_no, parent_version_id, origin,
                           generation_job_id, status, label, schema_version, created_by,
                           created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'draft', ?8, ?9, ?10, ?11, ?11)
`;

/**
 * Inserts a version.
 *
 * `version_no` is supplied by the caller from `getNextVersionNo()` rather than computed in SQL:
 * `uq_site_versions_no` makes a race a failed insert rather than a duplicate, and the caller
 * retries with a fresh number. A `max(version_no)+1` subquery inside the INSERT would look atomic
 * and would not be.
 */
export async function insertSiteVersion(
  db: D1Database,
  args: {
    readonly id: SiteVersionId;
    readonly siteId: SiteId;
    readonly orgId: OrganisationId;
    readonly versionNo: number;
    readonly parentVersionId: SiteVersionId | null;
    readonly origin: VersionOrigin;
    readonly generationJobId: GenerationJobId | null;
    readonly label: string | null;
    readonly schemaVersion: number;
    readonly createdBy: string | null;
    readonly now: Timestamp;
  },
): Promise<void> {
  const result = await db
    .prepare(SQL_INSERT_SITE_VERSION)
    .bind(
      args.id,
      args.siteId,
      args.orgId,
      args.versionNo,
      args.parentVersionId,
      args.origin,
      args.generationJobId,
      args.label,
      args.schemaVersion,
      args.createdBy,
      args.now,
    )
    .run();
  assertSingleChange(result.meta, 'insertSiteVersion');
}

/** The next free version number for a site: one reverse seek on `uq_site_versions_no`. */
export const SQL_GET_NEXT_VERSION_NO = `
SELECT coalesce(max(version_no), 0) + 1 AS next_no FROM site_versions WHERE site_id = ?1
`;

/** Reads the next version number. A concurrent insert makes this stale; the UNIQUE index catches it. */
export async function getNextVersionNo(db: D1Database, siteId: SiteId): Promise<number> {
  const row = await db.prepare(SQL_GET_NEXT_VERSION_NO).bind(siteId).first<{ next_no: number }>();
  return row?.next_no ?? 1;
}

/** One version by id. */
export const SQL_GET_SITE_VERSION = `
SELECT * FROM site_versions WHERE id = ?1
`;

/** Reads a version. */
export async function getSiteVersion(
  db: D1Database,
  versionId: SiteVersionId,
): Promise<SiteVersionRow | null> {
  return db.prepare(SQL_GET_SITE_VERSION).bind(versionId).first<SiteVersionRow>();
}

/** The newest version of a site, whatever its status. */
export const SQL_GET_LATEST_VERSION = `
SELECT * FROM site_versions WHERE site_id = ?1 ORDER BY version_no DESC LIMIT 1
`;

/** Reads the newest version of a site. */
export async function getLatestVersion(
  db: D1Database,
  siteId: SiteId,
): Promise<SiteVersionRow | null> {
  return db.prepare(SQL_GET_LATEST_VERSION).bind(siteId).first<SiteVersionRow>();
}

/** The version history a rollback picks from. */
export const SQL_LIST_VERSION_HISTORY = `
SELECT * FROM site_versions WHERE site_id = ?1 ORDER BY created_at DESC LIMIT ?2
`;

/** Lists a site's versions, newest first. */
export async function listVersionHistory(
  db: D1Database,
  args: { readonly siteId: SiteId; readonly limit: number },
): Promise<readonly SiteVersionRow[]> {
  const result = await db
    .prepare(SQL_LIST_VERSION_HISTORY)
    .bind(args.siteId, args.limit)
    .all<SiteVersionRow>();
  return result.results;
}

/** Records the built SiteDoc against an unsealed version. */
export const SQL_SET_VERSION_MANIFEST = `
UPDATE site_versions
SET manifest_sha256 = ?2, manifest_bytes = ?3, theme_tokens = ?4, features = ?5,
    status = 'ready', updated_at = ?6
WHERE id = ?1 AND sealed_at IS NULL
`;

/**
 * Attaches the manifest to a version.
 *
 * `AND sealed_at IS NULL` duplicates what `trg_site_versions_frozen` already refuses, on purpose:
 * the trigger raises, this returns false, and a publish retry that finds the version already sealed
 * is a no-op rather than a 500.
 */
export async function setVersionManifest(
  db: D1Database,
  args: {
    readonly versionId: SiteVersionId;
    readonly manifestSha256: Uint8Array;
    readonly manifestBytes: number;
    readonly themeTokens: string | null;
    readonly features: string | null;
    readonly now: Timestamp;
  },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_SET_VERSION_MANIFEST)
    .bind(
      args.versionId,
      toArrayBuffer(args.manifestSha256),
      args.manifestBytes,
      args.themeTokens,
      args.features,
      args.now,
    )
    .run();
  return changedOne(result.meta);
}

/**
 * Seals and publishes a version.
 *
 * After this, every content column on the version and every page under it is frozen. Undo,
 * rollback and regenerate all fork a NEW version; nothing ever edits a published one, which is what
 * makes "the live version serves untouched throughout a regeneration" true.
 */
export const SQL_SEAL_VERSION = `
UPDATE site_versions
SET sealed_at = ?2, status = 'published', bundle_sha256 = ?3, bundle_bytes = ?4, updated_at = ?2
WHERE id = ?1 AND sealed_at IS NULL AND manifest_sha256 IS NOT NULL
`;

/** Seals a version. Returns false when it was already sealed or has no manifest. */
export async function sealVersion(
  db: D1Database,
  args: {
    readonly versionId: SiteVersionId;
    readonly bundleSha256: Uint8Array | null;
    readonly bundleBytes: number | null;
    readonly now: Timestamp;
  },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_SEAL_VERSION)
    .bind(
      args.versionId,
      args.now,
      args.bundleSha256 === null ? null : toArrayBuffer(args.bundleSha256),
      args.bundleBytes,
    )
    .run();
  return changedOne(result.meta);
}

/** Moves a version's lifecycle status. Legal on a sealed row; content stays frozen. */
export const SQL_SET_VERSION_STATUS = `
UPDATE site_versions SET status = ?2, updated_at = ?3 WHERE id = ?1
`;

/** Sets a version's status — `archived` on rollback, `failed` on a dead run. */
export async function setVersionStatus(
  db: D1Database,
  args: {
    readonly versionId: SiteVersionId;
    readonly status: VersionStatus;
    readonly now: Timestamp;
  },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_SET_VERSION_STATUS)
    .bind(args.versionId, args.status, args.now)
    .run();
  return changedOne(result.meta);
}

/** Records the quality gate's verdict. WARN-only in Phase 1 (architecture §10 risk 3). */
export const SQL_SET_VERSION_QUALITY = `
UPDATE site_versions SET quality_state = ?2, quality_report = ?3, updated_at = ?4 WHERE id = ?1
`;

/** Writes the quality gate verdict. Allowed on a sealed version: it is a lifecycle column. */
export async function setVersionQuality(
  db: D1Database,
  args: {
    readonly versionId: SiteVersionId;
    readonly state: QualityState;
    readonly report: string | null;
    readonly now: Timestamp;
  },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_SET_VERSION_QUALITY)
    .bind(args.versionId, args.state, args.report, args.now)
    .run();
  return changedOne(result.meta);
}

/**
 * Unseals an ARCHIVED version so the purge job can delete it.
 *
 * The only legal unseal, and `trg_site_versions_unseal` enforces that. Retirement is therefore
 * always: archive (a legal transition on a sealed row) -> unseal -> delete, and each step is
 * separately auditable. Deleting a sealed published version would silently unpublish a paying
 * customer's site through `sites.published_version_id ON DELETE SET NULL` and free all of its blobs
 * for garbage collection.
 */
export const SQL_UNSEAL_ARCHIVED_VERSION = `
UPDATE site_versions SET sealed_at = NULL, status = 'archived', updated_at = ?2
WHERE id = ?1 AND status = 'archived' AND sealed_at IS NOT NULL
`;

/** Unseals an archived version. Returns false unless it is archived and sealed. */
export async function unsealArchivedVersion(
  db: D1Database,
  args: { readonly versionId: SiteVersionId; readonly now: Timestamp },
): Promise<boolean> {
  const result = await db.prepare(SQL_UNSEAL_ARCHIVED_VERSION).bind(args.versionId, args.now).run();
  return changedOne(result.meta);
}

/**
 * Deletes an unsealed version, cascading to its pages and translations.
 *
 * The cascade fires the blob refcount triggers, so every page tree this version referenced drops to
 * its true refcount and becomes eligible for the two-phase reaper.
 */
export const SQL_DELETE_UNSEALED_VERSION = `
DELETE FROM site_versions WHERE id = ?1 AND sealed_at IS NULL
`;

/** Deletes an unsealed version. Returns false if it is still sealed. */
export async function deleteUnsealedVersion(
  db: D1Database,
  versionId: SiteVersionId,
): Promise<boolean> {
  const result = await db.prepare(SQL_DELETE_UNSEALED_VERSION).bind(versionId).run();
  return changedOne(result.meta);
}

// ---------------------------------------------------------------------------------------------
// Locales
// ---------------------------------------------------------------------------------------------

/** Adds or updates a published locale for a site. */
export const SQL_UPSERT_SITE_LOCALE = `
INSERT INTO site_locales (site_id, locale, url_segment, is_default, is_enabled,
                          translation_status, sort_order, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
ON CONFLICT(site_id, locale) DO UPDATE SET
  url_segment        = excluded.url_segment,
  is_default         = excluded.is_default,
  is_enabled         = excluded.is_enabled,
  translation_status = excluded.translation_status,
  sort_order         = excluded.sort_order,
  updated_at         = excluded.updated_at
`;

/**
 * Upserts a site locale.
 *
 * `uq_site_locales_default` guarantees exactly one `x-default` per site, so promoting a new default
 * must demote the old one in the SAME batch — an hreflang cluster with two x-default entries is
 * silently dropped by Google, and the database refuses to let it exist here.
 */
export async function upsertSiteLocale(
  db: D1Database,
  args: {
    readonly siteId: SiteId;
    readonly locale: LocaleCode;
    readonly urlSegment: string;
    readonly isDefault: 0 | 1;
    readonly isEnabled: 0 | 1;
    readonly translationStatus: TranslationStatus;
    readonly sortOrder: number;
    readonly now: Timestamp;
  },
): Promise<void> {
  const result = await db
    .prepare(SQL_UPSERT_SITE_LOCALE)
    .bind(
      args.siteId,
      args.locale,
      args.urlSegment,
      args.isDefault,
      args.isEnabled,
      args.translationStatus,
      args.sortOrder,
      args.now,
    )
    .run();
  assertSingleChange(result.meta, 'upsertSiteLocale');
}

/** The locales a site publishes, in display order. */
export const SQL_LIST_SITE_LOCALES = `
SELECT * FROM site_locales WHERE site_id = ?1 AND is_enabled = 1 ORDER BY sort_order, locale
`;

/** Lists a site's enabled locales. */
export async function listSiteLocales(
  db: D1Database,
  siteId: SiteId,
): Promise<readonly SiteLocaleRow[]> {
  const result = await db.prepare(SQL_LIST_SITE_LOCALES).bind(siteId).all<SiteLocaleRow>();
  return result.results;
}

// ---------------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------------

/** Creates a page in an unsealed version. */
export const SQL_INSERT_PAGE = `
INSERT INTO pages (id, site_version_id, site_id, page_key, role, template, nav_group,
                   sort_order, is_indexable, sitemap_priority, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
`;

/**
 * Builds a page insert.
 *
 * Returned as a statement because publish writes the whole page set in one `batch()`. D1 caps a
 * query at 100 bound parameters — a 12-column insert would cap at eight rows in a multi-row VALUES
 * — so bulk writes are always a batch of single-row statements, never one big statement.
 */
export function insertPageStatement(
  db: D1Database,
  args: {
    readonly id: PageId;
    readonly siteVersionId: SiteVersionId;
    readonly siteId: SiteId;
    readonly pageKey: string;
    readonly role: PageRole;
    readonly template: string;
    readonly navGroup: NavGroup;
    readonly sortOrder: number;
    readonly isIndexable: 0 | 1;
    readonly sitemapPriority: number;
    readonly now: Timestamp;
  },
): D1PreparedStatement {
  return db
    .prepare(SQL_INSERT_PAGE)
    .bind(
      args.id,
      args.siteVersionId,
      args.siteId,
      args.pageKey,
      args.role,
      args.template,
      args.navGroup,
      args.sortOrder,
      args.isIndexable,
      args.sitemapPriority,
      args.now,
    );
}

/** Every page of a version, in nav order. Serves the editor and the nav builder from one index. */
export const SQL_LIST_PAGES_FOR_VERSION = `
SELECT * FROM pages WHERE site_version_id = ?1 ORDER BY sort_order, page_key
`;

/** Lists a version's pages. */
export async function listPagesForVersion(
  db: D1Database,
  versionId: SiteVersionId,
): Promise<readonly PageRow[]> {
  const result = await db.prepare(SQL_LIST_PAGES_FOR_VERSION).bind(versionId).all<PageRow>();
  return result.results;
}

/** Creates a page translation. The component tree is already in R2 at `content_sha256`. */
export const SQL_INSERT_PAGE_TRANSLATION = `
INSERT INTO page_translations (id, page_id, site_version_id, locale, path, slug, title,
                               meta_description, og_media_id, jsonld, content_sha256,
                               content_bytes, render_sha256, content_changed_at,
                               translation_source, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)
`;

/**
 * Builds a page-translation insert.
 *
 * The insert fires `trg_blob_ref_page_ins`, which increments the blob's refcount and resurrects it
 * if the reaper had tombstoned it. That is why a publish never needs to check whether an R2 object
 * still exists: the refcount is maintained by the database, not by the writer.
 */
export function insertPageTranslationStatement(
  db: D1Database,
  args: {
    readonly id: PageTranslationId;
    readonly pageId: PageId;
    readonly siteVersionId: SiteVersionId;
    readonly locale: LocaleCode;
    readonly path: string;
    readonly slug: string;
    readonly title: string;
    readonly metaDescription: string | null;
    readonly ogMediaId: string | null;
    readonly jsonld: string | null;
    readonly contentSha256: Uint8Array;
    readonly contentBytes: number;
    readonly renderSha256: Uint8Array | null;
    readonly contentChangedAt: Timestamp;
    readonly translationSource: 'ai' | 'human' | 'machine' | 'copied';
    readonly now: Timestamp;
  },
): D1PreparedStatement {
  return db
    .prepare(SQL_INSERT_PAGE_TRANSLATION)
    .bind(
      args.id,
      args.pageId,
      args.siteVersionId,
      args.locale,
      args.path,
      args.slug,
      args.title,
      args.metaDescription,
      args.ogMediaId,
      args.jsonld,
      toArrayBuffer(args.contentSha256),
      args.contentBytes,
      args.renderSha256 === null ? null : toArrayBuffer(args.renderSha256),
      args.contentChangedAt,
      args.translationSource,
      args.now,
    );
}

/** The single-page lookup: a UNIQUE seek on (version, path), cheaper than any covering index. */
export const SQL_GET_PAGE_TRANSLATION_BY_PATH = `
SELECT * FROM page_translations WHERE site_version_id = ?1 AND path = ?2
`;

/** Reads one page translation by version and path. */
export async function getPageTranslationByPath(
  db: D1Database,
  args: { readonly versionId: SiteVersionId; readonly path: string },
): Promise<PageTranslationRow | null> {
  return db
    .prepare(SQL_GET_PAGE_TRANSLATION_BY_PATH)
    .bind(args.versionId, args.path)
    .first<PageTranslationRow>();
}

/** One row of the per-locale sitemap. */
export interface SitemapEntry {
  readonly path: string;
  readonly page_id: PageId;
  readonly locale: LocaleCode;
  readonly content_changed_at: Timestamp;
  readonly sitemap_priority: number;
  readonly is_indexable: 0 | 1;
}

/**
 * The sitemap urlset for one locale.
 *
 * `content_changed_at` moves only when `render_sha256` moves — the canonical semantic projection of
 * the rendered page, not the row's `updated_at`. A rebuild that produces an identical page
 * therefore does not lie to Google about `lastmod`, which is what stops a site being demoted for
 * claiming daily freshness it does not have.
 */
export const SQL_LIST_SITEMAP_ENTRIES = `
SELECT t.path, t.page_id, t.locale, t.content_changed_at, p.sitemap_priority, p.is_indexable
FROM page_translations t
JOIN pages p ON p.id = t.page_id AND p.site_version_id = t.site_version_id
WHERE t.site_version_id = ?1 AND t.locale = ?2
ORDER BY t.path
`;

/** Lists the sitemap entries of one version and locale. */
export async function listSitemapEntries(
  db: D1Database,
  args: { readonly versionId: SiteVersionId; readonly locale: LocaleCode },
): Promise<readonly SitemapEntry[]> {
  const result = await db
    .prepare(SQL_LIST_SITEMAP_ENTRIES)
    .bind(args.versionId, args.locale)
    .all<SitemapEntry>();
  return result.results;
}

/**
 * Every sibling locale of one page.
 *
 * The hreflang cluster builder OMITS a locale that has no row; it never substitutes another. A
 * cluster that points `hreflang="de"` at a Dutch page is worse than no cluster at all.
 */
export const SQL_LIST_HREFLANG_CLUSTER = `
SELECT page_id, locale, path FROM page_translations WHERE page_id = ?1 ORDER BY locale
`;

/** Lists a page's translations, for the hreflang cluster. Covering. */
export async function listHreflangCluster(
  db: D1Database,
  pageId: PageId,
): Promise<readonly Pick<PageTranslationRow, 'page_id' | 'locale' | 'path'>[]> {
  const result = await db
    .prepare(SQL_LIST_HREFLANG_CLUSTER)
    .bind(pageId)
    .all<Pick<PageTranslationRow, 'page_id' | 'locale' | 'path'>>();
  return result.results;
}

/**
 * The slug this page already has in this locale, from the currently published version.
 *
 * This is what makes "the stored slug wins on regeneration" implementable: the join is on
 * `page_key`, which is stable across regenerations by design, so a regenerated page inherits the URL
 * its backlinks and its `content_changed_at` history already point at instead of inventing a new
 * one and orphaning both.
 */
export const SQL_GET_PUBLISHED_SLUG_FOR_PAGE_KEY = `
SELECT t.slug, t.path
FROM pages p
JOIN page_translations t ON t.page_id = p.id AND t.site_version_id = p.site_version_id
WHERE p.site_version_id = ?1 AND p.page_key = ?2 AND t.locale = ?3
`;

/** Reads the published slug and path for a (page_key, locale) in a given version. */
export async function getPublishedSlugForPageKey(
  db: D1Database,
  args: {
    readonly publishedVersionId: SiteVersionId;
    readonly pageKey: string;
    readonly locale: LocaleCode;
  },
): Promise<{ readonly slug: string; readonly path: string } | null> {
  return db
    .prepare(SQL_GET_PUBLISHED_SLUG_FOR_PAGE_KEY)
    .bind(args.publishedVersionId, args.pageKey, args.locale)
    .first<{ slug: string; path: string }>();
}

// ---------------------------------------------------------------------------------------------
// Slug aliases
// ---------------------------------------------------------------------------------------------

/** Retires a path. Site-scoped, not version-scoped: a 301 must outlive the version that made it. */
export const SQL_INSERT_SLUG_ALIAS = `
INSERT INTO page_slug_aliases (id, site_id, page_key, locale, old_path, new_path, reason, created_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
ON CONFLICT(site_id, old_path) DO UPDATE SET
  new_path   = excluded.new_path,
  reason     = excluded.reason,
  created_at = excluded.created_at
`;

/**
 * Upserts a retired path.
 *
 * The conflict clause is how chains are collapsed: when B is later retired to C, every alias whose
 * destination was B is rewritten to C in the same batch, so a redirect is always one hop. Google
 * stops following after five, and each hop is a round trip the visitor pays for.
 */
export async function upsertSlugAlias(
  db: D1Database,
  args: {
    readonly id: PageSlugAliasId;
    readonly siteId: SiteId;
    readonly pageKey: string;
    readonly locale: LocaleCode;
    readonly oldPath: string;
    readonly newPath: string;
    readonly reason: SlugAliasReason;
    readonly now: Timestamp;
  },
): Promise<void> {
  const result = await db
    .prepare(SQL_INSERT_SLUG_ALIAS)
    .bind(
      args.id,
      args.siteId,
      args.pageKey,
      args.locale,
      args.oldPath,
      args.newPath,
      args.reason,
      args.now,
    )
    .run();
  assertSingleChange(result.meta, 'upsertSlugAlias');
}

/** Resolves a retired path to its current destination. */
export const SQL_RESOLVE_SLUG_ALIAS = `
SELECT * FROM page_slug_aliases WHERE site_id = ?1 AND old_path = ?2
`;

/** Reads the 301 destination for a retired path, or `null` for a genuine 404. */
export async function resolveSlugAlias(
  db: D1Database,
  args: { readonly siteId: SiteId; readonly oldPath: string },
): Promise<PageSlugAliasRow | null> {
  return db
    .prepare(SQL_RESOLVE_SLUG_ALIAS)
    .bind(args.siteId, args.oldPath)
    .first<PageSlugAliasRow>();
}

/** Every alias of a site, for the redirect map the publish step materialises to R2. */
export const SQL_LIST_SLUG_ALIASES = `
SELECT * FROM page_slug_aliases WHERE site_id = ?1 ORDER BY old_path
`;

/** Lists a site's retired paths. */
export async function listSlugAliases(
  db: D1Database,
  siteId: SiteId,
): Promise<readonly PageSlugAliasRow[]> {
  const result = await db.prepare(SQL_LIST_SLUG_ALIASES).bind(siteId).all<PageSlugAliasRow>();
  return result.results;
}
