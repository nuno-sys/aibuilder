import type { Config } from '@react-router/dev/config';

/**
 * React Router v7, framework mode, server-rendered.
 *
 * `ssr: true` is not the default-because-it-was-there. Every page in this dashboard is behind a
 * session and reads tenant data, so a client-rendered shell would ship an empty document to a
 * customer on a phone and then make two round trips (JS, then data) before showing anything. The
 * loader runs on the same Worker as the D1 binding, so the first byte already contains the answer.
 *
 * There is deliberately no `prerender` list. Nothing here is public: `/inloggen` is the only route
 * an unauthenticated visitor reaches, and it is a form whose action is origin-guarded.
 */
export default {
  ssr: true,
  appDirectory: 'app',
  /**
   * `dist`, not React Router's default `build`.
   *
   * `@cloudflare/vite-plugin` writes the client environment to `dist/client` on its own convention.
   * Leaving React Router on `build` makes its server stage look for
   * `build/client/.vite/manifest.json`, which the client stage never wrote — the build fails at the
   * very last step with an ENOENT that names a path nothing produced. The two have to agree, and
   * the Cloudflare plugin's convention is the one `wrangler deploy` reads.
   */
  buildDirectory: 'dist',
} satisfies Config;
