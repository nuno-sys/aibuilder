# aibuilder — Frontend/Fullstack Stack & Runtime Topology Decision

*Researched against 2026-current docs (Sept 2026). Verified facts and version numbers are cited at the bottom.*

---

## 0. Platform baseline (decided first, because it constrains everything)

**Workers Static Assets, not Pages. Zero Pages usage in this repo.**

The client constraint says "Workers + Pages". I am overriding the Pages half, and here is the honest reason: as of 2026 Cloudflare's own docs tell you to use Workers for new projects, Pages gets maintenance updates at best, and every platform feature this product needs is **Workers-only** — Workflows, Containers, Secrets Store, Cron Triggers, full Observability. Concretely: `@astrojs/cloudflare` **v13 (March 2026) dropped Pages support entirely** and Astro 6 requires v13+. Choosing Pages would mean choosing an adapter that no longer supports it. Workers Static Assets gives the identical commercial benefit (static asset requests are free, same as Pages) plus everything Pages can't do.

Baseline versions to pin:

| Thing | Version | Note |
|---|---|---|
| `wrangler` | ≥ **4.34** | below this it still enforces the old 20k asset-file cap |
| `compatibility_date` | **≥ 2026-08-04** | `nodejs_compat` + `nodejs_compat_v2` are on by default at this date; below it you must set `nodejs_compat` manually (the Anthropic SDK needs it) |
| `@cloudflare/vite-plugin` | **1.x** (≥1.15) | runs your code in real `workerd` during `vite dev`; this is now the standard dev/build path for every surface |
| Worker size | **64 MiB uncompressed, all plans** | the old 3 MiB (free) / 10 MiB (paid) *compressed* gate was **removed 2026-09-04**. Bundle size is no longer a real constraint — startup CPU still is |
| CPU | 30 s/invocation default on Paid, raisable to **300 s** via `limits.cpu_ms` | wall-clock while awaiting I/O is not charged |
| Subrequests | **10,000** default on Paid (raised from 1,000 in Feb 2026), configurable to 10M | |
| Simultaneous connections | **6 per invocation** | this bites when fanning out 6 locale translation calls — batch them |
| Static assets | 100,000 files/version (Paid), 25 MiB/file | |
| D1 | **10 GB per database, hard cap, cannot be raised** | drives a real architectural decision, see §3.4 |

---

## 1. Surface (a) — Marketing site

### ✅ **Astro 6 + `@astrojs/cloudflare` v13, `output: 'static'`, deployed as an assets-only Worker**

- Ships **zero JS by default**; the onboarding modal is a single React island (`client:idle`). That is how you get 100/100 with a video hero, not by fighting a hydration payload.
- Built-in i18n routing, `<Image>`/`<Picture>`, content collections for the blog, sitemap + RSS integrations — all four of the things you'd otherwise hand-roll.
- Because it's `output: 'static'`, **no Worker invocation ever runs for marketing traffic**. Static asset requests are free. Cost ≈ €0.
- Dev server runs on `workerd` via the Cloudflare Vite plugin in Astro 6, so bindings behave the same in dev and prod.

**Runner-up: Next.js 16 + `@opennextjs/cloudflare` (v1.20.x).** It lost on *what it makes you fight*: a React runtime + hydration payload on a 6-page brochure site, an adapter indirection layer between you and the runtime, and every non-prerendered request becoming a billed Worker invocation — all to buy features (RSC, server actions) that a marketing page doesn't use. The bundle-size objection that used to kill it is now moot (64 MiB), so this is purely a "wrong tool" loss, not a "doesn't fit" loss.

**Also considered:** plain Vite + Hono JSX — lost on content collections, image pipeline, i18n routing and sitemap, which Astro gives free.

**Video-hero gotcha (applies to (a) and (c)):** never let the video be the LCP element. Serve an AVIF/WebP **poster** transformed via Cloudflare Images from R2, `<link rel="preload">` it, and attach the video with `preload="none" autoplay muted playsinline` swapped in after LCP. Hero video from R2 must be a compressed MP4/WebM ladder (or Cloudflare Stream) — a raw 20 MB MP4 destroys mobile CWV regardless of how fast the edge is.

---

## 2. Surface (b) — Dashboard + live editor

### ✅ **React Router v7, framework mode, on Workers via `@cloudflare/vite-plugin`**

- First-class, Cloudflare-documented target (`workers/framework-guides/web-apps/react-router/`); runs natively on `workerd`, no adapter shim.
- Typed `loader`/`action` per route is exactly the shape of an auth'd dashboard: session cookie read at the edge, D1/R2 access via `context.cloudflare.env`, progressively-enhanced forms for Stripe and domain management.
- Mature (Remix lineage, production-proven at scale). This is the surface that gates revenue — it gets the boring choice.
- Editor state (which is heavy) lives in client React + a Durable Object, not in the framework's data layer, so framework churn can't hurt it.

**Runner-up: TanStack Start.** Genuinely better type inference and the best client cache in the ecosystem (TanStack Query built in), and it benchmarks ~25% higher throughput than RR v7 on Workers. It lost on **timing**: as of Sept 2026 it is still RC (v1.15x, feature-complete/API-stable but not 1.0), and there is an open `cloudflare:workers` module-resolution issue with the Cloudflare Vite plugin. Not a risk worth taking on the paywall surface. Revisit at 1.0 — the migration cost from RR v7 is low because both are Vite + file-routes.

**Also considered:** Next.js/OpenNext (RSC buys nothing behind auth; heaviest startup CPU; extra adapter layer); SvelteKit (excellent Workers story and the best non-React answer — lost only on ecosystem depth for editor primitives, dnd, and Stripe components, plus it splits the stack from Astro's React islands); Nuxt/SolidStart/Qwik (Qwik's resumability solves a JS-payload problem we don't have, since surface (c) ships ~0 JS).

---

## 3. Surface (c) — Generated tenant sites ← **the decision that matters**

### 3.1 Verdict: **Strategy 4 (Hybrid), with a specific twist that removes cache purging entirely**

**Scoring** (5 = best; weights reflect this product: CWV and editor latency dominate, storage cost is irrelevant):

| Dimension | 1. D1→SSR/req | 2. Build→R2 static | 3. Raw AI HTML | **4. Hybrid** |
|---|---|---|---|---|
| LCP / CWV (TTFB) | 3 | 5 | 2 | **5** |
| Cold start | 4 | 5 | 5 | **5** |
| Cost / request | 2 | 5 | 5 | **5** |
| Cacheability | 2 | 5 | 5 | **5** |
| Editor round-trip | 5 | 1 | 1 | **5** |
| i18n fan-out (6×N) | 5 | 3 | 1 | **4** |
| Preview fidelity | 5 | 2 | 2 | **5** |
| Operational complexity | 5 | 4 | 5 | **3** |
| **Total /40** | **31** | **30** | **26** | **37** |

**Why each loser lost:**

- **(1) D1 SSR per request** — couples every page view to a D1 read. D1 is a single Durable Object per database; a request from Lisbon against a Frankfurt DB is 30–60 ms of TTFB before you render a byte, and read replication makes that eventually-consistent rather than fast. You'd bolt a cache on top to fix it — at which point you have built strategy 4 with a slower miss path. Also: D1's 10 GB hard cap makes it the wrong home for thousands of full site documents.
- **(2) Pure build→R2** — identical serving profile to the winner, and it lost **only** on the live editor. It has no on-demand render path, so previewing an unpublished draft means either re-materializing 40+ objects per keystroke or writing a *second* renderer for preview — which guarantees WYSIWYG drift between what the customer edits and what publishes. That drift is a support-ticket generator in a product whose entire promise is "what you see is your site."
- **(3) Raw AI HTML** — **disqualified, not merely outscored.** No structured source of truth means the live editor cannot reliably change a color or a paragraph; regeneration becomes the only edit primitive, which collides head-on with "Regenerate is paywalled." It also makes i18n a full re-generation per locale (6× the token spend, 6× the drift), makes Lighthouse non-deterministic (the model's HTML/a11y quality varies run to run), and hits the 128K output ceiling on larger sites.

### 3.2 The architecture

**Source of truth:** a `SiteDoc` JSON document — theme tokens, page tree, section list, per-locale content bundles.

**Renderer:** `packages/site-kit` — a component library authored in **`hono/jsx`, rendered to string**. Chosen because the renderer must run *inside workerd* (both for on-demand draft preview and for the publish pipeline), so it must be a **library, not a CLI build step**. There is no per-site Astro/Vite build anywhere in this system — that's what makes thousands of tenants tractable. Runner-up `preact-render-to-string` lost on bundle weight and because we never hydrate.

**CSS strategy — the single most important perf decision here:** no per-site Tailwind build. Ship **5–8 hand-authored industry archetype stylesheets** (~8–12 KB gzip each) as immutable hashed static assets, and inject each tenant's identity as ~40 **CSS custom properties** in a `<style>` block in `<head>`. Per-industry uniqueness (dark for the DJ, cream/red for the restaurant) is a token set, not a build artifact. Above-the-fold critical CSS is inlined; the archetype sheet loads once and is then cross-page cached.

**Zero third-party JS on tenant sites** — this is non-negotiable for ~100/100: WhatsApp button is a plain `<a href="https://wa.me/…">` (opens the app natively on mobile, no SDK), reviews render from stored JSON (no Google widget), cookie banner is ~1 KB of our own JS, analytics is the Cloudflare Web Analytics beacon or first-party logging from the renderer — never GA. Total tenant JS budget: **< 5 KB gzip**, one file, `defer`.

### 3.3 Request path (and how we delete the purge problem)

```
GET https://bakkerij-jan.nl/nl/contact
  → Cloudflare for SaaS custom hostname → zone mijnsaas.com → route */* → aibuilder-renderer
     1. KV lookup: host → { siteId, liveVersion, locales, defaultLocale }   (~1ms, edge-local)
     2. cache.match("https://c.internal/{siteId}/{liveVersion}/{locale}/{path}")   ← VERSION IN THE CACHE KEY
     3. HIT  → return (typical: ~1–3 ms CPU, no storage read at all)
        MISS → R2 get "sites/{siteId}/{liveVersion}/{locale}/{path}.html"
             → ctx.waitUntil(cache.put(versionedKey, res.clone() with max-age=31536000))
             → return res with browser-facing Cache-Control: public, max-age=300
```

**Because the Cache API key contains the version, publishing is just "bump `liveVersion` in KV."** No purge API call, no purge race, no stale-content window, no per-tenant purge quota. Old entries simply age out. This is the concrete reason the hybrid beats a naive "cache + purge on publish" design.

**Caching gotcha you must know:** the **Cache API is colo-local and does NOT participate in Tiered Cache** — only `fetch()` does. So on a cold colo, every miss is a real R2 read. For a local bakery with 50 visits/day spread across European colos, miss rate is high and R2 reads (~20–60 ms) are the dominant latency. **Optimization when RUM shows it:** put the R2 bucket behind a public custom domain **on a second zone** (so it doesn't re-enter the `*/*` route and loop) and make the miss path `fetch(url, { cf: { cacheEverything: true, cacheTtl: 31536000 } })` — that gets Tiered Cache + optional Cache Reserve, so the whole network pulls from R2 once per object. Ship the binding version first; add this when it's measurable.

### 3.4 Where the data actually lives (D1's 10 GB cap forces this)

- **D1 = metadata + pointers only.** `tenants`, `sites` (slug, status, `live_version`, `schema_version`, industry, locales), `custom_hostnames`, `subscriptions`, `media` (R2 keys), `generation_runs`. Small rows, thousands of tenants ≈ tens of MB. Comfortably inside 10 GB forever.
- **R2 = the bulk.** `sites/{siteId}/{version}.json` (the `SiteDoc`), `sites/{siteId}/{version}/{locale}/{path}.html` (materialized pages), `media/{tenantId}/…` (uploads). Storage math: 6 locales × ~8 pages ≈ 48 objects × ~40 KB ≈ 2 MB per version; 1,000 sites × 3 retained versions ≈ **6 GB ≈ $0.09/month**. Publish writes ~48 class-A ops. Irrelevant cost.
- **KV = the hot routing manifest.** host → site pointer. Eventually consistent (~60 s) which is exactly right for publish propagation.
- **Never put the `SiteDoc` blobs in D1.** That's the decision that keeps you off the 10 GB wall.

### 3.5 i18n fan-out — the JSON-source-of-truth payoff

Layout, theme and structure are **locale-independent**; only the content bundle fans out. So generation is: one Claude call for structure + copy in the primary locale, then N cheap translation calls over a *content-only* JSON subtree (`effort: "low"`, stable schema prefix cached). Adding Italian later = one translation pass + one materialize pass, **no regeneration, no re-design**. With strategy 3 (raw HTML) adding a locale means regenerating the whole site and hoping the design matches. Routing is `/{locale}/{path}` with `defaultLocale` at `/{defaultLocale}/`; `hreflang` + `x-default` are emitted from the locale list in the manifest, so extensibility is a config array, not a code change.

### 3.6 How the live editor previews (why (2) lost, concretely)

- **Color/font/spacing edits: 0 ms round-trip.** They are CSS custom properties. The editor `postMessage`s the token diff into the preview iframe and mutates `style.setProperty()` on `:root`. Nothing re-renders, nothing hits the network.
- **Content/structure edits:** editor patches a **`SiteDraftDO`** (one Durable Object per site) holding the draft `SiteDoc` in memory; the iframe requests `preview.mijnsaas.com/{siteId}/{locale}/{path}` with a short-lived signed token; the **same** `site-kit` renderer runs against the draft doc and returns `Cache-Control: no-store`. Sub-100 ms, and byte-identical to what publish will emit.
- **Publish:** DO writes `SiteDoc` v(N+1) to R2 + D1, a Workflow materializes all locale×page HTML, KV pointer flips. The DO also debounces autosave so the editor never hot-writes D1.

---

## 4. Runtime topology

**One zone, `mijnsaas.com`, with Cloudflare for SaaS enabled.**

| Hostname | Binding style | Worker | Notes |
|---|---|---|---|
| `mijnsaas.com`, `www.` | Custom Domain | `aibuilder-marketing` | assets-only, no `main` → **0 invocations, free requests** |
| `app.mijnsaas.com` | Custom Domain | `aibuilder-app` | React Router v7 |
| `api.mijnsaas.com` | Custom Domain | `aibuilder-api` | Hono |
| `*/*` (catch-all route) | Route | `aibuilder-renderer` | serves `<slug>.mijnsaas.com` **and every Cloudflare-for-SaaS custom hostname** |
| `origin.mijnsaas.com` | — | — | SaaS fallback origin, originless `AAAA 100::`, proxied |

The `*/*` pattern is the documented Cloudflare-for-SaaS approach: it matches all traffic entering the zone including customer vanity domains, so **you never add a Worker route per tenant**. Exact-hostname Custom Domains are how the other three surfaces carve themselves out of that wildcard — **verify this precedence in staging before Phase 3**; if it misbehaves, the fallback is explicit more-specific routes (`api.mijnsaas.com/*` beats `*/*`), which is standard route-specificity behaviour. Marketing's `/api/*` calls go to `api.mijnsaas.com` — same-site, and if you want to avoid CORS preflight entirely, add a more-specific route `mijnsaas.com/api/*` → api Worker rather than proxying through a Worker.

**Optional second zone** (recommended by Phase 3): a cheap `*-cdn` domain hosting the R2 public custom domain, for the Tiered-Cache miss path (§3.3) and tenant media — it must not sit inside the `*/*` route or the renderer will fetch itself.

**The generation pipeline is a Cloudflare Workflow, not an HTTP request.** `claude-opus-5` at `effort: "high"` with streaming and multiple sequential calls runs for minutes; it needs durable steps, per-step retries, and resumability across restarts. Workflows are **Workers-only** — another reason Pages was never viable. Steps:

1. resolve industry theme preset; if no uploads, search Pexels/Unsplash for hero video (subrequest — trivially under the 10k cap)
2. Claude: structure + copy in primary locale — `client.messages.parse()`, `output_config: { format: zodOutputFormat(SiteDocSchema), effort: "high" }`, `thinking: { type: "adaptive" }`, **streaming** (large `max_tokens`)
3. Claude: 2 blog posts (`effort: "medium"`)
4. Translation fan-out per locale (`effort: "low"`) — **batch these, max 6 simultaneous connections per invocation**
5. Legal pages (Privacy/Terms/cookie text) from **deterministic templates**, not the model — cheaper, and you do not want a hallucinated GDPR clause on a European SMB's site
6. Zod-validate → write `SiteDoc` to R2, metadata to D1
7. Materialize locale×page HTML into R2 (~48 renders ≈ well under 1 s CPU)
8. Flip KV pointer

**Prompt caching layout (prefix-match — stable content first):** system prompt → component/section catalog → `SiteDoc` JSON schema → industry design tokens, all marked `cache_control: { type: "ephemeral", ttl: "1h" }`; the tenant's business data goes **last**, uncached. Get this order wrong and you cache nothing. No `budget_tokens`. No assistant prefill.

---

## 5. Monorepo, package boundaries, TypeScript

**pnpm 10 workspaces + Turborepo 2.x.** Turbo earns its keep here because five deployables share seven packages — `turbo typecheck` / `turbo build` fan-out with caching is the difference between a 15 s and a 3 min inner loop. Not Nx (too much machinery), not bare pnpm (task graph gets hand-rolled by month two).

```
aibuilder/
  apps/
    marketing/        Astro 6, output:'static' → assets-only Worker
    app/              React Router v7 (dashboard + editor)
    api/              Hono — onboarding, uploads, Stripe + SaaS webhooks, auth
    renderer/         Hono — tenant SSR/serve + preview  (the */* Worker)
    generator/        Cloudflare Workflow + SiteDraftDO
  packages/
    site-schema/      ← THE CONTRACT. Zod v4 schemas, inferred types, migrations
    site-kit/         hono/jsx components, theme tokens, industry archetypes, CSS
    core/             domain logic: tenant resolution, publish pipeline, R2 keys
    ai/               Anthropic wrapper, prompt builders, cache_control layout
    db/               Drizzle schema for D1 + migrations
    ui/               React components (marketing islands + dashboard), Tailwind v4
    config/           tsconfig / eslint / tailwind presets
```

**Dependency rules (enforce with eslint-plugin-boundaries):**
`site-schema` depends on nothing. `site-kit` depends **only** on `site-schema` — no Cloudflare bindings, no `env`, so it is pure and unit-testable and can render in a test runner. `core` may touch bindings (takes `Env` as a parameter, never imports it globally). Apps depend on packages; **packages never depend on apps; apps never import each other.**

**Where the site schema contract lives: `packages/site-schema`.** This is the keystone of the whole product and deserves the strongest rule in the repo:

- One `SiteDocSchema` (Zod v4) is simultaneously (a) the DB/R2 document shape, (b) the renderer's input type, (c) the editor's form model, and (d) the **Anthropic structured-output format** via `zodOutputFormat`. One definition, four consumers — the AI physically cannot emit something the renderer can't draw.
- Every stored document carries an explicit `schemaVersion`. `migrations/` holds pure `vN → vN+1` functions. The renderer **upgrades on read** and persists on next publish. Non-negotiable: AI-generated documents will outlive several schema revisions and you cannot re-run generation to fix them (it costs money and changes the customer's site).

**TypeScript strategy:**
- Root `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules`, `moduleResolution: "bundler"`, `module: "esnext"`, `skipLibCheck`.
- **Internal packages are unbuilt** — `"exports": { ".": "./src/index.ts" }`, consumed as source and bundled by each app's Vite/esbuild pass. No build ordering, no stale `dist/`, no watch-mode dance. This works precisely because every consumer is a bundler.
- **Env types come from `wrangler types`**, run in `predev`/`pretypecheck`, emitting `worker-configuration.d.ts` per app from `wrangler.jsonc`. Do not hand-write the `Env` interface — it will drift from your bindings and you'll find out in production.
- Add project references only if `turbo typecheck` crosses ~20 s.

---

## 6. Workers-specific gotchas, collected

1. **`compatibility_date ≥ 2026-08-04`** turns on `nodejs_compat` + `nodejs_compat_v2` implicitly. Older dates: set `nodejs_compat` explicitly or `@anthropic-ai/sdk` fails at import.
2. **Bundle size is no longer the problem it was** — 64 MiB uncompressed, all plans, since 2026-09-04. The **400 ms startup CPU limit** is now the binding constraint: keep top-level imports lazy in the renderer (it's the hot path), dynamic-import the Anthropic SDK only in the generator.
3. **Anthropic SDK streaming on `workerd` has a history of edge-runtime parsing bugs** (`Unexpected end of JSON input`). Pin the SDK version, keep streaming confined to the generator Workflow, and cover it with a `@cloudflare/vitest-pool-workers` test that runs in real `workerd` — not Node.
4. **6 simultaneous outbound connections per invocation.** Locale fan-out must be chunked or it silently serializes.
5. **D1: 10 GB hard cap, single-writer, one query at a time.** Metadata only. Use the **Sessions API with bookmarks** for read-after-write correctness in the dashboard once read replication is on — without it a user saves and then sees stale data from a replica.
6. **Cache API is colo-local and not tiered; `fetch()` is tiered.** See §3.3. Also, Cache API is a no-op in some local dev modes — test cache logic against a deployed preview, not `wrangler dev`.
7. **Cloudflare for SaaS:** PAYG supports up to **50,000 custom hostnames**; **wildcard custom hostnames are Enterprise-only** (so tenants get `bakkerij-jan.nl` + `www.`, not `*.bakkerij-jan.nl`); fallback origin needs an originless proxied `AAAA 100::`.
8. **Static assets:** 100k files/version, 25 MiB/file. Fine for marketing; irrelevant for tenants (they're R2, not assets).
9. **Workflows, Containers, Secrets Store, Cron Triggers are Workers-only.** Put the Anthropic and Stripe keys in **Secrets Store**, not `wrangler secret`.
10. **Astro 6 requires `@astrojs/cloudflare` v13**, which removed `workerEntryPoint` and dropped Pages. Astro 6 also requires Node ^22.12 || ^24 and Zod v4 — which is convenient, since `site-schema` is Zod v4 anyway. Keep Zod v4 uniform across the repo.
11. **Images:** transformations are **$0.50 per 1,000 unique transformations** (5,000/mo free) on R2-stored originals via `/cdn-cgi/image/`. At thousands of tenants, generate a **fixed variant set at publish time**, don't transform per request per breakpoint — that's an unbounded bill.

---

## 7. Phase mapping

- **Phase 1** — pnpm/turbo scaffold; `site-schema` + `db` (D1 migrations via Drizzle); `apps/marketing` (Astro 6, hero + pricing + the onboarding modal island); `apps/api` (Hono: Zod validation, direct-to-R2 media upload, Workflow dispatch); `apps/generator` (Workflow with the Claude call chain); a minimal `site-kit` (one industry archetype) and `apps/renderer` serving `<slug>.mijnsaas.com` from R2. **Prove the full loop end-to-end in Phase 1 even with one archetype** — the renderer is the highest-risk component and must not be deferred.
- **Phase 2** — `apps/app` (React Router v7), `SiteDraftDO`, preview iframe + CSS-var live theming, Stripe trial-wall gating `regenerate`. Remaining industry archetypes.
- **Phase 3** — Cloudflare for SaaS custom hostnames, blog + featured images, analytics, second zone + Tiered Cache miss path if RUM justifies it, TanStack Start re-evaluation at 1.0.

---

**Sources:**
[Static Assets](https://developers.cloudflare.com/workers/static-assets/) · [Migrate from Pages to Workers](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/) · [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [64 MiB Worker size (2026-09-04)](https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/) · [Subrequest limit change (2026-02-11)](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/) · [Increased static asset limits](https://developers.cloudflare.com/changelog/post/2025-09-02-increased-static-asset-limits/) · [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) · [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/) · [Workers Cache limitations](https://developers.cloudflare.com/workers/cache/limitations/) · [How the Cache works](https://developers.cloudflare.com/workers/reference/how-the-cache-works/) · [Workers as fallback origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/) · [Cloudflare for SaaS plans/quotas](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/quotas-and-billing/) · [Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) · [React Router on Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/react-router/) · [Next.js on Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/) · [@astrojs/cloudflare](https://docs.astro.build/en/guides/integrations-guide/cloudflare/) · [@astrojs/cloudflare v13.0.0](https://newreleases.io/project/github/withastro/astro/release/@astrojs/cloudflare@13.0.0) · [@opennextjs/cloudflare](https://www.npmjs.com/package/@opennextjs/cloudflare) · [@cloudflare/vite-plugin](https://www.npmjs.com/package/@cloudflare/vite-plugin) · [TanStack Start comparison](https://tanstack.com/start/latest/docs/framework/react/comparison) · [Cloudflare Images pricing](https://developers.cloudflare.com/images/pricing/) · [Anthropic SDK edge streaming issue #292](https://github.com/anthropics/anthropic-sdk-typescript/issues/292)