// Imported rather than used as a global: this file is linted by the repo's flat ESLint config,
// which does not declare Node globals, and an explicit import is the honest way to say that this
// module runs in Node and nowhere else.
import { env } from 'node:process';

import { defineConfig, passthroughImageService } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';

/**
 * The canonical origin of the marketing host. `Astro.site` is derived from this, and every
 * canonical URL, hreflang entry, sitemap entry and JSON-LD `@id` in the build is derived from
 * `Astro.site` — so this is the single place the control-plane domain is written for this app.
 *
 * It is a build-time variable rather than a constant because the registrable domain is still a
 * placeholder (architecture §1.1: the client nominates it before code freeze). The same value
 * appears in `wrangler.jsonc` (`routes`) and in `public/_headers` (CSP); those three change
 * together or the deploy is broken in a way that only shows up in production.
 *
 * Read from `node:process` env, not `import.meta.env`: this file is evaluated before Vite's env
 * pipeline exists, so the variable must come from the real environment (CI, or an exported shell
 * variable) rather than only from a `.env` file. Every OTHER `PUBLIC_*` variable is read through
 * `import.meta.env` in `src/content/site.ts` and works from `.env` as well.
 */
const SITE_ORIGIN = env.PUBLIC_SITE_ORIGIN ?? 'https://www.aibuilder.app';

/** Routes that must never enter the sitemap: `/start/` is `noindex` (thin, query-parameterised). */
const SITEMAP_EXCLUDED = ['/start/', '/404', '/404/'];

export default defineConfig({
  site: SITE_ORIGIN,

  // Workers Static Assets serves the build output directly. A static build needs no adapter at
  // all — `@astrojs/cloudflare` exists for SSR, and adding it here would turn every marketing
  // request into a billed Worker invocation (architecture §1.2).
  output: 'static',

  // Uniform trailing slashes, matching the tenant sites (SEO §1.4). `format: 'directory'` emits
  // `prijzen/index.html`, which is what makes `/prijzen/` a 200 rather than a redirect.
  trailingSlash: 'always',

  build: {
    format: 'directory',

    // Hashed, immutable assets live under `/_a/` — the same prefix the renderer uses for tenant
    // sites, so one `Cache-Control: immutable` rule in `public/_headers` covers both surfaces.
    assets: '_a',

    // Every stylesheet is inlined into `<head>`. The whole marketing sheet sits far inside the
    // §4.13 budget (9 KB critical + 22 KB deferred, brotli), so there is no render-blocking
    // stylesheet request at all. If the sheet ever outgrows that budget, switch to 'auto' and
    // split — do not silently ship a 40 KB inline block.
    inlineStylesheets: 'always',
  },

  // All imagery is pre-encoded by the media pipeline (SEO §4.5: avifenc/cwebp/cjpeg at fixed
  // dimensions, asserted against the LCP size invariant). Astro's default image service would
  // pull in `sharp` to do work we deliberately do not do at build time.
  image: { service: passthroughImageService() },

  integrations: [
    react(),
    sitemap({
      filter: (page) => !SITEMAP_EXCLUDED.some((path) => page.endsWith(path)),
      // `changefreq` and `priority` are omitted on purpose — Google ignores both (architecture
      // §7.7). `lastmod` is omitted because a build timestamp is not a semantic content change
      // (§7.8); a sitemap that always says "now" gets ignored.
    }),
  ],

  // Marketing pages are ~14 KB of HTML; the win is small but free.
  compressHTML: true,

  // Astro's link prefetch is opt-in per link (`data-astro-prefetch`), not page-wide: prefetching
  // every link on hover would fetch the legal pages from the hero on a phone.
  prefetch: { prefetchAll: false, defaultStrategy: 'hover' },

  vite: {
    build: {
      // Fonts and pre-encoded media must stay separate files so they can be preloaded by URL and
      // cached immutably. Inlining any of them as a data: URI would put them on the critical path.
      assetsInlineLimit: 0,
    },
  },
});
