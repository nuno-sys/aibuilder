import { defineConfig } from 'vitest/config';

// `core` takes every binding as an injected `Env` parameter (architecture §2), so nothing in this
// package needs workerd to run. The plain node pool keeps the domain suite fast enough to run on
// every save; the app packages that actually hold bindings use @cloudflare/vitest-pool-workers.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
