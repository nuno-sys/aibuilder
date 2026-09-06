import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * The billing suite runs in real workerd.
 *
 * Two things under test here behave differently in Node and would prove the wrong thing there: the
 * Stripe SDK resolves to a completely different build under the `workerd` export condition (fetch
 * transport, SubtleCrypto provider), and webhook signature verification runs on Web Crypto. A green
 * signature test in Node would say nothing about the code that deploys.
 *
 * The pool is deliberately NOT pointed at `wrangler.jsonc`: that config binds two D1 databases, an
 * R2 bucket, a service binding and three Secrets Store secrets, none of which exist in a test. The
 * cases build explicit, typed doubles for exactly the bindings each one needs, which is also what
 * keeps a failure pointing at this Worker.
 *
 * `@cloudflare/vitest-pool-workers` v0.22 replaced the `defineWorkersConfig` helper (imported from
 * `.../config`) with a Vite plugin. Neither that helper nor the `/config` subpath exists any more.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-08-22',
        compatibilityFlags: ['nodejs_compat'],
      },
    }),
  ],
  test: {
    include: ['src/**/*.test.ts'],
  },
});
