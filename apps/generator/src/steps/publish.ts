import {
  ROUTING_MANIFEST_VERSION,
  assertLocale,
  buildLocaleSitemap,
  buildSitemapIndex,
  changedUrlsFor,
  decideLastmod,
  digestToBytes,
  hreflangCluster,
  isIndexState,
  mintId,
  newestChangedAt,
  publishVersion,
  runQualityGate,
  siteDocKey,
  sitemapIndexKey,
  sitemapKey,
} from '@aibuilder/core';
import type {
  HreflangLink,
  Locale,
  ProjectedPage,
  ProjectedTranslation,
  PublishObject,
  PublishPlan,
  PublishPorts,
  PublishProjection,
  QualityPageInput,
  RetiredPath,
  RoutingManifest,
  SitemapUrl,
} from '@aibuilder/core';
import { cp, shard, shardById } from '@aibuilder/db';
import type { NavGroup, PageRole, SiteId, SiteVersionId } from '@aibuilder/db';
import type { PageDoc, SiteDoc } from '@aibuilder/site-schema';
import { copyFor, deriveSlotInventoryForPages } from '@aibuilder/site-schema';

import type { Env } from '../env';
import { GeneratorError } from '../errors';
import type { RunIds } from '../ids';
import type { RenderResult } from './render';

/**
 * Step 10, `publish` — the SiteDoc into R2, the projection into the shard, the KV pointer LAST.
 *
 * THE ORDERING IS NOT IMPLEMENTED HERE. It lives in `@aibuilder/core`'s `publishVersion()`, which
 * is a pure sequence over injected ports and is unit-tested for exactly the property that matters:
 * nothing that can fail runs after the flip, and a missing rendered object fails the publish rather
 * than serving a site with a hole in it. This file is the composition root — it computes the plan
 * and supplies four adapters over this Worker's bindings. The Phase 2 editor republishes through
 * the same function with its own adapters, which is the reuse the Phase 1 stub promised and the
 * reason the ordering is not inlined into a Workflow step.
 *
 * WHAT THIS STEP ACTUALLY DECIDES, as against what it merely moves:
 *
 *   - **`content_changed_at` per page** (§7.8). The new projection digest is compared against the
 *     currently-published version's, joined on `page_key` — the identity that survives a
 *     regeneration — and the old timestamp is carried forward when they match. That is what stops a
 *     republish claiming freshness it does not have, and it is why the IndexNow ping carries only
 *     the URLs that really changed (§7.10).
 *   - **Retired paths** (§7.6). A path that moved becomes a permanent 301 alias, keyed on the site
 *     rather than the version so the redirect outlives the version that created it.
 *   - **The hreflang clusters in the sitemaps** (§7.4), built under the omit-never-substitute rule.
 *   - **The quality report**, stored and never acted on: the gate is WARN-only until its threshold
 *     is calibrated over 200 fixture sites (§7.27, §10 risk 3).
 */

/**
 * The routing namespace this step writes the pointer to.
 *
 * Declared as an augmentation rather than edited into `src/env.ts` because the binding is a
 * consequence of this step existing: before it, nothing in this Worker had any reason to hold the
 * tenant routing table. The binding must also be added to `apps/generator/wrangler.jsonc` —
 * `{ "binding": "ROUTING", "id": "…" }`, the same namespace `apps/api` and `apps/renderer` bind —
 * and this declaration merges with `Env` the moment it moves there.
 */
/** What a completed publish reports. */
export interface PublishResult {
  readonly versionId: string;
  readonly deploymentId: string;
  readonly pagesWritten: number;
  readonly bytesWritten: number;
  /** `https://<canonicalHost>` — the URL the modal finally shows. */
  readonly siteUrl: string;
}

/* -- The projection ---------------------------------------------------------------------------- */

/** A page's translation as it exists in the currently published version, if it exists at all. */
interface PreviousTranslation {
  readonly path: string;
  readonly renderSha256: string | null;
  readonly contentChangedAt: number;
}

/**
 * Reads what the currently published version knows about one `(page_key, locale)`.
 *
 * Two seeks rather than one, and deliberately: the slug lookup is joined on `page_key`, which is
 * stable across regenerations, and only then is the row fetched by the path it reported. Joining
 * directly on path would report "changed" for every page whose URL moved, which is true but would
 * also lose the alias — and the alias is the thing that keeps the backlinks working.
 */
async function previousTranslation(
  db: D1Database,
  args: {
    readonly publishedVersionId: SiteVersionId | null;
    readonly pageKey: string;
    readonly locale: Locale;
  },
): Promise<PreviousTranslation | null> {
  if (args.publishedVersionId === null) return null;

  const published = await shard.versions.getPublishedSlugForPageKey(db, {
    publishedVersionId: args.publishedVersionId,
    pageKey: args.pageKey,
    locale: args.locale,
  });
  if (published === null) return null;

  const row = await shard.versions.getPageTranslationByPath(db, {
    versionId: args.publishedVersionId,
    path: published.path,
  });
  if (row === null) return null;

  return {
    path: published.path,
    renderSha256: hexOf(row.render_sha256),
    contentChangedAt: row.content_changed_at,
  };
}

/** Lowercase hex of a D1 `BLOB(32)` column, in whichever wire shape the runtime handed back. */
function hexOf(column: unknown): string | null {
  if (column === null || column === undefined) return null;
  const bytes =
    column instanceof ArrayBuffer
      ? new Uint8Array(column)
      : ArrayBuffer.isView(column)
        ? new Uint8Array(column.buffer, column.byteOffset, column.byteLength)
        : Array.isArray(column)
          ? new Uint8Array(column as readonly number[])
          : null;
  if (bytes === null || bytes.length !== 32) return null;
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** Nav placement, derived from the page rather than authored: the model never picks a nav group. */
function navGroupFor(page: PageDoc): NavGroup {
  if (page.showInNav) return 'primary';
  return page.role === 'privacy' || page.role === 'terms' || page.role === 'cookies'
    ? 'footer'
    : 'none';
}

/**
 * Narrows a stored role onto the shard's `CHECK`ed enum.
 *
 * `custom` is the documented escape hatch, and falling back to it is right rather than defensive:
 * widening `pages.role` is a rebuild of a cascade parent, which is forbidden on D1 (§5.4), so a
 * role this schema has never heard of must land somewhere legal rather than fail the batch.
 */
function asPageRole(value: string): PageRole {
  return (PAGE_ROLES as readonly string[]).includes(value) ? (value as PageRole) : 'custom';
}

/** The roles `migrations/shard/0001_versions_pages.sql` accepts. */
const PAGE_ROLES = [
  'home',
  'about',
  'services',
  'menu',
  'gallery',
  'reviews',
  'team',
  'contact',
  'booking',
  'blog_index',
  'privacy',
  'terms',
  'cookies',
  'custom',
] as const;

/**
 * Sitemap priority.
 *
 * Not emitted into the sitemap — §7.7 drops `<priority>` entirely because Google ignores it — but
 * the column exists and the editor's page list sorts on it, so it is filled with something
 * defensible instead of a constant.
 */
function priorityFor(page: PageDoc): number {
  if (page.role === 'home') return 1.0;
  if (page.role === 'privacy' || page.role === 'terms' || page.role === 'cookies') return 0.1;
  return 0.6;
}

/* -- Ports ------------------------------------------------------------------------------------- */

/** Builds the four adapters `publishVersion` needs over this Worker's bindings. */
function portsFor(env: Env, ids: RunIds, db: D1Database): PublishPorts {
  return {
    now: () => Date.now(),

    async putBlob(object: PublishObject): Promise<void> {
      await env.BLOBS.put(object.key, object.body, {
        httpMetadata:
          object.contentEncoding === undefined
            ? { contentType: object.contentType }
            : { contentType: object.contentType, contentEncoding: object.contentEncoding },
        ...(object.customMetadata === undefined
          ? {}
          : { customMetadata: { ...object.customMetadata } }),
      });
    },

    async blobExists(key: string): Promise<boolean> {
      return (await env.BLOBS.head(key)) !== null;
    },

    async isVersionSealed(versionId: string): Promise<boolean> {
      const row = await shard.versions.getSiteVersion(db, versionId as SiteVersionId);
      return row !== null && row.sealed_at !== null;
    },

    async writeProjection(projection: PublishProjection): Promise<void> {
      await writeProjection(db, ids.siteId, projection);
    },

    async setPublishedVersion(args): Promise<void> {
      const moved = await cp.sites.setPublishedVersion(env.CP, {
        siteId: ids.siteId,
        orgId: ids.orgId,
        versionId: args.versionId as SiteVersionId,
        now: args.now,
      });
      if (!moved) {
        throw new GeneratorError('document_invalid', 'The site row is gone or not ours.', {
          detail: ids.siteId,
        });
      }
    },

    async putRoutingPointer(args): Promise<void> {
      await env.ROUTING.put(args.key, args.value);
    },

    async storeQualityReport(args): Promise<void> {
      await shard.versions.setVersionQuality(db, {
        versionId: args.versionId as SiteVersionId,
        state: args.state,
        report: args.report,
        now: Date.now(),
      });
    },

    // `recordDeployment` and `pingIndexNow` are deliberately absent. The `deployments` table exists
    // in `migrations/shard/0004_generation.sql` but `@aibuilder/db` has no statement module for it
    // yet, and `publishVersion` treats both as optional precisely so that a missing audit row can
    // never fail — or worse, retry — a publish whose first action would be the flip again.
  };
}

/**
 * Writes the whole projection and seals the version.
 *
 * IDEMPOTENT, because a Workflow step is retried and a second attempt must not produce a second set
 * of `pages` rows. The check is the page set itself rather than a lock: if this version already has
 * pages, the batch has already committed and only the seal is outstanding. `uq_pages_key` would
 * catch a duplicate anyway, but as a 500 rather than as a resume.
 *
 * The blob upsert leads the batch because `page_translations.content_sha256` is
 * `REFERENCES content_blobs(sha256) ON DELETE RESTRICT` — the row has to exist before anything
 * points at it — and because the insert triggers maintain the refcount that the two-phase reaper
 * later trusts.
 */
async function writeProjection(
  db: D1Database,
  siteId: SiteId,
  projection: PublishProjection,
): Promise<void> {
  const now = Date.now();
  const versionId = projection.versionId as SiteVersionId;
  const existing = await shard.versions.listPagesForVersion(db, versionId);

  if (existing.length === 0) {
    const statements: D1PreparedStatement[] = [
      shard.blobs.upsertContentBlobStatement(db, {
        sha256: projection.manifestSha256,
        bytes: projection.manifestBytes,
        contentType: 'application/json; charset=utf-8',
        encoding: 'identity',
        kind: 'site_doc',
        now,
      }),
    ];

    for (const page of projection.pages) {
      const pageId = mintId('page');
      statements.push(
        shard.versions.insertPageStatement(db, {
          id: pageId,
          siteVersionId: versionId,
          siteId,
          pageKey: page.pageKey,
          role: asPageRole(page.role),
          template: page.template,
          navGroup: asNavGroup(page.navGroup),
          sortOrder: page.sortOrder,
          isIndexable: page.isIndexable ? 1 : 0,
          sitemapPriority: page.sitemapPriority,
          now,
        }),
      );
      for (const translation of page.translations) {
        statements.push(
          shard.versions.insertPageTranslationStatement(db, {
            id: mintId('pageTranslation'),
            pageId,
            siteVersionId: versionId,
            locale: translation.locale,
            path: translation.path,
            slug: translation.slug,
            title: translation.title,
            metaDescription: translation.metaDescription,
            ogMediaId: translation.ogMediaId,
            jsonld: translation.jsonLd,
            contentSha256: translation.contentSha256,
            contentBytes: translation.contentBytes,
            renderSha256: translation.renderSha256,
            contentChangedAt: translation.contentChangedAt,
            translationSource: 'ai',
            now,
          }),
        );
      }
    }

    await db.batch(statements);
  }

  for (const retired of projection.retiredPaths) {
    await shard.versions.upsertSlugAlias(db, {
      id: mintId('pageSlugAlias'),
      siteId,
      pageKey: retired.pageKey,
      locale: retired.locale,
      oldPath: retired.oldPath,
      newPath: retired.newPath,
      reason: 'regeneration',
      now,
    });
  }

  await shard.versions.setVersionManifest(db, {
    versionId,
    manifestSha256: projection.manifestSha256,
    manifestBytes: projection.manifestBytes,
    themeTokens: projection.themeTokens,
    features: null,
    now,
  });

  // `sealVersion` returns false when the version was already sealed, which on a retry is the
  // correct outcome and not an error — `publishVersion` has already decided to resume.
  await shard.versions.sealVersion(db, {
    versionId,
    bundleSha256: null,
    bundleBytes: null,
    now,
  });
}

/* -- The step ---------------------------------------------------------------------------------- */

/**
 * Publishes a version and flips the routing pointer.
 *
 * The site is live at `<slug>.${SITES_ROOT_DOMAIN}` the moment this returns — that is the reveal,
 * and it is the point of the whole product — but it is served `X-Robots-Tag: noindex, nofollow` and
 * `robots.txt: Disallow: /` until `index_state` moves, which happens on payment and claim rather
 * than here (§3b step 7, DECISIONS §D2).
 */
export async function runPublishStep(
  env: Env,
  ids: RunIds,
  input: {
    readonly doc: SiteDoc;
    readonly rendered: RenderResult;
    readonly versionId: string;
    readonly canonicalHost: string;
  },
): Promise<PublishResult> {
  const db = shardById(ids.shardId, env);
  const site = await cp.sites.getLiveSite(env.CP, ids.siteId);
  if (site === null) {
    throw new GeneratorError('document_invalid', 'The site row disappeared before publish.', {
      detail: ids.siteId,
    });
  }

  const now = Date.now();
  const doc = input.doc;
  const siteDocBody = JSON.stringify(doc);
  const siteDocBytes = new TextEncoder().encode(siteDocBody);
  const manifestSha256 = new Uint8Array(await crypto.subtle.digest('SHA-256', siteDocBytes));

  const manifest: RoutingManifest = {
    v: ROUTING_MANIFEST_VERSION,
    siteId: ids.siteId,
    shardId: ids.shardId,
    orgId: ids.orgId,
    liveVersion: input.versionId,
    canonicalHost: input.canonicalHost,
    locales: doc.locales.enabled,
    defaultLocale: doc.locales.default,
    // The renderer reads indexability from the manifest, so it has to be the CURRENT value rather
    // than an assumption: a republish of a claimed, paid site must not push it back to `noindex`.
    indexState: isIndexState(site.index_state) ? site.index_state : 'noindex',
    goneAt: site.index_state === 'gone' ? site.updated_at : null,
    publishedAt: now,
  };

  /* -- Per-page projection, and the lastmod decision ------------------------------------------ */

  const projectedPages: ProjectedPage[] = [];
  const retiredPaths: RetiredPath[] = [];
  /** `pageKey -> locale -> path`, for the sitemap's hreflang clusters. */
  const cluster = new Map<string, Map<Locale, string>>();
  const changedByPath = new Map<string, boolean>();
  const changedAtByPath = new Map<string, number>();

  for (const page of doc.pages) {
    const translations: ProjectedTranslation[] = [];

    for (const locale of doc.locales.enabled) {
      const routing = page.perLocale[locale];
      const rendered = input.rendered.pages.find(
        (candidate) => candidate.pageId === page.pageId && candidate.locale === locale,
      );
      if (routing === undefined || rendered === undefined) continue;

      const previous = await previousTranslation(db, {
        publishedVersionId: site.published_version_id,
        pageKey: page.pageKey,
        locale,
      });

      const lastmod = decideLastmod({
        previous:
          previous === null
            ? null
            : {
                renderSha256: previous.renderSha256,
                contentChangedAt: previous.contentChangedAt,
              },
        renderSha256: rendered.renderSha256,
        now,
      });

      // §7.6: the URL a page had is a permanent 301, forever, keyed on the site rather than the
      // version. Slug STABILITY — the previously published slug winning on regeneration — is the
      // assemble step's job; this is the safety net for the case where it could not.
      if (previous !== null && previous.path !== routing.path) {
        retiredPaths.push({
          pageKey: page.pageKey,
          locale,
          oldPath: previous.path,
          newPath: routing.path,
        });
      }

      translations.push({
        locale,
        path: routing.path,
        slug: routing.slug,
        title: routing.title,
        metaDescription: routing.description.length === 0 ? null : routing.description,
        // The og media reference is a document ref, not a `media_assets.id`; the column is a FK to
        // that table and there is no mapping in the document, so it stays null rather than
        // pointing at a row that may not exist.
        ogMediaId: null,
        jsonLd: rendered.jsonLd,
        contentSha256: manifestSha256,
        contentBytes: siteDocBytes.byteLength,
        renderSha256: digestToBytes(rendered.renderSha256),
        contentChangedAt: lastmod.contentChangedAt,
        changed: lastmod.changed,
      });

      const byLocale = cluster.get(page.pageKey) ?? new Map<Locale, string>();
      byLocale.set(locale, routing.path);
      cluster.set(page.pageKey, byLocale);
      changedByPath.set(routing.path, lastmod.changed);
      changedAtByPath.set(routing.path, lastmod.contentChangedAt);
    }

    if (translations.length === 0) continue;

    projectedPages.push({
      pageKey: page.pageKey,
      role: page.role,
      template: 'default',
      navGroup: navGroupFor(page),
      sortOrder: page.sortOrder,
      isIndexable: !page.noindex,
      sitemapPriority: priorityFor(page),
      translations,
    });
  }

  /* -- Sitemaps -------------------------------------------------------------------------------- */

  const derived: PublishObject[] = [];
  const indexEntries: { readonly locale: Locale; readonly lastmod: number | null }[] = [];

  for (const locale of doc.locales.enabled) {
    const urls: SitemapUrl[] = [];

    for (const projected of projectedPages) {
      // A `noindex` page never appears in a sitemap: the sitemap says "index this" and the page
      // says the opposite, and a crawler that is told both trusts neither (§7.7).
      if (!projected.isIndexable) continue;
      const translation = projected.translations.find((entry) => entry.locale === locale);
      if (translation === undefined) continue;

      const available = [...(cluster.get(projected.pageKey)?.keys() ?? [])];
      urls.push({
        path: translation.path,
        contentChangedAt: translation.contentChangedAt,
        alternates: alternatesFor(manifest, cluster.get(projected.pageKey), available),
      });
    }

    derived.push({
      key: sitemapKey({ siteId: ids.siteId, versionId: input.versionId, locale }),
      body: buildLocaleSitemap({ manifest, urls }),
      // Stored UNCOMPRESSED, whatever the key's `.br` suffix suggests. There is no brotli in a
      // Worker — `CompressionStream` is gzip and deflate only — and the edge compresses XML on the
      // way out exactly as it compresses the HTML (§0). The renderer therefore declares no
      // `Content-Encoding` unless the stored object carries one. The key name is `keys.ts`'s and is
      // listed in this task's handover as a rename.
      contentType: 'application/xml; charset=utf-8',
    });

    indexEntries.push({ locale, lastmod: newestChangedAt([...urls]) });
  }

  derived.push({
    key: sitemapIndexKey({ siteId: ids.siteId, versionId: input.versionId }),
    body: buildSitemapIndex({ manifest, entries: indexEntries }),
    contentType: 'application/xml; charset=utf-8',
  });

  /* -- The plan -------------------------------------------------------------------------------- */

  const renderedKeys = input.rendered.pages.map((page) => page.key);
  if (input.rendered.rootKey !== null) renderedKeys.push(input.rendered.rootKey);

  const deploymentId = mintId('deployment');
  const bytesWritten =
    input.rendered.pages.reduce((total, page) => total + page.bytes, 0) + siteDocBytes.byteLength;

  const plan: PublishPlan = {
    manifest,
    // The slug host always resolves, even after a custom domain becomes canonical: it is printed on
    // business cards, and a KV entry that stops existing is a 404 rather than the one 301 that
    // `resolveHost` would otherwise serve.
    hosts: hostsFor(env, site.slug, input.canonicalHost),
    siteDoc: {
      key: siteDocKey({ siteId: ids.siteId, versionId: input.versionId }),
      body: siteDocBody,
      contentType: 'application/json; charset=utf-8',
    },
    projection: {
      siteId: ids.siteId,
      orgId: ids.orgId,
      versionId: input.versionId,
      pages: projectedPages,
      retiredPaths,
      manifestSha256,
      manifestBytes: siteDocBytes.byteLength,
      themeTokens: JSON.stringify(doc.theme.tokens),
    },
    derived,
    renderedKeys,
    indexNowUrls: changedUrlsFor({
      manifest,
      entries: [...changedByPath].map(([path, changed]) => ({ path, changed })),
    }),
    quality: runQualityGate(qualityInputFor(doc)),
    deployment: {
      deploymentId,
      siteId: ids.siteId,
      versionId: input.versionId,
      pagesWritten: input.rendered.pages.length,
      bytesWritten,
      url: `https://${input.canonicalHost}`,
    },
  };

  const outcome = await publishVersion(portsFor(env, ids, db), plan);
  if (!outcome.ok) {
    throw new GeneratorError(
      'document_invalid',
      'Refused to flip the routing pointer: rendered objects are missing.',
      { detail: outcome.missing.slice(0, 5).join(', ') },
    );
  }

  return {
    versionId: input.versionId,
    deploymentId,
    pagesWritten: input.rendered.pages.length,
    bytesWritten,
    siteUrl: `https://${input.canonicalHost}`,
  };
}

/** Narrows a stored nav group onto the shard's `CHECK`ed enum. */
function asNavGroup(value: string): NavGroup {
  return (['primary', 'footer', 'utility', 'none'] as readonly string[]).includes(value)
    ? (value as NavGroup)
    : 'none';
}

/** Every host the manifest must answer under: the slug host, plus the canonical one if it differs. */
function hostsFor(env: Env, slug: string, canonicalHost: string): readonly string[] {
  const slugHost = `${slug}.${env.SITES_ROOT_DOMAIN}`;
  return slugHost === canonicalHost ? [slugHost] : [slugHost, canonicalHost];
}

/** The hreflang cluster for one page, under the omit-never-substitute rule (§7.4). */
function alternatesFor(
  manifest: RoutingManifest,
  paths: Map<Locale, string> | undefined,
  available: readonly Locale[],
): readonly HreflangLink[] {
  if (paths === undefined) return [];
  return hreflangCluster({
    manifest,
    available,
    pathFor: (locale) => paths.get(locale) ?? null,
  });
}

/**
 * Reduces the document to what the WARN-only quality gate looks at.
 *
 * Slot text is read through `deriveSlotInventoryForPages`, never through `Object.entries(copy)`:
 * the record's key order is a JS-engine detail and its contents include slots for pages that are
 * not this one, so a thinness score built from it would be neither stable nor about the page it
 * claims to describe.
 */
function qualityInputFor(doc: SiteDoc): Parameters<typeof runQualityGate>[0] {
  const inventory = deriveSlotInventoryForPages(doc.pages);
  const pages: QualityPageInput[] = [];

  for (const page of doc.pages) {
    for (const [rawLocale, routing] of Object.entries(page.perLocale)) {
      const locale = assertLocale(rawLocale);
      const copy = copyFor(doc, locale);
      const slotIds = inventory.slots
        .filter((slot) => slot.pageId === page.pageId)
        .map((slot) => slot.id);
      pages.push({
        pageKey: page.pageKey,
        locale,
        path: routing.path,
        title: routing.title,
        description: routing.description,
        text: slotIds.map((slotId) => copy[slotId] ?? '').join(' '),
        indexable: !page.noindex,
      });
    }
  }

  const media = Object.values(doc.media);
  return {
    pages,
    facts: {
      hasBusinessName: doc.facts.businessName.length > 0,
      hasAddressOrServiceArea: doc.facts.address !== null || doc.facts.serviceArea !== null,
      hasPhone: doc.facts.phoneE164.length > 0,
      hasOpeningHours: doc.facts.openingHours !== null,
      hasDescription: (doc.facts.shortDescription ?? '').length > 0,
      hasRegistrationId: doc.facts.companyRegistrationId !== null,
    },
    // `credit` is set by the stock re-hosting path and is null for a tenant's own upload, which
    // makes it the honest discriminator between owned and borrowed imagery.
    ownedMediaCount: media.filter((asset) => asset.credit === null).length,
    totalMediaCount: media.length,
    // Empty until a nightly job builds the comparison corpus. With nothing to compare against there
    // is no evidence of duplication, and the check reports a perfect score rather than a guess.
    corpus: [],
  };
}
