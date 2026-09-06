import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * The dashboard's suite runs in real workerd, not in Node.
 *
 * Everything under test here touches a primitive whose Node polyfill differs from the runtime in a
 * way that matters: `crypto.subtle` for the session-token hash and the preview cookie's HMAC,
 * `Request`/`Headers` semantics for the guards, and `ctx.storage.sql` plus `transactionSync` for
 * `SiteDraftDO` — none of which has a faithful Node equivalent, and a hand-rolled double for the
 * last one would be testing the double.
 *
 * The pool is deliberately NOT pointed at `wrangler.jsonc`. That config binds D1, R2, a service
 * binding and Static Assets, none of which the tests need: the guard cases build explicit, typed
 * doubles for exactly the bindings each one exercises, which is also what keeps a failure pointing
 * at this Worker rather than at a fixture database.
 *
 * `additionalExports` registers the class with the pool so `runInDurableObject` can reach it, and
 * `useSQLite: true` is what gives it `ctx.storage.sql` — in production that comes from
 * `new_sqlite_classes` in `wrangler.jsonc`.
 *
 * `@cloudflare/vitest-pool-workers` v0.22 replaced the `defineWorkersConfig` helper (imported from
 * `.../config`) with a Vite plugin. Neither that helper nor the `/config` subpath exists any more.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './app/__tests__/do-worker.ts',
      additionalExports: {
        SiteDraftDO: 'DurableObject',
      },
      miniflare: {
        // The same date as `wrangler.jsonc`. The test pool and production must run the SAME
        // compatibility date or the suite stops proving anything about what deploys.
        compatibilityDate: '2026-08-22',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: {
          SITE_DRAFT: { className: 'SiteDraftDO', useSQLite: true },
        },
        bindings: { ENVIRONMENT: 'test' },
      },
    }),
  ],
  test: {
    include: ['app/**/*.test.ts'],
  },
});
