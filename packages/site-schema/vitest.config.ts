import { defineConfig } from 'vitest/config';

// This package is runtime-free (no bindings, no fetch, no DOM), so it runs in the
// plain node pool rather than @cloudflare/vitest-pool-workers. Keeping it out of
// workerd keeps the contract's test suite fast enough to run on every keystroke.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
