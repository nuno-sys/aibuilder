import type { ShardBindings } from '@aibuilder/db';

/**
 * Every binding declared in `apps/billing/wrangler.jsonc`, as one typed interface.
 *
 * Hand-authored for the same reasons `apps/api/src/env.ts` gives: a Secrets Store secret needs the
 * `readSecret()` contract so that a plain `wrangler secret put` value keeps working while Secrets
 * Store is in open beta, and a generated global `Env` cannot be imported by name. Adding a binding
 * is two edits — `wrangler.jsonc` and this file — and forgetting the second is a compile error at
 * the first use rather than a runtime `undefined`.
 */

/** A Secrets Store binding: an object with an async `get()`. */
export interface StoredSecret {
  get(): Promise<string>;
}

/** A secret in either of the two shapes the platform can deliver. */
export type SecretBinding = StoredSecret | string;

/**
 * The billing Worker's environment.
 *
 * Extends `ShardBindings` so `shardById(row.shard_id, env)` accepts it directly: the shard of an
 * existing tenant is always read from a stored `shard_id`, never recomputed.
 */
export interface Env extends ShardBindings {
  /** Control plane. Organisations, entitlement, the Stripe mirror, the trial ledger. */
  readonly CP: D1Database;

  /** Raw event archive under `stripe/events/{id}.json`; D1 keeps only the sha256. */
  readonly BLOBS: R2Bucket;

  /** `aibuilder-generator`. The webhook is the only dispatcher of the generation Workflow. */
  readonly GENERATOR: Fetcher;

  /** Live or test secret key. This Worker is the only holder, and that is the whole design. */
  readonly STRIPE_SECRET_KEY: SecretBinding;
  /** `whsec_…`. Verifies every delivery before anything else happens. */
  readonly STRIPE_WEBHOOK_SECRET: SecretBinding;
  /** Peppers `card.fingerprint` before it is stored. Never optional: see `trials.ts`. */
  readonly TRIAL_FINGERPRINT_PEPPER: SecretBinding;

  /** Compared against `event.livemode` on every delivery. */
  readonly ENVIRONMENT: 'production' | 'staging';
  /** Marketing origin; the Checkout `cancel_url` returns the customer to the onboarding theatre. */
  readonly APP_ORIGIN: string;
  /** API origin; the Checkout `success_url` is `GET /v1/billing/return` on it. */
  readonly API_ORIGIN: string;
  /** Dashboard origin; the customer portal returns here. */
  readonly DASHBOARD_ORIGIN: string;
  /** `<slug>.${SITES_ROOT_DOMAIN}` is the tenant host. */
  readonly SITES_ROOT_DOMAIN: string;
  /** The server-side price allowlist, and all of it. Never read from a request. */
  readonly STRIPE_PRICE_ID: string;
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
 * Accepts both shapes so that rotating the delivery mechanism is not a code change. Guarantees a
 * non-empty string or a thrown `MissingSecretError` — never an empty key silently verifying a
 * signature, which for a webhook secret would be an authentication bypass rather than a
 * degradation.
 */
export async function readSecret(binding: SecretBinding, name: string): Promise<string> {
  const value = typeof binding === 'string' ? binding : await binding.get();
  if (typeof value !== 'string' || value.length === 0) {
    throw new MissingSecretError(name);
  }
  return value;
}
