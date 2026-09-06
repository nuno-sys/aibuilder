I have what I need. The Anthropic reference resolved five contested claims across dimensions — I'll flag those explicitly where a critique was wrong.

---

# aibuilder — Definitive Architecture

**Status:** decided. Every open question below is closed. Where a critique corrected a dimension, the correction is taken and marked `[ADOPTED]`. Where a critique was itself wrong, it is marked `[REJECTED]` with the reason.

## 0. Verified facts that overrode the dimensions

Checked against the current Anthropic reference, not recalled:

| Claim | Verdict |
|---|---|
| `inference_geo` accepts `"eu"` | **FALSE.** Accepts `"us"` \| `"global"` only. The *framework critique* demanded `inference_geo: "eu"`; **`[REJECTED]`**. The *security* dimension was right: there is no EU inference region, so the answer is SCCs + TIA + never sending PII in prompts. |
| 1h cache write costs 1.25× | **FALSE.** 1.25× at 5m, **2× at 1h**. Break-even: 2 requests (5m), 3 requests (1h). A cache read refreshes the timer for free, so prefix-sharing requests <5 min apart keep a 5m entry warm indefinitely. The *aigen critique* was right; we use **5m TTL everywhere**. |
| Varying top-level `effort` across calls preserves the cache | **FALSE.** "Thinking and `effort` changes always invalidate the messages cache." The documented escape hatch is a `{role:"system", content:[], output_config:{effort}}` message behind beta `mid-conversation-output-config-2026-07-01` (Opus 5, Claude API). *aigen critique* `[ADOPTED]`. |
| Opus 5 `thinking.display` defaults to `"omitted"` | **TRUE.** Thinking streams as empty text. The *ux* progress theatre as written narrates nothing for the first N seconds. Fix: `display: "summarized"`. *ux critique* `[ADOPTED]`. |
| `thinking: {type:"disabled"}` fixes small-call truncation | **PARTLY.** Disabled is accepted on Opus 5 only at effort ≤ `high` (400 at `xhigh`/`max`), and it has two documented failure modes (tool calls written into visible text; `<thinking>` tag leakage). Guidance is explicit: **prefer thinking-on at `effort: "low"` with a generous `max_tokens`.** *ux critique's* diagnosis `[ADOPTED]`, its prescription `[MODIFIED]`. The *schema critique's* proposed `CHECK (thinking_type <> 'disabled' OR effort IN ('low','medium','high'))` is exactly right and ships. |
| Priority Tier available on Opus 5 | **FALSE** — excluded. Fast mode (`speed:"fast"`, beta `fast-mode-2026-02-01`, $10/$50) *is* available and is the only latency lever; not adopted by default. |
| `task_budget` exists as a hard-ish spend ceiling | **TRUE.** `output_config.task_budget:{type:"tokens", total:N}`, min 20,000, beta `task-budgets-2026-03-13`, on `client.beta.messages.stream`. *framework critique* `[ADOPTED]`. |
| Parallel fan-out shares one cache write | **FALSE.** "N parallel requests with identical prefixes all pay full price." Send one, await first streamed token, then fan out. *aigen's* "fire all five in parallel, not worth $0.18" `[REJECTED]` — it is worth it, and it is documented. Moot in Phase 1 (single locale). |

Two further corrections that change the product, not just the code:

- **Six locales per SMB is a liability, not a feature.** Six machine-translated copies of one bakery's LocalBusiness content, hreflang-linked, is the textbook scaled-content-abuse pattern the same SEO document spends §6.3 defending against. **Default locale count = 1.** A second is offered where plausible (NL→+EN, BE→NL+FR). The fan-out machinery stays; the default changes. *framework critique* `[ADOPTED]`. This alone cuts generation cost ~60%, cuts latency, and removes the largest SEO risk.
- **There is no build compute in this stack.** ffmpeg, avifenc, brotli-11 and zstd-19 cannot run in a Worker (`CompressionStream` is gzip/deflate only; no codecs; 128 MB isolate). Three dimensions specified them anyway. **Phase 1 accepts no user video at all** — hero video comes exclusively from a pre-vetted Pexels pool we re-host. Image derivatives are produced by the **Cloudflare Images binding inside the Worker, once at publish, written back to R2 as plain objects**, which also converts a recurring monthly transformation meter into a one-time cost. HTML is stored uncompressed and compressed by the edge. *seo/framework/ux critiques* `[ADOPTED]`.

---

## 1. Stack and topology

### 1.1 Registrable domains (the first one-way door)

Two zones. Every dimension's critique converged here independently and they are right.

| Zone | Contents | Why |
|---|---|---|
| **`aibuilder.app`** (control plane — client must nominate/purchase before code freeze) | `www.` marketing · `app.` dashboard+editor · `api.` API · `preview.` draft preview | Attacker-influenced tenant HTML must not share a registrable domain with the session cookie. `mijnsaas.com` is not on the PSL, so a tenant subdomain can set `.mijnsaas.com` cookies today. |
| **`mijnsaas.com`** (tenant plane) | `<slug>.mijnsaas.com` · all Cloudflare-for-SaaS custom hostnames · `cdn.` media · apex = noindex explainer | Slugs get indexed and printed on business cards; this cannot move later. Submit to the **PSL PRIVATE section** in Phase 1 (months of lead time). |

Consequences that are now decided, not discovered: `__Host-` cookies everywhere; passkey `rpID = app.aibuilder.app` and **may never be broadened to an apex** (a later PSL entry would permanently brick every credential — write it as a test); HSTS `preload; includeSubDomains` on `aibuilder.app` apex and on `mijnsaas.com` apex, but **never** `preload` on a customer's custom domain; a Safe Browsing listing of one phishing tenant takes down `mijnsaas.com` only, never the marketing site or the money path.

`[REJECTED]` — the *security critique* claimed PSL and HSTS-preload conflict. They are orthogonal; HSTS is unaffected by the PSL, as the security document itself correctly said. Both ship.

### 1.2 Surfaces

| Surface | Framework / runtime | Cloudflare product | Binding style | Why (runner-up) |
|---|---|---|---|---|
| Marketing `www.aibuilder.app` | **Astro 6, `output:'static'`, no adapter** | Workers **Static Assets** (assets-only Worker, no `main`) | Route `www.aibuilder.app/*` | Zero JS by default; the modal is one React island. Static asset requests are free — 0 invocations. *(Runner-up: Next 16 + OpenNext — a React runtime and a billed invocation on a 6-page brochure.)* |
| Dashboard + editor `app.aibuilder.app` | **React Router v7, framework mode** | Workers + `@cloudflare/vite-plugin` | Route `app.aibuilder.app/*` | First-class documented Workers target, no adapter shim; typed loader/action is the shape of an auth'd dashboard. This surface gates revenue, so it gets the boring choice. *(Runner-up: TanStack Start — better inference, ~25% faster, but still RC with an open `cloudflare:workers` resolution bug. Revisit at 1.0; migration cost is low.)* |
| API `api.aibuilder.app` | **Hono 4** | Workers | Route `api.aibuilder.app/*` | Thin router; no framework needed. |
| Billing `api.aibuilder.app/webhooks/stripe` | **Hono 4**, separate Worker | Workers | Route (more specific, wins) | Capability separation: the **only** Worker holding `STRIPE_SECRET_KEY`. |
| Generator | **Cloudflare Workflows** + 3 Durable Objects | Workflows, DO (SQLite), Queues | Service binding from api; no public route | The **only** Worker holding `ANTHROPIC_API_KEY`. Workflows is the only primitive with no 15-min wall-clock cap and with per-step memoisation. *(Runner-up: Queues — 15 min consumer cap kills it.)* |
| Tenant renderer `*.mijnsaas.com` | **Hono 4 + `packages/site-kit`** (`hono/jsx` → string) | Workers, R2, KV, Cache API | Route `*/*` on the tenant zone | Renderer must run *inside* workerd for draft preview and publish, so it is a library, not a per-site build. No D1 binding at all. |
| Media `cdn.mijnsaas.com` | **Hono 4**, tiny | Workers, R2 (read-only) | Route `cdn.mijnsaas.com/*` | Forced `Content-Type` from DB, `nosniff`, `default-src 'none'; sandbox`. Cookieless. |

**Routing correction `[ADOPTED]`:** Routes take precedence over Custom Domains on the same hostname. The framework document's "Custom Domains carve themselves out of `*/*`" is backwards and would have made every marketing request a billed renderer invocation. **Every surface is bound as a Route.** On the tenant zone, `cdn.mijnsaas.com/*` is a **blank route with no Worker** — the documented carve-out — so `cdn` sits outside `*/*` and the renderer cannot fetch itself. This must be proven on a deployed zone in Phase 1, not "before Phase 3".

### 1.3 Storage and residency

| Store | Contents | Residency |
|---|---|---|
| **D1 `aibuilder-cp`** (control plane) | identity, orgs, memberships, sessions, billing, slug registry, site identity + routing, custom domains | `--location eu`, **immutable, set at creation** |
| **D1 `aibuilder-shard-000`** (first shard) | versions, pages, page_translations, blog, media, leads, generation ledger, audit | `--location eu` |
| **R2 `aibuilder-blobs`** | SiteDoc JSON, materialised HTML, sitemaps, AI transcripts | `jurisdiction: eu`, binding-only, never public |
| **R2 `aibuilder-media`** | uploads + derivatives + re-hosted stock | `jurisdiction: eu`, binding-only |
| **R2 `aibuilder-quarantine`** | unverified uploads, 24h lifecycle delete | `jurisdiction: eu` |
| **KV `ROUTING`** | host → `{siteId, shardId, liveVersion, locales, defaultLocale, indexState}` | edge |
| **DO** `JobHub`, `BudgetDO`, `QuotaDO` | SSE log, spend, quotas | **`env.NS.jurisdiction('eu').idFromName(...)` — always** |

D1 jurisdiction, R2 jurisdiction and DO jurisdiction are all set-at-creation and unchangeable. `database_id` is still `REPLACE_WITH_REAL_ID` — nothing has been applied `--remote` — so **this is the last hour in which these are free.**

EU-jurisdiction R2 is addressed at `https://<account>.eu.r2.cloudflarestorage.com` for presigning. Signing the wrong host is unfixable after the fact because the host is covered by the signature. `[ADOPTED]` from the security critique.

`[REJECTED]` — the *framework critique's* "build the tiered-cache miss path on a public R2 domain from day one". A public R2 custom domain conflicts with the binding-only EU-jurisdiction decision, which outranks it. Phase 1 miss path is a direct R2 binding read from an EU-resident bucket to an EU colo (~20–40 ms) serving European visitors of European businesses. The tiered path is a **Phase 3 optimisation with a measurement gate** (RUM p95 TTFB on low-traffic tenants), implemented as a second zone if it is ever justified.

---

## 2. Monorepo layout

```
/home/user/aibuilder/
├─ pnpm-workspace.yaml            pnpm 10 workspaces
├─ turbo.json                     task graph: typecheck/build/test/eqp fan-out with caching
├─ package.json                   root scripts only; no runtime deps
├─ tsconfig.base.json             strict, noUncheckedIndexedAccess, verbatimModuleSyntax, moduleResolution bundler
│
├─ apps/
│  ├─ marketing/                  Astro 6 static. Hero, pricing, legal. Hosts the onboarding modal island.
│  ├─ api/                        Hono. Onboarding, drafts, uploads, slug/geo, submit, SSE proxy, leads, claim.
│  ├─ generator/                  Workflow entrypoint + JobHub/BudgetDO/QuotaDO. Sole holder of ANTHROPIC_API_KEY.
│  ├─ renderer/                   Hono. Serves *.mijnsaas.com from R2. No D1 binding.
│  ├─ media/                      Hono. Serves cdn.mijnsaas.com from R2 with forced headers.
│  ├─ billing/                    [Phase 2] Hono. Sole holder of STRIPE_SECRET_KEY.
│  └─ app/                        [Phase 2] React Router v7 dashboard + live editor.
│
├─ packages/
│  ├─ site-schema/                THE CONTRACT. Zod gen schemas, SiteDoc, normalize/genToDoc, slot derivation, migrations.
│  ├─ site-kit/                   hono/jsx section components, design-DNA tokens, CSS assembly, JSON-LD builder. Depends ONLY on site-schema.
│  ├─ core/                       Domain logic: publish pipeline, R2 keys, slug policy, hreflang, sitemap, quality gate. Takes Env as a parameter.
│  ├─ ai/                         Anthropic client wrapper, prompt blocks, cache layout, repair ladder, usage→cost ledger.
│  ├─ db/                         Drizzle schemas for cp + shard, shard router, typed queries, EXPLAIN-QUERY-PLAN fixtures.
│  ├─ ui/                         React components shared by the marketing island and (Phase 2) the dashboard. Tailwind v4.
│  └─ config/                     tsconfig / eslint / tailwind presets, eslint-plugin-boundaries rules.
│
├─ migrations/
│  ├─ cp/                         Control-plane D1 migrations (0001…)
│  └─ shard/                      Shard D1 migrations (0001…)
│
└─ .github/workflows/ci.yml       typecheck, unit, EQP gate, contrast gate, Lighthouse gate, gitleaks
```

**Boundary rules, enforced by `eslint-plugin-boundaries`:** `site-schema` depends on nothing. `site-kit` depends only on `site-schema` — no bindings, no `env`, so it renders in a plain test runner. `core` may touch bindings but only via an injected `Env`. Packages never depend on apps; apps never import each other. Internal packages are **unbuilt** (`"exports": {".": "./src/index.ts"}`) and bundled by each app's Vite/esbuild pass — no build ordering, no stale `dist/`.

`Env` types come from `wrangler types` in `pretypecheck`, per app. Never hand-written.

---

## 3. Request lifecycles

### (a) A visitor hits a generated tenant site

`GET https://bakkerij-jansen.mijnsaas.com/nl/diensten/`

1. Cloudflare for SaaS terminates TLS (custom hostname) or the wildcard cert terminates `*.mijnsaas.com`. Traffic enters the tenant zone and matches route `*/*` → `renderer`.
2. Renderer reads `KV_ROUTING.get(host)` → `{siteId, liveVersion, locales, defaultLocale, indexState, canonicalHost}`. One read serves the whole site. Miss → 404 with a neutral body; **an unrecognised Host is never served a default site.**
3. If `host !== canonicalHost` and the domain is flagged primary → one 301, path- and query-preserving, exactly one hop.
4. Cache lookup on a **synthetic versioned key**: `cache.match("https://c.internal/" + siteId + "/" + liveVersion + "/" + locale + "/" + path)`.
   - The key begins with `siteId`, which is what makes this multi-tenant-safe. `[ADOPTED]` from the SEO critique's fatal #1 — the default Workers cache is keyed on path+query **excluding host**, so any design that relies on `Cloudflare-CDN-Cache-Control` for tenant HTML serves one bakery's `/nl/` on every other tenant's domain. **We never set `Cloudflare-CDN-Cache-Control` on tenant HTML.** Only the explicit synthetic key is used.
5. HIT → return (~1–3 ms CPU, zero storage reads).
6. MISS → `R2_BLOBS.get("sites/{siteId}/{liveVersion}/{locale}{path}index.html")`. `ctx.waitUntil(cache.put(key, clone))` with an internal `max-age=31536000`. **D1 is never touched on this path.** This resolves the schema document's self-contradiction (pre-built bundle vs. per-request D1 lookups) in favour of pre-built: the tenant read path is KV + Cache + R2, full stop.
7. Response headers: browser `Cache-Control: public, max-age=60, stale-while-revalidate=600`; `ETag: W/"{version}-{renderSha8}"`; the tenant CSP (§7); `X-Robots-Tag` derived from `indexState`; `Content-Language`; `Link: rel=preload` for the hero poster and the one font.
8. `ctx.waitUntil` writes one Analytics Engine data point — first-party, server-side, zero client bytes, zero cookies, no consent question. This is the resolution of the three-way contradiction between the dimensions: the Cloudflare Web Analytics beacon is itself a third-party script from `static.cloudflareinsights.com` and is **banned** on tenant sites.

**Publishing is a KV pointer flip.** Because the version is in the cache key, old entries become unreachable and age out. There is no purge call, no purge quota, no purge race. There *is* a bounded ≤60 s KV propagation window — stated honestly, not claimed away `[ADOPTED]` — and the editor's "view live site" link carries `?v={version}` so the owner never sees a stale page.

### (b) User completes onboarding → site generated

1. Modal opens on `www.aibuilder.app` (`/start`, real `pushState` history). First keystroke on step 1 → `POST api.aibuilder.app/v1/drafts` gated by **Turnstile at draft creation**, not at submit `[ADOPTED]` — the expensive endpoints (`media/sign`, and later any model call) are all keyed on `draft_id`, so a client-minted draft id is an open relay. The server mints `draft_id` and `idempotency_key`, both **server-side, crypto-random**, and returns a signed `__Host-aib_draft` cookie.
2. Steps 2–6 autosave (400 ms local debounce, 1200 ms server debounce, `sendBeacon` on `pagehide`). Media uploads go browser → presigned PUT → **quarantine bucket** (`content-length` bound into the signature), then `commit` enqueues a Queue message that magic-byte-sniffs, re-encodes through the Images binding with `metadata:'none'`, writes derivatives to R2, and promotes the row.
3. Submit: Turnstile again → Zod intake validation → `QuotaDO.consume([ip, ip24, email, phone, identityHash])` → `BudgetDO.reserve(estMicro)` → a Haiku 4.5 policy screen on the free-text description (~$0.001, blocks prohibited verticals before Opus spend) → one D1 `batch()` on the control plane creating a **provisional organisation** (zero memberships), user row, site row (slug reserved by a total unique index), and a `generation_jobs` row on the shard.
4. `WORKFLOW.create({ id: jobId, params })`. Instance id is the job id — `job_01H…`, which matches `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`. `[ADOPTED]`: the framework/aigen proposal `gen:{siteId}:{intakeHash}` is **syntactically invalid** (colons) and, once sanitised, would lock a tenant out of regeneration for the 30-day retention window after any terminal failure. Idempotency lives in D1 on `uq_jobs_idem(org_id, idempotency_key)`.
5. The modal opens `GET /v1/jobs/{jobId}/events` (SSE, authorized by the draft cookie on connect **and** on every `Last-Event-ID` resume). Events come from `JobHub` DO; SSE `id` is the DO-assigned `seq`, never the D1 autoincrement `[ADOPTED]` — using the autoincrement would put a write to the single D1 primary in the critical path of every streamed line. Heartbeat comment every 15 s. Falls back to 2 s polling after two failed reconnects.
6. Workflow steps (§6). Publish is atomic: SiteDoc v1 → R2, page projection → shard D1, HTML materialised → R2, KV pointer set **last**.
7. Site is live at `<slug>.mijnsaas.com` immediately — the reveal shows the real domain, which is the whole point of the peak moment — but served `X-Robots-Tag: noindex, nofollow` and `robots.txt: Disallow: /` until the emailed claim link is clicked. `[ADOPTED]` from the ux critique's impersonation fatal: publishing a real third party's verified name, address and hours to an indexable public URL before any email verification is an impersonation and GDPR problem. A single header solves it now.
8. Claim: single-use 128-bit token, bound to `email_normalized`, 72 h, atomically consumed (`UPDATE … WHERE consumed_at IS NULL`, assert `meta.changes === 1`). On claim: membership created, org de-provisionalised, anon cookie deleted and a fresh session minted (session fixation), `index_state` becomes eligible. Unclaimed after 30 days → hard delete of D1 rows **and** the `drafts/{draft_id}/` R2 prefix.

### (c) Regenerate → paywall → Stripe trial → regeneration

1. Editor "Regenerate" is a server-side gate, never a UI state. `POST /v1/sites/:id/regenerate`.
2. API loads `organisations.entitlement` (a deliberate denormalisation, one row read on the hot path) and refuses unless `∈ ('trialing','active')`, writing `generation_jobs.status='blocked_paywall'`. The disabled React button is decoration.
3. Blocked → client opens Stripe Checkout. Session is created **server-side only**, `price_id` from a server allowlist, `client_reference_id = org_id`, `payment_method_collection: "always"`, `trial_period_days: 7`, `trial_settings.end_behavior.missing_payment_method: "cancel"`, Stripe Tax on (VAT is a Phase-2 schema concern for a €9,99 EU price point, not Phase 3).
4. Before creating the session: look up prior trials by `email_normalized` **and by `card.fingerprint`**, which is what actually stops "new email, same card".
5. `checkout.session.completed` → `worker-billing`. Raw body read first, `constructEventAsync` + `Stripe.createSubtleCryptoProvider()`, `event.livemode` checked against the environment. Insert-before-process into `stripe_events` with a **claim token** guard, not a bare status check `[ADOPTED]` — D1 has no interactive transactions, so two concurrent redeliveries both pass a plain `status <> 'processed'` test. Then **re-read the subscription from the Stripe API** and persist current state; event ordering becomes irrelevant. `subscriptions` and `organisations.entitlement` are written in the same `batch()`.
6. Entitlement flips. The client retries regenerate. `BudgetDO` enforces the per-org ceiling; `QuotaDO` enforces 2 regenerations / 30 days.
7. Regeneration writes a **new draft version**. The live version serves untouched throughout; publish is a pointer flip; rollback is a pointer flip back. Zero downtime, and a failed regeneration is invisible to the public.

---

## 4. The site-document contract

`packages/site-schema` is the keystone. **Three artifacts, one authoring source.**

**Why three and not one.** Structured Outputs' JSON-Schema subset rejects recursive schemas outright, and the SDKs strip string/number constraints (`pattern`, `maxLength`, `minimum`) before sending, validating them client-side instead. So a single richly-constrained recursive schema is doubly wrong: the shape cannot be sent, and the constraints fire as a hard client throw *after* you have paid for a 30K-token generation. The *aigen* two-layer split was right about the problem; the *aigen critique* was right that duplicating 17 section types by hand creates permanent drift. The synthesis:

1. **`gen/` — model-facing.** Flat, non-recursive, `additionalProperties:false`, every field required and `.nullable()` (never `.optional()` — an optional field lets the model silently skip a slot; a nullable one forces a decision). Bounded values are **enums**, which *are* enforced by grammar-constrained decoding. No `pattern`, no `maxLength`, no `min`/`max`. Three documents: `SiteStructureGen`, `LocaleBundleGen`, `BlogPostGen`.
2. **`normalize.ts` — deterministic repair, then `genToDoc()`.** Truncates over-long titles at a word boundary, lowercases and validates hex, clamps array lengths, drops unknown slot ids, substitutes fallback media refs, dedupes section ids. **Repairs; does not throw.** Only genuinely-missing copy escalates to one model repair turn (a *user* turn carrying `{path, problem, constraint}` — assistant prefill is a 400 on Opus 5), capped at 2 rounds.
3. **`doc.ts` — `SiteDoc`.** The renderer input, editor form model, and R2 storage shape. Its types are **derived** from the gen types (`z.infer` + resolved refs), never re-authored, so there are no 17 section definitions to keep in sync.

**The claim "the AI physically cannot emit something the renderer can't draw" is withdrawn** `[ADOPTED]`. The honest statement: *schema-valid by construction (enums + grammar), semantically valid by `genToDoc()` + a lint pass (contrast, required fields, section-type compatibility), and safe by the four invariants below regardless of either.*

### The four invariants — the actual security boundary

1. **No model string reaches the DOM except as a text node or a whitelisted attribute value.** The renderer only ever calls `escapeHtml()`. No `innerHTML`, no markdown parser, no rich-text runs. Emphasis comes from section structure, not inline markup.
2. **The model cannot author a URL.** Every link is a symbolic ref: `{kind:"page",pageId}` / `{kind:"anchor",sectionId}` / `{kind:"tel"|"whatsapp"|"email"|"route"}` / `{kind:"external",refId}` where `refId` indexes a server-built allowlist. `tel:`/`wa.me` links are built by code from the CHECK-constrained `phone_e164` column. *Scheme allowlist is `https:` only for external refs, stated explicitly* `[ADOPTED]`.
3. **The model cannot author CSS.** It picks a `dnaId` from a closed enum plus ≤6 bounded knobs. Code resolves those to OKLCH-derived custom properties.
4. **The model cannot author JSON-LD.** It supplies typed inputs (`schemaOrgType` enum, `priceRange` enum); code builds the graph from D1 facts and serialises with `<` → `\u003c`.

Because of these, a fully successful prompt injection yields bad copy, not code execution. **But the reframe is honest** `[ADOPTED]`: the contract defeats *code injection*, not *content abuse*. Bad copy on a live public site under our own brand — scam offers, fake medical claims — is itself the attack, and it is handled by the Haiku intake screen, the URL reputation check, the pre-publish moderation pass, and the nightly rescan, all specified in §8.

### `SiteDoc` shape (summarised)

```
SiteDoc {
  schemaVersion: 1
  siteId, versionId
  theme:   { dnaId, paletteVariant, accentHueShift, typeScaleId, radiusId,
             densityId, motionId, colorMode, tokens: { …resolved OKLCH… } }
  locales: { default: "nl", enabled: ["nl"] }
  chrome:  { navStyle, footerStyle, whatsappEnabled }
  pages:   [ { pageId, pageKey, role, noindex, showInNav, sortOrder,
               sections: [ Section ],                    // flat, typed, ZERO prose
               perLocale: { nl: { path, slug, title, description, ogMediaRef } } } ]
  copy:    { nl: { [slotId]: string } }                  // flat map, derived keys
  media:   { [refId]: { r2Key, w, h, blurhash, dominantColor, credit } }
  links:   { [refId]: { href } }                         // server-built allowlist
  jsonLdInputs: { schemaOrgType, priceRange, paymentAccepted[], amenities[], … }
  facts:   { businessName, address, geo?, phoneE164, whatsappE164, hours, … }  // FROM D1, never from the model
  blog:    [ BlogPost ]
}
```

**Slot ids are derived, never authored** `[ADOPTED]`. The *aigen* schema had the model emit `headlineSlot: z.string()` while claiming "the model cannot invent a slot id" — self-contradictory and load-bearing, because it makes `validateBundle` compare model output against model output. Slot ids are computed identically by the renderer, the editor, the inventory deriver and the translation validator:

```
`${section.id}.headline`   `${section.id}.items.${i}.title`   `page.${pageId}.meta.title`
```

Every stored document carries `schemaVersion`; `migrations/` holds pure `vN → vN+1` functions; the renderer upgrades on read and persists on next publish. AI-generated documents outlive schema revisions and you cannot re-run generation to fix them — it costs money and changes the customer's site.

---

## 5. D1 schema

### 5.1 The sharding decision (taken now, because it is the real one-way door)

**One control-plane D1 + N shard D1s keyed by `org_id`, launching with exactly one shard.** The critiques were right on all three counts: the "~60k tenants" measurement was taken on a database containing zero rows in `leads`, `audit_log`, `media_assets`, `sessions` and `generation_job_events`; a D1 database is single-threaded and processes queries one at a time, so **write throughput binds years before 10 GB does**; and the escape hatch was blocked by global uniqueness in the schema as written.

Resolved by placing global-uniqueness concerns in the control plane and making `content_blobs` shard-local (cross-tenant blob dedupe was worth almost nothing — page trees are per-tenant unique, and media dedupe is by sha in the R2 key, needing no D1 coordination).

**Migrations 0001–0009 are rewritten into `migrations/cp/` and `migrations/shard/` before the first `--remote` apply.** "Forward-only" begins at the first remote apply; `database_id` is still a placeholder, so nothing has been applied. This is the correct and final moment.

### 5.2 Control plane — `aibuilder-cp`

| Table | Purpose |
|---|---|
| `locales` | Global locale registry. Zero locale-named columns anywhere in the system. |
| `industries`, `industry_groups`, `industry_translations` | Taxonomy, design-DNA preset per row, localized labels + `search_terms` aliases. |
| `reserved_slugs` | System/brand/abuse-reserved labels **and retired tenant slugs**, now enforced by a trigger. |
| `users` | Identity. `password_hash` stays NULL forever — magic link + passkeys only. |
| `organisations` | Billing + entitlement owner. `provisional` flag; `entitlement` denormalised for the one-row paywall read. |
| `memberships` | user ↔ org ↔ role. **An org with zero memberships is unreachable by every authenticated path** — this is the isolation invariant, enforced by a lint rule and a test. |
| `sessions` | `WITHOUT ROWID`, `token_hash` PK — auth is a single page read. |
| `auth_tokens` | Magic-link / verification, single-use, atomically consumed. |
| `site_claim_tokens` | Separate table (adding a value to `auth_tokens.purpose`'s CHECK would need a 12-step rebuild). |
| `anon_sessions` | Pre-account draft ownership, 7-day TTL. |
| `onboarding_drafts` | Server-side draft/resume before a user exists. 30-day purge, **with the `drafts/{id}/` R2 prefix**. |
| `sites` | **Identity + routing only**: id, org_id, `shard_id`, slug, status, `default_locale`, `published_version_id`, `canonical_host`, `index_state`. The source of the KV routing manifest. |
| `custom_domains` | Cloudflare-for-SaaS hostnames, DCV state, primary flag. |
| `stripe_customers`, `subscriptions`, `stripe_events`, `invoices` | Billing. |
| `abuse_events`, `csp_reports` | Ops signals feeding a daily digest. |

### 5.3 Shard — `aibuilder-shard-000`

| Table | Purpose |
|---|---|
| `site_versions` | Immutable snapshot unit; the version DAG. Undo/rollback/regenerate all operate here. |
| `site_locales` | Which locales *this* site publishes; partial unique index guarantees exactly one `x-default`. |
| `pages` | Logical page, locale-independent. `page_key` is the stable join key across regenerations. |
| `page_translations` | Per (page, locale): path, SEO, `render_sha256`, `content_changed_at`, content pointer. **A build-time projection of SiteDoc, not a request-path table.** |
| `page_slug_aliases` | Retired slugs → 301 forever. Keyed on `page_key` + locale, which is what makes "the stored slug wins on regeneration" actually implementable. |
| `blog_posts`, `blog_post_translations` | Same shape for posts. |
| `content_blobs` | Refcount + GC ledger for R2 objects. Shard-local. |
| `media_assets` | R2 keys, dimensions, blurhash, dominant colour, status incl. `quarantined`. |
| `upload_sessions` | Multipart upload id, parts, expiry, reaper — R2 bills unaborted multipart parts indefinitely. |
| `site_reviews` | `reviews_source` gated; `verified_at`, `external_id`, `platform`. |
| `leads` | Contact/booking submissions. `purge_after`, indexed by email/phone for erasure. |
| `generation_jobs` | Run ledger, one row per run. |
| `generation_calls` | **New.** One row per Anthropic call — step, attempt, effort, tokens, cache tokens, cost, `stop_reason`, `refusal_category`, `repair_rounds`. Rolled up into `generation_jobs`. |
| `generation_job_events` | Durable mirror of the DO event log, for `Last-Event-ID` resume past DO lifetime. |
| `deployments` | Publish records. |
| `audit_log` | Actions. **Not** the editor undo journal. |
| `usage_counters`, `consent_log` | Coarse quota windows; consent accountability. |

### 5.4 Key decisions and adopted corrections

- **IDs:** prefixed ULID, 30 chars TEXT, `CHECK (id GLOB 'ste_[0-7]*' AND length(id)=30)`. Kept — but justified on **debuggability and index-cache locality only**. `[ADOPTED]` The billing rationale was invented: D1 bills rows, not pages ("a row that is 1 KB and a row that is 100 KB both count as one row"), and read replicas incur no extra charge. `sha256` is stored as `BLOB(32)`, not 64-char hex, and `idx_blobs_kind` is dropped (no query used it and it was larger than several data tables).
- **Where content lives:** D1 holds only what you filter, sort, join or authorise on. Page trees and the SiteDoc are always R2. `theme_tokens` (<8 KB) stays inline — the editor reads it every keystroke. `content_inline` is **removed from `page_translations`** `[ADOPTED]`: the rule "page trees always go to R2" made the inline branch dead code, confirmed by 28,800 rows of the author's own sizing database containing zero inline values.
- **Undo journal moves out of `audit_log`** `[ADOPTED]`. `before_json`/`after_json` at up to 32 KB means ~160k slider drags fill a 10 GB database, and nobody filters on those columns. The editor's undo ring lives in the `SiteDraftDO`'s storage and in R2 per version.
- **Soft delete:** `[ADOPTED]` — every partial index on `WHERE deleted_at IS NULL` is unusable unless the query text repeats the predicate, which is the exact bug the schema document claims to have caught on `idx_jobs_queue` and left in place on `sites.slug`, `custom_domains.hostname` and `users.email_normalized`. Fix: **total** `UNIQUE(slug)` and `UNIQUE(hostname)` alongside the partial live-lookup indexes (so a soft-deleted row still reserves its name, which slug retirement wants anyway), reads exposed through `live_sites` / `live_domains` views, plus a **CI gate that runs `EXPLAIN QUERY PLAN` over every shipped statement and fails the build on any `SCAN`**.
- **`content_blobs` refcount `[ADOPTED]` — this was a live data-loss bug.** There was no `AFTER UPDATE` trigger, so an editor save that repoints `content_sha256` from A to B leaves A at refcount 1 and B at 0, and the reaper deletes a live R2 object. Adds: `AFTER UPDATE OF content_sha256` triggers (decrement OLD, increment NEW, bump `last_ref_at`), removal of the `max(refcount-1,0)` clamp so drift aborts loudly, a `state` column (`live`/`tombstoned`), and a **two-phase reaper** — mark, wait past the grace window, re-verify refcount=0 in the same batch, then delete from R2.
- **Cross-tenant integrity `[ADOPTED]` via composite FKs, not triggers.** `UNIQUE(id, site_version_id)` on `pages` + `FOREIGN KEY (page_id, site_version_id) REFERENCES pages(id, site_version_id)` on `page_translations`, same for blog. The engine enforces this on every write with no trigger to forget. The ownership trigger becomes `BEFORE INSERT OR UPDATE` (it was UPDATE-only, and the schema's own documented `defer_foreign_keys` batch insert path bypassed it).
- **Sealing `[ADOPTED]`:** add `BEFORE INSERT ON pages`, `BEFORE DELETE ON pages`, `BEFORE DELETE ON page_translations`, and `BEFORE DELETE ON site_versions WHEN OLD.sealed_at IS NOT NULL AND OLD.status='published'`. Deleting a sealed published version was silently unpublishing a paying customer's site via `ON DELETE SET NULL` *and* freeing its blobs for GC.
- **Idempotency `[ADOPTED]`:** `uq_jobs_idem` becomes `UNIQUE(org_id, idempotency_key)`. Globally unique + client-supplied + ULID-shaped was a cross-tenant DoS and an existence oracle; combined with an unauthenticated `/jobs/:id/events` it handed out other tenants' job ids. Keys are now server-minted.
- **Queue index `[ADOPTED, corrected form]`:** neither the partial version nor the plain composite is right. Sentinel column: `queue_ready_at` set on enqueue, NULLed on terminal transition, `CREATE INDEX ... ON generation_jobs(queue_ready_at) WHERE queue_ready_at IS NOT NULL`. Small, sorted, immune to predicate matching, and it does not grow forever with terminal jobs.
- **GLOB anchoring `[ADOPTED]`:** every validation pattern gains a negated class. `phone_e164 NOT GLOB '*[^0-9+]*'`, `id NOT GLOB '*[^0-9A-HJKMNP-TV-Z_]*'`. `+31<script>` passed the shipped `GLOB '+[0-9]*'` and lands in a `wa.me` href and a JSON-LD `telephone` field. Database CHECKs are the second line; Zod at the boundary and contextual escaping at render are the first.
- **Anthropic ledger `[ADOPTED]`:** add `CHECK (thinking_type <> 'disabled' OR effort IN ('low','medium','high'))` — verified: `disabled` returns 400 at `xhigh`/`max`. **Drop `thinking_tokens`** — the Messages API `usage` object has no such field; thinking is billed inside `output_tokens`, so the column would always be 0 and any cost formula adding it double-counts.
- **Reserved slugs `[ADOPTED]`:** `reserved_slugs` had no FK, no trigger and no reference — a site with `slug='www'` inserted cleanly. Add a `BEFORE INSERT OR UPDATE OF slug ON sites` trigger, and seed `_acme-challenge`, `autodiscover`, `mx`, `imap`, `pop`, `wpad`, `cdn`, `preview`, plus homoglyph normalisation and trademark-lookalike (Levenshtein ≤1) rejection.
- **Migration rule #3 is deleted and replaced `[ADOPTED]` — it was an instruction to destroy production data.** `defer_foreign_keys` defers constraint *checking*; it does not disable FK *actions*. A 12-step rebuild of a cascade parent deletes every child, and `foreign_key_check` passes clean afterwards. Since D1 forbids `PRAGMA foreign_keys=OFF`, the stated escape hatch does not exist. New rule: **a cascade-parent table can never be rebuilt in place on D1.** Use expand→migrate→contract only (`ALTER TABLE ADD/DROP/RENAME COLUMN` never triggers a rebuild), and gate every migration in CI on a per-table row-count snapshot taken before and after, because `foreign_key_check` will not catch it.
- **`ANALYZE`:** D1 does not run it for you and several plans flip on `sqlite_stat1`. The EQP fixtures run against a seeded database with `ANALYZE` applied, matching production.
- `[REJECTED]` — the schema document's own flagged worry about `duration_ms` being a `VIRTUAL` generated column. D1 documents generated columns explicitly, including `VIRTUAL` as the default. Keep it.

---

## 6. AI generation pipeline

### 6.1 Decomposition — decided

**Per-step Workflow, one Anthropic call per step. Not one giant call, not Queues, not `waitUntil`.**

One call for a whole site means a single schema defect or one `stop_reason: "max_tokens"` destroys the entire spend with no partial salvage. Per-step memoisation is simultaneously the reliability story and the cost-control story: a failed blog post retries alone while everything before it stays memoised. Queues and DO alarms both cap at 15 minutes wall clock; a Workflow step's ceiling is **30 minutes** (`[ADOPTED]` — the "unlimited wall clock per step" claim is half-true and the margin is 2×, not infinite), and the `StepConfig` default is 10 minutes, so **every step gets an explicit `timeout`** and each step's SDK timeout is set strictly below its step timeout so the SDK aborts first and produces a typed error the retry ladder can classify.

**Phase 1 steps (single locale):**

| # | Step | Model | Config |
|---|---|---|---|
| 1 | `validate-intake` | — | Zod + Haiku 4.5 policy screen (~$0.001) |
| 2 | `resolve-media` | — | R2 uploads + curated Pexels pool, cached by composed-query hash |
| 3 | `plan-brief` → `SiteStructureGen` | `claude-opus-5` | `effort:"high"`, `thinking:{type:"adaptive",display:"summarized"}`, `max_tokens:32000`, `task_budget:{type:"tokens",total:40000}`, streaming |
| 4 | `copy-primary` → `LocaleBundleGen` | `claude-opus-5` | same; `max_tokens:48000` |
| 5 | `blog-0`, `blog-1` → `BlogPostGen` | `claude-opus-5` | `effort:"medium"`, `max_tokens:16000` (separate cache namespace — different grammar) |
| 6 | `legal` | — | **Deterministic pre-translated templates.** You do not want a hallucinated GDPR clause on a European SMB's site. |
| 7 | `assemble` | — | `normalize()` → `genToDoc()` → lint (contrast, refs, section compatibility) |
| 8 | `audit` | — | Perf/a11y/CSP budgets; fails the publish |
| 9 | `render` | — | site-kit → HTML per (locale, page), including `/` |
| 10 | `publish` | — | SiteDoc + HTML → R2, projection → shard D1, KV pointer last |

**Every emit is inside a `step.do()` or idempotent on `(runId, phase, seq)`** `[ADOPTED]`. `run()` is replayed on every resume, so an `emit()` in the bare function body re-fires on each retry, duplicating rows in the append-only log and making the progress bar jump backwards — damaging the one thing the DO exists for.

Steps pass **R2 keys, never payloads** (non-stream `step.do()` returns cap at 1 MiB). Every step is idempotent; they will be retried.

### 6.2 Call shape (exact)

`client.beta.messages.stream()` — never `messages.parse()` for the large calls. `[ADOPTED]`: `parse()` does not stream and never did; the `stream=` argument was removed precisely because it never streamed. The design correctly requires streaming for large `max_tokens`, so `parse()` is the wrong entry point for exactly the call the architecture is built on. `parse()` is kept only for small non-streaming calls.

```ts
const stream = client.beta.messages.stream({
  model: "claude-opus-5",
  max_tokens: 32_000,
  betas: ["server-side-fallback-2026-07-01", "task-budgets-2026-03-13"],
  fallbacks: "default",
  thinking: { type: "adaptive", display: "summarized" },
  output_config: {
    effort: "high",
    task_budget: { type: "tokens", total: 40_000 },
    format: zodOutputFormat(SiteStructureGen, "site_structure"),
  },
  system: SYSTEM_BLOCKS,          // last block carries cache_control
  messages: [ businessFacts, task ],
});
const msg = await stream.finalMessage();
if (msg.stop_reason === "refusal") → needs_review (read stop_details.category)
if (msg.stop_reason === "max_tokens") → raise & retry once, then split
const parsed = SiteStructureGen.safeParse(JSON.parse(textOf(msg)));
```

`fallbacks: "default"` is on by default per current guidance — a decline before any output is not billed, and the rescue is repriced automatically. `maxRetries: 0` on the SDK client: Workflows owns retries so every attempt is durable, observable and ledgered; SDK retries would double-retry invisibly and wall clock could reach `timeout × (maxRetries+1)`. TS SDK timeouts are **milliseconds**.

Always branch on `stop_reason` before reading `content`. `stop_details` is populated **only** on `refusal`. A refusal is a terminal `needs_review` state with honest user-facing copy and a route back into the modal — never a silent retry, which burns full price and refuses again.

### 6.3 Prompt cache layout

```
system: [ role + safety + the "you never emit markup/CSS/URLs" contract   (~4K)
          section catalogue: 17 types × variants, slot inventories        (~8K)
          design-DNA playbook + industry→DNA mapping                      (~6K)
          two compact golden exemplars                                    (~4K) ] ← ONE breakpoint, 5m TTL
messages:
  user: <business_facts nonce="…">  untrusted tenant data + media manifest  ← uncached, LAST
  user: <task>  "emit SiteStructure"
```

**One breakpoint, 5-minute TTL, industry tokens and tenant data after it.** `[ADOPTED]` on three counts: the 1h TTL costs a **2×** write (not 1.25×) and needs three prefix-sharing requests inside the hour to break even, which early traffic will not produce; a cache read refreshes the timer for free so requests <5 min apart keep a 5m entry warm indefinitely; and putting per-industry tokens *inside* the cached prefix fragments one namespace into 5–8, the exact mistake the design warned against one sentence earlier. Two of four breakpoints are held in reserve.

Caching pays for itself **within a single job** — steps 4 onward read what step 3 wrote, seconds apart. Cross-job hits are upside, not the plan. And because parallel requests with identical prefixes all pay full price (none can read what the others are still writing), any future fan-out sends one request, awaits the first streamed token, then fires the rest.

`usage.cache_read_input_tokens > 0` is asserted in a `@cloudflare/vitest-pool-workers` test and alerted on in production. A silent invalidator (unsorted JSON, a timestamp) makes you pay 1.25× for nothing.

Effort is pinned to one value across the structure+copy namespace in Phase 1. **Phase 2's translation fan-out uses the per-message effort system message** (`{role:"system", content:[], output_config:{effort:"low"}}`, beta `mid-conversation-output-config-2026-07-01`) rather than a top-level change, which would invalidate the messages cache.

### 6.4 Progress transport

**SSE from a per-job `JobHub` Durable Object.** One-way, native `EventSource` auto-reconnect, `Last-Event-ID` resume for free, survives corporate proxies, no framing code. Events buffer in DO SQLite storage and flush to `generation_job_events` in batches. Heartbeat comment every 15 s — nothing else keeps a stream alive through a long silent thinking phase.

`[REJECTED, with reason]` — the *ux critique* is factually right that SSE cannot use WebSocket Hibernation, so the DO is billed for duration. But a 60–90 s generation with one or two connected clients is fractions of a cent, and SSE's free reconnect-and-resume semantics are worth more than that at Phase 1 volume. WebSockets + Hibernation is a Phase 3 upgrade **if DO duration shows up in the bill**.

Cancellation calls the Workflow instance's `terminate()` — otherwise a cancelled job keeps burning tokens through the most expensive steps while the UI shows it stopped.

### 6.5 Cost per generation — derived, not asserted

`claude-opus-5`: $5/MTok in, $25/MTok out, cache read $0.50/MTok, cache write (5m) $6.25/MTok. **Thinking tokens bill as output and thinking is on by default on Opus 5.**

Single-locale generation, Phase 1 (4 Opus calls + 1 Haiku screen):

| | tokens | $ |
|---|---|---|
| Cache write (first call, ~22K prefix @1.25×) | 27.5K equiv | $0.14 |
| Cache reads (3 × 22K @0.1×) | 6.6K equiv | $0.03 |
| Fresh input | ~8K | $0.04 |
| **Output incl. thinking** | **30–51K** | **$0.75–$1.28** |
| **Total** | | **$0.96 – $1.49** |

**Planning figure: $1.20 per free generation, hard-ceilinged by `task_budget`.** The *aigen* document's $2.30 for six locales had **no line for thinking tokens at all** on a model where thinking is on by default `[ADOPTED]` — that number should not be planned against, and neither should its "11% of revenue".

Unit economics, corrected for VAT and Stripe:

- €9,99/mo billed annually = €119,88 gross. NL VAT-inclusive (21%) → €99,07. Stripe ~1.5% + €0.25 → **≈ €97 ≈ $105 net per paying customer per year.**
- At 15% free→paid conversion, each paying customer carries ~6.7 free generations ≈ **$8**.
- Therefore: **regeneration cap = 2 per 30 days, and a hard per-org model-spend ceiling of $18/year (≈17% of net).** `[ADOPTED]` — the *aigen* allowance of 10 regenerations/month at its own $2.30 was $23/month against $10.83/month of gross revenue. Colour, copy and layout edits in the editor are free and never call the model; only structural regeneration does.
- Worst case COGS: $8 + $18 = $26 / $105 = **25%**. Expected: $8 + ~$4 = **11%**.

Track **cost per completed site**, not per call — a cheap call that needs two repairs is not cheap.

---

## 7. SEO / i18n / perf non-negotiables

Every generated site must satisfy all of these, enforced at publish (the `audit` step fails the build) or in CI.

**URLs and i18n**
1. Every content URL is `/{locale}/…/` with a trailing slash, lowercase ASCII. There is no unprefixed content URL. Adding a 7th locale is three INSERTs and zero code changes.
2. **`/` is a 200 serving the default locale's content**, with `<link rel=canonical>` → `/{defaultLocale}/` and `x-default` → `/`. `[ADOPTED]` — a 308 on the single most-requested, flyer-printed URL of every tenant site is a self-inflicted LCP wound and trips "Avoid multiple page redirects". The cost is one extra R2 object per publish, which is free.
3. **Never geo-redirect and never redirect on `Accept-Language`.** Googlebot crawls from US IPs and sends no meaningful `Accept-Language`; a country redirect means the Dutch page is never indexed, hreflang reciprocity breaks and the whole cluster is discarded, and `Vary: CF-IPCountry` fragments the cache ~200×. Suggest via a fixed-position client-side hint bar; never redirect.
4. hreflang: every member of a cluster lists every member **including itself**; a locale with no translation of that page is **omitted, never substituted** — one non-reciprocal entry drops the entire cluster. Emitted in `<head>` and in the sitemap.
5. Localised slugs per locale (`/de/leistungen/`, not `/de/services/`), with locale-aware transliteration (`ä→ae`, `ß→ss`, `ĳ→ij`, `œ→oe`) — **not a generic NFD strip**, which yields the empty string for Greek, Cyrillic and Han and fails the `slug` CHECK at submit, after 82 seconds of user effort `[ADOPTED]`. Fallback to `{industry}-{city}`; the 63-char cap is applied **after** collision suffixing.
6. Slug stability is a database invariant: on regeneration the previously-published slug wins (joined on `page_key` + locale) and the new seed becomes a 301 alias, forever.

**Sitemaps and robots**
7. Per-locale sitemaps + an index at `/sitemap.xml`, materialised to R2 at publish. `<changefreq>` and `<priority>` are omitted entirely — Google ignores both.
8. **`lastmod` moves only when rendered semantic content changes**, driven by `render_sha256` over a canonicalised projection that excludes styling. It must not move on a deploy, a template change, a footer year rollover, or a republish with identical content. A sitemap that always says "now" gets ignored.
9. `robots.txt` is synthesised per `Host`. Three states, and **de-indexing is `200 + X-Robots-Tag: noindex, follow` with crawling still allowed for 30 days, then `410`** — `Disallow` does not de-index; it prevents Googlebot from ever seeing the `noindex`.
10. IndexNow ping on publish, with **only** the URLs whose `render_sha256` actually changed.

**Structured data**
11. One `<script type="application/ld+json">` per page: a single `@graph` with stable `@id`s. `Organization`/`LocalBusiness` is `https://host/#business` — **no locale in the business `@id`**, or one entity becomes six.
12. `@type` validated at emit time against a compiled LocalBusiness-subtype allowlist. An invented type (`DJService`) silently disables every rich result. A DJ is `ProfessionalService`.
13. **No `aggregateRating` and no `review` on `LocalBusiness`, ever, unless `reviews_source = 'verified_platform'`.** Three independent bars: self-serving reviews have been rich-result-ineligible since 2019; UCPD Annex I 23b/23c (NL Art. 6:193g BW, DE §5b UWG) makes unverified consumer-review claims a per-se unfair practice with penalties up to 4% of turnover; and copying GBP reviews breaches Maps Platform terms. Manual testimonials render as plain HTML with the Omnibus disclosure line and zero markup.
14. `author` on `BlogPosting` is the **Organization**, never a fabricated Person. `dateModified` equals `content_changed_at`.
15. `geo` is emitted only when `geo_source ∈ ('geocoded','user_pin')`. A guessed city-centre coordinate contradicting the address is worse than nothing.
16. JSON-LD is serialised by one function with `<` → `\u003c`; it is never string-concatenated and user text never nears a template literal.

**Performance — the size invariant is the one that matters**
17. **The poster image's intrinsic area must be ≥ the video's, at every breakpoint.** A `<video>` is an LCP candidate and LCP stays open until first interaction, so timing cannot save you — only the size invariant can. Poster 2400×1350 / video 1920×1080 desktop; poster 1170×2080 / video 720×1280 mobile. Asserted in CI per breakpoint pair. Never put `poster=` on the `<video>` — that makes the video element the candidate.
18. The video carries `preload="none"` and **no `src`**; sources attach after `load` + idle, gated on `prefers-reduced-motion`, `saveData`, and viewport — with **absence of `navigator.connection` treated as "unknown", not "fast"** `[ADOPTED]`; the API does not exist in Safari or Firefox, so every iPhone would have sailed through every guard. Mobile default is poster-only.
19. `min-height: 100svh` on the hero. Never `dvh` (changes on scroll → shift), never bare `vh` (iOS large viewport → overflow).
20. All CSS inlined, ≤11 KB brotli, assembled at publish from the components the page actually uses. Zero stylesheet requests, zero render-blocking resources. Theme is CSS custom properties only.
21. Fonts self-hosted from R2, one variable family (two only when the DNA preset demands a display face), `latin` + `latin-ext` subsets, one preload with `crossorigin`, and a metric-overridden (`size-adjust`/`ascent-override`) fallback so `font-display: swap` costs ~0.001 CLS. **Never Google Fonts** — a third origin on the critical path, and LG München I 3 O 17493/20 makes hotlinking a GDPR exposure in the exact market we sell to.
22. **Zero third-party origins.** No Google Fonts, no Maps iframe (static map image at publish + a link that opens the native maps app), no third-party CMP, and **no Cloudflare Web Analytics beacon** — it is a script from `static.cloudflareinsights.com`, i.e. a third party. Analytics is first-party Analytics Engine written server-side from the renderer.
23. Total tenant JS ≤ 4 KB gzip, one deferred file. The WhatsApp button is a plain `<a href="https://wa.me/…">` — opens the app natively on mobile, zero JS, zero INP.
24. Tenant CSP, corrected for all three broken versions across the dimensions:
    ```
    default-src 'none'; script-src 'sha256-…'; style-src 'sha256-…';
    img-src 'self' data:; media-src 'self'; font-src 'self'; connect-src 'self';
    form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none';
    upgrade-insecure-requests
    ```
    `connect-src` and `font-src` were missing (falling back to `'none'`); `frame-ancestors` does **not** inherit from `default-src`, so every tenant site was framable; and `'unsafe-inline'` on `script-src` meant the claim "the CSP already blocks execution" was false. Media is same-origin because derivatives are R2 objects served through the renderer's `/​_a/` path — which also removes the recurring Images transformation meter. `[ADOPTED]` And the claim that CSP moves the Lighthouse Best Practices score is dropped: `csp-xss` is informative and zero-weight.
25. **No cookie banner by default.** The site sets no non-essential cookies, uses no `localStorage`, and logs server-side — so the strictly-necessary exemption covers everything and the correct, best-UX, best-CWV output is no banner at all. The privacy policy and cookie statement are still generated and linked. When a tenant enables something non-essential, `uses_non_essential` flips (asserted from the rendered tree at publish, so it cannot be bypassed) and a ~2 KB first-party banner appears, `position: fixed` (zero CLS), reject as easy as accept, no pre-ticked boxes.

**Indexing gate**
26. `index_state` is `noindex` until **card-on-file AND a passing quality gate**. Card-on-file, not payment received: a card is the strongest anti-spam signal available and waiting until day 8 throws away Google's discovery runway on exactly the sites most likely to convert.
27. `[ADOPTED]` The quality gate's MinHash threshold of 0.35 was **asserted, never calibrated**, and two bakeries from the same template with the same boilerplate hours/address/footer will routinely exceed it — silently noindexing the paying customer base, with dashboard remediation advice ("add two photos") that cannot move a text-only MinHash. **Phase 1 ships the gate in WARN-only mode**, logging the score per check; the threshold is set from the observed distribution over 200 fixture sites before it can block anything. Every check reports its own remediation, and support has a manual override.
28. No sitewide followed backlinks (the "made with" badge is plain text or `rel="nofollow sponsored"`), no cross-tenant directory, no location-permutation pages. These are the three fastest routes to a manual action on the apex.

---

## 8. Security posture — the public onboarding endpoint

The most expensive operation in the product sits behind an unauthenticated public endpoint. Six layers, cheap-and-approximate first, expensive-and-exact last, **and money is only ever counted in a Durable Object.**

| # | Layer | Enforced by | Limit |
|---|---|---|---|
| 0 | WAF custom rules | Zone, pre-Worker, free | Datacenter/VPS ASNs and Tor exits → managed challenge. No baker onboards from Hetzner. |
| 1 | Rate-limiting rule | Zone, pre-Worker | 30 req/min/IP on `/v1/*` |
| 2 | Origin + Content-Type | Worker, µs | Reject non-app origins; reject a *missing* Origin on state-changing methods |
| 3 | **Turnstile at draft creation** | 1 subrequest | Managed mode, `action`+`cdata` bound to the draft, `hostname` asserted, `idempotency_key` passed. A second check at submit. |
| 4 | Workers Rate Limiting binding | sub-ms, per-colo | 1 generate / 60 s / IP. Documented as approximate and **per Cloudflare location** — never treated as global. |
| 5 | `QuotaDO` (EU jurisdiction) | strongly consistent | 3 gens/IP/day · 10/IPv4-\24 or IPv6-\48/day · 2/normalised-email/day, 5 lifetime · 2/E.164/day · 1/business-identity/day (`sha256(nfkc(name)+postcode)`) |
| 6 | `BudgetDO` (one global instance) | strongly consistent | 250 generations/day · **$500/day hard**, with staged degradation |

**Staged degradation** is what makes a hard cap survivable — a naive cap turns a bot attack into a customer outage. <70%: generate immediately. 70–85%: require **email confirmation before generation** (kills essentially all automated abuse, costs a real user 20 seconds). 85–100%: confirm + queue. ≥100%: onboarding still succeeds, the lead and media are kept, generation is deferred with "we'll email you within the hour" — nothing is lost, no money is spent, and you get a human review queue for free.

`[ADOPTED]` **IP-derived limits escalate, they do not block.** European mobile traffic is largely CGNAT; a hard 10-per-/24 cap refuses the eleventh Vodafone NL customer of the day with no signal distinguishing them from a bot. Over the threshold, the session moves into the confirm-email mode that already exists. Hard blocks are kept only for the datacenter/Tor case where false positives are near zero.

**Per-call containment.** Every Opus call carries `output_config.task_budget` (min 20,000) plus a conservative `max_tokens`; every call writes `generation_calls` from `response.usage`; `BudgetDO.reserve()` before, `settle()` after, with a +10 min alarm force-settling orphaned reservations at estimate (fail closed) and **decrementing `gens` on abort/failure** so the counter cannot ratchet. An organisation-level spend limit is set in the Anthropic Console as an independent backstop that survives a bug in our own code. Anthropic **org rate limits (RPM/ITPM/OTPM) are paced by the `AnthropicLimiter` DO** — and note Priority Tier is not available on Opus 5, so 429s must be absorbed with backoff, not bought around.

**SDK timeout is ~12 minutes** (under the Workflow step timeout, which is under the 30-minute ceiling), **not 180 seconds** `[ADOPTED]` — a 180 s abort fires on the majority of *successful* generations after the tokens are already billed, and then Queue/Workflow retry pays for them again.

**Uploads:** presigned PUT into a **separate quarantine bucket** with `content-length` bound into the signature (this is what stops a 5 GB body against a URL issued for a 2 MB avatar), a **server-derived key** (the user's filename is display-only and HTML-escaped at render), 120 s expiry, explicit bucket CORS (`AllowedOrigins` exact, `AllowedHeaders` enumerating every signed header, `ExposeHeaders: etag`), and signing against the **`.eu.` jurisdictional endpoint**. Then: magic-byte sniff that must *equal* the declared type, **mandatory re-encode through the Images binding with `metadata:'none'`**, derivatives written to R2, quarantine object deleted. Re-encoding destroys polyglots, EXIF GPS (a home-address leak is a GDPR incident) and trailing payloads without an AV engine we cannot run. **SVG, HTML, XML and PDF are denied outright** — an SVG is an HTML document. **HEIC is denied and converted client-side**: iOS Safari transcodes to JPEG when the file input's `accept` lists only JPEG/PNG/WebP, and HEIC ingestion into Images is Enterprise-only `[ADOPTED]`.

**Prompt injection** is defeated structurally by §4's four invariants, not by prompting. Additionally: user text is NFKC-normalised with bidi overrides, zero-width, Unicode tag characters and control/format characters stripped; it goes in its own user message wrapped with a per-request random nonce; **user text never enters the system prompt** (which would also destroy the cache prefix); a per-deploy canary sentinel in the system prompt blocks and alerts if it ever appears in output; and **PII is not sent to the model at all** — city, industry, description and hours go; email, phone, street address and the GBP URL are merged in from D1 at render time. That kills the lead-theft vector and minimises the transfer to a US sub-processor in one move.

**Content abuse** (as distinct from code injection) gets: a Haiku 4.5 intake screen over the free-text description before any Opus spend; `https:`-only scheme validation plus a phishing/brand/domain-age check on every onboarding-supplied external URL; a specified pre-publish moderation pass; and a nightly rescan for keyword stuffing, outbound-link count, injected markup in editable fields, and cloaking (bot-served vs human-served body hash must be identical).

**Lead forms do not use Turnstile** `[ADOPTED]`. A free-plan widget covers 10 hostnames, "Any Hostname" is Enterprise, and pre-clearance cookies only work on zones in your own account — so the whole story collapses the moment a customer attaches their own domain, which is the headline Phase 3 feature. Lead endpoints use the per-tenant D1 origin allowlist, a rate-limit binding keyed on `siteId` + hashed IP, a honeypot and timing check, and server-side spam scoring.

**Secrets** live in Secrets Store bound per Worker, resolved once per isolate. Because bindings are per-Worker, **capability separation on Workers means splitting Workers**: `worker-generator` is the only holder of `ANTHROPIC_API_KEY`; `worker-billing` the only holder of `STRIPE_SECRET_KEY`; `worker-renderer` — the highest-exposure surface, rendering attacker-influenced content — has **no D1 binding at all**. Access is written as `await env.KEY.get?.() ?? env.KEY` so `wrangler secret put` remains a working fallback while Secrets Store is in open beta `[ADOPTED]`.

**GDPR posture** (ours, not the tenant's): controller for customers, processor for tenant site visitors' leads — two different DPAs and a published sub-processor list. IPs are never stored raw (`sha256(ip || daily_salt)`, salt rotated daily, two retained for lookback), and `ip_hash` is documented as **pseudonymous personal data, not anonymous** `[ADOPTED]` — the controller holds the salt and IPv4 is exhaustively enumerable. D1/R2/DO all EU. **Anthropic has no EU inference region** (`inference_geo` is `"us"`|`"global"`), so: SCCs, a written TIA, pursue Zero Data Retention, disclose Anthropic as a US sub-processor, and rely on the prompt-level PII stripping above — which makes the transferred data business marketing copy rather than personal data. That is the honest and defensible position, and it is the *reason* the PII stripping is architectural rather than optional. Log redaction middleware is mandatory: prompts and lead bodies must never reach Workers Logs or Logpush by default.

---

## 9. Phased delivery

### Phase 1 — prove the whole loop end-to-end

Repo scaffold; `site-schema`; `db` (both migration sets); `apps/marketing` (hero, pricing, legal, onboarding modal island); `apps/api`; `apps/generator` (Workflow + 3 DOs, 4 Opus calls, single locale); `apps/renderer` serving `<slug>.mijnsaas.com` from R2 with **one industry archetype**; `apps/media`. The renderer is the highest-risk component and is **not deferred** — a single archetype end-to-end beats eight archetypes with no serving path.

Explicitly **out** of Phase 1: user video, Google Places/GBP resolution, address autocomplete outside NL/BE, the dashboard, Stripe, custom domains, translation fan-out, blog in non-primary locales.

### Phase 2 — editor and the trial wall

`apps/app` (React Router v7); `SiteDraftDO` with **every patch written to DO storage, not held in memory** `[ADOPTED]` (DOs hibernate and evict; in-memory draft state loses the user's unsaved work in the product whose entire promise is "what you see is your site"); preview iframe on `preview.aibuilder.app` with a short-lived **HttpOnly host-scoped cookie, not a query-string token** (which leaks via `Referer` the moment a draft page contains the mandated `wa.me` link) plus `X-Robots-Tag: noindex` and `Referrer-Policy: no-referrer`; CSS-variable live theming with 0 ms round-trip; `apps/billing`; Stripe trial-wall enforced at Workflow dispatch; SCA/3DS and VAT/OSS; magic-link + passkey auth; remaining industry archetypes; second-locale translation (per-message effort, wave-1-then-fan-out); incremental re-translation driven by the `is_stale` flag that already exists.

### Phase 3 — scale surface

Cloudflare for SaaS custom hostnames (**own ownership proof via `_aibuilder-challenge` TXT before calling the Custom Hostnames API**, TXT/HTTP DCV never CNAME-only, a daily dangling-DNS reconciler, and the `www`-vs-apex decision below); blog in all locales; Analytics Engine dashboards; user video via Containers + ffmpeg with Stream budgeted; Places/GBP import with the 30-day cache cron built first; tiered-cache miss path if RUM justifies it; TanStack Start re-evaluation at 1.0; WebSocket+Hibernation for progress if DO duration shows up.

**Phase 3 blocker to resolve in Phase 1:** Cloudflare for SaaS **cannot serve a customer's zone apex** below Enterprise, and wildcard custom hostnames are Enterprise-only `[ADOPTED]`. The target market is on TransIP/Strato/OVH/Hostnet/one.com default DNS, much of which has no CNAME flattening at the apex. **Decision: canonical host is `www.<customer-domain>`**, with apex→www handled by a redirect the customer configures at their registrar; the onboarding flow ships per-registrar DNS instructions. Cost: two custom hostnames per tenant at $0.10/mo beyond the included 100 ≈ **$2,000/mo at 10k tenants**, and a non-Enterprise ceiling of 50,000 hostnames caps the business at ~25,000 tenants. Both go in the model now.

### Phase 1 file manifest

**Root**
| File | Purpose |
|---|---|
| `/home/user/aibuilder/package.json` | Root scripts (`dev`, `build`, `typecheck`, `test`, `migrate:*`). No runtime deps. |
| `/home/user/aibuilder/pnpm-workspace.yaml` | `apps/*`, `packages/*` |
| `/home/user/aibuilder/turbo.json` | Task graph + cache config for `typecheck`/`build`/`test`/`eqp` |
| `/home/user/aibuilder/tsconfig.base.json` | strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules`, `moduleResolution: "bundler"` |
| `/home/user/aibuilder/.github/workflows/ci.yml` | typecheck · unit · EQP-no-SCAN gate · migration row-count gate · contrast matrix · Lighthouse · gitleaks |
| `/home/user/aibuilder/README.md` | Bootstrap: exact `wrangler d1 create --location eu` / `r2 bucket create --jurisdiction eu` ordering |

**`packages/site-schema/src/`**
| File | Purpose |
|---|---|
| `gen/common.ts` | `Locale`, `MediaRef`, `LinkRef`, `Cta`, `IconId` enums — model-facing, constraint-free |
| `gen/section.ts` | Flat discriminated union of 17 section types, variants as enums, no `*Slot` fields |
| `gen/site-structure.ts` | `SiteStructureGen` — theme, pages, sections, jsonLdInputs, chrome, stockQueryHint |
| `gen/locale-bundle.ts` | `LocaleBundleGen` — `{locale, entries: [{id, text}]}` |
| `gen/blog-post.ts` | `BlogPostGen` — typed block union |
| `slots.ts` | `deriveSlotInventory(structure)` — the single derivation of every slot id |
| `normalize.ts` | Deterministic repair: truncate, clamp, lowercase hex, drop unknown slots, dedupe ids |
| `gen-to-doc.ts` | `genToDoc()` — resolves refs, merges D1 facts, produces `SiteDoc`. Tested as hard as the schema. |
| `doc.ts` | `SiteDoc` types derived from gen types; `SiteDocSchema` for storage validation |
| `lint.ts` | Semantic lint: contrast, dangling refs, section-type compatibility, required fields |
| `migrations/index.ts` | `vN → vN+1` pure functions; upgrade-on-read |
| `index.ts` | Public exports |

**`packages/site-kit/src/`**
| File | Purpose |
|---|---|
| `tokens/oklch.ts` | OKLCH palette generation from `(hue, chroma, lightnessCurve)`; provable contrast by construction |
| `tokens/dna.ts` | Design-DNA registry (Phase 1: 4 archetypes; full 20 in Phase 2) |
| `tokens/resolve.ts` | DNA + knobs → ~40 CSS custom properties |
| `css/base.css.ts`, `css/components/*.css.ts` | Per-component CSS fragments, assembled at publish |
| `css/assemble.ts` | Collect used components → minify → assert ≤11 KB → inline |
| `sections/*.tsx` | 17 `hono/jsx` section components. `escapeHtml()` only. |
| `layout/document.tsx` | `<head>` order: LCP preloads → inline CSS → consent bootstrap → metadata → JSON-LD |
| `layout/hero.tsx` | Poster-as-LCP, size invariant, `100svh`, video attached post-load |
| `layout/whatsapp.tsx` | Pure-CSS fixed `<a href="https://wa.me/…">`, site colours, zero JS |
| `seo/jsonld.ts` | `@graph` builder from D1 facts + `jsonLdInputs`; `ldScript()` with `\u003c` escaping |
| `seo/hreflang.ts` | Cluster builder — omit, never substitute |
| `seo/allowlist.ts` | Generated LocalBusiness subtype allowlist, committed |
| `js/site.ts` | ≤4 KB: hero video swap, mobile nav, form enhancement. One deferred file. |
| `render.ts` | `renderPage(doc, locale, pageId) → {html, renderSha256}` |

**`packages/core/src/`**
| File | Purpose |
|---|---|
| `keys.ts` | Every R2 key shape in one place |
| `routing.ts` | KV manifest build/read; `host → site` resolution that never trusts a client-supplied siteId |
| `publish.ts` | Atomic publish: SiteDoc → R2, projection → D1, HTML materialise, KV flip last |
| `slug.ts` | Locale transliteration, reserved/homoglyph/trademark checks, collision suffixing, alias retirement |
| `sitemap.ts` | Index + per-locale urlsets with nested `xhtml:link` |
| `robots.ts` | Three-state per-host synthesis |
| `lastmod.ts` | Canonical semantic projection → `render_sha256` → `content_changed_at` |
| `quality-gate.ts` | Facts, thinness, uniqueness (MinHash), owned media, doorway. WARN-only in Phase 1. |
| `budgets.ts` | Publish-time perf/a11y budget assertions |
| `media-pipeline.ts` | Sniff → Images re-encode → derivatives → R2 → promote |
| `hours.ts` | `opening_hours` → `openingHoursSpecification` (splits, closed, 24h, midnight-crossing, seasonal) |

**`packages/ai/src/`**
| File | Purpose |
|---|---|
| `client.ts` | Anthropic client, `maxRetries: 0`, ms timeouts, lazy dynamic import |
| `prompt/blocks.ts` | The 4 frozen system blocks, content-hashed, one `cache_control` breakpoint |
| `prompt/tasks.ts` | Per-step user turns; untrusted data wrapped with a per-request nonce |
| `call.ts` | `streamStructured()` — beta stream + fallbacks + task_budget, `stop_reason` branching, Zod parse |
| `repair.ts` | Deterministic repair → one model repair turn (user role) → fail step. Max 2 rounds. |
| `usage.ts` | `response.usage` → `generation_calls` row → `cost_usd_micro` |
| `screen.ts` | Haiku 4.5 intake policy classifier |

**`packages/db/src/`**
| File | Purpose |
|---|---|
| `cp/schema.ts`, `shard/schema.ts` | Drizzle schemas |
| `shard-router.ts` | `org_id → shard binding`; the indirection that makes shard 2 a config change |
| `queries/*.ts` | Every shipped statement, exported for the EQP gate |
| `views.sql` | `live_sites`, `live_domains` — soft-delete predicate outside the author's memory |
| `eqp.test.ts` | Runs `EXPLAIN QUERY PLAN` over every query against a seeded + `ANALYZE`d DB; fails on `SCAN` |

**`migrations/cp/`** — `0001_identity.sql`, `0002_taxonomy.sql`, `0003_sites_routing.sql`, `0004_billing.sql`, `0005_drafts_claims.sql`, `0006_triggers.sql`, `0007_seed.sql`
**`migrations/shard/`** — `0001_versions_pages.sql`, `0002_blobs_media.sql`, `0003_blog_reviews.sql`, `0004_generation.sql`, `0005_leads_audit.sql`, `0006_triggers.sql`

**`apps/api/src/`** — `index.ts` (Hono app + global middleware), `middleware/{security-headers,origin,turnstile,draft-cookie,ratelimit}.ts`, `routes/{bootstrap,drafts,slug,geo,media,submit,jobs,leads,claim}.ts`, `lib/{presign,quota,budget}.ts`, `wrangler.jsonc`
**`apps/generator/src/`** — `workflow.ts`, `steps/{validate,media,structure,copy,blog,legal,assemble,audit,render,publish}.ts`, `do/{JobHub,BudgetDO,QuotaDO}.ts`, `queue/media-consumer.ts`, `wrangler.jsonc`
**`apps/renderer/src/`** — `index.ts`, `resolve.ts`, `cache.ts`, `serve.ts`, `robots.ts`, `sitemap.ts`, `analytics.ts`, `wrangler.jsonc`
**`apps/media/src/`** — `index.ts`, `headers.ts`, `wrangler.jsonc`
**`apps/marketing/src/`** — `pages/{index,prijzen,voorwaarden,privacy}.astro`, `layouts/Base.astro`, `components/Hero.astro`, `islands/OnboardingModal.tsx` (+ the component list in §10.6), `astro.config.mjs`, `wrangler.jsonc`

---

## 10. Risk register

| # | Risk | Mitigation | Owner phase |
|---|---|---|---|
| 1 | **Financial DoS on the free generation.** $1.20 × unbounded requests; Workflows allows 50k concurrent instances at 300/s. | The six-layer funnel (§8) + `task_budget` per call + `BudgetDO` $500/day with staged degradation + Console org spend limit. **Escalate to client:** requiring the Stripe trial before the *first* generation would eliminate this entirely at a conversion cost. Not taken, because the blueprint makes the first generation the conversion event — but it should be a decision, not a discovery from a bill. | 1 |
| 2 | **Cost model is estimated, not measured.** Thinking tokens dominate output and are unmeasured. | `generation_calls` records every call from `response.usage` from day one. **20 real generations are run and §6.5 is rewritten from observation before Phase 2 pricing is fixed.** `task_budget` bounds the worst case meanwhile. | 1 |
| 3 | **Quality gate noindexes paying customers.** Uncalibrated MinHash threshold on template-generated sites. | WARN-only in Phase 1; threshold set from 200 fixture sites with a target false-positive rate; per-check remediation; support override; a rollback path that does not require a passing gate to restore. | 1→2 |
| 4 | **`~100/100` Lighthouse is contract-adjacent and fragile.** A hero video plus AI-chosen palettes puts contrast and LCP one commit from failing. | Contrast is proven **analytically** over the full knob space in pure code on every commit (no browsers). Layout/CLS/tap-targets are **sampled** — 4 archetypes × 3 variants × 17 sections × longest-string locale ≈ 200 renders — plus a nightly randomised sweep. `[ADOPTED]`: the claim to render every combination was ~440,000 browser renders per CI run and cannot run on any budget; the guarantee is restated honestly as *contrast proven, layout sampled*. | 1 |
| 5 | **Anthropic org rate limits, not dollars, bind first.** 429s at 32K-output calls; no Priority Tier on Opus 5. | `AnthropicLimiter` DO paces in-flight calls; exponential backoff honouring `retry-after`; the Workflow retry ladder distinguishes transport from content failures so a rate-limit blip never becomes a permanently failed onboarding. | 1 |
| 6 | **Platform-abuse shared fate.** One phishing tenant listed by Safe Browsing takes down every `*.mijnsaas.com` site. | Domain split (marketing and app are on a different registrable domain and survive); Haiku intake screen; slug brand/homoglyph blocking; nightly content rescan; `abuse@` route and takedown workflow; a documented "flip `index_state` to `gone` and 410" kill switch per tenant. | 1→3 |
| 7 | **Email is a single point of total compromise.** Magic link is the only first factor and the claim token arrives the same way. | SPF/DKIM/DMARC `p=reject` before the first send; EU sending provider; rate limits on sending claim invitations to *third-party* addresses typed into the modal (spam amplification + sender reputation); passkey upgrade offered at first login. | 1→2 |
| 8 | **D1 single-writer throughput at scale.** Every publish, autosave, lead, webhook and job event serialises through one writer. | Tenant reads are off D1 entirely (§3a). `shard_id` + routing indirection exist from migration 0001, launching with one shard. Size alarm at 6 GB and a write-rate alarm. Editor autosave debounces in the DO and never hot-writes D1. | 1 |

### One-way doors — all closed in Phase 1, none deferred

1. **D1 jurisdiction** (`--location eu`) — settable only at creation, and `database_id` is still a placeholder.
2. **R2 bucket jurisdiction** (`eu`) — immutable after creation, and it changes the S3 endpoint host that presigned URLs are signed against.
3. **Durable Object jurisdiction** — `.jurisdiction('eu')` changes every DO id, so retrofitting it silently resets every quota counter.
4. **The two-domain split** — slugs are indexed and printed; the cookie boundary cannot be retrofitted.
5. **PSL submission for `mijnsaas.com`** — baked into browser releases, months of lead time, must start in Phase 1.
6. **The shard key** — resharding with 10,000 live tenants is the migration this architecture exists to avoid.
7. **Passkey `rpID = app.aibuilder.app`** — a later PSL entry makes an apex rpID invalid and every credential unrecoverable. Written as a comment and a test.
8. **`schemaVersion` on every stored SiteDoc** — AI-generated documents outlive schema revisions and cannot be regenerated for free.
9. **`www` (not apex) as the tenant canonical host** — determined by the non-Enterprise Cloudflare for SaaS limitation, and every sitemap, JSON-LD `@id` and hreflang URL derives from it.
10. **The migration rewrite into `cp/` + `shard/`** — free now, a live-data migration after the first `--remote` apply.

---

# PHASE 1 IMPLEMENTATION SPEC

## S1. Dependencies

Root `package.json` (scripts only). Versions are floors; `pnpm install` resolves and the lockfile is committed. **`@anthropic-ai/sdk` is pinned exact** — edge-runtime streaming has a history of `Unexpected end of JSON input` on workerd, and the pin must move only with a passing `@cloudflare/vitest-pool-workers` test that runs in real workerd, not Node.

```jsonc
// root devDependencies
{
  "packageManager": "pnpm@10",
  "devDependencies": {
    "turbo": "^2.5.0",
    "typescript": "^5.7.0",
    "wrangler": "^4.34.0",                    // <4.34 still enforces the old 20k asset-file cap
    "@cloudflare/workers-types": "^4.2026",
    "@cloudflare/vite-plugin": "^1.15.0",
    "@cloudflare/vitest-pool-workers": "^0.9.0",
    "vitest": "^3.0.0",
    "eslint": "^9.20.0",
    "eslint-plugin-boundaries": "^5.0.0",
    "prettier": "^3.4.0",
    "drizzle-kit": "^0.31.0"
  }
}
```

| Package | Version | Where | Why |
|---|---|---|---|
| `@anthropic-ai/sdk` | **`1.x` exact pin** | `packages/ai` | Messages API. Dynamic-imported in the generator only (400 ms startup CPU limit). |
| `zod` | `^4.0.0` | `site-schema`, `api` | v4 uniform across the repo (Astro 6 requires it anyway). |
| `hono` | `^4.6.0` | `api`, `renderer`, `media`, `site-kit` | Router + `hono/jsx` render-to-string. |
| `drizzle-orm` | `^0.44.0` | `packages/db` | D1 dialect. |
| `astro` | `^6.0.0` | `apps/marketing` | `output: 'static'`. **No `@astrojs/cloudflare`** — a static build needs no adapter. |
| `@astrojs/react`, `react`, `react-dom` | `^4`, `^19`, `^19` | `apps/marketing`, `packages/ui` | The single modal island. |
| `@astrojs/sitemap` | `^3.4.0` | `apps/marketing` | Marketing sitemap only; tenant sitemaps are ours. |
| `tailwindcss` | `^4.0.0` | `packages/ui` | Marketing + Phase 2 dashboard. **Never in `site-kit`** — tenant CSS is hand-authored archetypes. |
| `aws4fetch` | `^1.0.20` | `apps/api` | R2 presigning against the `.eu.` endpoint. |
| `ulid` | `^3.0.0` | `packages/core` | Prefixed ULID minting. |
| `@fontsource-variable/inter` | `^5.1.0` | build-time only | Subset offline, ship `.woff2` to R2. Never a font CDN at runtime. |
| `unhead` *(or plain string building)* | — | — | **Not used.** `<head>` is assembled by `site-kit/layout/document.tsx`. |

Deliberately absent: any CSS-in-JS runtime, any icon font, any markdown parser (rule 1 of §4), `heic2any` (HEIC is client-converted), `libphonenumber-js` in the initial bundle (lazy-imported on step-5 focus only — the `/max` build is ~145 KB and is required to distinguish MOBILE from FIXED_LINE for the WhatsApp warning).

## S2. `wrangler.jsonc` bindings

Common to every Worker: `"compatibility_date": "2026-09-01"` (≥2026-08-04 enables `nodejs_compat` + `v2` implicitly; the explicit flag is kept as belt-and-braces), `"compatibility_flags": ["nodejs_compat"]`, `"observability": { "enabled": true }`.

**`apps/api/wrangler.jsonc`**
```jsonc
{
  "name": "aibuilder-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "routes": [{ "pattern": "api.aibuilder.app/*", "zone_name": "aibuilder.app" }],
  "d1_databases": [
    { "binding": "CP",       "database_name": "aibuilder-cp",           "database_id": "…", "migrations_dir": "../../migrations/cp" },
    { "binding": "SHARD_000","database_name": "aibuilder-shard-000",    "database_id": "…", "migrations_dir": "../../migrations/shard" }
  ],
  "r2_buckets": [
    { "binding": "QUARANTINE", "bucket_name": "aibuilder-quarantine", "jurisdiction": "eu" },
    { "binding": "MEDIA",      "bucket_name": "aibuilder-media",      "jurisdiction": "eu" }
  ],
  "kv_namespaces": [
    { "binding": "ROUTING", "id": "…" },
    { "binding": "GEO",     "id": "…" }
  ],
  "durable_objects": { "bindings": [
    { "name": "JOB_HUB",  "class_name": "JobHub",   "script_name": "aibuilder-generator" },
    { "name": "QUOTA",    "class_name": "QuotaDO",  "script_name": "aibuilder-generator" },
    { "name": "BUDGET",   "class_name": "BudgetDO", "script_name": "aibuilder-generator" }
  ]},
  "services": [{ "binding": "GENERATOR", "service": "aibuilder-generator" }],
  "queues": { "producers": [{ "binding": "MEDIA_Q", "queue": "aibuilder-media" }] },
  "images": { "binding": "IMAGES" },
  "ratelimits": [
    { "name": "RL_DRAFT",  "namespace_id": "1001", "simple": { "limit": 5,  "period": 60 } },
    { "name": "RL_SUBMIT", "namespace_id": "1002", "simple": { "limit": 1,  "period": 60 } },
    { "name": "RL_UPLOAD", "namespace_id": "1003", "simple": { "limit": 20, "period": 60 } },
    { "name": "RL_LEADS",  "namespace_id": "1004", "simple": { "limit": 5,  "period": 60 } }
  ],
  "secrets_store_secrets": [
    { "binding": "TURNSTILE_SECRET", "store_id": "…", "secret_name": "turnstile_secret" },
    { "binding": "DRAFT_HMAC_KEY",   "store_id": "…", "secret_name": "draft_hmac_key" },
    { "binding": "IP_SALT",          "store_id": "…", "secret_name": "ip_salt" },
    { "binding": "R2_ACCESS_KEY_ID", "store_id": "…", "secret_name": "r2_access_key_id" },
    { "binding": "R2_SECRET_KEY",    "store_id": "…", "secret_name": "r2_secret_key" },
    { "binding": "GEOCODER_KEY",     "store_id": "…", "secret_name": "geocoder_key" }
  ],
  "vars": {
    "ENVIRONMENT": "production",
    "APP_ORIGIN": "https://www.aibuilder.app",
    "SITES_ROOT_DOMAIN": "mijnsaas.com",
    "R2_S3_ENDPOINT": "https://<account>.eu.r2.cloudflarestorage.com"
  }
}
```
`ratelimits` is the GA form. The repo's current `[[unsafe.bindings]] type="ratelimit"` is the pre-GA path and is migrated. `period` must be exactly `10` or `60`, and the limit is **per Cloudflare location** — never treated as global.

**`apps/generator/wrangler.jsonc`** — adds `"workflows": [{ "binding": "SITEGEN", "name": "site-generation", "class_name": "SiteGenerationWorkflow" }]`, `"migrations": [{ "tag": "v1", "new_sqlite_classes": ["JobHub","QuotaDO","BudgetDO"] }]`, `"queues": { "consumers": [{ "queue": "aibuilder-media", "max_batch_size": 5, "max_retries": 2, "dead_letter_queue": "aibuilder-media-dlq" }] }`, `"limits": { "cpu_ms": 300000 }`, `"analytics_engine_datasets": [{ "binding": "AE", "dataset": "aibuilder_gen" }]`, `r2_buckets` BLOBS+MEDIA, both D1s, and the secrets `ANTHROPIC_API_KEY`, `PEXELS_KEY`. **No public route.**

**`apps/renderer/wrangler.jsonc`** — `"routes": [{ "pattern": "*/*", "zone_name": "mijnsaas.com" }]`, `r2_buckets: [BLOBS(ro), MEDIA(ro)]`, `kv_namespaces: [ROUTING]`, `analytics_engine_datasets: [{binding:"AE", dataset:"aibuilder_sites"}]`, `services: [{binding:"API", service:"aibuilder-api"}]` (lead form POST only). **No `d1_databases`.**

**`apps/media/wrangler.jsonc`** — `"routes": [{ "pattern": "cdn.mijnsaas.com/*", "zone_name": "mijnsaas.com" }]`, `r2_buckets: [MEDIA(ro)]`. A **blank route** `cdn.mijnsaas.com/*` must additionally be removed from `*/*` — configure this Worker's route as more-specific, which wins over `*/*` by specificity.

**`apps/marketing/wrangler.jsonc`** — `"assets": { "directory": "./dist" }`, **no `main`** (assets-only: zero invocations, free requests), `"routes": [{ "pattern": "www.aibuilder.app/*", "zone_name": "aibuilder.app" }]`.

## S3. Env vars and secrets

| Name | Type | Worker | Value / note |
|---|---|---|---|
| `ENVIRONMENT` | var | all | `production` \| `staging`. Gates `event.livemode`, log verbosity. |
| `APP_ORIGIN` | var | api | `https://www.aibuilder.app` — the **exact** Origin allowlist entry. No regex. |
| `SITES_ROOT_DOMAIN` | var | api, generator, renderer | `mijnsaas.com` |
| `MEDIA_ORIGIN` | var | renderer, generator | `https://cdn.mijnsaas.com` |
| `R2_S3_ENDPOINT` | var | api | `https://<account>.eu.r2.cloudflarestorage.com` — **the `.eu.` label is mandatory for jurisdictional buckets and is covered by the signature.** |
| `ANTHROPIC_MODEL` | var | generator | `claude-opus-5` |
| `ANTHROPIC_API_KEY` | secret | **generator only** | Separate key per environment; Console workspace spend limit set. |
| `PEXELS_KEY` | secret | generator only | Apply for the unlimited-limit upgrade before launch — the default is **200 req/hour, 20,000/month**, which throttles signup throughput to ~20–30 sites/hour. Search results are cached by composed-query hash in KV; a curated per-industry pool is the degradation path. |
| `TURNSTILE_SECRET` | secret | api | |
| `DRAFT_HMAC_KEY` | secret | api | Signs `__Host-aib_draft`. `kid`-versioned with dual-accept during rotation. |
| `IP_SALT` | secret | api, generator | Rotated daily by cron; two retained for lookback. |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_KEY` | secret | api | Scoped to the **quarantine bucket only**. |
| `GEOCODER_KEY` | secret | api | NL/BE postcode lookup. |
| `INDEXNOW_KEY` | secret | generator | Served at `/<key>.txt` per tenant host. |

## S4. API routes — exact shapes

Base `https://api.aibuilder.app`. All responses `application/json` unless noted. Every mutating route asserts `Origin === APP_ORIGIN` (and rejects a *missing* Origin). Every response carries the §S7 security headers.

---
**`GET /v1/bootstrap?locale=nl&country=NL`** — public, **no user data**.
`200` → `{ locales: [{code,label,urlSegment}], industries: [{key,groupKey,label,searchTerms,icon}], groups: [{key,label,icon}], turnstileSiteKey, country }`
Headers: `Cache-Control: public, max-age=3600`, `Vary: Accept-Language`, `ETag`.
`[ADOPTED]` — this route **must not** return the caller's draft. The ux design marked a body containing business name, address, phone and email as `public, max-age=3600`, which serves one visitor's PII to the next from any shared cache. The draft is a separate, `private, no-store`, cookie-authenticated route.

---
**`POST /v1/drafts`** — Turnstile-gated draft creation.
Req `{ turnstileToken: string, locale: Locale }`
`201` → `{ draftId: "drf_…", expiresAt: number }` + `Set-Cookie: __Host-aib_draft=<signed>; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`
`403` on Turnstile failure. **`idempotency_key` is minted server-side and stored in the draft row — never returned to or accepted from the client.**

---
**`GET /v1/drafts/me`** — cookie-authenticated.
`200` → `{ draft: Draft }` · `404` if none. `Cache-Control: private, no-store`.

**`PUT /v1/drafts/me`** — autosave.
Req `{ step, furthestStep, values: Partial<Intake>, updatedAt }` · `200` → `{ updatedAt }` · `409` → `{ server: Draft }` when the server copy is strictly newer.

---
**`GET /v1/slug-check?slug=mijn-kapsalon`**
`200` → `{ available: boolean, normalized: string, suggestion?: string, reason?: "reserved"|"taken"|"invalid"|"homoglyph" }`
Validates the **final** slug server-side (post-transliteration, post-collision-suffix, ≤63 chars) so a non-Latin business name fails at step 1, never inside the submit `batch()`.

---
**`POST /v1/geo/nl-be`**
Req `{ country: "NL"|"BE", postalCode: string, houseNumber: string }`
`200` → `{ addressLine1, city, postalCode, country, latitude, longitude, source: "geocoded" }`
`404` → `{ error: "not_found" }` · `503` → `{ error: "provider_unavailable" }`, and the client falls through to manual entry. **No lookup may ever block Continue.** KV-cached 24 h on `sha256(country|postcode|number)`.

---
**`POST /v1/media/sign`**
Req `{ role: "hero"|"gallery"|"logo", declaredType: "image/jpeg"|"image/png"|"image/webp", bytes: number, width: number, height: number }`
`200` → `{ mediaId, uploadUrl, expiresInSeconds: 120, headers: { "content-length": "…" } }`
`413` over 15 MB · `415` on a type outside the allowlist · `429` over 12 files / 300 MB per draft.
The key is **server-derived** (`q/{draftId}/{mediaId}.{ext}` from a MIME→ext map). The filename is never used. `content-length` is bound into the signature.

**`POST /v1/media/:mediaId/commit`**
Req `{ sha256: string }` · `202` → `{ mediaId, status: "verifying" }` — enqueues the verify/re-encode consumer.

**`GET /v1/media/:mediaId`** → `{ status: "verifying"|"ready"|"failed"|"quarantined", width?, height?, blurhash?, dominantColor? }`

---
**`POST /v1/onboarding/submit`**
Headers: `Idempotency-Key` **is not accepted from the client**; the server uses the draft's stored key.
Req: the full `IntakeSchema` (§S5) + `{ turnstileToken }`.
`202` → `{ jobId: "job_…", slug: "mijn-kapsalon", siteUrl: "https://mijn-kapsalon.mijnsaas.com", eventsUrl: "/v1/jobs/job_…/events" }`
`200` → the same body when the draft already has a job (idempotent replay).
`402` → `{ error: "budget_deferred", mode: "confirm_email"|"queued", message }` — staged degradation, never a bare failure.
`403` Turnstile · `409` quota · `422` Zod with a field-keyed error map · `451` policy screen rejection with an honest reason.

---
**`GET /v1/jobs/:jobId/events`** — `text/event-stream`. **Authorized against the draft cookie or session on connect and on every `Last-Event-ID` resume.**
```
id: 17
event: progress
data: {"seq":17,"phase":"streaming","progress":41,"message":"Homepage — over ons",
       "data":{"slot":"about.body","text":"Al ruim twaalf jaar…"}}
```
`id` is the DO-assigned `seq`, never the D1 autoincrement. `: ping` heartbeat every 15 s. `phase` is one of the twelve values already in the `generation_job_events` CHECK; the client maps phase → UI act via a published **many-to-one** table, and acts advance monotonically (a lower-act phase updates the detail line without moving the rail backwards).

**`GET /v1/jobs/:jobId`** — polling fallback → `{ status, phase, progress, message, siteUrl?, error? }`

---
**`POST /v1/leads/:siteId`** — from a tenant origin.
CORS: `Origin` looked up in the per-site D1 allowlist (slug host + verified custom domains) and **echoed only on exact match**; `Access-Control-Allow-Credentials: false`; `Vary: Origin`. Never `*`, never a regex (`/mijnsaas\.com$/` matches `evilmijnsaas.com`).
Req `{ name, email?, phone?, message, consent: true, hp: "" , t: number }` · `202` → `{ ok: true }`

---
**`GET /claim?t=<token>`** — minimal HTML page (Phase 1 has no dashboard).
Atomic consume; `410` on used/expired; on success sets a session cookie, promotes `index_state` eligibility, and redirects to the live site.

## S5. Zod schemas

**Intake (API boundary — real constraints, this never goes to the model):**
```ts
export const E164 = z.string().regex(/^\+[1-9]\d{6,14}$/);
export const Locale = z.enum(["nl","en","de","fr","es","pt"]);

export const OpeningHours = z.object({
  tz: z.string(),
  byAppointmentOnly: z.boolean(),
  spec: z.array(z.object({
    dayOfWeek: z.array(z.enum(["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"])).min(1),
    opens: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    closes: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  })).max(21),
  closed: z.array(z.string()),
  exceptions: z.array(z.object({ from: z.string(), to: z.string(), closed: z.boolean() })).max(24),
});

export const IntakeSchema = z.object({
  businessName: z.string().trim().min(2).max(120).regex(/\p{L}/u),
  slug: z.string().min(3).max(63).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).refine(s => !s.includes("--")),
  industryKey: z.string().min(1).max(40),
  defaultLocale: Locale,
  extraLocales: z.array(Locale).max(1),                       // Phase 1: at most one extra, Phase 2 fans out
  serviceArea: z.object({ city: z.string().max(80), radiusKm: z.enum(["5","10","25","50"]) }).nullable(),
  address: z.object({
    line1: z.string().max(120), line2: z.string().max(120).nullable(),
    postalCode: z.string().max(16), city: z.string().max(80),
    country: z.string().regex(/^[A-Z]{2}$/),
    latitude: z.number().min(-90).max(90).nullable(),
    longitude: z.number().min(-180).max(180).nullable(),
    geoSource: z.enum(["none","geocoded","user_pin"]),
  }).nullable(),
  openingHours: OpeningHours.nullable(),
  phoneE164: E164,
  whatsappE164: E164.nullable(),
  gbpUrl: z.string().url().startsWith("https://").max(500).nullable(),   // stored for sameAs; NEVER fetched
  shortDescription: z.string().max(600).nullable(),
  contactEmail: z.string().email().max(254),
  marketingOptIn: z.boolean(),
  mediaIds: z.array(z.string()).max(12),
}).refine(v => v.address !== null || v.serviceArea !== null,
  { message: "address_or_service_area_required" });
```
Address/service-area is a `refine`, not two optional fields, because `LocalBusiness` needs one of them and the JSON-LD emitter branches on it.

**Model-facing (`gen/`) — no `pattern`, no `min`/`max`, no recursion, enums for every bounded value, every field required + `.nullable()`:**
```ts
const Hue   = z.enum(["-30","-15","0","15","30"]);
const DnaId = z.enum(["midnight_neon","warm_trattoria","clinical_trust","garage_steel"]); // Phase 1: 4

export const ThemeGen = z.object({
  dnaId: DnaId,
  paletteVariant: z.enum(["default","alt","inverse"]),
  accentHueShift: Hue,
  typeScaleId: z.enum(["compact","regular","editorial","display"]),
  radiusId: z.enum(["sharp","soft","round","pill"]),
  densityId: z.enum(["compact","regular","airy"]),
  motionId: z.enum(["none","subtle","expressive"]),
  colorMode: z.enum(["light","dark"]),
  rationale: z.string(),                       // QA + editor hints; never rendered
});

const MediaRef = z.object({ refId: z.string(),
  focalPoint: z.enum(["center","top","bottom","left","right"]) });

const LinkRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page"),     pageId: z.string() }),
  z.object({ kind: z.literal("anchor"),   sectionId: z.string() }),
  z.object({ kind: z.literal("tel"),      _: z.null() }),
  z.object({ kind: z.literal("whatsapp"), _: z.null() }),
  z.object({ kind: z.literal("email"),    _: z.null() }),
  z.object({ kind: z.literal("route"),    _: z.null() }),
  z.object({ kind: z.literal("external"), refId: z.string() }),   // ∈ server allowlist
]);
const Cta = z.object({ target: LinkRef, style: z.enum(["primary","secondary","ghost"]) });

// NOTE: no *Slot fields anywhere. Slot ids are DERIVED from (sectionId, field, index).
// NOTE: no itemCount — the array length IS the count; normalize() clamps it.
export const SectionGen = z.discriminatedUnion("type", [
  z.object({ id: z.string(), type: z.literal("hero"),
    variant: z.enum(["video_fullbleed","image_split","type_centered","image_offset_grid"]),
    media: MediaRef.nullable(), ctas: z.array(Cta), showTrustline: z.boolean() }),
  z.object({ id: z.string(), type: z.literal("usp_trio"),
    variant: z.enum(["icons_row","numbered_cards","bordered_grid"]),
    items: z.array(z.object({ iconId: z.enum(["clock","shield","star","leaf","truck",
      "heart","wrench","scissors","cup","sparkle","euro","phone"]) })) }),
  /* about · services_grid · menu · gallery · reviews · team · process_steps ·
     stats_band · faq · booking · contact_form · map_hours · cta_band ·
     blog_teaser · rich_text — same pattern */
]);

export const PageGen = z.object({
  pageId: z.string(),
  role: z.enum(["home","about","services","menu","gallery","reviews","team",
                "contact","booking","blog_index","privacy","terms","cookies"]),
  noindex: z.boolean(), showInNav: z.boolean(),
  sections: z.array(SectionGen),
});

export const SiteStructureGen = z.object({
  schemaVersion: z.literal("1"),
  theme: ThemeGen,
  primaryLocale: Locale,
  pages: z.array(PageGen),
  jsonLd: z.object({
    schemaOrgType: z.enum([/* the LocalBusiness-subtype allowlist */]),
    priceRange: z.enum(["€","€€","€€€","€€€€"]).nullable(),
    paymentAccepted: z.array(z.enum(["cash","credit_card","debit_card","ideal",
      "bancontact","paypal","apple_pay","google_pay","bank_transfer","invoice"])),
    amenities: z.array(z.enum(["wheelchair_accessible","parking","wifi",
      "outdoor_seating","takeaway","delivery","pet_friendly","kids_welcome",
      "air_conditioning","ev_charging"])),
  }),
  navStyle: z.enum(["centered_logo_slim","logo_left_links_right","minimal_burger"]),
  footerStyle: z.enum(["rich_4col","rich_3col_map","compact_2col"]),
  whatsappEnabled: z.boolean(),
  stockQueryHint: z.string(),
  inputSafety: z.object({ containsInstructions: z.boolean(), note: z.string() }),
});

export const LocaleBundleGen = z.object({
  schemaVersion: z.literal("1"), locale: Locale,
  entries: z.array(z.object({ id: z.string(), text: z.string() })),
});

export const BlogPostGen = z.object({
  schemaVersion: z.literal("1"), locale: Locale,
  titleText: z.string(), slugSeed: z.string(),
  excerptText: z.string(), metaDescriptionText: z.string(),
  heroMedia: MediaRef.nullable(),
  blocks: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("h2"),    text: z.string() }),
    z.object({ type: z.literal("h3"),    text: z.string() }),
    z.object({ type: z.literal("p"),     text: z.string() }),
    z.object({ type: z.literal("ul"),    items: z.array(z.string()) }),
    z.object({ type: z.literal("quote"), text: z.string(), attributionText: z.string().nullable() }),
    z.object({ type: z.literal("image"), media: MediaRef, captionText: z.string().nullable() }),
    z.object({ type: z.literal("cta"),   target: LinkRef }),
  ])),
});
```

**Why constraint-free is right regardless of SDK behaviour.** The critiques disagreed on whether the TS SDK strips unsupported constraints and validates client-side. This design is correct under either reading: if the SDK strips them, a constrained schema silently fails post-hoc after full payment; if it does not, the API rejects the request. Enums are enforced by grammar-constrained decoding in both cases. Constraints live in `normalize()`, which **repairs and never throws.**

Post-parse, `validateBundle(structure, bundle)` proves key-set equality against `deriveSlotInventory(structure)` — a **pure function of the section list**, which is why deleting the `*Slot` fields was necessary for that check to mean anything.

## S6. Onboarding modal — component list

`apps/marketing/src/islands/` — one React island, `client:idle`, chunk prefetched on `pointerenter`/`focus` of any CTA and on `requestIdleCallback` after LCP, so it never touches the marketing page's critical path.

| Component | Purpose |
|---|---|
| `OnboardingModal.tsx` | Native `<dialog>` + `showModal()`. Top-layer, real focus trap, `inert` behind, `::backdrop`, `Escape` — all free and correct. No hand-rolled trap, **no manual `aria-modal`** (implicit on `showModal()`; adding it double-announces in some AT). |
| `ProgressRail.tsx` | 6 segments visible from frame one. Non-linear fill `[0,28,44,58,72,86,100]` — perceived proximity accelerates completion. Completed segments are backward-nav buttons; `aria-current="step"`. |
| `StepShell.tsx` | Directional slide + crossfade (160 ms out / 240 ms in), `ResizeObserver`-measured height. Sets focus on the step heading after the transition, never on a moving target. |
| `Step1Name.tsx` | Single XL field + live slug preview with availability tick. `autocomplete="organization"`. |
| `Step2Industry.tsx` | ARIA 1.2 combobox over a ~14 KB client-side JSON. Zero network per keystroke. Scoring: exact 100 / prefix 90 / alias 85 / substring 60 / Damerau-Levenshtein≤2 45. Live one-line design preview from `dna.tagline`. |
| `Step3Address.tsx` | NL/BE postcode + house number → one call. Everyone else: manual fields. Service-area toggle. |
| `Step4Hours.tsx` | **Chip-first** (Ma–vr 9–17 / Ma–za 9–18 / Di–zo 12–22 / Op afspraak / 24-7); the 7-day grid is collapsed until edited. `<select>` at 15-min steps, 24h — not `<input type="time">`. `+ pauze` for split shifts. Copy-to-all. |
| `Step5Contact.tsx` | Country button + `<input type="tel">`; `libphonenumber-js/max` **lazy-imported on focus**. WhatsApp checkbox default on. |
| `Step6Story.tsx` | Textarea + media dropzone + email + consent + submit with the trust strip. |
| `MediaDropzone.tsx` | Document-level dragover with a counter (no child flicker). `accept="image/jpeg,image/png,image/webp"` — **this is what makes iOS hand us JPEG instead of HEIC.** |
| `MediaTile.tsx` | queued / compressing / uploading (radial `role="progressbar"`) / done / error. First tile badged `Hero`. |
| `MediaReorder.tsx` | WCAG 2.2 **2.5.7**: pointer drag is an enhancement only. `Space` picks up, arrows move with announcements, `Space` drops, `Escape` restores. Always-visible `⟨ ⟩` buttons at ≥44 px. |
| `SkipMediaCard.tsx` | Full-width, never smaller than the dropzone CTA. Shows 3 stock thumbnails for the industry so "skip" reads as *choosing*. |
| `GenerationTheatre.tsx` | Status rail + live preview. Acts driven by SSE `phase`; between events the bar asymptotically approaches the next floor (`τ = 6 s`) so it always moves and never overshoots. Honest line at 15 s of silence, email-and-release at 45 s. |
| `SkeletonMorph.tsx` | `data-slot` blocks; on a `streaming` event: measure → swap → FLIP 220 ms → fade 160 ms. Blurhash → image crossfade with `blur(12px)→blur(0)`. |
| `RevealCard.tsx` | Un-blur + spring, domain sheen, 14 SVG confetti particles — **all suppressed under `prefers-reduced-motion`**. |
| `ErrorSummary.tsx` | `role="alert" tabindex="-1"`, focused on submit with ≥2 errors. Anchor text is the exact error copy. |
| `LiveRegions.tsx` | One polite, one assertive. Cleared then set on **separate ticks ~100 ms apart** — one animation frame is too short for a screen reader to observe the mutation. Generation announcements throttled to 1 per 4 s. |
| `useDraft.ts` | 400 ms local debounce, 1200 ms server debounce, `sendBeacon` on `pagehide`, every storage access in `try/catch` with an in-memory fallback. |
| `useKeyboardInset.ts` | **`visualViewport`-driven footer offset.** `env(safe-area-inset-bottom)` is the notch inset and does nothing about the software keyboard; on iOS the layout viewport does not shrink, so a sticky footer sits under the keyboard — a WCAG 2.4.11 failure on the primary conversion button, on the majority platform. Plus `interactive-widget=resizes-content` in the viewport meta. |
| `useSSE.ts` | `EventSource` + `Last-Event-ID`; falls back to 2 s polling after two failed reconnects. |

Reduced motion: durations collapse to ~0.01 ms globally, then opacity-only essentials are re-enabled (120 ms modal crossfade, 100 ms step crossfade) — because a progress bar that does not move is a broken progress bar, `width` transitions are kept but the asymptotic interpolation is disabled and the bar steps on real events only.

## S7. Security headers (one middleware, every response)

```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload   # aibuilder.app + mijnsaas.com apex only
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=(), fullscreen=(self)
Cross-Origin-Opener-Policy: same-origin        # app/api only
X-Frame-Options: DENY                          # legacy companion to frame-ancestors
```
`interest-cohort=()` is **dropped** — FLoC was withdrawn in 2022 and it is not a real Permissions-Policy feature; `browsing-topics=()` is the actual successor opt-out. On customer custom domains: `max-age=15768000`, **no `includeSubDomains`, no `preload`** — preloading a customer's apex is close to irreversible and will break them if they ever leave.

---

## Three things to settle with the client before code freeze

1. **Nominate the control-plane domain.** `aibuilder.app` is a placeholder. Everything in §1.1 depends on it and it cannot be retrofitted after slugs are indexed.
2. **Workers Static Assets instead of Pages** is a deviation from a stated non-negotiable and needs explicit sign-off. The honest argument is not the one the framework document gave (the `@astrojs/cloudflare` v13 Pages removal affects SSR only, and a static Astro build needs no adapter at all): it is that Cloudflare directs new projects to Workers, Pages is in maintenance, Workers Static Assets gives identical free static-asset billing, Workflows/Cron/Secrets Store are Workers-only, and one deployment primitive across six deployables beats two.
3. **Whether the first generation is free.** It is $1.20 of Anthropic spend on an unauthenticated endpoint, amortised at ~$8 per paying customer at 15% conversion. Requiring the Stripe trial before the *first* generation removes the largest financial risk in the product and the largest source of abuse, at a conversion cost. The blueprint says regeneration is the paywall, so this architecture keeps the first generation free — but that should be a decision, not something discovered from an invoice.