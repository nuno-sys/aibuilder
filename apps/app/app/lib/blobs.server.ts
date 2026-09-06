import { siteDocKey } from '@aibuilder/core';
import { parseSiteDoc } from '@aibuilder/site-schema';
import type { SiteDoc } from '@aibuilder/site-schema';

import type { Env } from '../env';

/**
 * Reading a published `SiteDoc` out of R2.
 *
 * WHERE THE DOCUMENT LIVES. `sites/{siteId}/{versionId}/sitedoc.json` in the blobs bucket, written
 * by the publish pipeline as the FIRST object of a publish — before the shard projection, because
 * every later artefact describes it. `siteDocKey()` in `@aibuilder/core` is the only place that key
 * shape is written; building it here by hand is how the editor ends up reading an object the
 * publisher stopped writing.
 *
 * WHY THE KEY IS NEVER BUILT FROM A REQUEST VALUE. Both segments come from rows this Worker has
 * already authorised: `siteId` from `cp.dashboard.getSiteForUser`, `versionId` from that site's own
 * `site_versions` row on its own shard. `siteDocKey` additionally rejects a segment that could
 * address something other than itself, so a crafted id cannot escape the prefix even if a future
 * caller passes one through.
 *
 * A DOCUMENT THAT DOES NOT VALIDATE IS A MISSING DOCUMENT. `parseSiteDoc` is the read-path parser
 * that returns issues instead of throwing, and the editor's answer to a failure is "this version
 * cannot be edited" rather than a half-populated form whose saves would be rejected one field at a
 * time.
 */

/** Why a document could not be loaded. Both cases are shown to the customer as one message. */
export type SiteDocLoadFailure = 'missing_object' | 'invalid_document';

export type SiteDocLoad =
  | { readonly ok: true; readonly doc: SiteDoc }
  | { readonly ok: false; readonly reason: SiteDocLoadFailure; readonly issues: readonly string[] };

/**
 * Loads one version's `SiteDoc`.
 *
 * Guarantees the returned document validates against `SiteDocSchema` on this request — not "was
 * valid when it was written" — because the editor's form model IS the document and a field that
 * cannot round-trip is a field the customer will lose work in.
 */
export async function loadSiteDoc(
  env: Env,
  args: { readonly siteId: string; readonly versionId: string },
): Promise<SiteDocLoad> {
  const key = siteDocKey({ siteId: args.siteId, versionId: args.versionId });
  const object = await env.BLOBS.get(key);
  if (object === null) {
    return { ok: false, reason: 'missing_object', issues: [] };
  }

  let raw: unknown;
  try {
    raw = await object.json();
  } catch {
    return { ok: false, reason: 'invalid_document', issues: ['object is not JSON'] };
  }

  const parsed = parseSiteDoc(raw);
  if (!parsed.ok) {
    return { ok: false, reason: 'invalid_document', issues: parsed.issues };
  }
  return { ok: true, doc: parsed.doc };
}
