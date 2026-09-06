import type { RoutingManifest } from '@aibuilder/core';

/**
 * Every binding declared in `apps/renderer/wrangler.jsonc`, as one typed interface.
 *
 * WHAT IS NOT HERE IS THE POINT. No `D1Database`, no secret binding, no queue producer, no Images
 * binding. This Worker renders attacker-influenced content on a public URL (§8), so it holds
 * exactly the four capabilities the read path needs and nothing that would be worth stealing. If a
 * future feature seems to need a database here, the answer is a service binding to the API, which
 * has the authorisation logic — not a binding on this script.
 *
 * Hand-authored for the same reason as `apps/api/src/env.ts`: `wrangler types` produces a global
 * that cannot be imported by name, so a handler could not state which bindings it needs.
 */
export interface Env {
  /** SiteDocs, materialised HTML and sitemaps. Read-only in practice — nothing here writes. */
  readonly BLOBS: R2Bucket;
  /** Verified originals and derivatives, served same-origin under `/_a/` (§7.24). */
  readonly MEDIA: R2Bucket;
  /** host -> `RoutingManifest`. One read serves the whole site (§3a step 2). */
  readonly ROUTING: KVNamespace;
  /** First-party, server-side. There is no client analytics beacon on a tenant site (§7.22). */
  readonly AE: AnalyticsEngineDataset;
  /** Lead form posts only. The API owns the origin allowlist, the rate limit and the spam score. */
  readonly API: Fetcher;

  readonly ENVIRONMENT: 'production' | 'staging';
  /** `mijnsaas.com`. Decides the HSTS parameters — never `preload` on a customer's domain (§S7). */
  readonly SITES_ROOT_DOMAIN: string;
  /** Served at `/<key>.txt` so an IndexNow endpoint can verify the ping. Public by design. */
  readonly INDEXNOW_KEY: string;
}

/** Hono's generic parameter: the bindings plus what the host-resolution middleware puts on `c`. */
export interface AppEnv {
  readonly Bindings: Env;
  readonly Variables: {
    /** Set by `resolveSite` before any handler runs. Never `undefined` inside a handler. */
    site: RoutingManifest;
    /** The normalised host the manifest was found under. */
    host: string;
  };
}
