import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * The media Worker's suite runs in real workerd.
 *
 * What is being asserted here is header behaviour on a `Response` built around an `R2ObjectBody`
 * stream, which is precisely the thing a Node polyfill would get subtly right and the runtime would
 * get subtly different. The R2 binding itself is a typed double, so a failure points at this Worker.
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
