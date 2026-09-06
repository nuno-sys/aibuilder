import { defineConfig } from 'vitest/config';

// Every test in this package runs against a stubbed client: the suite must never open a socket,
// because a test that can reach api.anthropic.com is a test that can spend money in CI. Nothing
// here needs workerd either -- the one runtime-specific dependency, `crypto.subtle`, is a global in
// both node >= 22 and workerd -- so the plain node pool keeps the suite fast.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
