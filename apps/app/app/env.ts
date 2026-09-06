import type { AuthEnv } from '@aibuilder/auth';
import type { ShardBindings } from '@aibuilder/db';

import type { SiteDraftDO } from './do/SiteDraftDO';

/**
 * Every binding declared in `apps/app/wrangler.jsonc`, as one typed interface.
 *
 * WHY THIS IS HAND-AUTHORED. The same reasons `apps/api/src/env.ts` gives, plus one this app has on
 * its own: a generated global `Env` cannot be named in the `AppLoadContext` augmentation at the
 * bottom of this file, so every loader in the dashboard would take an ambient type instead of an
 * imported one. Adding a binding is two edits — `wrangler.jsonc` and this file — and forgetting the
 * second is a compile error at the first use rather than a runtime `undefined`.
 *
 * WHAT THIS WORKER MAY DO, EXPRESSED AS BINDINGS. It reads the control plane and one shard, reads
 * the blobs bucket, and owns `SiteDraftDO`. It has NO queue, NO Images binding, NO Anthropic key
 * and NO Stripe key: everything that spends money or mutates billing goes through `API`, which owns
 * the entitlement gate, the rate limiters and the idempotency keys (architecture §8 — capability
 * separation on Workers means splitting Workers).
 */

/** A Secrets Store binding, or the plain string a `wrangler secret put` value arrives as. */
export interface StoredSecret {
  get(): Promise<string>;
}

/** A secret in either of the two shapes the platform can deliver. */
export type SecretBinding = StoredSecret | string;

/** The dashboard Worker's environment. */
export interface Env extends ShardBindings, AuthEnv {
  /** Control plane: identity, memberships, organisations, sites, billing mirror. */
  readonly CP: D1Database;

  /** Published site artefacts. Read-only here: the editor seeds a draft from `sitedoc.json`. */
  readonly BLOBS: R2Bucket;

  /** One object per site, holding that site's unsaved draft and its undo ring. */
  readonly SITE_DRAFT: DurableObjectNamespace<SiteDraftDO>;

  /** `aibuilder-api`: the entitlement gate, regenerate, the billing portal, the auth surface. */
  readonly API: Fetcher;

  /** The Vite-built client bundle, served by Workers Static Assets. */
  readonly ASSETS: Fetcher;

  /** Signs the preview session cookie. `kid:material`, comma separated, first entry signs. */
  readonly PREVIEW_HMAC_KEY: SecretBinding;
  /** Rotated daily. IPs are never stored raw (architecture §8, GDPR posture). */
  readonly IP_SALT: SecretBinding;

  readonly ENVIRONMENT: 'production' | 'staging';
  /** `https://app.<control-plane-domain>` — this Worker's dashboard host. */
  readonly DASHBOARD_ORIGIN: string;
  /** `https://preview.<control-plane-domain>` — the draft-render host. A different origin. */
  readonly PREVIEW_ORIGIN: string;
  /** `https://www.<control-plane-domain>` — the marketing site, where onboarding lives. */
  readonly APP_ORIGIN: string;
  /** `https://api.<control-plane-domain>`. */
  readonly API_ORIGIN: string;
  /** `<slug>.${SITES_ROOT_DOMAIN}` is a tenant host. */
  readonly SITES_ROOT_DOMAIN: string;
  /** Absolute origin of the media CDN. The preview cannot use same-origin asset paths. */
  readonly MEDIA_CDN_ORIGIN: string;
  /** Public Turnstile widget key. A var and not a secret: it is rendered into the login page. */
  readonly TURNSTILE_SITE_KEY: string;
}

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
 * Accepts both shapes so that rotating the delivery mechanism is not a code change, and guarantees
 * a non-empty string or a thrown `MissingSecretError` — never an empty key silently signing
 * something (architecture §8).
 */
export async function readSecret(binding: SecretBinding, name: string): Promise<string> {
  const value = typeof binding === 'string' ? binding : await binding.get();
  if (typeof value !== 'string' || value.length === 0) {
    throw new MissingSecretError(name);
  }
  return value;
}

/**
 * What every loader and action receives as `context`.
 *
 * React Router's `AppLoadContext` is an interface the host augments; augmenting it here — rather
 * than casting `context` in each route — is what makes `context.cloudflare.env.CP` a typed D1
 * binding in forty route modules without forty casts.
 */
declare module 'react-router' {
  interface AppLoadContext {
    readonly cloudflare: {
      readonly env: Env;
      readonly ctx: ExecutionContext;
    };
  }
}
