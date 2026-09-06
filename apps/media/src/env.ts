/**
 * Every binding declared in `apps/media/wrangler.jsonc`.
 *
 * One bucket and two strings. This Worker serves bytes a member of the public uploaded, so it holds
 * nothing an attacker could want: no database, no key, no service binding, no analytics dataset.
 * The isolation is the binding list, not a code review.
 */
export interface Env {
  /** Verified originals and derivatives. Read-only: there is no `put` or `delete` in `src/`. */
  readonly MEDIA: R2Bucket;

  readonly ENVIRONMENT: 'production' | 'staging';
  /** Decides the HSTS parameters. Never `preload` on a hostname we do not own (§S7). */
  readonly SITES_ROOT_DOMAIN: string;
}

/** Hono's generic parameter. This Worker has no request-scoped variables — it has no state. */
export interface AppEnv {
  readonly Bindings: Env;
}
