import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * The API's suite runs in real workerd, not in Node.
 *
 * Everything under test here touches a primitive whose Node polyfill differs from the runtime in a
 * way that matters: `crypto.subtle` HMAC for the draft cookie, `Request`/`Headers` semantics for the
 * Origin middleware, and Hono's router itself. A green suite in Node would prove the wrong thing.
 *
 * The pool is deliberately NOT pointed at `wrangler.jsonc`. That config binds three Durable Objects
 * and a service binding that live in `aibuilder-generator`, which the pool would have to be handed
 * as auxiliary workers; the tests instead build explicit, typed doubles for exactly the bindings
 * each case needs, which is also what keeps a test failure pointing at this Worker.
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
