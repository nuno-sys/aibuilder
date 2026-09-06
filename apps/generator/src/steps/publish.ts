import { NotImplementedInPhase1 } from '@aibuilder/core';
import type { SiteDoc } from '@aibuilder/site-schema';

import type { Env } from '../env';
import type { RunIds } from '../ids';
import type { RenderResult } from './render';

/**
 * Step 10, `publish` — SiteDoc and HTML into R2, the projection into the shard, the KV pointer last.
 *
 * OUT OF SCOPE FOR THIS DELIVERY (VERIFIED-FACTS.md, deliberate deviation 2). It belongs to
 * `@aibuilder/core`'s `publish.ts`, alongside `keys.ts`, `routing.ts`, `sitemap.ts` and
 * `lastmod.ts`, because publishing is a domain operation over an injected `Env` rather than a
 * Workflow concern — the Phase 2 editor republishes through exactly the same function, and a
 * publish implemented inside a Workflow step could not be reused by it.
 *
 * THE ORDER IS THE WHOLE DESIGN, AND IT IS WHY THIS IS NOT A FEW `put()` CALLS. Every artefact of a
 * version lives under `sites/{siteId}/{versionId}/`, so a new version is a new key: there is no
 * stale window and no cache purge (§7). The KV pointer flip is therefore the atomic publish, and it
 * must be LAST — flipping it before the objects exist serves 404s from a live tenant site, and
 * flipping it before the D1 projection lands means a lead form posting against a version the shard
 * has never heard of.
 *
 * WHY A THROWING FUNCTION AND NOT AN ABSENT ONE. The alternative — a step that writes the SiteDoc
 * and skips the pointer — would look like it worked, would leave the customer's site at 404, and
 * would report success to the progress bar. A named, classified `not_implemented` failure at a real
 * call site is the honest shape of an unfinished pipeline.
 *
 * What lands here when `@aibuilder/core/publish.ts` ships:
 *   - SiteDoc and every rendered page written under the version prefix, plus the `/` document.
 *   - Per-locale sitemaps and the sitemap index, brotli-precompressed (`.xml.br`).
 *   - The shard projection: `pages`, `page_translations`, blog rows, `content_blobs` refcounts.
 *   - `sealVersion()`, which freezes every content column — nothing ever edits a published version.
 *   - The `ROUTING` KV pointer, written last, and only after all of the above succeeded.
 *   - A `deployments` row recording when the pointer moved and to what.
 */

/** What a completed publish reports. */
export interface PublishResult {
  readonly versionId: string;
  readonly deploymentId: string;
  readonly pagesWritten: number;
  readonly bytesWritten: number;
  /** `https://<slug>.${SITES_ROOT_DOMAIN}` — the URL the modal finally shows. */
  readonly siteUrl: string;
}

/**
 * Publishes a version and flips the routing pointer.
 *
 * @throws NotImplementedInPhase1 always. The publish pipeline is owned by `@aibuilder/core`, which
 * does not yet export it; the signature is final so the Workflow's ordering, step timeout and
 * failure classification are real and reviewed today.
 */
export function runPublishStep(
  _env: Env,
  _ids: RunIds,
  _input: {
    readonly doc: SiteDoc;
    readonly rendered: RenderResult;
    readonly versionId: string;
    readonly canonicalHost: string;
  },
): Promise<PublishResult> {
  throw new NotImplementedInPhase1(
    'publish: @aibuilder/core owns the atomic publish (R2 objects, shard projection, KV pointer last)',
  );
}
