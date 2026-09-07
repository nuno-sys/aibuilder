import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';

/**
 * The dashboard's build.
 *
 * WHY THERE IS NO `@cloudflare/vite-plugin` HERE. There was, and it does not build. The plugin
 * declares its worker entry as an OBJECT (`{ index: "virtual:cloudflare/worker-entry" }`) while
 * React Router declares its inputs as an ARRAY, and Vite's config merge concatenates rather than
 * replaces — so the bundler is handed an array with an object inside it and rejects it:
 *
 *     Failed to convert JavaScript value `Object {"index":"virtual:cloudflare/worker-entry"}`
 *     into rust type `String` on BindingInputItem.import
 *
 * Bisected before giving up on it: plugin 1.49 through 1.54.5, React Router 7.13 through 7.18.3,
 * Vite 7 (Rollup) and Vite 8 (Rolldown). All fail identically, and each plugin builds fine alone,
 * so it is an upstream collision rather than a setting on this side. Declaring the same object
 * shape here does not help — the merge still concatenates.
 *
 * WHAT REPLACES IT. React Router builds both halves and `wrangler` bundles the Worker, which is how
 * this pairing worked before the plugin existed:
 *
 *   · `resolve.conditions` puts `workerd` first, so the server graph resolves the Worker build of
 *     every dependency. This is the one job the plugin did that actually mattered here, and getting
 *     it wrong fails at the first `cloudflare:` import in production rather than at build time.
 *   · `input: workers/app.ts` gives the SSR environment a real entry. Without one it emitted route
 *     chunks and no worker.
 *   · `entryFileNames` is a FUNCTION, not a string. The SSR build has many entries (every route is
 *     one), so a fixed `index.js` renames them all and they overwrite each other — the observable
 *     symptom was an 11-byte `index.js`. Only the worker chunk gets the stable name that
 *     `wrangler.jsonc`'s `main` points at.
 *   · `outDir: dist/server` matches `react-router.config.ts`'s `buildDirectory: 'dist'`. Without
 *     it the SSR pass writes over `dist/client` and the two bundles overlay each other — which
 *     also, quietly, put three `.server.ts` modules into the client output.
 *
 * WHAT IT COSTS. `vite dev` no longer carries Cloudflare bindings, so `pnpm dev` is now a watching
 * build behind `wrangler dev`, which does. `pnpm dev:ui` is still the plain Vite server for pure
 * UI work, where a loader hitting `env.CP` is not what you are looking at.
 */
export default defineConfig({
  plugins: [reactRouter()],
  build: {
    // Every generated site is a separate origin; nothing here is shared with a tenant page, so the
    // only consumer of this bundle is a signed-in customer on a warm connection. A slightly larger
    // chunk that avoids a waterfall is the right trade for this surface.
    target: 'es2022',
  },
  environments: {
    ssr: {
      resolve: { conditions: ['workerd', 'worker', 'browser'] },
      build: {
        target: 'es2022',
        outDir: 'dist/server',
        rollupOptions: {
          input: 'workers/app.ts',
          // `cloudflare:workers` and friends are provided by the runtime, not by the bundle.
          external: [/^cloudflare:/u],
          output: {
            entryFileNames: (chunk) =>
              chunk.name === 'app' ? 'index.js' : 'assets/[name]-[hash].js',
          },
        },
      },
    },
  },
});
