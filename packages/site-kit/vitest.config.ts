import { defineConfig } from 'vitest/config';

/**
 * site-kit renders in a plain Node pool, deliberately.
 *
 * The package depends on `@aibuilder/site-schema` and on `hono/jsx`, and touches exactly two web
 * globals (`crypto.subtle`, `TextEncoder`) that Node 22 and workerd implement identically. Running
 * the suite in `@cloudflare/vitest-pool-workers` would buy nothing and would put a workerd boot on
 * the path of a contrast proof that is pure arithmetic (architecture §2: this package must render
 * in a plain test runner, and the test config is where that claim is either true or a slogan).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // The contrast proof enumerates 17 280 themes and evaluates ~2.9 M token pairs. It runs in a
    // few seconds, but the 5 s default would make it flaky on a loaded CI box, and a flaky proof
    // gets deleted rather than fixed.
    testTimeout: 120_000,
  },
});
