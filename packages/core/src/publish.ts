import type { QualityReport } from './quality-gate';
import type { RoutingManifest } from './routing';
import { encodeRoutingManifest, routingKey } from './routing';

/**
 * The atomic publish: SiteDoc into R2, the projection into the shard, the derived artefacts into
 * R2, and the routing pointer LAST.
 *
 * WHY THE ORDER IS THE WHOLE DESIGN. Every artefact of a version lives under
 * `sites/{siteId}/{versionId}/`, so a new version is a new set of keys. Nothing a publish writes is
 * reachable by a visitor until the KV manifest names that version — which means **publishing is the
 * pointer flip and nothing else**, there is no stale window, no cache purge, no purge quota and no
 * purge race, and a rollback is the same flip in the other direction. The corollary is that the
 * flip has to be last and unconditional on everything before it:
 *
 *   - flipping before the objects exist serves 404s from a live tenant site;
 *   - flipping before the D1 projection lands means a lead form posting against a version the shard
 *     has never heard of, and a sitemap builder with nothing to enumerate;
 *   - flipping before the control plane records `published_version_id` means a dashboard that
 *     disagrees with the internet about what is live.
 *
 * WHY THIS TAKES PORTS RATHER THAN AN `Env`. `core` has to stay runnable in a plain Node runner
 * with no Cloudflare types (architecture §2, and `packages/core/tsconfig.json` accordingly declares
 * no runtime types at all). Ports are that rule taken literally: the domain states the operations
 * and their order, and the composition root — `apps/generator/src/steps/publish.ts` today, the
 * Phase 2 editor's republish path tomorrow — supplies four small adapters over its own bindings.
 * The ordering guarantee therefore lives in one tested function instead of being re-derived by
 * every caller, which is the reuse the Phase 1 stub promised.
 *
 * WHERE THE HTML IS WRITTEN, AND WHY IT IS NOT HERE. `runRenderStep` materialises each page under
 * the version prefix as it renders it, and hands this function the key list. Buffering seven
 * documents through a Workflow step boundary is not an option — a non-streaming `step.do()` return
 * is capped at 1 MiB and is stored durably for the life of the instance — and re-reading them here
 * only to write them again would double the R2 traffic for no gain. The invariant is untouched:
 * those objects are under the unreferenced version prefix, and `publishVersion` **verifies every
 * one of them exists** before it flips. A missing object fails the publish instead of publishing a
 * site with a hole in it.
 */

/* -- What a publish writes --------------------------------------------------------------------- */

/** One object to write into the blobs bucket. */
export interface PublishObject {
  readonly key: string;
  readonly body: string | Uint8Array;
  readonly contentType: string;
  /** `br` for the pre-compressed sitemaps; absent for everything else. */
  readonly contentEncoding?: string | undefined;
  /** Small strings the renderer reads back — the CSP hashes, the `Link` header, the render digest. */
  readonly customMetadata?: Readonly<Record<string, string>> | undefined;
}

/** One page translation, projected out of the SiteDoc into the shape `page_translations` stores. */
export interface ProjectedTranslation {
  readonly locale: string;
  /** Full locale-prefixed path with a trailing slash. */
  readonly path: string;
  /** Last path segment; empty for the locale home page. */
  readonly slug: string;
  readonly title: string;
  readonly metaDescription: string | null;
  readonly ogMediaId: string | null;
  /** The `@graph`, serialised. Built by code from D1 facts; the model never authors it (§4). */
  readonly jsonLd: string | null;
  /** Digest of the content blob this translation points at. `BLOB(32)`. */
  readonly contentSha256: Uint8Array;
  readonly contentBytes: number;
  /** Digest of the canonical semantic projection (`lastmod.ts`). Drives `content_changed_at`. */
  readonly renderSha256: Uint8Array;
  readonly contentChangedAt: number;
  /** True when the projection differs from the published version's. Drives the IndexNow ping. */
  readonly changed: boolean;
}

/** One page, projected. */
export interface ProjectedPage {
  /** Stable across regenerations; the join key for slug stability and `content_changed_at`. */
  readonly pageKey: string;
  readonly role: string;
  readonly template: string;
  readonly navGroup: string;
  readonly sortOrder: number;
  readonly isIndexable: boolean;
  readonly sitemapPriority: number;
  readonly translations: readonly ProjectedTranslation[];
}

/** A path this publish retired. Becomes a permanent 301 (§7.6). */
export interface RetiredPath {
  readonly pageKey: string;
  readonly locale: string;
  readonly oldPath: string;
  readonly newPath: string;
}

/** Everything the shard has to be told, in one place so it can be written in one `batch()`. */
export interface PublishProjection {
  readonly siteId: string;
  readonly orgId: string;
  readonly versionId: string;
  readonly pages: readonly ProjectedPage[];
  readonly retiredPaths: readonly RetiredPath[];
  /** Digest and size of the stored SiteDoc, for `site_versions.manifest_*`. */
  readonly manifestSha256: Uint8Array;
  readonly manifestBytes: number;
  /** Resolved theme tokens, inlined on the version row because the editor reads them constantly. */
  readonly themeTokens: string | null;
}

/** The publish record written to `deployments`. */
export interface DeploymentRecord {
  readonly deploymentId: string;
  readonly siteId: string;
  readonly versionId: string;
  readonly pagesWritten: number;
  readonly bytesWritten: number;
  /** `https://<canonical host>` — the URL the modal finally shows. */
  readonly url: string;
}

/** Everything one publish consists of, computed before any side effect happens. */
export interface PublishPlan {
  /** The manifest to write to KV. Written LAST, and only after everything else succeeded. */
  readonly manifest: RoutingManifest;
  /** Hosts this manifest is reachable under: the canonical host plus any verified alias. */
  readonly hosts: readonly string[];
  readonly siteDoc: PublishObject;
  readonly projection: PublishProjection;
  /** Per-locale sitemaps and the index, pre-compressed. */
  readonly derived: readonly PublishObject[];
  /** Keys `runRenderStep` already materialised. Every one is verified before the flip. */
  readonly renderedKeys: readonly string[];
  /** Absolute URLs whose content actually changed, for the IndexNow ping (§7.10). */
  readonly indexNowUrls: readonly string[];
  readonly quality: QualityReport | null;
  readonly deployment: DeploymentRecord;
}

/* -- Ports ------------------------------------------------------------------------------------- */

/**
 * The capabilities a publish needs, injected.
 *
 * Each is deliberately one operation with no options: an adapter that can only do the one thing
 * cannot be talked into doing a different one by a future caller, and a test double for it is four
 * lines. `recordDeployment` and `pingIndexNow` are optional because they are observability rather
 * than correctness — a publish that succeeded but could not write its own audit row must not be
 * reported as failed, and must certainly not be retried, since the retry would re-do the flip.
 */
export interface PublishPorts {
  /** Wall clock, injected so a publish is reproducible in a test. */
  now(): number;
  /** Writes one object into the blobs bucket. Overwrites; a retry is free and idempotent. */
  putBlob(object: PublishObject): Promise<void>;
  /** True when the key exists. Used to verify the render step's output before the flip. */
  blobExists(key: string): Promise<boolean>;
  /** True when this version has already been sealed, i.e. a previous attempt got this far. */
  isVersionSealed(versionId: string): Promise<boolean>;
  /** Writes the whole projection and seals the version. One D1 `batch()`, all or nothing. */
  writeProjection(projection: PublishProjection): Promise<void>;
  /** Points the control plane at the new version. */
  setPublishedVersion(args: {
    readonly siteId: string;
    readonly orgId: string;
    readonly versionId: string;
    readonly now: number;
  }): Promise<void>;
  /** THE FLIP. Nothing may run after this that could fail and leave the site half-published. */
  putRoutingPointer(args: { readonly key: string; readonly value: string }): Promise<void>;
  /** Stores the WARN-only quality report against the version. */
  storeQualityReport?(args: {
    readonly versionId: string;
    readonly state: 'pass' | 'warn';
    readonly report: string;
  }): Promise<void>;
  /**
   * Records the publish in `deployments`.
   *
   * Optional because `@aibuilder/db` has no `shard/deployments.ts` module yet — the table exists in
   * `migrations/shard/0004_generation.sql` and its statements are listed in this task's handover.
   * Until it does, a publish is recorded by the `site_versions` row and the job ledger, both of
   * which are written elsewhere, so nothing is lost that cannot be reconstructed.
   */
  recordDeployment?(record: DeploymentRecord): Promise<void>;
  /** Pings IndexNow with the changed URLs only. Best effort by definition. */
  pingIndexNow?(urls: readonly string[]): Promise<void>;
}

/* -- Outcome ----------------------------------------------------------------------------------- */

/** What a publish did. */
export type PublishOutcome =
  | {
      readonly ok: true;
      /** True when a previous attempt had already sealed the version and this run only flipped. */
      readonly resumed: boolean;
      readonly objectsVerified: number;
      readonly hostsPointed: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'missing_rendered_objects';
      readonly missing: readonly string[];
    };

/* -- The pipeline ------------------------------------------------------------------------------ */

/**
 * Executes one publish.
 *
 * Idempotent, because a Workflow step is retried and a retry must not produce a second set of
 * `pages` rows or a second `deployments` row. The version's `sealed_at` is the marker: the D1
 * triggers refuse every content write to a sealed version, so a second `writeProjection` would
 * throw rather than duplicate — the seal check turns that into a resume instead of a failure.
 *
 * A publish that cannot verify one of the rendered objects returns `ok: false` and **does not
 * flip**. That is the one failure this function exists to make impossible to get wrong: half a site
 * behind a live pointer is worse than no publish, because the customer sees it and Google indexes
 * it.
 */
export async function publishVersion(
  ports: PublishPorts,
  plan: PublishPlan,
): Promise<PublishOutcome> {
  const resumed = await ports.isVersionSealed(plan.projection.versionId);

  if (!resumed) {
    // 1. The SiteDoc. First, because it is the document every later step describes: the projection
    //    references its digest, and a version row with a manifest digest pointing at an object that
    //    does not exist is unrecoverable without a re-generation the customer already paid for.
    await ports.putBlob(plan.siteDoc);

    // 2. The shard projection, and the seal. One batch: pages, translations, retired paths, the
    //    blob refcounts and `sealed_at` either all land or none of them do. After this the version
    //    is frozen and every later step is a pointer move rather than a content write.
    await ports.writeProjection(plan.projection);
  }

  // 3. The derived artefacts — the per-locale sitemaps and the index. They are written after the
  //    projection because their `lastmod` values come from it, and re-writing them on a resumed
  //    publish is free and keeps them consistent with whatever the projection actually says.
  for (const object of plan.derived) {
    await ports.putBlob(object);
  }

  // 4. Verify what `render` wrote. The pointer is about to make these keys public, and this is the
  //    last moment at which a missing one is a failed publish rather than a 404 on a live site.
  const missing: string[] = [];
  for (const key of plan.renderedKeys) {
    if (!(await ports.blobExists(key))) missing.push(key);
  }
  if (missing.length > 0) {
    return { ok: false, reason: 'missing_rendered_objects', missing };
  }

  // 5. The quality report. WARN-only (§7.27); stored for the calibration run, never consulted here.
  if (plan.quality !== null && ports.storeQualityReport !== undefined) {
    await ports.storeQualityReport({
      versionId: plan.projection.versionId,
      state: plan.quality.state,
      report: JSON.stringify(plan.quality),
    });
  }

  // 6. The control plane learns which version is live. Before the flip, so the dashboard and the
  //    internet never disagree in the direction where the dashboard is behind.
  await ports.setPublishedVersion({
    siteId: plan.projection.siteId,
    orgId: plan.projection.orgId,
    versionId: plan.projection.versionId,
    now: ports.now(),
  });

  // 7. THE FLIP. Last, and the only step that changes what a visitor sees. The ≤60 s KV propagation
  //    window is real and is not claimed away: the editor's "view live site" link carries
  //    `?v={version}` so the owner never lands on a stale pointer (architecture §3a).
  const value = encodeRoutingManifest(plan.manifest);
  for (const host of plan.hosts) {
    await ports.putRoutingPointer({ key: routingKey(host), value });
  }

  // 8. After the flip, and therefore explicitly allowed to fail. Both of these are records of a
  //    publish that has already happened; throwing here would retry a step whose first action is
  //    the flip itself.
  await recordQuietly(ports, plan);

  return {
    ok: true,
    resumed,
    objectsVerified: plan.renderedKeys.length,
    hostsPointed: plan.hosts.length,
  };
}

/**
 * Runs the two post-flip side effects, swallowing their failures.
 *
 * Swallowed on purpose and swallowed narrowly: an IndexNow endpoint being down and a `deployments`
 * insert losing a race are both events that must not undo a successful publish. Anything that could
 * corrupt state runs before step 7, where a throw is a clean, retryable failure.
 */
async function recordQuietly(ports: PublishPorts, plan: PublishPlan): Promise<void> {
  if (ports.recordDeployment !== undefined) {
    try {
      await ports.recordDeployment(plan.deployment);
    } catch {
      // See the JSDoc.
    }
  }
  if (ports.pingIndexNow !== undefined && plan.indexNowUrls.length > 0) {
    try {
      await ports.pingIndexNow(plan.indexNowUrls);
    } catch {
      // See the JSDoc.
    }
  }
}

/* -- Rollback ---------------------------------------------------------------------------------- */

/**
 * Rolls back to a previously published version.
 *
 * Deliberately the *same* operation as a publish with an older manifest, and deliberately not a
 * "restore" that rebuilds anything: the older version's objects were never deleted (they live under
 * their own prefix and the blob reaper only collects at refcount zero), so pointing at them again
 * is one KV write. That is what makes rollback instant, free of a rebuild, and — the property that
 * matters most — **available when the thing that broke is the build itself**.
 *
 * Note what this does NOT do: it does not touch `sites.published_version_id` first. A rollback is an
 * emergency; the fastest correct order is to stop serving the bad version, then reconcile the
 * control plane. The caller does the second half.
 */
export async function rollbackTo(
  ports: PublishPorts,
  args: { readonly manifest: RoutingManifest; readonly hosts: readonly string[] },
): Promise<void> {
  const value = encodeRoutingManifest(args.manifest);
  for (const host of args.hosts) {
    await ports.putRoutingPointer({ key: routingKey(host), value });
  }
}

/* -- The published-object contract ------------------------------------------------------------- */

/**
 * R2 custom-metadata keys on a materialised page.
 *
 * WHY THESE FIVE VALUES TRAVEL WITH THE OBJECT. The renderer has no D1 binding and does exactly one
 * KV read per request (§3a), so anything it must know that is *per page* rather than per site has
 * to arrive with the page itself. All five are derived at publish, from the same rendered bytes
 * they describe:
 *
 *   - `rsha` gives the `ETag` a semantic component, so a republish that changed nothing does not
 *     invalidate every visitor's cached copy;
 *   - `csp` carries the inline `sha256-` sources, which are per-site (the token block differs) and
 *     therefore cannot be a constant in the renderer;
 *   - `link` repeats the head's preloads as a response header, which reaches the browser a round
 *     trip before the preload scanner could (§3a step 7);
 *   - `loc` is the locale, for `Content-Language`, so the renderer does not have to re-derive it
 *     from the key it fetched;
 *   - `nx` is the page's own `noindex` flag, which restricts an otherwise indexable site.
 *
 * Keys are short because R2 caps total custom metadata at 2 KB and the CSP value alone is ~200
 * bytes per hash.
 */
export const PAGE_METADATA_KEYS = {
  renderSha: 'rsha',
  csp: 'csp',
  link: 'link',
  locale: 'loc',
  noindex: 'nx',
} as const;

/** The decoded form of the metadata above. */
export interface PublishedPageMetadata {
  readonly renderSha256: string | null;
  readonly csp: string | null;
  readonly link: string | null;
  readonly locale: string | null;
  readonly noindex: boolean;
}

/** Encodes page metadata for `R2Bucket.put`. Absent values are omitted rather than written empty. */
export function encodePageMetadata(metadata: PublishedPageMetadata): Record<string, string> {
  const encoded: Record<string, string> = {};
  if (metadata.renderSha256 !== null) encoded[PAGE_METADATA_KEYS.renderSha] = metadata.renderSha256;
  if (metadata.csp !== null) encoded[PAGE_METADATA_KEYS.csp] = metadata.csp;
  if (metadata.link !== null) encoded[PAGE_METADATA_KEYS.link] = metadata.link;
  if (metadata.locale !== null) encoded[PAGE_METADATA_KEYS.locale] = metadata.locale;
  if (metadata.noindex) encoded[PAGE_METADATA_KEYS.noindex] = '1';
  return encoded;
}

/**
 * Decodes page metadata read back from R2.
 *
 * Total and never throwing: an object written by an older deploy is missing keys, and the correct
 * reading of a missing key is "this page has no such directive" rather than a 500 on a live tenant
 * page. `noindex` defaults to `false` because the site-level state already covers the restrictive
 * case — a page cannot be accidentally exposed by a missing flag.
 */
export function decodePageMetadata(
  raw: Readonly<Record<string, string>> | undefined,
): PublishedPageMetadata {
  const source = raw ?? {};
  return {
    renderSha256: source[PAGE_METADATA_KEYS.renderSha] ?? null,
    csp: source[PAGE_METADATA_KEYS.csp] ?? null,
    link: source[PAGE_METADATA_KEYS.link] ?? null,
    locale: source[PAGE_METADATA_KEYS.locale] ?? null,
    noindex: source[PAGE_METADATA_KEYS.noindex] === '1',
  };
}

/**
 * The `ETag` for one published document.
 *
 * WEAK, and deliberately: the bytes are not guaranteed identical across deploys (the CSS bundle or
 * the template may differ) while the *content* is, and a weak validator is exactly the "semantically
 * equivalent" claim. Built from the version and the first 16 hex characters of the semantic
 * projection digest, so it changes when the content changes and when the version does, and not
 * when neither did.
 */
export function pageETag(versionId: string, renderSha256: string | null): string {
  const suffix = renderSha256 === null ? '0' : renderSha256.slice(0, 16);
  return `W/"${versionId}-${suffix}"`;
}
