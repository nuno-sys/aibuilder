import { cloudflare } from '@cloudflare/vite-plugin';
import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';

/**
 * The dashboard's build.
 *
 * PLUGIN ORDER MATTERS. `cloudflare()` has to register the `ssr` environment before `reactRouter()`
 * attaches its server build to it; reversing them produces a server bundle targeting Node's
 * conditions, which then fails at the first `cloudflare:workers` import — at deploy time, not at
 * build time, which is the worst place to find out.
 *
 * `viteEnvironment: { name: 'ssr' }` tells the Cloudflare plugin that React Router's `ssr`
 * environment IS the Worker, rather than creating a second one beside it.
 *
 * There is no `optimizeDeps` block and no aliasing of the workspace packages. Internal packages
 * expose `"exports": { ".": "./src/index.ts" }` and are compiled by this Vite pass like any other
 * source in the graph, which is the whole reason they are shipped unbuilt.
 */
export default defineConfig({
  plugins: [cloudflare({ viteEnvironment: { name: 'ssr' } }), reactRouter()],
  build: {
    // Every generated site is a separate origin; nothing here is shared with a tenant page, so the
    // only consumer of this bundle is a signed-in customer on a warm connection. A slightly larger
    // chunk that avoids a waterfall is the right trade for this surface.
    target: 'es2022',
  },
  environments: {
    /**
     * `dist/server`, not the plugin's default `dist/ssr`.
     *
     * The two tools disagree on where the SSR bundle goes. `@cloudflare/vite-plugin` derives the
     * directory from the ENVIRONMENT NAME (`join(build.outDir ?? 'dist', 'ssr')`), while React
     * Router's server stage reads `<buildDirectory>/server/.vite/manifest.json`. Left alone, the
     * client and server halves build to sibling directories that never meet and the build dies at
     * the last step on an ENOENT naming a path nothing wrote. The plugin honours an explicit
     * per-environment `outDir`, so this is the seam where they are reconciled.
     *
     * `react-router.config.ts` sets `buildDirectory: 'dist'` to match. Change neither alone.
     */
    ssr: { build: { outDir: 'dist/server' } },
  },
});
