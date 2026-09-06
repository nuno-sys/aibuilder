import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * The renderer's suite runs in real workerd.
 *
 * Everything under test is a runtime primitive whose Node polyfill differs where it matters: the
 * Cache API (which has no Node equivalent at all), `R2Bucket` semantics including `customMetadata`
 * and `httpEtag`, and `Request`/`Response` header handling on the conditional-request path. A green
 * suite in Node would prove the wrong thing.
 *
 * The pool is deliberately NOT pointed at `wrangler.jsonc`: the tests build explicit typed doubles
 * for KV, R2 and Analytics Engine, which keeps a failure pointing at this Worker rather than at a
 * misconfigured binding, and keeps the suite from needing real bucket ids.
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
