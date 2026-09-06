import type { AnonSessionRow, ShardBindings } from '@aibuilder/db';

/**
 * Every binding declared in `apps/api/wrangler.jsonc`, as one typed interface.
 *
 * WHY THIS IS HAND-AUTHORED. Architecture §2 prefers `wrangler types`, and that generator remains
 * the cross-check: run it and the shapes must agree. It is not the compile-time source here for two
 * reasons. First, three bindings need a contract the generator cannot express — a Secrets Store
 * secret is read through `readSecret()` so that a plain `wrangler secret put` value keeps working
 * while Secrets Store is in open beta (architecture §8), the queue producer carries a typed message
 * the generator's consumer must agree with, and the Images binding is bound but never called from
 * this Worker. Second, a generated global `Env` cannot be imported by name, so every module would
 * depend on ambient state instead of an explicit import. Adding a binding is therefore two edits —
 * `wrangler.jsonc` and this file — and forgetting the second one is a compile error at the first
 * use, not a runtime `undefined`.
 */

/**
 * A Secrets Store binding.
 *
 * Architecture §8: access is written so that `wrangler secret put` remains a working fallback while
 * Secrets Store is in open beta. A plain Worker secret arrives as a `string`; a Secrets Store
 * binding arrives as an object with an async `get()`. Both are accepted, and `readSecret()` is the
 * only thing that has to know the difference.
 */
export interface StoredSecret {
  get(): Promise<string>;
}

/** A secret binding in either of the two shapes the platform can deliver. */
export type SecretBinding = StoredSecret | string;

/** The result of a Workers Rate Limiting `limit()` call. */
export interface RateLimitOutcome {
  readonly success: boolean;
}

/**
 * A Workers Rate Limiting binding.
 *
 * Declared structurally rather than imported so that the four bindings share one exact type and so
 * that this Worker compiles against the GA `ratelimits` shape independently of which
 * `@cloudflare/workers-types` release is installed.
 */
export interface RateLimitBinding {
  limit(options: { readonly key: string }): Promise<RateLimitOutcome>;
}

/** The four rate-limit bindings, by name. Mirrors the `ratelimits` block in `wrangler.jsonc`. */
export type RateLimitBindingName = 'RL_DRAFT' | 'RL_SUBMIT' | 'RL_UPLOAD' | 'RL_LEADS';

/**
 * The message `POST /v1/media/:mediaId/commit` puts on `MEDIA_Q`.
 *
 * This is a contract with the consumer in `apps/generator/src/queue/media-consumer.ts`: the
 * consumer magic-byte-sniffs the quarantined object, re-encodes it through the Images binding with
 * `metadata: 'none'`, writes derivatives to the media bucket and promotes the row. The API sends
 * identifiers and the values it derived server-side — never the client's filename, and never the
 * bytes.
 *
 * `claimedSha256` is the browser's claim about what it uploaded. It is recorded, never trusted: the
 * consumer hashes the object itself.
 */
export interface MediaVerifyMessage {
  readonly type: 'verify';
  readonly mediaId: string;
  readonly draftId: string;
  readonly shardId: number;
  readonly bucket: string;
  readonly key: string;
  readonly declaredMimeType: string;
  readonly claimedSha256: string;
}

/**
 * The API Worker's environment.
 *
 * Extends `ShardBindings` from `@aibuilder/db` so `shardById(row.shard_id, env)` accepts it
 * directly: the shard of an existing tenant is always read from a stored `shard_id`, never
 * recomputed.
 */
export interface Env extends ShardBindings {
  /** Control plane. Identity, orgs, sites, slugs, drafts, claims, abuse signals. */
  readonly CP: D1Database;

  /** Unverified uploads. EU jurisdiction, 24-hour lifecycle, presigned PUT target. */
  readonly QUARANTINE: R2Bucket;
  /** Verified originals and derivatives. Written by the generator, bound here for reads. */
  readonly MEDIA: R2Bucket;

  /** `host -> {siteId, shardId, liveVersion, …}`. Written at publish, read by the renderer. */
  readonly ROUTING: KVNamespace;
  /** NL/BE postcode lookups, cached 24 h (architecture §S4). */
  readonly GEO: KVNamespace;

  /** Per-job SSE hub. Always addressed through `.jurisdiction('eu')`. */
  readonly JOB_HUB: DurableObjectNamespace;
  /** Per-subject onboarding quotas (architecture §8 layer 5). */
  readonly QUOTA: DurableObjectNamespace;
  /** The single global spend ceiling with staged degradation (architecture §8 layer 6). */
  readonly BUDGET: DurableObjectNamespace;

  /** `aibuilder-generator`: the only Worker holding `ANTHROPIC_API_KEY`. No public route. */
  readonly GENERATOR: Fetcher;

  /** Producer for the media verify/re-encode consumer. */
  readonly MEDIA_Q: Queue<MediaVerifyMessage>;

  /**
   * The Cloudflare Images binding.
   *
   * Bound because §S2 lists it, and deliberately typed as `unknown`: no Phase 1 route in this
   * Worker calls it — re-encoding happens in the generator's queue consumer, which owns the media
   * pipeline. A hand-written approximation of an API nobody calls would be a lie that outlives
   * Phase 1; when a caller appears, `wrangler types` produces the real shape.
   */
  readonly IMAGES: unknown;

  readonly RL_DRAFT: RateLimitBinding;
  readonly RL_SUBMIT: RateLimitBinding;
  readonly RL_UPLOAD: RateLimitBinding;
  readonly RL_LEADS: RateLimitBinding;

  readonly TURNSTILE_SECRET: SecretBinding;
  /** Signs `__Host-aib_draft`. `kid`-versioned; see `src/middleware/draft-cookie.ts`. */
  readonly DRAFT_HMAC_KEY: SecretBinding;
  /** Rotated daily. IPs are never stored raw (architecture §8, GDPR posture). */
  readonly IP_SALT: SecretBinding;
  /** Scoped to the quarantine bucket only — it signs URLs handed to unauthenticated browsers. */
  readonly R2_ACCESS_KEY_ID: SecretBinding;
  readonly R2_SECRET_KEY: SecretBinding;
  readonly GEOCODER_KEY: SecretBinding;

  readonly ENVIRONMENT: 'production' | 'staging';
  /** The exact allowed `Origin`. Compared with `===`, never with a regex. */
  readonly APP_ORIGIN: string;
  /** `<slug>.${SITES_ROOT_DOMAIN}` is the tenant host. */
  readonly SITES_ROOT_DOMAIN: string;
  /** Must carry the `.eu.` label; it is covered by the presigned signature. */
  readonly R2_S3_ENDPOINT: string;
  /** The quarantine bucket's NAME, which the binding does not expose but an S3 path needs. */
  readonly R2_QUARANTINE_BUCKET: string;
  /** Public Turnstile widget key, returned by `GET /v1/bootstrap`. */
  readonly TURNSTILE_SITE_KEY: string;
}

/** Request-scoped values middleware puts on the Hono context. */
export interface AppVariables {
  /**
   * The anonymous session behind `__Host-aib_draft`.
   *
   * Set only by `requireAnonSession`, so a route that reads it is a route that ran the check.
   */
  anonSession: AnonSessionRow;
}

/** The Hono environment every app, router and middleware in this Worker is typed against. */
export type AppEnv = { Bindings: Env; Variables: AppVariables };

/** Thrown when a secret binding resolves to nothing. Never carries the value. */
export class MissingSecretError extends Error {
  public readonly binding: string;

  public constructor(binding: string) {
    super(`Secret binding "${binding}" is not configured`);
    this.name = 'MissingSecretError';
    this.binding = binding;
  }
}

/**
 * Resolves a secret binding to its value.
 *
 * Accepts both shapes (Secrets Store object, plain Worker secret string) so that rotating the
 * delivery mechanism is not a code change. Guarantees a non-empty string or a thrown
 * `MissingSecretError` — never an empty key silently signing or verifying something.
 */
export async function readSecret(binding: SecretBinding, name: string): Promise<string> {
  const value = typeof binding === 'string' ? binding : await binding.get();
  if (typeof value !== 'string' || value.length === 0) {
    throw new MissingSecretError(name);
  }
  return value;
}
