/**
 * The bindings this package needs, injected.
 *
 * `eslint.config.js` forbids every package from importing `cloudflare:*`, and the reason is exactly
 * this file: authentication has to be exercisable from a plain test runner and from three different
 * Workers (`apps/api` today, `apps/app` and `apps/billing` next), so the capability it needs arrives
 * as a parameter rather than as an ambient import. `D1Database` is an ambient type from
 * `@cloudflare/workers-types`, not a runtime import, so naming it costs nothing at runtime.
 *
 * Deliberately narrower than any app's `Env`: this package can read and write the control plane and
 * do nothing else. It cannot reach a shard, a bucket, a queue or a Durable Object, which is what
 * makes "did an auth change touch tenant data" answerable by looking at the type.
 */
export interface AuthEnv {
  /** Control plane. `users`, `memberships`, `sessions`, `auth_tokens`. */
  readonly CP: D1Database;
}
