Research done. Here is the design.

---

# AI Website Generation Pipeline — `aibuilder`

Verified against Cloudflare's current paid-tier limits and the Anthropic API facts in the brief. Aligns with the D1 schema already in `/home/user/aibuilder/migrations/` (`generation_jobs`, `generation_job_events`, `content_blobs`, `site_versions`, `page_translations`).

---

## 1. OUTPUT CONTRACT

### Verdict: **(c) hybrid — and the hybrid is the security boundary, not the prompt**

**(b) raw HTML/CSS is disqualified on two independent grounds.**

*Security:* tenant sites live at `<slug>.mijnsaas.com`. Anything the model emits as markup is an XSS primitive on a shared parent domain — `<script>`, `<img onerror>`, `javascript:` hrefs, `<svg><use href>`, CSS `url()` exfil. Sanitising model-authored HTML is a permanent losing game, and the attacker is *inside the prompt*: the onboarding form's "short description" is free text a hostile signup controls. You cannot prompt your way out of this.

*Lighthouse:* 100/100 is a property of bytes you control — inlined critical CSS, an explicitly preloaded LCP element, `width`/`height` on every image, a font subset with metric overrides, ≤4 KB of JS, zero third-party origins. Each of those is a deterministic invariant. A model authoring HTML re-rolls the dice on all of them every generation, and you find out post-hoc.

**(a) pure JSON site doc is the right *shape* but the wrong *vocabulary*.** If the model emits `"#c8102e"` and `"padding: 72px"`, it is still inventing a design system: unvalidated contrast ratios, broken type scales, off-grid spacing. You have moved the failure from XSS to taste, but it is still nondeterministic.

**(c) wins.** The model emits **selections and prose**. Code owns **every byte that renders**.

### The four invariants

| # | Invariant | Enforcement |
|---|---|---|
| 1 | **No model string reaches the DOM except as a text node or a whitelisted attribute value** | Renderer only ever calls `escapeHtml()`. No `innerHTML`, no markdown parser, no rich-text runs — plain strings only. Emphasis comes from *section structure* (lead paragraph, stat callout), not inline markup. |
| 2 | **The model cannot author a URL** | Every link is a symbolic ref: `{kind:"page",pageId}` / `{kind:"tel"}` / `{kind:"whatsapp"}` / `{kind:"email"}` / `{kind:"external",refId}` where `refId` indexes a server-built allowlist (GBP URL + socials from onboarding). Kills `javascript:`, phishing, and SSRF. |
| 3 | **The model cannot author CSS** | It picks a `designDnaId` from a closed enum plus ≤6 bounded knobs. Code resolves those to OKLCH-derived CSS custom properties. Every reachable combination is snapshot-tested in CI. |
| 4 | **The model cannot author JSON-LD** | It supplies typed inputs (`schemaOrgType` enum, `priceRange` enum). Code builds the graph from D1 facts and serialises with `<` → `\u003c`. |

Because of (1)–(4), a *fully successful* prompt injection yields nothing exploitable — the worst case is bad copy, which the editor fixes. That is the point: **the output contract is the security boundary.** The tenant CSP then becomes shippable: `default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; script-src 'sha256-…'; base-uri 'none'; form-action 'self'` — itself a Lighthouse best-practices signal.

### Critical constraint on schema design (verified)

Structured Outputs' JSON-Schema subset **rejects**: recursive schemas, external `$ref`, `minLength`/`maxLength`, `minimum`/`maximum`/`multipleOf`, complex types inside enums, and `minItems` other than `0` or `1`. Grammar is compiled on first use and cached 24h; schema changes invalidate it, and the injected grammar prompt slightly raises input tokens.

So the schema is **two-layer**:

- **`wire.ts`** — constraint-free, model-facing, passed to `zodOutputFormat()`. Only objects, string enums, booleans, arrays, literal-discriminated unions, `.nullable()`.
- **`domain.ts`** — the same shapes `.extend()`ed with `.min()`/`.max()`/`.regex()`/`.refine()`, applied **after** parse, plus cross-document referential integrity.

Two deliberate tricks: **bounded numerics become string enums** (`"2"|"3"|"4"`), so grammar-constrained decoding enforces the bound for free and code casts; and **every field is required + `.nullable()`, never `.optional()`** — an optional field lets the model silently omit a slot, a nullable one forces an explicit decision.

### The schema (three model-facing documents, not one)

Splitting structure from copy is what makes the fan-out, the translation strategy, and the editor all work.

```ts
// ═══════════════════════════════════════════════════════════════════
// wire.ts — MODEL-FACING. No constraint keywords. Bounds via enums.
// ═══════════════════════════════════════════════════════════════════
import { z } from "zod";

export const Locale = z.enum(["nl", "en", "de", "fr", "es", "pt"]);
const Count = z.enum(["1", "2", "3", "4", "5", "6"]);          // cast Number() in code
const Shift = z.enum(["-30", "-15", "0", "15", "30"]);         // bounded numeric knob

/* ── THEME ─────────────────────────────────────────────────────── */
export const DesignDnaId = z.enum([
  "midnight_neon", "warm_trattoria", "cream_bistro", "nordic_calm",
  "clinical_trust", "chambers_navy", "workwear_industrial", "concrete_brutal",
  "soft_botanical", "sunlit_editorial", "salon_monochrome", "ink_tattoo",
  "estate_serif", "athletic_charge", "coastal_light", "atelier_muted",
  "bakery_paper", "garage_steel", "petal_market", "studio_gallery",
  "kids_playful", "tech_slate", "heritage_gold", "eco_moss",
]);

export const Theme = z.object({
  designDnaId: DesignDnaId,
  paletteVariant: z.enum(["default", "alt", "inverse"]),
  accentHueShift: Shift,                                        // ±30° in OKLCH
  typeScaleId: z.enum(["compact", "regular", "editorial", "display"]),
  radiusId: z.enum(["sharp", "soft", "round", "pill"]),
  densityId: z.enum(["compact", "regular", "airy"]),
  motionId: z.enum(["none", "subtle", "expressive"]),
  imageTreatmentId: z.enum(["natural", "warm_grade", "cool_grade",
                            "duotone_accent", "high_contrast_bw"]),
  ornamentId: z.enum(["none", "hairline", "grain", "gradient_wash", "arch_mask"]),
  colorMode: z.enum(["light", "dark"]),
  rationale: z.string(),        // internal only — never rendered, used for QA + editor hints
});

/* ── REFS: the only way the model addresses the outside world ───── */
const MediaRef = z.object({
  refId: z.string(),                                            // ∈ server media manifest
  focalPoint: z.enum(["center", "top", "bottom", "left", "right"]),
});
const LinkRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page"),     pageId: z.string() }),
  z.object({ kind: z.literal("anchor"),   sectionId: z.string() }),
  z.object({ kind: z.literal("tel"),      _: z.null() }),
  z.object({ kind: z.literal("whatsapp"), _: z.null() }),
  z.object({ kind: z.literal("email"),    _: z.null() }),
  z.object({ kind: z.literal("route"),    _: z.null() }),        // maps deep-link, built by code
  z.object({ kind: z.literal("external"), refId: z.string() }),  // ∈ server allowlist
]);
const Cta = z.object({ labelSlot: z.string(), target: LinkRef,
                       style: z.enum(["primary", "secondary", "ghost"]) });

/* ── SECTIONS: flat discriminated union, NEVER recursive ────────── */
// Sections carry zero prose. They carry SLOT IDS. Code derives the slot
// inventory from the section list; the model cannot invent a slot id.
const Base = { id: z.string() };                                 // "s3"

export const Section = z.discriminatedUnion("type", [
  z.object({ ...Base, type: z.literal("hero"),
    variant: z.enum(["video_fullbleed", "image_split", "type_centered", "image_offset_grid"]),
    media: MediaRef.nullable(), headlineSlot: z.string(), subheadSlot: z.string().nullable(),
    ctas: z.array(Cta), showTrustline: z.boolean() }),

  z.object({ ...Base, type: z.literal("usp_trio"),
    variant: z.enum(["icons_row", "numbered_cards", "bordered_grid"]),
    itemCount: Count,
    items: z.array(z.object({ iconId: z.enum(["clock","shield","star","leaf","truck",
      "heart","wrench","scissors","cup","sparkle","euro","phone"]),
      titleSlot: z.string(), bodySlot: z.string() })) }),

  z.object({ ...Base, type: z.literal("about"),
    variant: z.enum(["text_image", "image_text", "wide_quote", "timeline"]),
    media: MediaRef.nullable(), headlineSlot: z.string(),
    bodySlots: z.array(z.string()), cta: Cta.nullable() }),

  z.object({ ...Base, type: z.literal("services_grid"),
    variant: z.enum(["cards_3col", "list_split", "image_tiles", "accordion"]),
    itemCount: Count, headlineSlot: z.string(),
    items: z.array(z.object({ titleSlot: z.string(), bodySlot: z.string(),
      priceSlot: z.string().nullable(), media: MediaRef.nullable(),
      target: LinkRef.nullable() })) }),

  z.object({ ...Base, type: z.literal("menu"),                   // food verticals
    variant: z.enum(["two_column", "cards", "chalkboard"]),
    headlineSlot: z.string(),
    groups: z.array(z.object({ titleSlot: z.string(),
      items: z.array(z.object({ nameSlot: z.string(), descSlot: z.string().nullable(),
        priceSlot: z.string(),
        tags: z.array(z.enum(["vegan","vegetarian","gluten_free","spicy","new"])) })) })) }),

  z.object({ ...Base, type: z.literal("gallery"),
    variant: z.enum(["masonry", "carousel", "grid_square", "before_after"]),
    media: z.array(MediaRef), captionSlots: z.array(z.string()) }),

  z.object({ ...Base, type: z.literal("reviews"),
    variant: z.enum(["cards_3col", "single_large", "marquee", "google_badge"]),
    headlineSlot: z.string(), source: z.enum(["google", "manual", "mixed"]) }),

  z.object({ ...Base, type: z.literal("team"),
    variant: z.enum(["portraits_grid", "list_compact"]),
    itemCount: Count,
    items: z.array(z.object({ nameSlot: z.string(), roleSlot: z.string(),
      media: MediaRef.nullable() })) }),

  z.object({ ...Base, type: z.literal("process_steps"),
    variant: z.enum(["numbered_horizontal", "vertical_timeline", "arrow_flow"]),
    itemCount: Count,
    items: z.array(z.object({ titleSlot: z.string(), bodySlot: z.string() })) }),

  z.object({ ...Base, type: z.literal("stats_band"),
    variant: z.enum(["plain", "boxed", "accent_bg"]),
    itemCount: Count,
    items: z.array(z.object({ valueSlot: z.string(), labelSlot: z.string() })) }),

  z.object({ ...Base, type: z.literal("faq"),
    variant: z.enum(["accordion", "two_column"]),
    headlineSlot: z.string(), emitFaqSchema: z.boolean(),
    items: z.array(z.object({ qSlot: z.string(), aSlot: z.string() })) }),

  z.object({ ...Base, type: z.literal("booking"),
    variant: z.enum(["inline_calendar", "cta_to_provider"]),
    headlineSlot: z.string(), bodySlot: z.string().nullable(),
    provider: z.enum(["native", "external_link"]) }),

  z.object({ ...Base, type: z.literal("contact_form"),
    variant: z.enum(["split_map", "stacked", "boxed_accent"]),
    headlineSlot: z.string(),
    fields: z.array(z.enum(["name","email","phone","date","service","message","consent"])),
    submitSlot: z.string() }),

  z.object({ ...Base, type: z.literal("map_hours"),
    variant: z.enum(["map_left", "map_right", "hours_only"]),
    headlineSlot: z.string(), showRouteCta: z.boolean() }),

  z.object({ ...Base, type: z.literal("cta_band"),
    variant: z.enum(["accent_full", "image_overlay", "minimal_rule"]),
    headlineSlot: z.string(), bodySlot: z.string().nullable(),
    media: MediaRef.nullable(), ctas: z.array(Cta) }),

  z.object({ ...Base, type: z.literal("blog_teaser"),
    variant: z.enum(["cards_2col", "list"]), headlineSlot: z.string() }),

  z.object({ ...Base, type: z.literal("rich_text"),              // legal / long-form
    variant: z.enum(["prose_narrow", "prose_wide"]),
    headlineSlot: z.string(), bodySlots: z.array(z.string()) }),
]);

/* ── PAGES + SEO ───────────────────────────────────────────────── */
export const Page = z.object({
  pageId: z.string(),
  role: z.enum(["home","about","services","menu","gallery","reviews","team",
                "contact","booking","blog_index","privacy","terms","cookies"]),
  slugSeedSlot: z.string(),      // model writes a PHRASE per locale; CODE slugifies
  titleSlot: z.string(),         // ≤60 chars enforced post-parse
  descriptionSlot: z.string(),   // ≤155 chars enforced post-parse
  ogMedia: MediaRef.nullable(),
  noindex: z.boolean(),
  showInNav: z.boolean(),
  sections: z.array(Section),
});

/* ── JSON-LD INPUTS (typed facts, never a serialised graph) ─────── */
export const JsonLdInputs = z.object({
  schemaOrgType: z.enum(["Restaurant","CafeOrCoffeeShop","Bakery","BarOrPub","NightClub",
    "HairSalon","BeautySalon","NailSalon","HealthAndBeautyBusiness","Dentist","Physician",
    "MedicalClinic","LegalService","Accounting","Plumber","Electrician","HVACBusiness",
    "GeneralContractor","RoofingContractor","HousePainter","Locksmith","MovingCompany",
    "RealEstateAgent","AutoRepair","AutoDealer","GasStation","Florist","PetStore",
    "VeterinaryCare","ExerciseGym","SportsActivityLocation","DaySpa","Photographer",
    "TattooParlor","DrivingSchool","ChildCare","ProfessionalService","Store","LocalBusiness"]),
  priceRange: z.enum(["€","€€","€€€","€€€€"]).nullable(),
  servesCuisine: z.array(z.string()).nullable(),
  acceptsReservations: z.boolean().nullable(),
  areaServedSlot: z.string().nullable(),
  paymentAccepted: z.array(z.enum(["cash","credit_card","debit_card","ideal","bancontact",
    "paypal","apple_pay","google_pay","bank_transfer","invoice"])),
  amenities: z.array(z.enum(["wheelchair_accessible","parking","wifi","outdoor_seating",
    "takeaway","delivery","pet_friendly","kids_welcome","air_conditioning","ev_charging"])),
});

/* ── DOC A: STRUCTURE (one call, locale-independent, ZERO prose) ── */
export const SiteStructure = z.object({
  schemaVersion: z.literal("1"),
  theme: Theme,
  primaryLocale: Locale,
  pages: z.array(Page),
  jsonLd: JsonLdInputs,
  whatsappEnabled: z.boolean(),
  navStyle: z.enum(["centered_logo_slim", "logo_left_links_right", "minimal_burger"]),
  footerStyle: z.enum(["rich_4col", "rich_3col_map", "compact_2col"]),
  stockQueryHint: z.string(),   // 2-4 words; CODE composes the final Pexels query
});

/* ── DOC B: COPY (one call per locale; flat, no dynamic keys) ───── */
export const LocaleBundle = z.object({
  schemaVersion: z.literal("1"),
  locale: Locale,
  entries: z.array(z.object({ id: z.string(), text: z.string() })),
});

/* ── DOC C: BLOG ───────────────────────────────────────────────── */
export const BlogPost = z.object({
  schemaVersion: z.literal("1"),
  locale: Locale,
  titleText: z.string(), slugSeed: z.string(), excerptText: z.string(),
  metaDescriptionText: z.string(),
  heroMedia: MediaRef.nullable(),
  blocks: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("h2"),     text: z.string() }),
    z.object({ type: z.literal("h3"),     text: z.string() }),
    z.object({ type: z.literal("p"),      text: z.string() }),
    z.object({ type: z.literal("ul"),     items: z.array(z.string()) }),
    z.object({ type: z.literal("ol"),     items: z.array(z.string()) }),
    z.object({ type: z.literal("quote"),  text: z.string(), attributionText: z.string().nullable() }),
    z.object({ type: z.literal("image"),  media: MediaRef, captionText: z.string().nullable() }),
    z.object({ type: z.literal("cta"),    labelText: z.string(), target: LinkRef }),
  ])),
});
```

```ts
// ═══════════════════════════════════════════════════════════════════
// domain.ts — SERVER-SIDE. Real constraints + referential integrity.
// ═══════════════════════════════════════════════════════════════════
export const StrictPage = Page.extend({
  titleSlot: z.string().min(1), descriptionSlot: z.string().min(1),
  sections: z.array(Section).min(1).max(12),
});

export const validateBundle = (
  struct: z.infer<typeof SiteStructure>,
  bundle: z.infer<typeof LocaleBundle>,
) => {
  const required = deriveSlotInventory(struct);          // pure fn over the section list
  const got = new Map(bundle.entries.map(e => [e.id, e.text]));
  const missing = [...required].filter(id => !got.has(id));
  const unknown = bundle.entries.filter(e => !required.has(e.id)).map(e => e.id);
  const overlong = struct.pages.flatMap(p => [
    [p.titleSlot, 60] as const, [p.descriptionSlot, 155] as const,
  ]).filter(([id, max]) => (got.get(id)?.length ?? 0) > max);
  return { missing, unknown, overlong };                 // → deterministic repair, then model repair
};
```

**Why the slot indirection earns its keep:** the model never invents a slot id (code derives the inventory from the section list); translation becomes a pure `entries[]` → `entries[]` map; the live editor's left panel is a flat list of `(slotId, text)` rows with no tree-walking; and `page_translations` in D1 stores exactly one bundle per `(page, locale)`.

---

## 2. PROMPT ARCHITECTURE

### Decision: one frozen mega-prefix shared by *every* call type, not per-call-type prefixes

The tempting design is a tailored system prompt per call (brief / copy / translate / blog). It is wrong. Caching is a **prefix match**, so divergent prefixes mean *n* cache entries, *n* cold writes, and *n* keep-alives. One identical 50K prefix for all ten calls costs $0.025 per call in cache reads — noise — and buys a single always-warm entry with a near-100% hit rate. The task selector goes in the **user** turn.

### Layering

```
tools:  (none — the generation path uses no tools; media search runs in code)
system: [ block 1 … block 8 ]  ← ALL FROZEN, byte-identical for every call
        └─────────────── cache_control: {type:"ephemeral", ttl:"1h"} ← BP1 (~50K)
messages:
  user: <business_facts>  …untrusted tenant data + media manifest…
        └─────────────── cache_control: {type:"ephemeral"} ← BP2 (~1.8K)
  user: <task>            …"emit SiteStructure" / "translate to de" / …
  (repair turns append here — no assistant prefill; prefill 400s on claude-opus-5)
```

| Block | Content | Tokens | Churn |
|---|---|---|---|
| 1 | Role, safety rules, the "you never emit markup/CSS/URLs" contract, untrusted-data framing | 4,000 | never |
| 2 | JSON contract docs — field semantics the schema can't encode (when `variant` X vs Y, slot naming, `rationale` usage) | 3,500 | on schema version |
| 3 | Section catalogue — 17 types × variants, slot inventories, fitness notes, anti-patterns | 8,500 | monthly |
| 4 | Design-DNA playbook — 24 presets, what each *feels* like, knob semantics, combination rules | 7,000 | monthly |
| 5 | Industry → DNA mapping table (~60 industries) | 2,500 | weekly |
| 6 | SEO rules — title/description budgets, hreflang, slug-seed rules, JSON-LD input semantics | 3,000 | rarely |
| 7 | Locale style cards ×6 — formality register (Sie/du, u/je, vous), number/date/address/phone/VAT formats, CTA idiom | 4,500 | rarely |
| 8 | Two golden exemplar documents (a restaurant, a plumber), compact | 12,000 | monthly |
| | **BP1 total** | **~45,000** | |
| | + injected grammar prompt from `output_config.format` | ~3–5K | per schema |
| | **effective cached prefix** | **~48–50K** | |

**Volatile block (after BP1, before BP2):** business name, address, industry key, opening hours, description, phone, GBP URL, media manifest (R2 uploads + Pexels shortlist with ids and captions), locale set, external-link allowlist. ~1,800 tokens. It is cached at BP2 because **all ten calls in one job share it**, and a regeneration within the hour hits it too.

Two breakpoints used, two held in reserve (max is 4) — one for a long repair turn, one spare.

### Cost per generation

Model `claude-opus-5`: **$5/MTok in · $25/MTok out · $0.50/MTok cache read (0.1×) · $6.25/MTok cache write (1.25×)**.

| # | Call | `effort` | cache read | fresh in | out |
|---|---|---|---|---|---|
| 1 | `plan-brief` → `SiteStructure` | `high` | 48,000 | 1,800 (write) | 6,000 |
| 2 | `copy-primary` → `LocaleBundle(nl)` | `high` | 49,800 | 400 | 9,000 |
| 3–7 | `localize` ×5 → `LocaleBundle(en/de/fr/es/pt)` | `medium` | 49,800 | 9,400 | 9,500 |
| 8–9 | `blog` ×2 → `BlogPost` (primary locale only) | `medium` | 49,800 | 700 | 4,000 |
| 10 | `legal-variables` (fills a **pre-translated** template) | `low` | 49,800 | 500 | 800 |

```
cache reads   516,200 tok × $0.50/MTok  = $0.258
cache write     1,800 tok × $6.25/MTok  = $0.011
fresh input    49,300 tok × $5.00/MTok  = $0.247
output         71,300 tok × $25.0/MTok  = $1.783
                                        ─────────
   6-locale site                          $2.30
   1-locale site (calls 1,2,8,9,10)        $0.75
```

**Caching is worth ~49% of the job.** Uncached, the same ten calls pay 500,000 fresh input tokens = $2.50, against $0.258 — a **$2.24 saving per site**.

Prefix write amortisation: 48,000 × $6.25/MTok = **$0.30 per write**. With `ttl:"1h"` that is ≤$7.20/day globally even at zero traffic; above ~1 generation per 5 minutes the default 5m TTL stays warm off real traffic for free. Note the pre-warm gotcha: `max_tokens: 0` is rejected together with `output_config.format`, so warm with a real `max_tokens: 64` no-op call carrying the same `output_config`, and confirm with `usage.cache_read_input_tokens` — the injected grammar prompt is part of the prefix, so a *format-less* warm request may key differently.

**Unit economics:** €9,99/mo billed annually ≈ €119,88 ≈ $130/yr. One free single-locale generation ($0.75) + ~6 metered regenerations ($2.30) ≈ **$14.5/yr COGS ≈ 11% of revenue**. That number is the whole argument for the regeneration paywall.

**Effort is the tuning lever, not model choice.** `plan-brief` is the only call where design judgment compounds across the whole site — keep it `high` (consider `xhigh` and A/B it). Translation and legal are mechanical: `medium`/`low`. Never downgrade the model; downgrade effort.

---

## 3. DECOMPOSITION

### Verified Cloudflare paid-tier limits (Sept 2026)

| Primitive | Limit that matters |
|---|---|
| **Workers (Paid)** | CPU **30 s default, configurable to 5 min** per request; **no wall-clock limit** while awaiting I/O; subrequests **10,000 default** (was 1,000 before Feb 2026), raisable to 10M via `limits.subrequests` |
| **Queues** | consumer **15 min wall clock** — killed mid-job past that |
| **Durable Object alarms** | **15 min wall clock** per invocation |
| **Workflows (Paid)** | **10,000 steps** default → **25,000** configurable; step compute 30 s default → **5 min CPU**; **wall clock per step unlimited**; sleep to 365 days; state retained 30 days; **1 GB persisted state/instance**; 50K concurrent instances, 300 new/s |

### Decision: **fan-out on Cloudflare Workflows.** Not one giant call, not Queues, not `waitUntil`.

**Not one giant call.** A 6-locale site is ~71K output tokens. One call means: mandatory streaming near the 128K ceiling, 8–15 min TTFT-to-done, and — decisively — **one schema defect or one `stop_reason: "max_tokens"` destroys $2.30 of work with no partial salvage**. Ten calls means a failed Portuguese translation retries for $0.30 while the other nine stay memoised.

**Not Queues, not DO alarms.** Both cap at **15 min wall clock**. A 6-locale job is 5–12 min happy-path; add one retry on a slow `high`-effort call and you are dead. Workflows has **no wall-clock cap per step**.

**Not `waitUntil`.** No durability, no retry, no memoisation, no observability, and it dies with the request context.

**Workflows wins on the property that matters: per-step memoisation.** Each Anthropic call is one `step.do` with its own retry policy. That is simultaneously the reliability story *and* the cost-control story.

**Durable Objects keep three jobs** — all of them things Workflows deliberately can't do:
1. **`JobHub` (one per run)** — the SSE progress feed, append-only event log in DO SQL storage.
2. **`AnthropicLimiter` (one global)** — token-bucket concurrency cap (~20 in-flight Opus calls account-wide). Fan-out ×5 locales × N concurrent jobs will hit 429s otherwise, and a D1 read-then-write cannot be atomic under that fan-out.
3. **`TenantBudget` (one per org)** — atomic pre-flight cost reservation.

**Queues keep only side effects:** sitemap ping, thumbnail derivatives, webhook delivery, Stripe reconciliation. Nothing on the critical path.

### Job state machine

```
                            ┌──────── cancelled ◄─── user
                            │
queued ─► validating ─► planning ─► media_resolving ─► copy_primary
                            │                                │
                            │                    ┌───────────┴───────────┐
                            │                    ▼           ▼           ▼
                            │            localize×5    blog×2      legal_vars   (parallel)
                            │                    └───────────┬───────────┘
                            │                                ▼
                            │                          assembling
                            │                                ▼
                            │                    auditing (perf/contrast/a11y budgets)
                            │                                ▼
                            │                           rendering ─► publishing ─► ready
                            │
                            └─► blocked_paywall | needs_review | failed
```

`needs_review` is the terminal state for a `stop_reason: "refusal"` or a moderation hit — a human-visible state, never a silent retry.

### The Workflow

```ts
export class SiteGenerationWorkflow extends WorkflowEntrypoint<Env, GenParams> {
  async run(event: WorkflowEvent<GenParams>, step: WorkflowStep) {
    const { runId, siteId, orgId, locales, primaryLocale } = event.payload;
    const hub = this.env.JOB_HUB.get(this.env.JOB_HUB.idFromName(runId));
    const emit = (phase: Phase, pct: number, data?: unknown) =>
      hub.fetch("https://hub/emit", { method: "POST",
        body: JSON.stringify({ phase, progress: pct, data }) });

    const intake = await step.do("validate-intake",
      { retries: { limit: 2, delay: "2 seconds", backoff: "exponential" } },
      () => validateIntake(this.env, siteId));                    // + Haiku 4.5 policy screen

    // Deterministic: R2 uploads + Pexels shortlist. Cached by query hash.
    const media = await step.do("resolve-media",
      { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "3 minutes" },
      () => resolveMedia(this.env, intake));

    await emit("api_call", 15);
    // Big payloads go to R2; the step returns a pointer, keeping instance state tiny
    // (step outputs cap at 1 MiB; instance state at 1 GB).
    const structRef = await step.do("plan-brief",
      { retries: { limit: 3, delay: "20 seconds", backoff: "exponential" }, timeout: "10 minutes" },
      () => callAnthropic(this.env, {
        runId, kind: "initial_site", effort: "high", maxTokens: 32_000,
        schema: SiteStructure, task: TASK_PLAN_BRIEF, intake, media,
      }));

    const primaryRef = await step.do("copy-primary", RETRY, () =>
      callAnthropic(this.env, { runId, kind: "copy_rewrite", effort: "high",
        maxTokens: 32_000, schema: LocaleBundle, locale: primaryLocale,
        task: TASK_COPY, intake, media, structRef }));

    await emit("streaming", 45);
    // Fan-out. Separate steps ⇒ a single locale failure retries alone.
    const rest = locales.filter(l => l !== primaryLocale);
    const [bundles, posts] = await Promise.all([
      Promise.all(rest.map(loc => step.do(`localize-${loc}`, RETRY, () =>
        callAnthropic(this.env, { runId, kind: "translate", effort: "medium",
          maxTokens: 32_000, schema: LocaleBundle, locale: loc,
          task: TASK_LOCALIZE, intake, structRef, primaryRef })))),
      Promise.all([0, 1].map(i => step.do(`blog-${i}`, RETRY, () =>
        callAnthropic(this.env, { runId, kind: "blog_post", effort: "medium",
          maxTokens: 16_000, schema: BlogPost, locale: primaryLocale,
          task: TASK_BLOG(i), intake, media, structRef })))),
    ]);

    const legal = await step.do("legal-variables", RETRY, () =>
      fillLegalTemplate(this.env, intake, locales));   // pre-translated boilerplate, not AI prose

    const site = await step.do("assemble", () =>
      assembleAndValidate(this.env, { structRef, primaryRef, bundles, posts, legal, media }));

    await step.do("audit", () => auditBudgets(this.env, site));      // contrast, weight, a11y, CLS
    await emit("build", 80);

    // The only CPU-heavy step. Split per locale to stay clear of the CPU cap.
    const rendered = await Promise.all(locales.map(loc =>
      step.do(`render-${loc}`, () => renderLocale(this.env, site, loc))));

    await step.do("publish", () => publishAtomically(this.env, siteId, rendered));
    await emit("done", 100);
  }
}
```

**Idempotency comes free from the instance id:** `gen:{siteId}:{intakeHash}` — Workflows rejects a duplicate instance id, so a double-submitted onboarding form cannot start two jobs. **This makes the `locked_by` / `lock_expires_at` cooperative lease in `generation_jobs` redundant** — Workflows guarantees single execution per instance. Keep the columns for the legacy poller path if you want, but the reaper index (`idx_jobs_reaper`) should not be the safety net.

**Schema note for the parent agent:** `generation_jobs` currently holds one row per *run* with a single `input_tokens`/`cost_usd_micro` set, but this design makes **10 Anthropic calls per run**. Add a child table:

```sql
CREATE TABLE generation_calls (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  step_name TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL, locale TEXT REFERENCES locales(code),
  effort TEXT NOT NULL CHECK (effort IN ('low','medium','high','xhigh','max')),
  max_tokens INTEGER NOT NULL, schema_name TEXT, schema_version TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd_micro INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT, refusal_category TEXT, anthropic_request_id TEXT,
  repair_rounds INTEGER NOT NULL DEFAULT 0 CHECK (repair_rounds BETWEEN 0 AND 2),
  started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX uq_calls_step ON generation_calls(job_id, step_name, attempt);
CREATE INDEX idx_calls_cost ON generation_calls(job_id, cost_usd_micro);
```
Roll `generation_jobs.cost_usd_micro` up from it. The existing `generation_job_events` table is exactly right for the DO's event log — mirror DO events into it on flush for durability past the DO's lifetime.

### Client progress watching: **SSE from the `JobHub` Durable Object**

Ranked against the alternatives:

| Option | Verdict |
|---|---|
| **Polling** `GET /jobs/:id` every 2s | Works, ~150 requests/job, zero infra. **Keep as the automatic fallback.** |
| **WebSocket + Hibernation** | Right answer *later* for the live editor (bidirectional, hibernation means no billable duration while idle, 32 MiB message cap). Overkill for a one-way 5-minute feed. |
| **SSE from a DO** ✅ | One-way, native `EventSource` auto-reconnect, `Last-Event-ID` resume for free, survives corporate proxies, no framing code. |

The magic-popup UX depends on *narrated* progress ("Choosing a palette…", "Writing your homepage…", "Translating to German…"), which is exactly an event stream, not a percentage. Implementation:

```ts
// GET /api/runs/:id/events   → text/event-stream
// DO holds an append-only log in SQL storage: (seq INTEGER PK, phase, message, progress, data, ts)
// On connect: replay everything after Last-Event-ID, then stream live.
// Heartbeat ": ping\n\n" every 15s so intermediaries don't reap the connection.
// The DO is billed for duration while the stream is open — a 5-min job is ~cents.
// Client falls back to polling after 2 failed EventSource reconnects.
```

The DO also owns run-level truth for the paywall: on `regenerate_*`, the DO checks `organisations.entitlement IN ('trialing','active')` **before** dispatching the Workflow, and writes `status='blocked_paywall'`. The check belongs there, not in the Workflow — you must never spend a step on a job that isn't entitled.

---

## 4. INDUSTRY DESIGN INTELLIGENCE

### The principle: the model **selects and parameterises**; it never authors

Three layers:

**Layer 0 — primitives.** Colours are defined in **OKLCH** and generated by code from `(hue, chroma, lightnessCurve)`. Because OKLCH lightness is perceptually uniform, a palette generated at fixed L-steps has *provable* contrast. Every palette ships with a machine-checked contrast matrix (WCAG AA minimum, AAA for body text) computed in CI. The model cannot select an unreadable pair because unreadable pairs do not exist in the token set.

**Layer 1 — semantic tokens.** `--bg --surface --surface-2 --ink --ink-muted --accent --accent-ink --border --focus --overlay`, plus `--space-{1..12}` on a fixed 4px grid, `--radius-{sm,md,lg}`, `--shadow-{1,2}`, `--font-display --font-body`, `--step--1 … --step-6` (fluid `clamp()` type scale). Resolved deterministically from the DNA preset + knobs.

**Layer 2 — Design DNA presets.** A named tuple of `(paletteId, typePairId, scaleId, radiusId, densityId, motionId, heroTreatmentId, imageTreatmentId, ornamentId, sectionRhythmId)`. 24 presets × (3 palette variants × 5 hue shifts × 4 radii × 3 densities) ≈ 4,300 reachable looks — and **every one is renderable by construction**, because each axis is a token swap, not a code path.

**How different-ness is achieved:** the presets differ on *structural* axes, not just colour. `heroTreatmentId` (full-bleed video / editorial split / centered type / offset grid), `sectionRhythmId` (tight-alternating / generous single-column / asymmetric offset), `ornamentId` (hairline rules / film grain / gradient wash / arch masks), `imageTreatmentId` (duotone / warm grade / high-contrast B&W). A DJ and a restaurant differ in silhouette and rhythm, not merely hue — that is what makes them read as *designed* rather than *recoloured*.

**Fonts are self-hosted, always.** Eight curated variable-font pairings, subset to `latin` + `latin-ext` (needed for PT/ES/DE/FR/NL diacritics), served from R2 with immutable cache headers. **Never Google Fonts CDN** — it is a third-party origin on the critical path *and* German courts have treated Google Fonts hotlinking as a GDPR violation (transferring visitor IPs to the US without consent). For a product selling to European small businesses, self-hosting is a compliance feature, not just a perf one.

**CI guarantee:** a Playwright matrix renders every `(preset × variant × section-type × locale-with-longest-strings)` combination and asserts: no horizontal overflow at 320px, contrast ≥ 4.5:1 on every text token pair, CLS = 0, no element under 44×44px tap target. A preset that fails cannot ship. This is why the model "can't invent broken CSS" — the space it selects from is pre-proven.

### Industry → Design DNA mapping (excerpt from the ~60-row table in system block 5)

| # | Industry | DNA preset | Palette (light/dark) | Type pairing | Hero | Radius · Density · Motion | Signature moves | Primary CTA |
|---|---|---|---|---|---|---|---|---|
| 1 | **DJ / nightlife** | `midnight_neon` | dark · `#08070C` bg, `#E8E6F0` ink, accent `#B026FF`→`#00E5C7` | Space Grotesk / Inter | `video_fullbleed`, dark overlay | sharp · compact · expressive | Grain overlay, marquee gig list, accent glow on hover, uppercase tracking | Book me |
| 2 | **Restaurant (bistro)** | `warm_trattoria` | cream `#FBF6EE` bg, `#2A1D16` ink, accent `#A32B1E` | Playfair Display / Source Sans 3 | `image_split` editorial | soft · airy · subtle | Two-column chalk menu, hairline rules, warm-graded photography | Reserve a table |
| 3 | **Pizzeria / takeaway** | `petal_market` | `#FFF9F0` bg, `#241A12` ink, accent `#E4572E`, support `#2E7D4F` | Fraunces / Inter | `image_offset_grid` | round · regular · subtle | Big price chips, sticky "Order now", cards menu | Order now |
| 4 | **Café / bakery** | `bakery_paper` | `#F7F2E7` bg, `#3B2E23` ink, accent `#C08552` | Cormorant / Karla | `type_centered` over still | soft · airy · none | Paper texture, arch image masks, hours front-and-centre | See opening hours |
| 5 | **Hair salon** | `salon_monochrome` | `#F4F2F0` bg, `#141313` ink, accent `#B79B7B` | Tenor Sans / Inter | `image_split`, B&W hero | sharp · airy · subtle | High-contrast B&W portfolio, generous whitespace, thin nav | Book online |
| 6 | **Beauty / nails** | `soft_botanical` | `#FDF7F7` bg, `#3A2B31` ink, accent `#D98A96`, support `#7E9B79` | Marcellus / Nunito Sans | `image_offset_grid` | round · airy · subtle | Duotone-blush images, price list cards, before/after gallery | Book a treatment |
| 7 | **Barber** | `workwear_industrial` | dark `#161514` bg, `#EDE7DC` ink, accent `#C6892F` | Oswald / Inter | `video_fullbleed`, tight crop | sharp · compact · subtle | Numbered price list, hairline dividers, tall uppercase headings | Walk in or book |
| 8 | **Dentist** | `clinical_trust` | `#FFFFFF` bg, `#12242E` ink, accent `#0E7C8B`, support `#EAF6F8` | Söhne-alt (Inter Tight) / Inter | `image_split`, bright clinical | round · regular · none | Trust band (registrations, insurers), FAQ accordion + FAQPage schema | Make an appointment |
| 9 | **Physio / medical** | `nordic_calm` | `#F7F9F8` bg, `#1B2A27` ink, accent `#3E7C6B` | Instrument Sans / Inter | `type_centered` | soft · airy · none | Process steps, calm imagery, large legible body (18px) | Book an intake |
| 10 | **Law / accounting** | `chambers_navy` | `#FCFBF9` bg, `#101B2D` ink, accent `#8A6E3B` (gold rule) | Lora / Inter | `type_centered`, no photo | sharp · regular · none | Serif headings, gold hairline rules, credentials band, zero stock imagery | Request a consult |
| 11 | **Plumber / electrician** | `garage_steel` | `#F5F6F7` bg, `#15191C` ink, accent `#F2A413`, support `#1E5A96` | Barlow Condensed / Inter | `image_split` + phone band | sharp · compact · none | 24/7 badge, service-area chips, giant tap-to-call, urgency band | Call now |
| 12 | **Construction / renovation** | `concrete_brutal` | `#EFEDE9` bg, `#111111` ink, accent `#E4572E` | Archivo / Inter | `image_offset_grid` | sharp · compact · subtle | Heavy grid, project cards with before/after, stats band | Request a quote |
| 13 | **Real estate agent** | `estate_serif` | `#FAF8F5` bg, `#1A1F1C` ink, accent `#255C4C` | Libre Caslon / Inter | `image_split` wide | soft · airy · subtle | Full-width property carousel, valuation CTA band, map + hours | Free valuation |
| 14 | **Gym / personal trainer** | `athletic_charge` | dark `#0D0F12` bg, `#F2F4F7` ink, accent `#D6FF3E` | Anton / Inter | `video_fullbleed` | sharp · compact · expressive | Diagonal cuts, transformation gallery, pricing tiers, stat counters | Start free trial |
| 15 | **Yoga / wellness** | `eco_moss` | `#F6F4EE` bg, `#232B22` ink, accent `#6B7F5B` | Cormorant Garamond / Karla | `type_centered` over still | round · airy · none | Timetable grid, breathing whitespace, muted natural photography | Reserve your mat |
| 16 | **Photographer** | `studio_gallery` | `#FFFFFF` bg, `#0A0A0A` ink, accent `#0A0A0A` (image-led) | Inter Tight / Inter | `image_offset_grid`, no overlay text | sharp · airy · subtle | Masonry gallery, near-invisible chrome, images are the design | View portfolio |
| 17 | **Auto garage** | `garage_steel` (variant `alt`) | `#F2F3F5` bg, `#14181B` ink, accent `#0E5FA8` | Barlow / Inter | `image_split` | sharp · regular · none | APK/MOT date band, service price grid, brand-logo strip | Book a service |
| 18 | **Tattoo studio** | `ink_tattoo` | dark `#0B0B0B` bg, `#EDEAE4` ink, accent `#9E2B25` | Cinzel / Inter | `video_fullbleed`, grain | sharp · compact · subtle | Heavy grain, portfolio masonry, artist cards, deposit FAQ | Request a design |
| 19 | **Florist** | `petal_market` (variant `alt`) | `#FDFBF7` bg, `#2C2A26` ink, accent `#C2456B`, support `#6E8B5A` | Fraunces / Karla | `image_offset_grid` | round · airy · subtle | Seasonal colour rotation, occasion cards, same-day delivery band | Order flowers |
| 20 | **Driving school** | `kids_playful` | `#FFFFFF` bg, `#161A2B` ink, accent `#2F6BFF`, support `#FFC94A` | Poppins / Inter | `type_centered` | round · regular · subtle | Pass-rate stat band, package pricing tiers, step-by-step process | Book a first lesson |

*(The full table in system block 5 covers ~60 industries; `industries.design_preset` in `0001_core_identity.sql` already stores this per row as JSON, so adding an industry is an `INSERT`, not a migration — exactly right.)*

The model receives this table in the cached prefix as **guidance with permission to deviate**, and must justify a deviation in `theme.rationale`. Two pizzerias in the same town should not get byte-identical sites: the `paletteVariant` + `accentHueShift` + `densityId` knobs give ~180 distinct looks *within* one preset, and the model varies them on the business's own description ("wood-fired, since 1974" → `warm_trattoria` over `petal_market`).

---

## 5. MULTILINGUAL

### Decision: **primary locale authored natively → per-locale transcreation calls (one call per locale, in parallel).** Not one pass, not machine translation.

**Not one pass for all six.** Six bundles in one response is ~57K output tokens: it forces streaming near the ceiling, produces one 4–8 minute call instead of six ~90-second parallel ones, and — the killer — **one defect voids all six locales**. Retrying costs 6× more. Output token cost is identical either way, so the one-pass design buys nothing and risks everything.

**Not DeepL/machine translation.** A local-business site needs *transcreation*, not translation:
- **Formality register** is a business decision, not a linguistic one: German `Sie` for a dentist, `du` for a gym; Dutch `u` for a notary, `je` for a barber; French `vous` almost always. A DJ's site in `vous` is wrong; a lawyer's in `du` is malpractice.
- **CTAs don't translate, they get rewritten.** "Book a table" → NL "Reserveer een tafel", DE "Tisch reservieren", FR "Réserver une table" — but the *idiom* for "Call now" in a German trades context is "Jetzt anrufen", while a literal translation of an English urgency band reads like spam.
- **Conventions:** decimal comma, `€ 12,50` vs `12,50 €` (position differs DE vs NL vs FR), 24h clock everywhere in the EU, address ordering (DE puts house number after street, NL before), phone formatting, and the VAT identifier's local name (`BTW-nummer` / `USt-IdNr.` / `n° TVA` / `NIF` / `NIPC`).

Claude is already in the loop and does all of this natively. The locale style cards live in cached block 7, so the per-call cost of that expertise is zero.

**The translation call:** cached prefix (BP1) + tenant brief (BP2) + primary `LocaleBundle` + a one-line locale selector. Output: the target `LocaleBundle`. Because `LocaleBundle` is a flat `entries: [{id, text}]` array, the model's job is a pure map with a fixed key set — and `validateBundle()` proves key-set equality afterwards.

**One optimisation worth naming and *not* taking by default:** the 9K-token primary bundle is sent fresh to all five translation calls (~$0.22). You could put a breakpoint on it and run wave 1 = one locale, wave 2 = four parallel, saving ~$0.18 — but five parallel calls race the cache *write*, so only a serialised first call warms it. **Not worth ~60s of added latency for $0.18.** Fire all five in parallel. Revisit only if per-call cost analytics (`generation_calls.cache_read_tokens`) say otherwise.

### Locale-consistent SEO metadata

**Title and description are generated in the same call as that locale's body copy — never in a separate metadata pass.** Independently generated metadata drifts from the page it describes: the H1 promises one thing, the SERP snippet another. They are slots in the same `LocaleBundle`, so they are written with the body in view.

Length budgets (≤60 title, ≤155 description) **cannot** be expressed in the JSON schema — Structured Outputs rejects `maxLength`. So: state the budget in the prompt, then enforce deterministically post-parse (truncate at a word boundary, append `…`), and escalate to a model repair only if grossly over (>1.3×). Belt and braces.

### Slugs: **per-locale, and owned by the database, not the model**

The model emits a `slugSeed` — a short natural-language phrase in the target language (`"openingstijden"`, `"unsere-leistungen"`). Code slugifies deterministically: NFKD normalise → strip diacritics (`ë`→`e`, `ç`→`c`, `ß`→`ss`) → lowercase → collapse to `[a-z0-9-]` → trim → collision-suffix `-2`.

**Stability is a database invariant, not a prompt instruction.** On first publish, the resolved slug is written to `page_translations` and **never regenerated**. On a regeneration, the stored slug wins; if the model proposes a different seed, the old slug stays canonical and the new one is recorded as a **301 alias**. This is the only design that survives regeneration without nuking a site's accumulated SEO — and small businesses regenerate constantly.

```
CREATE TABLE page_slug_aliases (
  site_id TEXT NOT NULL, locale TEXT NOT NULL REFERENCES locales(code),
  slug TEXT NOT NULL, page_id TEXT NOT NULL, retired_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, locale, slug)
) STRICT, WITHOUT ROWID;   -- serves 301s forever; costs one D1 lookup on 404
```

### URL shape, hreflang, and extensibility

```
https://<slug>.mijnsaas.com/                 → 302 by Accept-Language (Vary: Accept-Language)
https://<slug>.mijnsaas.com/nl/              → NL home
https://<slug>.mijnsaas.com/de/leistungen/   → DE services
```

Every localized page emits the **full n×n hreflang set plus `x-default`**, self-referencing included — a partial set is worse than none:

```html
<link rel="alternate" hreflang="nl" href="https://x.mijnsaas.com/nl/diensten/">
<link rel="alternate" hreflang="de" href="https://x.mijnsaas.com/de/leistungen/">
… (all six) …
<link rel="alternate" hreflang="x-default" href="https://x.mijnsaas.com/">
<link rel="canonical" href="https://x.mijnsaas.com/de/leistungen/">
```

`x-default` points at the language-negotiating root. Sitemap emits one `<url>` per locale with nested `xhtml:link` alternates.

**Adding a 7th language is one `INSERT` into `locales` + one locale style card in block 7 + one extra `localize-{loc}` step.** No section template, slot id, or renderer change — that is precisely what the structure/copy split buys. The existing `locales` table already has `direction TEXT CHECK (direction IN ('ltr','rtl'))`: **use CSS logical properties everywhere from day one** (`margin-inline-start`, `padding-block`, `inset-inline`, `text-align: start`) so Arabic or Hebrew becomes a config row rather than a rewrite. Costs nothing now; costs a month later.

---

## 6. MEDIA

### Search strategy

Queries are **composed by code**, not free-typed by the model. The model contributes a 2–4 word `stockQueryHint`; code assembles `hint + industry keywords + DNA mood terms + orientation + min-resolution`, so `midnight_neon` adds "moody, neon, low light" and `warm_trattoria` adds "rustic, warm, natural light". This keeps stock imagery visually consistent with the chosen theme — the single biggest tell between a generated site and a designed one.

Pipeline: fetch top 12 candidates → filter (≥16:9 and ≥1920px for hero; 8–25s duration for video) → Workers AI safety/content classification → hand the model a **shortlist with `refId` + caption**. The model *selects*; it never sees or emits a URL.

### Licensing — this changes the architecture

| Source | What the API terms actually require | Consequence |
|---|---|---|
| **Pexels** | Download, hosting and modification permitted, commercial, free. Guidelines require a **prominent link back to Pexels** when using the API, and crediting the photographer where possible. | ✅ **Re-host in R2.** Render a compact credit line. |
| **Unsplash** | API Terms require **hotlinking** the `photo.urls` returned by the API — you may **not** re-host API-sourced images. Attribution to Unsplash **and** the photographer, linking to their profile. Must ping `photo.links.download_location` when a user selects a photo. | ❌ Incompatible with our architecture. |

**Decision: Pexels is the sole automatic stock source. Unsplash is disabled for generated sites.**

The reasoning is not preference, it is arithmetic. Unsplash's mandatory hotlinking puts a **third-party origin on the LCP critical path** — extra DNS + TLS + connection setup before the hero byte arrives, which forfeits the 100/100 target — and it transfers every visitor's IP to a US CDN on page load without consent, which is a GDPR exposure we are selling *against* for European small businesses. A licence term therefore dictates the media architecture. Unsplash can be offered later as a *manual* choice in the editor, hotlinked, with the download-ping and attribution wired up, and a clear note that it costs a little performance.

Also decisive: **Unsplash has no video API.** The full-screen video hero requires Pexels regardless.

**Credit rendering** (compliance, kept tasteful): a `MediaCredit` row per asset, rendered as one small line in the rich footer — `Photography: Jane Doe / Pexels` with `rel="nofollow noopener"`. Non-negotiable for API compliance; costs ~30 bytes and one footer row.

**One more guardrail:** never auto-select an image containing an identifiable person for a business that isn't theirs. Small-business owners genuinely believe the smiling barista *is* their staff, and a customer discovering otherwise is a trust failure (plus model-release risk). Filter people-heavy results for `team` and `about` sections; surface an editor warning: *"This is a stock photo — upload a photo of your own team to build trust."*

### Persistence

**Always proxy into R2. Never hotlink.**

```
R2 layout (content-addressed → automatic cross-tenant dedupe):
  orig/{sha256}                      original download
  img/{sha256}/{w}.avif|.webp|.jpg   w ∈ {400,800,1200,1600,2400}
  vid/{sha256}/hero.mp4|.webm
  poster/{sha256}.avif|.webp|.jpg
```

Content-hash addressing matters more than it looks: 300 pizzerias will select the same 20 Pexels photos. Dedupe collapses that to 20 stored objects and 20 transformation sets, and immutable paths mean `Cache-Control: public, max-age=31536000, immutable` on everything.

- **Images:** Cloudflare Images transformations in front of the R2 bucket via a custom domain. A Worker cannot encode AVIF at any sane CPU cost, and the fixed width ladder plus content-hash dedupe bounds the billable transformation set.
- **Video:** **don't use Stream for the hero.** Stream's HLS needs `hls.js` on non-Safari — a JS payload on the critical path for a decorative, muted, controls-less loop. Instead: Pexels returns multiple `video_files` renditions with width/height/bitrate; **pick the ≤1280px, lowest-bitrate rendition and re-host it as-is** (typically 1.5–3 MB for 10s). Phase 3 adds a Cloudflare Containers + ffmpeg step to trim to 8s, strip the audio track (~10% saving and it can never unmute), and emit VP9/AV1 WebM. Stream stays the right answer for *tenant-uploaded* long-form video, where transcoding and adaptive bitrate genuinely matter.

### LCP strategy for a full-screen video hero at 100/100

**The single rule: the LCP element is the poster image. The video is never in the initial HTML.**

1. **Poster is the LCP.** `<picture>` with AVIF → WebP → JPEG, responsive `srcset`/`sizes="100vw"`, explicit `width`/`height` + `aspect-ratio`, `object-fit: cover`, `fetchpriority="high"`, `decoding="sync"`. Preloaded in `<head>`:
   ```html
   <link rel="preload" as="image" fetchpriority="high"
         imagesrcset="/img/ab12/800.avif 800w, /img/ab12/1600.avif 1600w, /img/ab12/2400.avif 2400w"
         imagesizes="100vw" type="image/avif">
   ```
2. **Video is injected after load**, never parsed at first paint. Gate on *all* of: `load` fired → `requestIdleCallback` → `matchMedia('(prefers-reduced-motion: no-preference)')` → `navigator.connection?.saveData !== true` → `effectiveType === '4g'` → `innerWidth >= 768`. **Mobile gets the poster only by default** — it saves data and battery, mobile is where Lighthouse is scored, and on a 375px viewport a video loop is almost invisible anyway. Attributes: `muted playsinline autoplay loop preload="none" disablepictureinpicture` with the same image as `poster`. Cross-fade `opacity` on `canplaythrough`.
3. **Zero CLS by construction.** Poster and video occupy the same fixed `aspect-ratio` container, absolutely positioned. The video's arrival changes no geometry.
4. **Inline 100% of the CSS.** Total CSS is <14 KB for a site this size; a separate stylesheet is a render-blocking round-trip for no benefit. Zero stylesheet requests, zero render-blocking resources.
5. **Fonts:** self-hosted `woff2` variable subsets, `<link rel="preload" as="font" crossorigin>` for the one display face in the hero, `font-display: swap`, and `size-adjust`/`ascent-override` metric overrides tuned against the fallback stack so the swap causes no reflow.
6. **Zero third-party origins.** No Google Fonts, no analytics `<script>` (Cloudflare Web Analytics or a deferred 400-byte beacon), our own 1.5 KB cookie banner. Total JS ≤ 4 KB, one `defer`red file: WhatsApp button, mobile nav, video swap, banner, form.
7. **Budget enforcement in the `audit` step** (fails the build): HTML ≤ 40 KB, CSS ≤ 14 KB inline, JS ≤ 4 KB, hero poster ≤ 120 KB AVIF, total first-view transfer ≤ 400 KB, CLS = 0, zero third-party requests. Real Lighthouse runs nightly against a sample of published sites via **Cloudflare Browser Rendering** (Lighthouse cannot run inside a Worker) — synthetic budgets gate every build, real audits catch drift.

**Sticky WhatsApp button:** pure CSS `position: fixed`, coloured from `--accent`/`--accent-ink` (contrast-checked like any other token pair), `href="https://wa.me/<E164>?text=<encoded>"` — which opens the app directly on mobile and WhatsApp Web on desktop, no SDK, no JS, no third-party request. The phone number is normalised to E.164 by code from the onboarding field; the model never touches it.

---

## 7. FAILURE MODES

### 7.1 Schema-validation failure → deterministic repair first, then a repair *turn*

Grammar-constrained decoding via `output_config.format` all but eliminates *syntactic* failure. What remains is *semantic*: missing slot ids, dangling `mediaRef`, over-long title, duplicate section ids, `items.length` disagreeing with `itemCount`.

**Escalation ladder — never regenerate from scratch:**

1. **Deterministic auto-repair** (free, ~90% of defects): truncate over-long titles at a word boundary, drop unknown slot ids, substitute a fallback `mediaRef`, clamp knobs, dedupe ids.
2. **Repair turn** (~$0.05, only for defects code can't fix — genuinely missing copy): append the assistant's message plus a **user** turn carrying a machine-generated defect list (`{path, problem, constraint}`), asking for a corrected full document. **This must be a user turn — assistant prefill returns a 400 on `claude-opus-5`.** The whole prefix is still cached, so the repair is cheap. Cap at **2 rounds** (`generation_calls.repair_rounds`).
3. **Fail the step** → Workflows retries the step from scratch (fresh sample, different seed).
4. **`NonRetryableError`** → `needs_review`.

### 7.2 `stop_reason` — always branch before reading `content`

| `stop_reason` | Meaning | Action |
|---|---|---|
| `end_turn` | ✅ | Parse and validate. |
| `max_tokens` | **Truncated** — the JSON is invalid *because it was cut off*, not because the schema failed | Detect via `stop_reason`, **never** via the parse error. Raise `max_tokens` and retry once; if it recurs, split the call (per-page copy instead of whole-site). |
| `refusal` | Policy decline (HTTP 200) | Read `stop_details.category`. → **`needs_review`**. |
| `pause_turn` | N/A — no server tools in this path | — |

Real refusal triggers for this product: nightlife/adult venues, vape and CBD shops, gambling, escort services, clinics making unqualified medical claims, firearms dealers. **Do not silently retry a refusal** — it burns $0.30 and refuses again.

Two mitigations:
- **Enable server-side fallbacks by default** on every generation call: `betas: ["server-side-fallback-2026-07-01"]` + `fallbacks: "default"`. A decline before any output isn't billed; the rescue bills at the fallback model's rates with cache repricing applied automatically. Persist `stop_details.category` into `generation_calls.refusal_category` so you learn which verticals to gate.
- **Screen at intake**, before spending Opus tokens: an industry blocklist plus a `claude-haiku-4-5` classifier over the free-text description. Costs ~$0.001; saves a $2.30 refusal and gives the user an honest message at signup instead of five minutes into a progress bar.

### 7.3 Timeouts

- **SDK:** per-call `timeout` in **milliseconds** (TS SDK) — `plan-brief` 600_000, `copy` 480_000, `localize` 300_000. Set **`maxRetries: 0`**: let Workflows own retries so every attempt is durable, observable and ledgered. SDK-level retries would double-retry invisibly and wall-clock could reach `timeout × (maxRetries+1)`.
- **Streaming:** use `client.messages.stream()` + `.finalMessage()` for any call with `max_tokens > 16_000` (`plan-brief`, `copy-primary`, `localize`); `client.messages.parse()` for the small ones (`blog`, `legal-variables`) — but always guard `response.parsed_output`, which is `null` when parsing failed. With streaming + structured output, accumulate the full response, then `JSON.parse` + Zod. Streaming also gives a **stall detector**: no event for 90s → abort and let the step retry.
- **Workers/Workflows:** wall clock inside a step is unlimited and awaiting `fetch` burns no CPU, so an 8-minute Anthropic call is fine. The only CPU-bound step is `render` (36 documents for 6 locales × 6 pages) — split per locale and raise the step CPU limit toward the 5-minute ceiling.
- **Subrequests:** ~45 per job against a 10,000 default. Pin it explicitly in `wrangler.jsonc` anyway so a future fan-out can't silently hit the wall.

### 7.4 Partial output → **atomic publish, never a half-built site**

Everything renders into a **staging** `site_versions` row (`status='draft'`). Publication is a single D1 transaction flipping `sites.live_version_id`; the serving Worker only ever reads `live_version_id`. Consequences: a job that dies after 7 of 12 steps is invisible to the public; Workflows memoises those 7 so resume is **free**; and a regeneration is **zero-downtime** — the previous version serves throughout and the swap is instant. A first-generation failure shows the progress UI's error state, never a broken site. The existing `CHECK (status <> 'published' OR sealed_at IS NOT NULL)` on `site_versions` already encodes this invariant — good.

### 7.5 Idempotency & dedupe (four layers)

1. **HTTP:** `Idempotency-Key` required on `POST /api/generate`; `generation_jobs.idempotency_key` already has `uq_jobs_idem`. Same key + same `prompt_sha256` → return the existing job; same key + different hash → **409**.
2. **Infrastructure:** Workflow instance id = `gen:{siteId}:{intakeHash}` — Workflows rejects duplicate ids, so a double-clicked "Generate" cannot start two runs. **This supersedes the `locked_by`/`lock_expires_at` lease.**
3. **Step level:** `uq_calls_step (job_id, step_name, attempt)` + `INSERT … ON CONFLICT DO NOTHING`, so a replayed step cannot double-bill the ledger.
4. **Content:** media deduped by SHA-256; `content_blobs.sha256` is already the PK, so identical page trees across regenerations cost zero extra R2. Stripe webhooks dedupe on `event.id` with a unique index.

### 7.6 Retry policy — separate *transport* failures from *content* failures

This distinction is the whole game. **Transport** errors (`RateLimitError`, `APIConnectionError`, `APIStatusError` ≥500) → rethrow, let Workflows retry with exponential backoff. **Content** defects → handle *inside* the step via the repair ladder; a blind retry reproduces them at full cost.

```ts
try { /* … Anthropic call … */ }
catch (e) {
  if (e instanceof Anthropic.RateLimitError) {                       // respect retry-after
    await scheduler.wait(retryAfterMs(e)); throw e;                  // → Workflows retries
  }
  if (e instanceof Anthropic.APIConnectionError) throw e;
  if (e instanceof Anthropic.APIStatusError && e.status >= 500) throw e;
  if (e instanceof Anthropic.APIStatusError && e.status === 400)
    throw new NonRetryableError(`bad request: ${e.message}`);         // schema/param bug — ours
  throw e;
}
```

Catch the chain most-specific-first; a single broad catch loses the retryable/non-retryable distinction, which is exactly the information the retry policy needs.

**Rate limits under fan-out:** five parallel `localize` calls × N concurrent jobs will hit 429s. The **`AnthropicLimiter` Durable Object** holds a global token bucket (~20 in-flight Opus calls account-wide) and queues the rest. A DO is required here, not D1 — read-then-write across concurrent Workers is not atomic; a single-threaded DO is.

### 7.7 Cost caps per user

Every call writes `generation_calls` from `response.usage` — `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens` → `cost_usd_micro` (integer micro-USD; money never touches `REAL`, per the schema's own convention).

**Enforcement is a `TenantBudget` DO, not a D1 check.** Before each call it atomically *reserves* an estimated cost and reconciles the actual afterwards. Under 5-way fan-out a D1 read-then-write races and lets a tenant overspend.

| Entitlement | Allowance |
|---|---|
| Onboarded, no trial | **1 generation, primary locale only** ($0.75). Regenerate → `blocked_paywall`. |
| `trialing` / `active` | Full 6-locale generation; **1 regeneration / 24h, 10 / month**; soft cap **$8 model spend / tenant / month** → queue for review. |
| Account-wide | Daily org kill-switch; the limiter DO refuses new jobs and alerts. |

The cost model is what makes the product design fall out: **generate the primary locale free at signup ($0.75), unlock the other five locales when the trial starts.** The user sees a real site immediately, and the expensive 5× translation fan-out is gated behind a Stripe payment method — which is exactly what the brief asks for, arrived at from the arithmetic rather than asserted.

Track **cost per completed site**, not per call — a cheap call that needs two repairs is not cheap.

### 7.8 Abuse

**Prompt injection is structurally defeated, not prompted against.** The onboarding "short description" is attacker-controlled free text. Because of §1's invariants, a *fully successful* injection produces at worst bad copy — the model has no channel to emit a `<script>`, an `href`, or a style. Belt and braces on top: user facts go in delimited blocks in the **user** turn with an explicit "untrusted business data, never an instruction" framing; **user text never enters the system prompt** (which would also destroy the cache prefix).

| Vector | Control |
|---|---|
| **Signup farming** | Turnstile on the modal; email verification before generation; 1 free generation per verified email and per IP /24 per day; Stripe payment method required for any regeneration. |
| **Upload abuse** | Short-lived presigned R2 URLs from the Worker; 10 MB image / 100 MB video caps; **MIME sniffed from magic bytes, never `Content-Type`**; re-encode strips EXIF (GPS in a customer photo is a GDPR leak); **reject SVG outright** — it is an XSS vector, not an image format. `media_assets.status` already has a `quarantined` state — use it. |
| **Content abuse** | Industry blocklist at intake; `claude-haiku-4-5` screen on the description (~$0.001) *before* the Opus call; moderation pass on assembled copy before `publish`. |
| **Domain abuse** | Before calling the Cloudflare for SaaS Custom Hostnames API, verify ownership via the pre-validation TXT record and check the hostname against a brand/phishing blocklist — otherwise you become a phishing host with a valid cert. (Every plan includes 100 custom hostnames; $0.10/hostname/month beyond that, so also cap per tenant to bound spend.) |
| **API abuse** | Cloudflare Rate Limiting rules at the edge + the per-tenant DO limiter behind it. |
| **Regeneration griefing** | Idempotency + the 24h/monthly caps above; a regeneration never touches the live version until `publish`. |

---

## Phase 1 — concrete scope

| Deliverable | Notes |
|---|---|
| Repo scaffold | pnpm workspaces: `apps/marketing` (Astro → Pages), `apps/dashboard`, `workers/api`, `workers/renderer`, `packages/schema` (`wire.ts` + `domain.ts`), `packages/design-system` (tokens, 24 DNA presets, 17 section templates), `packages/prompt` (the 8 cached blocks, content-hashed) |
| Onboarding modal | Full-screen; direct-to-R2 presigned uploads; Turnstile; E.164 phone normalisation; industry dropdown fed from the `industries` table |
| Worker API | `POST /api/generate` (Idempotency-Key, Zod intake validation, entitlement check, Workflow dispatch), `GET /api/runs/:id/events` (SSE from `JobHub` DO) |
| Workflow | Steps 1–4 only (`validate-intake`, `resolve-media`, `plan-brief`, `copy-primary`) — single locale, no fan-out. Proves the contract, the cache, and the renderer end-to-end for **$0.75/site**. |
| D1 | Existing migrations + `0010_generation_calls.sql` + `0011_page_slug_aliases.sql` |
| CI gate | Design-system snapshot matrix + the perf budget file |

Fan-out, translation, blog and the trial-wall are Phase 2 — but the schema split and the cached prefix are built for them from day one, so Phase 2 adds steps rather than reshaping the contract.

---

**Sources**

- [Workers are no longer limited to 1000 subrequests — Cloudflare Changelog](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/)
- [Limits · Cloudflare Workers docs](https://developers.cloudflare.com/workers/platform/limits/)
- [Workflows step limit increased to 25,000 steps per instance — Changelog](https://developers.cloudflare.com/changelog/post/2026-03-03-step-limits-to-25k/)
- [Limits · Cloudflare Workflows docs](https://developers.cloudflare.com/workflows/reference/limits)
- [Cloudflare Workflows V2 with Deterministic Execution and 50K Concurrent Workflows — InfoQ](https://www.infoq.com/news/2026/05/cloudflare-workflows-v2-release/)
- [Build durable applications on Cloudflare Workers — Cloudflare Blog](https://blog.cloudflare.com/building-workflows-durable-execution-on-workers/)
- [Use WebSockets · Cloudflare Durable Objects docs](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Limits · Cloudflare D1 docs](https://developers.cloudflare.com/d1/platform/limits)
- [Custom hostnames · Cloudflare for Platforms docs](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/)
- [Unsplash API Guidelines](https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines) · [Guideline: Hotlinking Images](https://help.unsplash.com/en/articles/2511271-guideline-hotlinking-images) · [Unsplash API Terms](https://unsplash.com/api-terms)
- [Pexels API](https://www.pexels.com/api/) · [Pexels API documentation](https://www.pexels.com/api/documentation/)
- [Anthropic Structured Outputs docs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md)