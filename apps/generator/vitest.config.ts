import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * The generator's suite runs in real workerd.
 *
 * The Durable Objects under test use `ctx.storage.sql` and `ctx.storage.setAlarm`, neither of which
 * has a faithful Node equivalent — a hand-rolled double would be testing the double. `additionalExports`
 * registers the three classes with the pool so `runInDurableObject` can reach them.
 *
 * `@cloudflare/vitest-pool-workers` v0.22 replaced the `defineWorkersConfig` helper (imported from
 * `.../config`) with a Vite plugin. Neither that helper nor the `/config` subpath exists any more.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/index.ts',
      additionalExports: {
        JobHub: 'DurableObject',
        BudgetDO: 'DurableObject',
        QuotaDO: 'DurableObject',
      },
      miniflare: {
        compatibilityDate: '2026-08-22',
        compatibilityFlags: ['nodejs_compat'],
        // `additionalExports` tells the pool what KIND each export is; it does not create bindings.
        // The namespaces themselves have to be declared here, or `env.JOB_HUB` is undefined.
        // All three use `ctx.storage.sql`, which is off unless the class is SQLite-backed. In
        // production that comes from `new_sqlite_classes` in wrangler.jsonc; here it is `useSQLite`.
        durableObjects: {
          JOB_HUB: { className: 'JobHub', useSQLite: true },
          BUDGET: { className: 'BudgetDO', useSQLite: true },
          QUOTA: { className: 'QuotaDO', useSQLite: true },
        },
        bindings: { ENVIRONMENT: 'test' },
      },
    }),
  ],
  test: {
    include: ['src/**/*.test.ts'],
  },
});
