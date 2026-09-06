# Phase 2 — `packages/site-kit`: design-DNA tokens and the section library

**Status:** specification, ready to implement. No code in this document is committed anywhere yet.
**Owns:** `packages/site-kit/**` only. It depends on `@aibuilder/site-schema` and on nothing else —
no `cloudflare:*`, no `node:*`, no bindings — so it renders in a plain Node test runner
(architecture §2 boundary rules).
**Reads from Phase 1 and must not contradict:** `gen/section.ts` (17 types, fixed variants),
`gen/common.ts` (8 theme knobs, 12 icons, `LinkRef`, `MediaRef`), `doc.ts` (`SiteDoc`, `textFor`,
`mediaFor`, `externalLinkFor`), `slots.ts` (`deriveSectionSlots` — the slot inventory below is
transcribed from it, not invented), `lint.ts` (`CONTRAST_PAIRS`, `contrastRatio`, `parseColor`),
`core/industries.ts` (`dnaId` per industry), `core/hours.ts` (`formatHoursForLocale`,
`toOpeningHoursSpecification`), `core/keys.ts` (R2 key shapes).

Citation convention: **"non-negotiable §N"** means item N of the numbered list in
`00-ARCHITECTURE.md` §7; a bare **"§N"** is a section of *this* document; anything else is named
with its file (`dim-seo §4.3`).

Every OKLCH value, contrast ratio, `clamp()` string and scrim alpha in this document was computed
and checked with the same maths `lint.ts` uses (`oklchToLinearRgb` → WCAG relative luminance). The
matrix in §3 was run: **32 token pairs × 120 colourways = 3 840 assertions, 0 failures.** Nothing
here is a guess dressed as a number.

---

## 0. File manifest

| File | Purpose |
|---|---|
| `src/tokens/oklch.ts` | OKLCH ↔ linear-sRGB, sRGB gamut boundary (`maxChromaInSrgb`), WCAG luminance/ratio, the monotone lightness solver. Pure maths, no design opinions. |
| `src/tokens/dna.ts` | The four archetype definitions: ladders, accent/support specs, type pairing, defaults, thesis. Data, not code. |
| `src/tokens/resolve.ts` | `resolveTheme(theme: ThemeGen-minus-rationale) → ThemeTokens` — the 47 custom properties. Constructs, then **verifies, then throws**. |
| `src/tokens/tones.ts` | The 5 tones and their `--t-*` bindings. The only colour names a component may read. |
| `src/tokens/contract.ts` | `THEME_CONTRAST_CONTRACT` — the pair list §3 proves, as data, so the test and the doc cannot drift. |
| `src/tokens/fonts.ts` | Per-DNA font stacks, `@font-face` blocks, `unicode-range`, preload descriptor. |
| `src/tokens/fonts.metrics.generated.ts` | `ascent-override`/`descent-override`/`line-gap-override`/`size-adjust` per family, **generated** from the woff2 by `scripts/font-metrics.ts`. Never hand-edited. |
| `src/css/layers.ts` | The single `@layer` statement and the cascade contract. |
| `src/css/base.generated.ts` | Reset + base type + a11y + layout primitives, pre-minified at build time. |
| `src/css/components/<key>.generated.ts` | One pre-minified fragment per section type and per chrome part. |
| `src/css/theme.ts` | Emits the `:root{}` token block and the five `[data-tone]` blocks from `ThemeTokens`. |
| `src/css/assemble.ts` | `assembleCss(usedKeys, tokens) → { css, bytes }`, raw-byte ceiling assertion. |
| `src/sections/*.tsx` | 17 `hono/jsx` components. `escapeHtml()` only, no `innerHTML`, no markdown. |
| `src/layout/{document,header,footer,hero,whatsapp}.tsx` | Chrome. |
| `src/icons.ts` | The 12 `IconId` SVG paths. Closed set; no model string reaches an `<svg>`. |
| `src/escape.ts` | `escapeHtml`, `escapeAttr`, `escapeJsonLd`. |
| `src/seo/{jsonld,hreflang,allowlist}.ts` | `@graph` builder, hreflang cluster, LocalBusiness subtype allowlist. |
| `src/js/site.ts` | The three inline scripts as frozen strings (hero video, nav, form). ≤ 4 KB gzip total. |
| `src/project.ts` | `projectPage()` → canonical semantic projection → `renderSha256`. |
| `src/render.ts` | `renderPage(doc, locale, pageId) → { html, renderSha256 }`. |

`scripts/` at the package root holds the two build-time generators (CSS minification, font metrics).
Both write `*.generated.ts` and CI asserts the checked-in output matches a fresh run.

---

## 1. The four archetypes

### 1.1 How a theme resolves

The model chooses eight enums (`ThemeGen`). `resolveTheme` turns them into 47 custom properties:

```
effectiveMode = paletteVariant === 'inverse' ? flip(colorMode) : colorMode
ground        = DNA.grounds[effectiveMode]          // the neutral ladder
accentSpec    = paletteVariant === 'alt' ? DNA.support : DNA.accent
accentHue     = accentSpec.hue + Number(accentHueShift)     // −30 … +30
```

`colorMode` picks the page's ground; `paletteVariant: 'inverse'` asks for *this DNA's other ground*.
They are not redundant: `alt` changes hue relationships at the same polarity, `inverse` changes
polarity at the same hue. Every DNA declares **both** grounds, so all six (variant × mode) pairs
exist for all four archetypes — there is no unreachable or fallback combination.

Chroma is never taken at face value. Every colour is capped at
`min(specChroma, 0.94 × maxChromaInSrgb(L, H))`. The 0.94 is not decoration: `lint.ts`'s
`oklchToLinearRgb` **clamps** out-of-gamut channels to `[0,1]`, and clamping silently changes the
colour, so a contrast ratio computed on a clamped colour is a ratio for a colour the browser will
not paint (browsers gamut-*map* by reducing chroma; they do not clamp per channel). Keeping every
token strictly inside sRGB is what makes the analytic proof in §3 sound rather than approximate.

Three tokens are **solved**, not laddered, because a fixed ladder value cannot hold across 5 hue
shifts × 2 grounds:

| token | solved for |
|---|---|
| `--color-fg-on-accent` | the ground pole (ink or paper) with the better ratio against the accent fill, ≥ 4.5:1 |
| `--color-accent-hover` | the largest \|ΔL\| in `{0.07 … 0.03}`, either direction, that keeps ≥ 4.5:1 against the same ink (a hover that fails contrast is not a hover) |
| `--color-accent-text` | the L closest to the fill that clears 4.5:1 against **`--color-bg`, `--color-surface` and `--color-surface-2` simultaneously** |
| `--color-accent-edge` | `--color-accent` when the fill already clears 3:1 against every ground (no rim needed); otherwise the L closest to the fill that clears 3:1 against every ground and 2.2:1 against the fill |
| `--color-border-strong`, `--color-fg-subtle` | ≥ 3.05:1 against **all four** grounds, not just `--color-bg` |
| `--color-focus` | ≥ 3:1 against all four grounds |
| `--color-danger` | ≥ 4.5:1 against `--color-bg` and `--color-surface` |

The solver bisects on L at fixed (C, H), quantises the result to **4 decimal places rounded away
from the failing side**, and then re-runs the actual contrast check on the quantised value. If the
check fails, `resolveTheme` **throws**. It is a build-time function; a throw is a failed publish,
never a broken page. §3 proves the throw is unreachable across the whole knob space.

`--color-accent-edge` deserves its own note. `garage_steel`'s accent is safety amber
(`#f7a830`); a filled amber button on a near-white page is 1.79:1 against its own ground, which is a
WCAG 2.2 SC 1.4.11 failure — the control has no discernible boundary. The naive fix (darken the
accent) destroys the archetype, because the amber *is* the archetype. So the resolver keeps the fill
and derives a rim by walking **away from the fill**, not in from the far pole: `oklch(0.581 0.117
72)` = `#a56d17`, 4.07:1 against the page and 2.2:1 against the fill. It reads as a designed amber
button with a darker rim, not as a black outline. For the other three archetypes the fill already
clears 3:1 and `--color-accent-edge === --color-accent`, so the rim costs zero bytes.

### 1.2 `midnight_neon`

> **Thesis:** a lit room after dark — near-black violet ground, one electric accent that behaves like
> a light source, and type set tight and large enough to feel like signage.

| axis | value |
|---|---|
| canonical ground | `dark` |
| neutral | hue 288, chroma 0.018 |
| accent | hue 295, chroma 0.200, L 0.64 (dark) / 0.53 (light) |
| support (→ `alt` accent) | hue 195, chroma 0.130, L 0.80 (dark) / 0.64 (light) |
| type pairing | **Space Grotesk Variable** (wght 300–700) display / **Inter Variable** body |
| defaults | `typeScaleId: display`, `radiusId: sharp`, `densityId: compact`, `motionId: expressive` |
| hero | `video_fullbleed`, dark scrim, `--hero-ink: light` |

```css
/* midnight_neon · dark · default · 0° */
--color-bg:                  oklch(0.17 0.018 288);      /* #0f0e17 */
--color-bg-alt:              oklch(0.21 0.018 288);      /* #181720 */
--color-surface:             oklch(0.235 0.018 288);     /* #1d1d26 */
--color-surface-2:           oklch(0.28 0.018 288);      /* #282831 */
--color-fg:                  oklch(0.965 0.0164 288);    /* #f2f2fe */
--color-fg-on-surface:       oklch(0.965 0.0164 288);    /* #f2f2fe */
--color-fg-muted:            oklch(0.78 0.018 288);      /* #b6b6c3 */
--color-fg-subtle:           oklch(0.6205 0.018 288);    /* #858591 */
--color-border:              oklch(0.34 0.018 288);      /* #373741 */
--color-border-strong:       oklch(0.5545 0.018 288);    /* #72717d */
--color-accent:              oklch(0.64 0.2 295);        /* #986bf6 */
--color-accent-hover:        oklch(0.71 0.1599 295);     /* #aa8afa */
--color-accent-edge:         oklch(0.64 0.2 295);        /* #986bf6 — fill clears 3:1, no rim */
--color-fg-on-accent:        oklch(0.17 0.018 288);      /* #0f0e17 */
--color-accent-text:         oklch(0.6675 0.1865 295);   /* #9f77f9 */
--color-accent-subtle:       oklch(0.245 0.045 295);     /* #221c34 */
--color-fg-on-accent-subtle: oklch(0.6405 0.2 295);      /* #986bf6 */
--color-focus:               oklch(0.5705 0.2 295);      /* #8455de */
--color-focus-halo:          oklch(0.965 0.0164 288);    /* #f2f2fe */
--color-danger:              oklch(0.6345 0.16 27);      /* #da5d53 */
```

**16 industries** map here: `bar_pub`, `barbershop`, `tattoo_studio`, `gym`, `crossfit_box`,
`personal_trainer`, `martial_arts`, `driving_school`, `electronics_store`, `sports_store`,
`it_services`, `dj`, `live_band`, `videographer`, `nightclub`, `self_storage`.

### 1.3 `warm_trattoria`

> **Thesis:** paper, not screen — a warm cream ground, terracotta ink-on-clay accent, editorial
> serif headings and hairline rules, so the page reads like a menu card rather than a template.

| axis | value |
|---|---|
| canonical ground | `light` |
| neutral | hue 78, chroma 0.017 |
| accent | hue 32, chroma 0.145, L 0.52 (light) / 0.64 (dark) |
| support (→ `alt` accent) | hue 122, chroma 0.070, L 0.47 (light) / 0.72 (dark) — olive |
| type pairing | **Playfair Display Variable** (wght 400–900) display / **Inter Variable** body |
| defaults | `typeScaleId: editorial`, `radiusId: soft`, `densityId: airy`, `motionId: subtle` |
| hero | `image_split`, `--hero-ink: dark` on a light scrim |

```css
/* warm_trattoria · light · default · 0° */
--color-bg:                  oklch(0.972 0.017 78);      /* #fcf5e9 */
--color-bg-alt:              oklch(0.946 0.017 78);      /* #f4ece1 */
--color-surface:             oklch(0.995 0.004 78);      /* #fffdfa */
--color-surface-2:           oklch(0.923 0.017 78);      /* #ece4d9 */
--color-fg:                  oklch(0.26 0.017 78);       /* #29231b */
--color-fg-on-surface:       oklch(0.26 0.017 78);       /* #29231b */
--color-fg-muted:            oklch(0.45 0.017 78);       /* #5b544b */
--color-fg-subtle:           oklch(0.5495 0.017 78);     /* #777067 */
--color-border:              oklch(0.882 0.017 78);      /* #ded7cc */
--color-border-strong:       oklch(0.607 0.017 78);      /* #888177 */
--color-accent:              oklch(0.52 0.145 32);       /* #ac412e */
--color-accent-hover:        oklch(0.45 0.145 32);       /* #952a19 */
--color-accent-edge:         oklch(0.52 0.145 32);       /* #ac412e */
--color-fg-on-accent:        oklch(0.972 0.017 78);      /* #fcf5e9 */
--color-accent-text:         oklch(0.5295 0.145 32);     /* #b04431 */
--color-accent-subtle:       oklch(0.917 0.038 32);      /* #fcdbd4 */
--color-fg-on-accent-subtle: oklch(0.5225 0.145 32);     /* #ad422f */
--color-focus:               oklch(0.6265 0.145 32);     /* #d1624d */
--color-focus-halo:          oklch(0.972 0.017 78);      /* #fcf5e9 */
--color-danger:              oklch(0.5665 0.16 27);      /* #c3473f */
```

**31 industries** map here — the largest bucket by far: all of `food_drink` except `bar_pub` and
`brewery`; `hairdresser`, `beauty_salon`, `nail_studio`; `dance_school`; most of `retail`
(`clothing_store`, `shoe_store`, `jeweller`, `bookshop`, `toy_store`, `butcher`, `farm_shop`);
`wedding_planner`, `party_rental`, `art_gallery`; `language_school`, `music_school`, `childcare`;
`hotel`, `campsite`, `travel_agency`, `tour_operator`; `equestrian_centre`; `artisan_maker`,
`tailor`.

### 1.4 `clinical_trust`

> **Thesis:** nothing between the visitor and the information — white ground, one calm teal, generous
> line height, and every claim next to the credential that backs it.

| axis | value |
|---|---|
| canonical ground | `light` |
| neutral | hue 228, chroma 0.008 |
| accent | hue 205, chroma 0.108, L 0.54 (light) / 0.70 (dark) |
| support (→ `alt` accent) | hue 258, chroma 0.095, L 0.49 (light) / 0.72 (dark) — navy |
| type pairing | **Inter Variable only** (`opsz` 14–32). Display = Inter at `opsz 32`, `letter-spacing: -0.02em`. **One font file for the whole site.** |
| defaults | `typeScaleId: regular`, `radiusId: round`, `densityId: regular`, `motionId: none` |
| hero | `image_split`, bright clinical still, `--hero-ink: dark` |

```css
/* clinical_trust · light · default · 0° */
--color-bg:                  oklch(0.99 0.0057 228);     /* #f8fdff */
--color-bg-alt:              oklch(0.964 0.008 228);     /* #eef4f7 */
--color-surface:             oklch(1 0 228);             /* #ffffff */
--color-surface-2:           oklch(0.945 0.008 228);     /* #e8eef1 */
--color-fg:                  oklch(0.24 0.008 228);      /* #1b2022 */
--color-fg-on-surface:       oklch(0.24 0.008 228);      /* #1b2022 */
--color-fg-muted:            oklch(0.46 0.008 228);      /* #54595c */
--color-fg-subtle:           oklch(0.5595 0.008 228);    /* #707578 */
--color-border:              oklch(0.895 0.008 228);     /* #d7dde0 */
--color-border-strong:       oklch(0.623 0.008 228);     /* #82888b */
--color-accent:              oklch(0.54 0.0867 205);     /* #177d87 */
--color-accent-hover:        oklch(0.47 0.0755 205);     /* #11676f */
--color-accent-edge:         oklch(0.54 0.0867 205);     /* #177d87 */
--color-fg-on-accent:        oklch(0.99 0.0057 228);     /* #f8fdff */
--color-accent-text:         oklch(0.5205 0.0836 205);   /* #167780 */
--color-accent-subtle:       oklch(0.935 0.038 205);     /* #cdf1f6 */
--color-fg-on-accent-subtle: oklch(0.516 0.0829 205);    /* #15757e */
--color-focus:               oklch(0.6175 0.0992 205);   /* #1e96a2 */
--color-focus-halo:          oklch(0.99 0.0057 228);     /* #f8fdff */
--color-danger:              oklch(0.5795 0.16 27);      /* #c74b43 */
```

**42 industries** map here — every `health` leaf, every `professional` leaf except `it_services`,
`day_spa`, `massage`, `yoga_studio`, `racket_club`, `car_dealer`, `car_wash`, `florist`,
`furniture_store`, `pet_store`, `estate_agent`, `property_manager`, `surveyor`, `bed_breakfast`,
`veterinarian`, `pet_grooming`, `dog_training`, `dry_cleaner`, `cleaning_company`, `print_shop`,
`funeral_services`, `tutoring`, `business_coach`, `photographer`, and `other`.

### 1.5 `garage_steel`

> **Thesis:** a phone number you can hit with a gloved thumb — cool steel ground, safety-amber
> accent, condensed uppercase headings, and no ornament that is not a signal.

| axis | value |
|---|---|
| canonical ground | `light` |
| neutral | hue 255, chroma 0.006 |
| accent | hue 72, chroma 0.155, L 0.79 (light) / 0.82 (dark) — safety amber |
| support (→ `alt` accent) | hue 252, chroma 0.140, L 0.48 (light) / 0.68 (dark) — signal blue |
| type pairing | **Archivo Variable** (wght 400–800, `wdth` 62–125, used at `wdth 78`) display / **Inter Variable** body. Archivo's width axis gives the condensed industrial voice without shipping a second static family. |
| defaults | `typeScaleId: compact`, `radiusId: sharp`, `densityId: compact`, `motionId: none` |
| hero | `image_split` with a tap-to-call band, `--hero-ink: dark` |

```css
/* garage_steel · light · default · 0° */
--color-bg:                  oklch(0.976 0.006 255);     /* #f4f7fb */
--color-bg-alt:              oklch(0.943 0.006 255);     /* #e9ecf0 */
--color-surface:             oklch(0.998 0.0009 255);    /* #fefeff */
--color-surface-2:           oklch(0.918 0.006 255);     /* #e1e4e8 */
--color-fg:                  oklch(0.21 0.006 255);      /* #16181b */
--color-fg-on-surface:       oklch(0.21 0.006 255);      /* #16181b */
--color-fg-muted:            oklch(0.44 0.006 255);      /* #505356 */
--color-fg-subtle:           oklch(0.5395 0.006 255);    /* #6c6f72 */
--color-border:              oklch(0.875 0.006 255);     /* #d3d6da */
--color-border-strong:       oklch(0.603 0.006 255);     /* #7f8185 */
--color-accent:              oklch(0.79 0.155 72);       /* #f7a830 */
--color-accent-hover:        oklch(0.72 0.145 72);       /* #dc9322 */
--color-accent-edge:         oklch(0.581 0.117 72);      /* #a56d17 — rim required, see §1.1 */
--color-fg-on-accent:        oklch(0.21 0.006 255);      /* #16181b */
--color-accent-text:         oklch(0.5145 0.1037 72);    /* #8c5c11 */
--color-accent-subtle:       oklch(0.921 0.038 72);      /* #f5e1ca */
--color-fg-on-accent-subtle: oklch(0.516 0.104 72);      /* #8c5c11 */
--color-focus:               oklch(0.613 0.1235 72);     /* #b17619 */
--color-focus-halo:          oklch(0.976 0.006 255);     /* #f4f7fb */
--color-danger:              oklch(0.5695 0.16 27);      /* #c44840 */
```

**15 industries** map here: `brewery`, every `trades` leaf (`plumber`, `electrician`,
`hvac_heatpump`, `general_contractor`, `painter_decorator`, `roofer`, `carpenter`, `locksmith`,
`landscaper`, `solar_installer`), `car_repair`, `car_bodywork`, `tyre_service`, `bike_shop`.

### 1.6 The other 27 resolved tokens

Colour is 20 of the 47. The rest:

| group | tokens | source |
|---|---|---|
| hero (3) | `--hero-ink` (`light`\|`dark`), `--hero-scrim-top`, `--hero-scrim-band` | DNA + effective mode (§5). `--hero-ink` is the one token that is never *consumed* by CSS — a custom property cannot be selected on — so the renderer copies its value into `data-ink` on the hero element. It lives in the token set anyway so that the editor changes it in one place and the resolver can prove the scrim alpha against it. |
| type (12) | `--font-display`, `--font-body`, `--font-display-wght`, `--font-display-wdth`, `--font-display-tracking`, `--step--1` … `--step-5` | DNA (families) + `typeScaleId` (steps) |
| space (4) | `--space-unit` (always `0.25rem`), `--section-y`, `--gutter`, `--measure` | `densityId` |
| radius (4) | `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-pill` | `radiusId` |
| motion (2) | `--dur`, `--ease` | `motionId` |
| elevation (1) | `--shadow-1` | effective mode |
| rules (1) | `--hairline` (always `max(1px, 0.0625rem)`) | constant |

**20 + 3 + 12 + 4 + 4 + 2 + 1 + 1 = 47.** The architecture's "~40" resolves to exactly 47; this is
the itemisation. `--space-1 … --space-12` are *not* theme tokens: the 4 px grid is fixed
(`calc(var(--space-unit) * n)`) and lives in the base layer, because a density knob that rescaled
the grid would move every optical relationship in the system, not just the rhythm.

#### Type scales — the four `typeScaleId` tables, as literal `clamp()` strings

Fluid between 320 px and 1440 px, `clamp(min, yIntercept + slopeVw, max)`. **The smallest body size
in every scale is 17 px**, which is deliberate: WCAG's "large text" exemption (3:1 at ≥ 18.66 px
bold / ≥ 24 px) is never used anywhere in this system, so every text pair is checked at 4.5:1
regardless of size and the contrast proof does not have to know the type scale.

```css
/* compact */
--step--1: clamp(0.875rem, 0.8661rem + 0.0446vw, 0.9063rem);   /* 14 → 14.5 */
--step-0:  clamp(1.0625rem, 1.0536rem + 0.0446vw, 1.0938rem);  /* 17 → 17.5 */
--step-1:  clamp(1.1875rem, 1.1518rem + 0.1786vw, 1.3125rem);  /* 19 → 21 */
--step-2:  clamp(1.375rem, 1.3214rem + 0.2679vw, 1.5625rem);   /* 22 → 25 */
--step-3:  clamp(1.5625rem, 1.4554rem + 0.5357vw, 1.9375rem);  /* 25 → 31 */
--step-4:  clamp(1.625rem, 1.4107rem + 1.0714vw, 2.375rem);    /* 26 → 38 */
--step-5:  clamp(1.875rem, 1.5893rem + 1.4286vw, 2.875rem);    /* 30 → 46 */

/* regular */
--step--1: clamp(0.9375rem, 0.9286rem + 0.0446vw, 0.9688rem);  /* 15 → 15.5 */
--step-0:  clamp(1.0625rem, 1.0446rem + 0.0893vw, 1.125rem);   /* 17 → 18 */
--step-1:  clamp(1.25rem, 1.2054rem + 0.2232vw, 1.4063rem);    /* 20 → 22.5 */
--step-2:  clamp(1.4375rem, 1.3482rem + 0.4464vw, 1.75rem);    /* 23 → 28 */
--step-3:  clamp(1.6875rem, 1.5446rem + 0.7143vw, 2.1875rem);  /* 27 → 35 */
--step-4:  clamp(1.75rem, 1.4643rem + 1.4286vw, 2.75rem);      /* 28 → 44 */
--step-5:  clamp(2rem, 1.5714rem + 2.1429vw, 3.5rem);          /* 32 → 56 */

/* editorial */
--step--1: clamp(0.9375rem, 0.9196rem + 0.0893vw, 1rem);       /* 15 → 16 */
--step-0:  clamp(1.125rem, 1.1071rem + 0.0893vw, 1.1875rem);   /* 18 → 19 */
--step-1:  clamp(1.3125rem, 1.2589rem + 0.2679vw, 1.5rem);     /* 21 → 24 */
--step-2:  clamp(1.5625rem, 1.4554rem + 0.5357vw, 1.9375rem);  /* 25 → 31 */
--step-3:  clamp(1.875rem, 1.6964rem + 0.8929vw, 2.5rem);      /* 30 → 40 */
--step-4:  clamp(1.875rem, 1.4821rem + 1.9643vw, 3.25rem);     /* 30 → 52 */
--step-5:  clamp(2.125rem, 1.5179rem + 3.0357vw, 4.25rem);     /* 34 → 68 */

/* display */
--step--1: clamp(0.9375rem, 0.9196rem + 0.0893vw, 1rem);       /* 15 → 16 */
--step-0:  clamp(1.125rem, 1.1071rem + 0.0893vw, 1.1875rem);   /* 18 → 19 */
--step-1:  clamp(1.375rem, 1.3214rem + 0.2679vw, 1.5625rem);   /* 22 → 25 */
--step-2:  clamp(1.625rem, 1.5rem + 0.625vw, 2.0625rem);       /* 26 → 33 */
--step-3:  clamp(2rem, 1.7679rem + 1.1607vw, 2.8125rem);       /* 32 → 45 */
--step-4:  clamp(2rem, 1.4643rem + 2.6786vw, 3.875rem);        /* 32 → 62 */
--step-5:  clamp(2.25rem, 1.3929rem + 4.2857vw, 5.25rem);      /* 36 → 84 */
```

`SLOT_MAX_LENGTH.heading` is 90 code points. At `display`/`--step-5` on a 320 px viewport that is
36 px over a 280 px measure ≈ 6 lines ≈ 227 px — which fits inside `100svh` alongside the subhead
and two CTAs. This is exactly the kind of claim §3.6's render matrix exists to keep honest.

#### Density, radius, motion, elevation

```css
/* densityId: compact | regular | airy */
--space-unit: 0.25rem;                                     /* all three — the grid is fixed */
--section-y:  clamp(2.5rem, 5vw, 4rem)   | clamp(3.5rem, 7vw, 6rem) | clamp(4.5rem, 9vw, 8.5rem);
--gutter:     clamp(1rem, 4vw, 1.5rem)   | clamp(1.25rem, 5vw, 2rem)| clamp(1.5rem, 6vw, 2.5rem);
--measure:    68ch                        | 66ch                     | 62ch;

/* radiusId: sharp | soft | round | pill        sm / md / lg / pill */
sharp: 0        0        0        2px
soft:  2px      4px      8px      999px
round: 6px      10px     16px     999px
pill:  10px     16px     24px     999px

/* motionId: none | subtle | expressive */
none:       --dur: 0s;    --ease: linear;
subtle:     --dur: .18s;  --ease: cubic-bezier(.2, 0, 0, 1);
expressive: --dur: .32s;  --ease: cubic-bezier(.16, 1, .3, 1);

/* elevation, by effective mode */
light: --shadow-1: 0 1px 2px rgb(0 0 0 / .06), 0 8px 24px rgb(0 0 0 / .06);
dark:  --shadow-1: 0 1px 2px rgb(0 0 0 / .50), 0 8px 24px rgb(0 0 0 / .45);
```

`prefers-reduced-motion: reduce` forces `--dur: 0s` in the base layer, so `motionId: expressive` and
the user preference cannot disagree.

### 1.7 Fonts

Self-hosted from R2 under `/_a/`, variable, subset to `latin` + `latin-ext`, **one preload per
page**, metric-matched fallback. Never Google Fonts (third origin on the critical path; LG München I
3 O 17493/20).

```css
@font-face{
  font-family:"Inter";
  src:url("/_a/inter-latin.7c1e9a.woff2") format("woff2-variations");
  font-weight:400 700; font-style:normal; font-display:swap;
  unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,
                U+2000-206F,U+20AC,U+2122,U+2212,U+FEFF,U+FFFD;
}
@font-face{
  font-family:"Inter";
  src:url("/_a/inter-latin-ext.b4402f.woff2") format("woff2-variations");
  font-weight:400 700; font-style:normal; font-display:swap;
  unicode-range:U+0100-02AF,U+1E00-1E9F,U+1EF2-1EFF,U+20A0-20AB,U+2C60-2C7F,U+A720-A7FF;
}
/* Generated by scripts/font-metrics.ts from the woff2's hhea/OS-2 tables. Never hand-written. */
@font-face{
  font-family:"Inter Fallback";
  src:local("Arial"), local("Helvetica Neue"), local("Liberation Sans");
  ascent-override:90.00%; descent-override:22.43%; line-gap-override:0%; size-adjust:107.12%;
}
```

**Which face is preloaded.** Exactly one, because the budget is ≤ 3 requests before LCP (HTML, hero
AVIF, font). For a two-file DNA it is the **display** face: the `<h1>` is the largest and most
visible text on the page and the swap is most noticeable there. Body text renders in the
metric-matched local fallback until its woff2 arrives, at ~0.001 CLS. `clinical_trust` has one file
and preloads it.

```html
<link rel="preload" as="font" type="font/woff2" href="/_a/space-grotesk-latin.4d1e77.woff2" crossorigin>
```

`crossorigin` is mandatory even same-origin — fonts are CORS-fetched, and omitting it causes a
double download.

### 1.8 Sanity check of the `dnaId` column, and what is mismapped

The mapping in `packages/core/src/industries.ts` is real and mostly right. Distribution:
`clinical_trust` 42, `warm_trattoria` 31, `midnight_neon` 16, `garage_steel` 15 — total 104.

**Eight rows are wrong enough to change the customer's first impression.** Each is a one-line data
edit in a file this task does not own; they are listed for the orchestrator.

| industry | current | should be | why |
|---|---|---|---|
| `florist` | `clinical_trust` | `warm_trattoria` | The archetypal warm, seasonal, botanical business rendered in clinical white and medical teal. Of the four, `clinical_trust` is the single worst fit for a florist. |
| `self_storage` | `midnight_neon` | `garage_steel` | Utilitarian, price-and-access driven, bought on the phone. Neon violet and expressive motion sell nothing here; steel + amber + a giant tap-to-call is exactly right. |
| `driving_school` | `midnight_neon` | `clinical_trust` | Bought by parents for 17-year-olds. The 20-preset registry maps it to `kids_playful` (blue/yellow, round, Poppins); of the four shipped, `clinical_trust` (round, calm, trust band, pass-rate stats) is the honest reduction. `midnight_neon` reads as a nightclub. |
| `pet_grooming` | `clinical_trust` | `warm_trattoria` | `veterinarian` → `clinical_trust` is correct; grooming is a warm retail service, not a clinic. |
| `dog_training` | `clinical_trust` | `warm_trattoria` | Same reasoning. |
| `pet_store` | `clinical_trust` | `warm_trattoria` | Retail, and every other pet-adjacent retailer in the table is warm. |
| `bed_breakfast` | `clinical_trust` | `warm_trattoria` | `hotel` and `campsite` are `warm_trattoria`; a B&B is the warmest of the three and is the odd one out. |
| `car_wash` | `clinical_trust` | `garage_steel` | Sits alone in `clinical_trust` while `tyre_service`, `car_repair` and `car_bodywork` are `garage_steel`. Nothing about a car wash is clinical. |

Two more are defensible but worth a decision rather than a default:

- `brewery` → `garage_steel`. A brewery *taproom* is closer to `bar_pub` (`midnight_neon`); a
  brewery *facility* is industrial. Leave it, but note that the model can reach the taproom look via
  `paletteVariant: 'inverse'` (which flips `garage_steel` to its dark ground).
- `photographer` → `clinical_trust`. Right bucket (white, image-led, near-invisible chrome), wrong
  accent — a teal accent on a portfolio fights the work. The generator should be steered to
  `paletteVariant: 'alt'` (navy) for this key; the same applies to `funeral_services`, where a
  medical teal is tonally wrong.

**The structural problem this table exposes, which no remapping fixes.** 31 industries share
`warm_trattoria` and 42 share `clinical_trust`. Two bakeries in the same town get the same DNA, and
the knobs are what must make them look different. The reachable colourway space is
4 DNA × 3 variants × 2 modes × 5 hue shifts = **120 colourways**, and the full theme space is
× 4 type scales × 4 radii × 3 densities × 3 motions = **17 280 themes**. On top of that the model
picks a hero variant (4), a nav style (3), a footer style (3) and the section order. That is enough
that byte-identical sites are effectively impossible — but *within one DNA* the silhouette
differentiators are only the hero variant, the density rhythm and the nav/footer style. Honest
statement: **the four archetypes carry Phase 2, and the remaining sixteen presets from the 20-key
registry are what actually stop the 31-business bucket reading as one template.** They are a data
addition to `tokens/dna.ts` — no renderer change, no schema change, because `DNA_IDS` is the only
thing that has to grow.

---

## 2. Tones — why the proof covers the whole page, not just `:root`

A section that wants a dark island on a light page must not reach for `--color-fg` and hope. It
declares a **tone**, and the tone rebinds a small fixed set of *consumed* names.

```
Palette tokens  --color-*   20, resolved per theme, declared once on :root.
                            NO component may reference them. Ever.
Tone tokens     --t-*       17, redeclared by each tone block. The ONLY colour names a
                            section fragment is allowed to read.
```

There are five tones and they are a closed set:

| tone | used by | `--t-bg` | `--t-fg` | `--t-fg-muted` | `--t-surface` | `--t-accent` |
|---|---|---|---|---|---|---|
| `page` | default | `--color-bg` | `--color-fg` | `--color-fg-muted` | `--color-surface` | `--color-accent` |
| `alt` | alternating bands | `--color-bg-alt` | `--color-fg` | `--color-fg-muted` | `--color-surface` | `--color-accent` |
| `surface` | cards, dialogs, footer | `--color-surface` | `--color-fg-on-surface` | `--color-fg-muted` | `--color-surface-2` | `--color-accent` |
| `accent` | `cta_band/accent_full`, `stats_band/accent_bg` | `--color-accent` | `--color-fg-on-accent` | `--color-fg-on-accent` | `--color-fg-on-accent` | `--color-fg-on-accent` |
| `contrast` | one inverted island per page, max | `--color-fg` | `--color-bg` | `--color-border` | `--color-bg` | `--color-bg` |

```css
@layer tokens{
  :root,[data-tone="page"]{
    --t-bg:var(--color-bg);              --t-fg:var(--color-fg);
    --t-fg-muted:var(--color-fg-muted);  --t-fg-subtle:var(--color-fg-subtle);
    --t-surface:var(--color-surface);    --t-fg-on-surface:var(--color-fg-on-surface);
    --t-border:var(--color-border);      --t-border-strong:var(--color-border-strong);
    --t-accent:var(--color-accent);      --t-accent-hover:var(--color-accent-hover);
    --t-accent-edge:var(--color-accent-edge);
    --t-fg-on-accent:var(--color-fg-on-accent);
    --t-accent-text:var(--color-accent-text);
    --t-focus:var(--color-focus);        --t-danger:var(--color-danger);
    --t-chip-bg:var(--color-accent-subtle);
    --t-chip-fg:var(--color-fg-on-accent-subtle);
  }
  [data-tone="alt"]{ --t-bg:var(--color-bg-alt) }
  [data-tone="surface"]{
    --t-bg:var(--color-surface); --t-fg:var(--color-fg-on-surface); --t-surface:var(--color-surface-2);
  }
  [data-tone="accent"]{
    --t-bg:var(--color-accent);          --t-fg:var(--color-fg-on-accent);
    --t-fg-muted:var(--color-fg-on-accent);  --t-fg-subtle:var(--color-fg-on-accent);
    --t-surface:var(--color-fg-on-accent);   --t-fg-on-surface:var(--color-accent);
    --t-border:var(--color-fg-on-accent);    --t-border-strong:var(--color-fg-on-accent);
    --t-accent:var(--color-fg-on-accent);    --t-accent-hover:var(--color-fg-on-accent);
    --t-accent-edge:var(--color-fg-on-accent);
    --t-fg-on-accent:var(--color-accent);    --t-accent-text:var(--color-fg-on-accent);
    --t-focus:var(--color-fg-on-accent);     --t-danger:var(--color-fg-on-accent);
    --t-chip-bg:var(--color-fg-on-accent);   --t-chip-fg:var(--color-accent);
  }
  [data-tone="contrast"]{
    --t-bg:var(--color-fg);              --t-fg:var(--color-bg);
    --t-fg-muted:var(--color-border);    --t-fg-subtle:var(--color-border);
    --t-surface:var(--color-bg);         --t-fg-on-surface:var(--color-fg);
    --t-border:var(--color-fg-subtle);   --t-border-strong:var(--color-fg-subtle);
    --t-accent:var(--color-bg);          --t-accent-hover:var(--color-bg);
    --t-accent-edge:var(--color-bg);     --t-fg-on-accent:var(--color-fg);
    --t-accent-text:var(--color-bg);     --t-focus:var(--color-bg);
    --t-danger:var(--color-bg);
    --t-chip-bg:var(--color-bg);         --t-chip-fg:var(--color-fg);
  }
}
```

Two things this buys, both load-bearing:

1. **The accent and contrast tones need no new resolved tokens.** `contrast(a, b)` is symmetric, so
   `--t-fg` / `--t-bg` on the `accent` tone is the already-proven `fg-on-accent` / `accent` pair
   read backwards, and on the `contrast` tone it is the already-proven body pair read backwards. A
   filled button on an accent band is an inverted button — paper fill, accent ink — which is both
   the correct visual answer and free.
2. **Colour cannot leak out of the token layer.** `css/assemble.ts` runs a lint over every fragment
   in the `sections` layer: collect every `var(--…)` name and assert the set is a subset of
   `TONE_TOKENS ∪ NON_COLOUR_TOKENS ∪ COMPONENT_LOCALS`, where `COMPONENT_LOCALS` are names
   beginning `--_` and declared in the same fragment. A section fragment that says
   `var(--color-accent)` fails the build.
   The `base` and `chrome` layers *are* permitted to read palette tokens, because some things float
   over an unknown tone, but every such read is enumerated in `TONE_EXEMPT_READS` and the lint
   asserts the list is exhaustive. There are exactly three: `--color-focus-halo` in the
   `:focus-visible` rule (the ring's outer tone must be the page's paper regardless of what it rings),
   the WhatsApp pill (§7), and `<meta name="theme-color">` (§9.1). This is what makes "every text pair
   on every page is one of the pairs in §3" a *checked* statement rather than a convention.

Restrictions that come with the tones, enforced in `sections/*.tsx` by construction:

- `contact_form` may only appear on `page`, `alt` or `surface` — a lead form on a saturated ground is
  bad design and would need a danger colour that survives it.
- `--color-accent-subtle` is a **chip fill only** (menu tags, service-area chips, badges). It is
  never a section ground, so no control and no focus ring ever sits on it, and its only obligation
  is `--color-fg-on-accent-subtle` at ≥ 4.5:1 (worst observed 4.51:1).
- At most one `contrast` island per page. More than one and the page reads as stripes.

---

## 3. Proving contrast analytically over the whole knob space

### 3.1 What is being proven

> For every theme reachable from `ThemeGen` — all 17 280 of them — and for every tone, every token
> pair that can put text or a boundary on a ground meets WCAG 2.2 AA, and body copy meets AAA where
> the archetype allows it. No browser is involved, no colour is sampled from a screenshot, and the
> test runs in under a second on every commit.

This is possible only because of three structural facts, all of which are themselves asserted:

1. **The theme is a pure function of eight enums.** `resolveTheme` takes no `Date`, no random, no
   environment. Enumerating the enums enumerates the reachable colour space exactly.
2. **Only four of the eight knobs affect colour.** `typeScaleId`, `radiusId`, `densityId` and
   `motionId` cannot change a colour token. This is asserted, not assumed (§3.4), which collapses
   17 280 themes to **120 distinct colourways** for the colour proof while keeping the enumeration
   honest.
3. **Components read only `--t-*`** (§2), so the set of realisable (foreground, background) pairs on
   a rendered page is the finite product of the pair list and the five tones.

### 3.2 The algorithm

```ts
// packages/site-kit/src/__tests__/contrast.test.ts
import { DNA_IDS, PALETTE_VARIANTS, HUE_SHIFTS, TYPE_SCALE_IDS, RADIUS_IDS,
         DENSITY_IDS, MOTION_IDS, COLOR_MODES } from '@aibuilder/site-schema';
import { contrastRatio, parseColor, CONTRAST_PAIRS } from '@aibuilder/site-schema';
import { resolveTheme } from '../tokens/resolve';
import { applyTone, TONES } from '../tokens/tones';
import { THEME_CONTRAST_CONTRACT } from '../tokens/contract';

for (const dnaId of DNA_IDS)
for (const paletteVariant of PALETTE_VARIANTS)
for (const accentHueShift of HUE_SHIFTS)
for (const colorMode of COLOR_MODES)
for (const typeScaleId of TYPE_SCALE_IDS)
for (const radiusId of RADIUS_IDS)
for (const densityId of DENSITY_IDS)
for (const motionId of MOTION_IDS) {
  const tokens = resolveTheme({ dnaId, paletteVariant, accentHueShift, colorMode,
                                typeScaleId, radiusId, densityId, motionId });
  for (const tone of TONES) {
    const t = applyTone(tokens, tone);                     // resolves --t-* to literal values
    for (const { foreground, background, minRatio, label } of THEME_CONTRAST_CONTRACT[tone]) {
      const fg = t[foreground], bg = t[background];
      expect(fg, `${label}: ${foreground} unresolved`).toBeDefined();
      expect(parseColor(fg), `${label}: ${foreground} unparseable`).not.toBeNull();
      const ratio = contrastRatio(fg, bg)!;
      expect(ratio, `${dnaId}/${paletteVariant}/${colorMode}/${accentHueShift} · ${tone} · ${label}`)
        .toBeGreaterThanOrEqual(minRatio);
    }
  }
}
```

The whole product is enumerated — 17 280 iterations, ~1.7 M ratio computations — because it costs
about 900 ms and removes the need to trust the collapsing argument. No sampling, no random seeds, no
`expect.soft`.

Four properties are asserted alongside the ratios, and each one is load-bearing:

| assertion | why it exists |
|---|---|
| **In-gamut.** For every colour token, `maxChromaInSrgb(L, H) ≥ C / 0.94`. | `lint.ts` clamps out-of-gamut channels to `[0,1]`; the browser reduces chroma instead. A ratio computed on a clamped colour is a ratio for a colour nobody will see. Staying in gamut makes the two agree. |
| **No `var()` indirection.** Every value in `theme.tokens` matches `/^oklch\(|^#|^rgb\(/` for colour keys. | `lint.ts` deliberately refuses to follow `var()` and would emit `token_unparseable` at publish. The resolver must store fully-resolved values. |
| **Determinism.** `resolveTheme(x)` called twice returns byte-identical strings; every numeric component has ≤ 4 decimals. | The tokens go into `render_sha256` (§9). A float that serialises as `0.6404999999999999` on one run moves `lastmod` for free. |
| **Colour ⟂ non-colour knobs.** For a fixed `(dnaId, paletteVariant, accentHueShift, colorMode)`, the 20 colour tokens are identical across all 144 `(typeScaleId, radiusId, densityId, motionId)` combinations. | This is the fact that lets a human reason about "120 colourways". If someone later makes `densityId` tint a border, the test says so. |

`CONTRAST_PAIRS` in `site-schema/lint.ts` stays as the publish-time subset (5 pairs, checked on
every assembled document, cheap). `THEME_CONTRAST_CONTRACT` in site-kit is its superset and the
test asserts `CONTRAST_PAIRS ⊆ THEME_CONTRAST_CONTRACT.page`, so the two cannot drift.
The dependency direction is forced — `site-schema` may not import `site-kit` — and this is the
right side of it: the linter checks a stored document, the proof checks the generator.

### 3.3 The pairs, and the measured worst case over all 120 colourways

Tone `page`. Tones `alt` / `surface` substitute the ground and are listed where the ratio differs;
tones `accent` / `contrast` reduce to already-listed pairs by symmetry (§2).

| # | foreground | background | min | measured worst | worst at |
|---|---|---|---|---|---|
| 1 | `--t-fg` | `--t-bg` | **7.0** (AAA) | 14.33 | `warm_trattoria/default/light/−30` |
| 2 | `--t-fg` | `--t-surface` | **7.0** (AAA) | 12.81 | `warm_trattoria/default/dark/−30` |
| 3 | `--t-fg` | `--color-bg-alt` | **7.0** (AAA) | 13.27 | `warm_trattoria/default/light/−30` |
| 4 | `--t-fg` | `--color-surface-2` | 4.5 | 11.14 | `warm_trattoria/default/dark/−30` |
| 5 | `--t-fg-muted` | `--t-bg` | 4.5 | 6.87 | `warm_trattoria/default/light/−30` |
| 6 | `--t-fg-muted` | `--t-surface` | 4.5 | 7.11 | `clinical_trust/default/light/−30` |
| 7 | `--t-fg-muted` | `--color-bg-alt` | 4.5 | 6.34 | `midnight_neon/default/light/−30` |
| 8 | `--t-fg-muted` | `--color-surface-2` | 4.5 | 5.88 | `midnight_neon/default/light/−30` |
| 9 | `--t-fg-on-accent` | `--t-accent` | 4.5 | 4.68 | `clinical_trust/default/light/−30` |
| 10 | `--t-fg-on-accent` | `--t-accent-hover` | 4.5 | 4.52 | `midnight_neon/alt/light/+30` |
| 11 | `--t-accent-text` | `--t-bg` | 4.5 | 5.14 | `clinical_trust/alt/light/−15` |
| 12 | `--t-accent-text` | `--t-surface` | 4.5 | 5.15 | `midnight_neon/alt/dark/−15` |
| 13 | `--t-accent-text` | `--color-surface-2` | 4.5 | 4.51 | `garage_steel/default/dark/−30` |
| 14 | `--t-chip-fg` | `--t-chip-bg` | 4.5 | 4.51 | `clinical_trust/default/dark/+15` |
| 15 | `--t-fg-muted` | `--t-chip-bg` | 4.5 | 5.74 | `warm_trattoria/default/light/−30` |
| 16 | `--t-danger` | `--t-bg` | 4.5 | 4.51 | `midnight_neon/default/light/−30` |
| 17 | `--t-danger` | `--t-surface` | 4.5 | 4.51 | `warm_trattoria/default/dark/−30` |
| 18 | `--t-border-strong` | `--t-bg` | 3.0 | 3.49 | `clinical_trust/default/light/−30` |
| 19 | `--t-border-strong` | `--t-surface` | 3.0 | 3.50 | `midnight_neon/default/dark/−30` |
| 20 | `--t-border-strong` | `--color-bg-alt` | 3.0 | 3.24 | `clinical_trust/default/light/−30` |
| 21 | `--t-border-strong` | `--color-surface-2` | 3.0 | 3.06 | `warm_trattoria/default/light/−30` |
| 22 | `--t-fg-subtle` | `--t-bg` | 3.0 | 4.49 | `warm_trattoria/default/light/−30` |
| 23 | `--t-fg-subtle` | `--t-surface` | 3.0 | 4.18 | `warm_trattoria/default/dark/−30` |
| 24 | `--t-fg-subtle` | `--color-bg-alt` | 3.0 | 4.14 | `midnight_neon/default/light/−30` |
| 25 | `--t-accent-edge` | `--t-bg` | 3.0 | 4.68 | `clinical_trust/default/light/−30` |
| 26 | `--t-accent-edge` | `--t-surface` | 3.0 | 4.04 | `warm_trattoria/default/dark/−30` |
| 27 | `--t-accent-edge` | `--color-bg-alt` | 3.0 | 4.34 | `clinical_trust/default/light/−30` |
| 28 | `--t-focus` | `--t-bg` | 3.0 | 3.43 | `clinical_trust/alt/light/−30` |
| 29 | `--t-focus` | `--t-surface` | 3.0 | 3.43 | `midnight_neon/alt/dark/+30` |
| 30 | `--t-focus` | `--color-bg-alt` | 3.0 | 3.18 | `clinical_trust/alt/light/−30` |
| 31 | `--t-focus` | `--color-surface-2` | 3.0 | 3.01 | `warm_trattoria/default/light/+30` |
| 32 | `--color-focus-halo` | `--t-focus` | 3.0 | 3.43 | `clinical_trust/alt/light/−30` |

**32 pairs, zero failures across all 120 colourways** (3 840 assertions). Body copy is AAA everywhere (worst 12.81:1); secondary
text clears AA with margin (worst 5.88:1) and clears AAA on the page ground for three of the four
archetypes. Pairs 9–14 sit near 4.5 by construction — the solver stops at the first quantised value
that passes, which is the correct behaviour: pushing further would desaturate the accent for no
accessibility gain.

Two deliberate omissions:

- **`--t-border` has no obligation.** It is a decorative hairline; a background change carrying no
  information needs no contrast (SC 1.4.11 covers information, not decoration). Any control boundary
  uses `--t-border-strong`.
- **The focus ring is checked against grounds, not against the control it rings.** The base layer
  mandates `outline-offset: 3px`, so the ring is drawn *outside* the control, on the ground, and the
  ground is its only adjacency. This is why `--t-focus` does not need 3:1 against `--t-accent` —
  which is unachievable for a light amber button on a light page, and which no amount of token
  solving would fix. `--color-focus-halo` (pair 32) is the second tone of the two-tone ring, for
  backgrounds the ring may overlap during scroll.

### 3.4 The hero scrim, proven the same way

Text over an unknown video frame cannot be checked pair-wise, because one side of the pair is a
video. It can be checked *algebraically*, because CSS alpha compositing on an opaque backdrop is
`result = α·scrim + (1−α)·backdrop` per channel in gamma-encoded sRGB, and the worst case over "any
frame" is a single known colour:

| ink | worst backdrop | required α for 4.5:1 | required α for 7:1 |
|---|---|---|---|
| `--hero-ink: light` (paper) over a **black** scrim | pure white | **0.535** | **0.651** |
| `--hero-ink: dark` (ink) over a **white** scrim | pure black | **0.456** | **0.584** |

So a flat 54 % black scrim guarantees AA for white hero text over *any* video ever produced. But a
flat 54 % scrim over a bright hero looks like a dimmer switch, which is the opposite of the product
promise. The resolution is a **band-guaranteed gradient**: the scrim is a vertical gradient chosen
for mood, and the hero's grid places the copy only inside the region where α is already above the
proven floor.

```css
.hero__scrim{
  background:linear-gradient(180deg,
    rgb(0 0 0 / var(--hero-scrim-top))  0%,
    rgb(0 0 0 / var(--hero-scrim-top))  20%,
    rgb(0 0 0 / var(--hero-scrim-band)) 26%,
    rgb(0 0 0 / var(--hero-scrim-band)) 100%);
}
.hero{ display:grid; grid-template-rows:26% 1fr }   /* copy is in row 2 == the guaranteed band */
```

`--hero-scrim-band` is `0.66` for `--hero-ink: light` and `0.60` for `--hero-ink: dark` (white-based
gradient, `rgb(255 255 255 / …)`), both above the 7:1 floor with margin. `--hero-scrim-top` is
`0.18`–`0.24` per DNA and carries no obligation because no text is placed there. The 26 % boundary
and the `grid-template-rows` value are the *same constant*, emitted from one place, and the test
asserts they agree — a geometric proof is only a proof while the two numbers cannot drift apart.

`gallery` captions and `cta_band/image_overlay` reuse the same mechanism with a solid plate rather
than a gradient (the geometry is a box, not a band). **Nothing anywhere in site-kit places text over
a semi-transparent surface that is itself over an image** — that composition cannot be proven and
is banned by the CSS lint (no `background-color` with alpha < 1 on any element that contains text,
except the two scrim elements, which contain none).

### 3.5 What this method cannot prove

Being precise about the boundary is the point. Analytic proof covers colour and nothing else. It
says nothing about:

- **Layout.** Horizontal overflow at 320 px, a grid that collapses at 768 px, a `flex` row that
  cannot wrap, a `position: sticky` header that eats the focused element.
- **Tap targets.** SC 2.5.8 is a geometry question. A 44 px `min-block-size` in the CSS is not proof
  the rendered box is 44 px, because padding, line-height and font fallback all move it.
- **Text over real photographs.** The scrim algebra proves the *scrim* is opaque enough. It does not
  prove the renderer actually emitted the scrim, or that the copy landed in the guaranteed band.
- **Overflow and truncation.** Whether `SLOT_MAX_LENGTH.heading = 90` German code points fit in a
  `display`/`--step-5` `<h1>` inside `100svh`.
- **Font-swap shift.** Whether the metric overrides actually produce ≈ 0 CLS with the real woff2.
- **`content-visibility: auto` estimates.** A wrong `contain-intrinsic-size` reintroduces CLS on
  scroll, and the only way to know is to scroll.
- **Focus visibility in situ.** The ring may have 3:1 and still be clipped by `overflow: hidden` on
  an ancestor.
- **Reflow at 400 % zoom** (SC 1.4.10) and **text-spacing overrides** (SC 1.4.12).

### 3.6 The sampled render matrix that covers the rest

Playwright + `axe-core`, two tiers. The full cartesian product (17 280 themes × 17 sections × 4
variants × 6 locales × 3 viewports ≈ 10⁸ renders) is not a plan; a **pairwise covering array** is.

**Tier 1 — PR gate, ~640 renders, target ≤ 4 minutes.**
Rows: an IPOG 2-wise covering array over the eight theme axes (≈ 24 rows for 4·3·5·2·4·4·3·3, forced
to include each DNA's canonical tuple and both extreme hue shifts) × the 17 sections at their
**widest variant** × viewports {320, 768, 1440} × locale `de` (longest compounds).
Copy fixture: a locale bundle generated *from `SLOT_MAX_LENGTH` itself* — every slot filled to its
exact ceiling with unbroken German compounds (`Kraftfahrzeug-Haftpflichtversicherung…`). Generating
the stress fixture from the schema's own ceilings is what stops it drifting when a ceiling changes.

**Tier 2 — nightly, ~4 000 renders.** Full pairwise over (theme axes × section × variant × locale ×
viewport), plus the four canonical whole-page fixtures per archetype, plus Lighthouse mobile on
those four (the 100/100/100/100 gate).

Assertions per render:

| # | assertion | covers |
|---|---|---|
| 1 | `document.documentElement.scrollWidth <= window.innerWidth` at 320 px | SC 1.4.10 reflow, the single most common generated-site defect |
| 2 | every element matching the interactive selector has a border box ≥ 44 × 44 CSS px, or ≥ 24 × 24 with ≥ 24 px of clear space | SC 2.5.8, and the product's own 44 px rule |
| 3 | `axe-core` `wcag2a, wcag2aa, wcag21aa, wcag22aa` → 0 violations | heading order, landmark names, form labels, `aria-*` validity |
| 4 | CLS via `PerformanceObserver('layout-shift')` = 0 over a scripted scroll to the bottom and back | `contain-intrinsic-size` estimates, sticky header, lazy images |
| 5 | for each focusable element: `:focus-visible` computed `outline-style !== 'none'`, `outline-width >= 2px`, `outline-offset >= 2px`, and the focused element's box is fully inside its nearest scroll container's client box | focus appearance, clipped rings |
| 6 | re-run 1 and 4 with the SC 1.4.12 text-spacing overrides applied (`line-height: 1.5; letter-spacing: .12em; word-spacing: .16em; margin-block-end: 2em` on `p`) | SC 1.4.12 |
| 7 | screenshot of the hero copy region, sample every pixel's luminance, assert min contrast of the ink against the *actual composited* backdrop ≥ 4.5 | closes the loop on §3.4 — proves the scrim was emitted and the copy landed in the band |
| 8 | no `<img>`/`<video>`/`<iframe>` without `width` and `height` attributes | CLS |
| 9 | `getComputedStyle(document.body).fontSize` ≥ 17 px at 320 px | keeps the "never use the large-text exemption" premise true |
| 10 | DOM node count ≤ 1 500 | the perf budget |

Assertion 7 is the one worth building carefully: it is the only place where a *rendered pixel* is
compared against the analytic guarantee, and it is what turns §3.4 from an argument into a test.

---

## 4. CSS strategy

**One `<style>` element in `<head>`, containing 100 % of the page's CSS, assembled at publish from
the sections the page actually uses. No external stylesheet, no CSS-in-JS runtime, no Tailwind, no
`@import`, no `<link rel=stylesheet>` anywhere on a tenant site.**

### 4.1 Cascade layers

```css
@layer reset, tokens, base, layout, sections, chrome, state;
```

Declared once, first, before anything else — layer order is fixed by the first `@layer` statement,
so this line is the whole contract:

| layer | contents | why here |
|---|---|---|
| `reset` | box-sizing, margin zeroing, `img/video` defaults, `:target` scroll padding | lowest precedence: everything can override it without specificity games |
| `tokens` | the `:root{}` theme block (47 properties) and the five `[data-tone]` blocks | above reset so a tone can restate a reset colour; below base so base can consume tokens |
| `base` | element defaults — type scale on `h1…h6/p/li`, link underlines, focus ring, `.vh`, `.skip`, `prefers-reduced-motion`, `@font-face` | the "unstyled page still looks right" layer |
| `layout` | `.wrap`, `.stack`, `.grid-auto`, `.section`, `.split`, `.cluster` — the ~9 layout primitives every section composes from | shared, so 17 fragments do not each ship a grid |
| `sections` | one fragment per section type, all rules prefixed `.s-<type>` | the only layer that varies per page |
| `chrome` | header, footer, WhatsApp, skip link, cookie banner | always present, sized once |
| `state` | `[hidden]`, `[aria-expanded]`, `[data-ready]`, `[open]`, `@media print` | highest: state must beat everything without `!important` |

`!important` appears exactly twice in the whole package and both are documented in place: the
`prefers-reduced-motion` block and `@media print`.

**The theme block is emitted inside `@layer tokens`, not unlayered.** Unlayered rules beat every
layer, and Phase 2's live editor writes theme overrides as inline styles on
`document.documentElement`, which beat layers *and* unlayered rules. Keeping the published theme in
a layer means the editor's 0 ms preview and the published output differ by exactly one mechanism
(inline style vs. layer), which is easy to reason about and easy to flush on save.

### 4.2 The reset (complete)

```css
@layer reset{
  *,*::before,*::after{ box-sizing:border-box }
  html{ -webkit-text-size-adjust:100%; scroll-padding-block-start:calc(var(--space-unit)*24) }
  body,h1,h2,h3,h4,p,figure,blockquote,dl,dd,ul,ol{ margin:0 }
  ul[role="list"],ol[role="list"]{ list-style:none; padding:0 }
  h1,h2,h3,h4{ text-wrap:balance; overflow-wrap:break-word }
  p,li,dd{ text-wrap:pretty }
  img,picture,video,canvas,svg{ display:block; max-inline-size:100%; block-size:auto }
  input,button,textarea,select{ font:inherit; color:inherit }
  button{ background:none; border:0 }
  table{ border-collapse:collapse }
  :where(a){ color:inherit }
  [hidden]{ display:none !important }   /* 1 of 2 — state must not be overridable */
}
```

`overflow-wrap:break-word` on headings is not cosmetic: it is the difference between a German
compound noun breaking and a 320 px page scrolling horizontally, which is assertion 1 of §3.6.

### 4.3 Base

```css
@layer base{
  /* The 4px grid. Fixed for every theme (§1.6): density moves rhythm, not the grid. */
  :root{
    --space-1:calc(var(--space-unit)*1);  --space-2:calc(var(--space-unit)*2);
    --space-3:calc(var(--space-unit)*3);  --space-4:calc(var(--space-unit)*4);
    --space-5:calc(var(--space-unit)*5);  --space-6:calc(var(--space-unit)*6);
    --space-8:calc(var(--space-unit)*8);  --space-10:calc(var(--space-unit)*10);
    --space-12:calc(var(--space-unit)*12);--space-16:calc(var(--space-unit)*16);
    --space-20:calc(var(--space-unit)*20);--space-24:calc(var(--space-unit)*24);
  }
  body{
    margin:0;
    background:var(--t-bg);
    color:var(--t-fg);
    font-family:var(--font-body);
    font-size:var(--step-0);
    line-height:1.6;
    font-synthesis-weight:none;
    text-rendering:optimizeLegibility;
  }
  h1,h2,h3,h4{
    font-family:var(--font-display);
    font-variation-settings:"wght" var(--font-display-wght),"wdth" var(--font-display-wdth);
    letter-spacing:var(--font-display-tracking);
    line-height:1.1;
  }
  h1{ font-size:var(--step-5) }
  h2{ font-size:var(--step-4) }
  h3{ font-size:var(--step-2) }
  h4{ font-size:var(--step-1) }
  p,li{ max-inline-size:var(--measure) }
  small,.u-fine{ font-size:var(--step--1) }

  a{ color:var(--t-accent-text); text-underline-offset:.18em; text-decoration-thickness:.08em }
  a:hover{ text-decoration-thickness:.14em }

  /* One focus rule for the whole site. Drawn OUTSIDE the control (see §3.3). */
  :focus-visible{
    outline:3px solid var(--t-focus);
    outline-offset:3px;
    border-radius:var(--radius-sm);
    box-shadow:0 0 0 6px var(--color-focus-halo);   /* second tone of the two-tone ring */
  }
  :focus:not(:focus-visible){ outline:none }

  .vh{ position:absolute!important; inline-size:1px; block-size:1px; padding:0; margin:-1px;
       overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0 }
  .skip{ position:absolute; inset-block-start:0; inset-inline-start:0; z-index:100;
         transform:translateY(-120%); background:var(--t-surface); color:var(--t-fg-on-surface);
         padding:var(--space-3) var(--space-4); border-radius:var(--radius-md) }
  .skip:focus{ transform:none }

  @media (prefers-reduced-motion:reduce){
    *,*::before,*::after{
      animation-duration:.001ms!important; animation-iteration-count:1!important;
      transition-duration:.001ms!important; scroll-behavior:auto!important;
    }                                       /* 2 of 2 */
  }
}
```

The `.vh` rule uses `clip-path: inset(50%)` rather than the legacy `clip: rect(…)`; both hide, but
`clip-path` does not disable text selection announcements in some AT builds.

### 4.4 Layout primitives

Nine classes. Every section composes from these; none of the 17 fragments defines its own grid.

```css
@layer layout{
  .wrap{ inline-size:min(100% - var(--gutter)*2, var(--wrap-max,72rem)); margin-inline:auto }
  .wrap--narrow{ --wrap-max:46rem }
  .wrap--wide{ --wrap-max:84rem }
  .section{
    padding-block:var(--section-y);
    background:var(--t-bg); color:var(--t-fg);
    content-visibility:auto;
    contain-intrinsic-size:auto var(--sec-h,720px);   /* per-section estimate, see §9.4 */
  }
  .section:first-of-type{ content-visibility:visible }   /* never defer the LCP section */
  .stack > * + *{ margin-block-start:var(--stack-gap,var(--space-4)) }
  .cluster{ display:flex; flex-wrap:wrap; gap:var(--space-3); align-items:center }
  .grid-auto{ display:grid; gap:var(--space-6);
              grid-template-columns:repeat(auto-fit,minmax(min(100%,var(--col,17rem)),1fr)) }
  .split{ display:grid; gap:var(--space-8); align-items:center }
  @media (min-width:52em){ .split{ grid-template-columns:var(--split,1fr 1fr) } }
  .card{ background:var(--t-surface); color:var(--t-fg-on-surface);
         border:var(--hairline) solid var(--t-border); border-radius:var(--radius-lg);
         padding:var(--space-6) }
  .lead{ font-size:var(--step-1); color:var(--t-fg-muted); max-inline-size:var(--measure) }
}
```

`minmax(min(100%, var(--col)), 1fr)` rather than `minmax(var(--col), 1fr)` is the fix for the
classic `auto-fit` overflow at 320 px: without the inner `min()`, a 17 rem minimum forces a 272 px
column inside a 280 px content box and the first long word overflows.

### 4.5 Buttons — the one place the accent edge matters

```css
@layer base{
  .btn{
    display:inline-flex; align-items:center; justify-content:center; gap:var(--space-2);
    min-block-size:44px; min-inline-size:44px;         /* SC 2.5.8, and the product's own rule */
    padding-block:var(--space-3); padding-inline:var(--space-5);
    border-radius:var(--radius-md);
    font-weight:600; line-height:1.2; text-decoration:none;
    transition:background-color var(--dur) var(--ease), border-color var(--dur) var(--ease);
  }
  .btn--primary{
    background:var(--t-accent); color:var(--t-fg-on-accent);
    border:var(--hairline) solid var(--t-accent-edge);
  }
  .btn--primary:hover{ background:var(--t-accent-hover); border-color:var(--t-accent-hover) }
  .btn--secondary{
    background:transparent; color:var(--t-accent-text);
    border:2px solid var(--t-accent-edge);
  }
  .btn--ghost{ background:transparent; color:var(--t-accent-text);
               text-decoration:underline; text-underline-offset:.2em; padding-inline:var(--space-2) }
}
```

The three classes are exactly `CTA_STYLES` from `gen/common.ts`. `--t-accent-edge` equals
`--t-accent` for three archetypes, so the border costs nothing there and rescues `garage_steel`.

### 4.6 Assembly, minification and the budget

```ts
// packages/site-kit/src/css/assemble.ts
export interface CssBundle { readonly css: string; readonly bytes: number }

export function assembleCss(used: ReadonlySet<ComponentKey>, tokens: ThemeTokens): CssBundle {
  const parts = [
    LAYER_STATEMENT,          // "@layer reset,tokens,base,layout,sections,chrome,state;"
    RESET_CSS,
    themeBlock(tokens),       // :root{…47 props…} + 5 [data-tone] blocks
    fontFaceBlock(tokens),
    BASE_CSS,
    LAYOUT_CSS,
    ...COMPONENT_ORDER.filter((k) => used.has(k)).map((k) => COMPONENT_CSS[k]),
    STATE_CSS,
  ];
  const css = parts.join('');
  const bytes = new TextEncoder().encode(css).byteLength;
  if (bytes > CSS_RAW_CEILING) throw new CssBudgetError(bytes, CSS_RAW_CEILING);
  return { css, bytes };
}
```

Three deliberate choices:

1. **Fragments are pre-minified at build time, not at publish.** `scripts/build-css.ts` runs
   Lightning CSS over the readable sources in `src/css/**/*.css` and writes
   `*.generated.ts` exporting a minified string constant. The Worker only concatenates. This keeps a
   native/wasm minifier out of the publish path, makes the output byte-stable across deploys
   (important for §9), and makes the fragments greppable in review.
2. **`COMPONENT_ORDER` is a fixed array, not iteration over the `Set`.** Set iteration order is
   insertion order, which is section order, which varies per page — and a page whose CSS is the same
   rules in a different order is a different string, a different `render_sha256` and a spurious
   `lastmod` move. Emitting in catalogue order makes the bundle a pure function of the *set*.
3. **The publish-time gate is on raw bytes; the brotli gate lives in CI.** `workerd` exposes
   `CompressionStream` for gzip/deflate only — there is no brotli stream API — so the publish path
   cannot measure the number the budget is actually stated in. CI measures brotli-11 over the
   worst-case assembly (all 17 sections + both chrome variants) and derives `CSS_RAW_CEILING` from
   the worst observed ratio with 15 % margin; the constant is committed with the measurement
   alongside it. Saying "≤ 11 KB brotli, asserted at publish" without noticing this would be a lie
   in the build log.

**Budget table.** Brotli-11 bytes, measured in CI over the fragment plus its share of shared rules.

| fragment | budget (br) | note |
|---|---|---|
| layer statement + reset | 210 | |
| theme block (47 props + 5 tone blocks) | 380 | scales with token count, not site |
| `@font-face` (1 or 2 families + fallback) | 300 | |
| base | 900 | type, links, focus, `.vh`, `.skip`, buttons |
| layout primitives | 480 | |
| state + print | 210 | |
| **fixed subtotal** | **2 480** | on every page |
| header (one of 3 nav styles) | 520 | |
| footer (one of 3 styles) | 460 | |
| whatsapp | 180 | §7 |
| cookie banner | 240 | emitted only when `uses_non_essential` |
| `hero` | 760 | 4 variants |
| `usp_trio` | 300 | `services_grid` 420 · `menu` 380 · `about` 320 |
| `gallery` | 470 | `reviews` 380 · `team` 300 · `process_steps` 340 |
| `stats_band` | 260 | `faq` 240 · `booking` 260 · `contact_form` 470 |
| `map_hours` | 300 | `cta_band` 300 · `blog_teaser` 260 · `rich_text` 200 |
| **all 17 sections** | **5 960** | pathological page |

- Typical home page (hero, usp_trio, about, services_grid, reviews, faq, cta_band, map_hours,
  contact_form) = 2 480 + 520 + 460 + 180 + 3 490 = **7 130 B**.
- Pathological page (all 17 sections + banner) = 2 480 + 520 + 460 + 180 + 240 + 5 960 = **9 840 B**.

**Even the page that uses every section type fits under 11 264 B with 1 424 B of headroom.** That is
the number to defend in review; if a future component pushes past it, the answer is a smaller
component, not a bigger budget.

### 4.7 How the theme is injected

```ts
export function themeBlock(t: ThemeTokens): string {
  const decls = TOKEN_ORDER.map((k) => `${k}:${t[k]}`).join(';');
  return `@layer tokens{:root{${decls}}${TONE_BLOCKS}}`;
}
```

`TOKEN_ORDER` is a frozen array of the 47 names in a fixed order — again, so the same theme always
serialises to the same bytes. `TONE_BLOCKS` is a constant string; tones do not vary per site.

The live editor (Phase 2, `apps/app`) changes a colour by writing
`root.style.setProperty('--color-accent', …)` — 20 possible properties, a style recalculation, no
re-render, no network round trip. On save, the same eight enums go back through `resolveTheme` on
the server, so the preview and the publish cannot disagree about anything except the moment they
were computed.

---

## 5. The hero

A full-screen bright video header that still scores 100/100. Everything in this section exists to
satisfy one invariant.

### 5.1 The size invariant

A `<video>` element is an LCP candidate, and LCP stays open until the first interaction. Timing
cannot save you; only size can. LCP size = viewport-intersection area **capped by intrinsic size**,
and a new candidate replaces the old only when it is *strictly larger*. Therefore:

> **poster intrinsic area ≥ video intrinsic area, at every breakpoint.**

| breakpoint | poster | video | video ÷ poster |
|---|---|---|---|
| desktop | 2400 × 1350 | 1920 × 1080 | 0.64 |
| mobile | 1170 × 2080 | 720 × 1280 | 0.38 |

Asserted per site at publish in `core/media-pipeline.ts`; a failing pair fails the publish. Four
guards, in decreasing order of reliability: the size invariant (the actual guarantee);
`opacity: 0` until mounted (Chrome excludes fully transparent elements from LCP); mounting only
after LCP was attributed to the poster; and **never** putting `poster=` on the `<video>` — that makes
the video element itself the candidate and hands Lighthouse a "video did not have a preload" audit.

### 5.2 The markup

`hero`, variant `video_fullbleed`. `escapeHtml()` on every interpolated string; every `href` is
built by code from a `LinkRef` (invariant 2).

```html
<section class="hero s-hero" id="hero" data-variant="video_fullbleed" data-ink="light"
         style="--hero-bg:#3a2a1c;--hero-focal:50% 40%">
  <picture class="hero__media">
    <source media="(max-width:767px)" type="image/avif" sizes="100vw"
            srcset="/_a/hero-p-780.3f9a1c.avif 780w,/_a/hero-p-1170.3f9a1c.avif 1170w">
    <source media="(max-width:767px)" type="image/webp" sizes="100vw"
            srcset="/_a/hero-p-780.3f9a1c.webp 780w,/_a/hero-p-1170.3f9a1c.webp 1170w">
    <source type="image/avif" sizes="100vw"
            srcset="/_a/hero-l-1280.3f9a1c.avif 1280w,/_a/hero-l-1920.3f9a1c.avif 1920w,/_a/hero-l-2400.3f9a1c.avif 2400w">
    <source type="image/webp" sizes="100vw"
            srcset="/_a/hero-l-1280.3f9a1c.webp 1280w,/_a/hero-l-1920.3f9a1c.webp 1920w,/_a/hero-l-2400.3f9a1c.webp 2400w">
    <img class="hero__poster" src="/_a/hero-l-1920.3f9a1c.jpg" alt=""
         width="2400" height="1350" fetchpriority="high" decoding="sync">
  </picture>

  <video class="hero__video" muted loop playsinline
         disablepictureinpicture disableremoteplayback
         preload="none" aria-hidden="true" tabindex="-1"
         width="1920" height="1080"
         data-src-desktop-av1="/_a/hero-1920.av1.9c22d1.webm"
         data-src-desktop-h264="/_a/hero-1920.h264.9c22d1.mp4"
         data-src-mobile-av1="/_a/hero-720x1280.av1.9c22d1.webm"
         data-src-mobile-h264="/_a/hero-720x1280.h264.9c22d1.mp4"></video>

  <div class="hero__scrim" aria-hidden="true"></div>

  <div class="hero__copy stack">
    <h1 id="hero-h">Ambachtelijk desembrood, elke ochtend vers</h1>
    <p class="hero__sub">Javastraat 118, Amsterdam-Oost · open di t/m zo</p>
    <p class="hero__trust">Sinds 1962 · 4 generaties bakkers</p>
    <div class="cluster">
      <a class="btn btn--primary" href="/nl/contact/">Bestel een taart</a>
      <a class="btn btn--secondary" href="tel:+31205551234">Bel ons</a>
    </div>
  </div>
</section>
```

Every attribute here is load-bearing:

- `alt=""` on the poster — it is decorative, the `<h1>` carries the meaning, and an empty `alt` does
  **not** disqualify an image from being the LCP element.
- `decoding="sync"`, not `async` — for the single LCP element you want it decoded in the frame it
  paints.
- No `loading` attribute → `eager`. `loading="lazy"` on the LCP image is an automatic Lighthouse
  failure.
- `width`/`height` are the **poster's** intrinsic size (2400 × 1350), not the video's, so the
  aspect-ratio box is known before either loads.
- `preload="none"` and **no `src`** on the video: the element exists for layout, generates zero
  network activity, and is invisible to the a11y tree and the tab order.
- `--hero-bg` is `media_assets.dominant_color`. It paints at ~200 ms, removes the white flash, and
  Chrome's low-entropy heuristic ignores solid-colour paints as LCP candidates, so it does not
  create a fake early LCP.
- `--hero-focal` comes from `MediaRef.focalPoint` (`center|top|bottom|left|right` → a percentage
  pair). It is the only style attribute site-kit ever emits, and both its values are drawn from
  closed enums / a `CHECK`-constrained column, never from a model string.

The other three variants share the same box and copy structure; they differ only in what fills the
media layer:

| variant | media layer | scrim | grid |
|---|---|---|---|
| `video_fullbleed` | `<picture>` + deferred `<video>`, full bleed | band gradient (§3.4) | `26% 1fr`, copy centred in row 2 |
| `image_split` | `<picture>`, one column of a 2-col split | **none** — copy is on `--t-bg` | `.split` with `--split:1.1fr 1fr` |
| `type_centered` | none (or a `--hero-bg` wash) | none | single column, `.wrap--narrow` |
| `image_offset_grid` | `<picture>` in a 7/12 offset cell | none | 12-col grid, copy in cols 1–6 |

Only `video_fullbleed` puts text over unknown pixels, so only it carries a scrim, and only it needs
§3.4. That is deliberate: three of the four hero variants are provable by ordinary token contrast.

### 5.3 The CSS

```css
@layer sections{
  .hero{
    position:relative;
    min-block-size:100vh;      /* fallback for UAs without svh */
    min-block-size:100svh;     /* SMALL viewport height: the value with the URL bar EXPANDED.
                                  It never changes as the bar collapses, so there is no
                                  resize-driven shift. 100dvh changes on scroll (CLS);
                                  100vh is iOS's LARGE viewport (hero overflows, CTA hides
                                  under the browser chrome). */
    display:grid;
    grid-template-rows:26% 1fr;             /* row 2 == the proven scrim band, §3.4 */
    overflow:clip;
    isolation:isolate;
    background:var(--hero-bg,var(--t-bg));
    content-visibility:visible;             /* never defer the LCP section */
  }
  /* Poster and video occupy the EXACT same box: mounting the video reflows nothing. */
  .hero__media,.hero__video{
    position:absolute; inset:0; z-index:-2;
    inline-size:100%; block-size:100%;
  }
  .hero__poster{
    inline-size:100%; block-size:100%;
    object-fit:cover; object-position:var(--hero-focal,50% 50%);
  }
  .hero__video{
    object-fit:cover; object-position:var(--hero-focal,50% 50%);
    opacity:0;                              /* transparent ⇒ excluded from LCP */
    transition:opacity .6s ease-out;
    z-index:-1; pointer-events:none;
  }
  .hero__video[data-ready="1"]{ opacity:1 }
  .hero__scrim{
    position:absolute; inset:0; z-index:-1;
    background:linear-gradient(180deg,
      rgb(0 0 0 / var(--hero-scrim-top))  0%,
      rgb(0 0 0 / var(--hero-scrim-top))  20%,
      rgb(0 0 0 / var(--hero-scrim-band)) 26%,
      rgb(0 0 0 / var(--hero-scrim-band)) 100%);
  }
  .hero[data-ink="dark"] .hero__scrim{
    background:linear-gradient(180deg,
      rgb(255 255 255 / var(--hero-scrim-top))  0%,
      rgb(255 255 255 / var(--hero-scrim-top))  20%,
      rgb(255 255 255 / var(--hero-scrim-band)) 26%,
      rgb(255 255 255 / var(--hero-scrim-band)) 100%);
  }
  .hero__copy{
    grid-row:2;
    align-self:center;
    justify-self:center;
    position:relative; z-index:1;
    inline-size:min(100% - var(--gutter)*2,56ch);
    text-align:center;
    padding-block-end:var(--space-10);
    color:var(--hero-copy-ink);
  }
  .hero[data-ink="light"]{ --hero-copy-ink:#fff }
  .hero[data-ink="dark"] { --hero-copy-ink:#000 }
  .hero__sub{ font-size:var(--step-1); max-inline-size:none }
  .hero__trust{ font-size:var(--step--1); letter-spacing:.06em; text-transform:uppercase;
                opacity:.92 }
  .hero[data-variant="image_split"],
  .hero[data-variant="type_centered"],
  .hero[data-variant="image_offset_grid"]{
    grid-template-rows:1fr; min-block-size:auto; padding-block:var(--section-y);
    --hero-copy-ink:var(--t-fg);
  }
  @media (prefers-reduced-motion:reduce){
    .hero__video{ display:none !important }
  }
}
```

`--hero-copy-ink` is deliberately pure `#fff` / `#000` and not a theme token: the scrim algebra in
§3.4 is derived for the extreme ink, and substituting a slightly-off-white would invalidate the
proof by a few percent for no visual gain.

### 5.4 Video attach

Inlined at the end of `<body>` in a `<script>` with no `src`. ~980 B minified; cheaper inline than
as a request.

```js
(() => {
  const v = document.querySelector('.hero__video');
  const img = document.querySelector('.hero__poster');
  if (!v || !img) return;

  // Gate 1 — user preference. Checked first, never overridden.
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  if (mq.matches) { v.remove(); return; }

  // Gate 2 — connection and device. ABSENCE OF navigator.connection IS "UNKNOWN", NOT "FAST":
  // the API does not exist in Safari or Firefox, so a permissive default would wave through
  // every iPhone on a train. Unknown ⇒ desktop only, and only above 768px.
  const c = navigator.connection;
  if (c) {
    if (c.saveData === true) { v.remove(); return; }
    if (c.effectiveType && !/^(4g|5g)$/.test(c.effectiveType)) { v.remove(); return; }
    if (typeof c.downlink === 'number' && c.downlink < 1.5) { v.remove(); return; }
  } else if (innerWidth < 768) { v.remove(); return; }
  if (typeof navigator.deviceMemory === 'number' && navigator.deviceMemory < 4) { v.remove(); return; }

  // Gate 3 — LCP must already be attributed to the POSTER.
  let lcpSeen = false;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.element === img) lcpSeen = true;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch { lcpSeen = true; }                    // Safari/Firefox: no LCP API

  const mount = () => {
    if (document.visibilityState !== 'visible') return;
    const portrait = innerWidth < 768, d = v.dataset;
    const add = (src, type) => { const s = document.createElement('source');
                                 s.src = src; s.type = type; v.appendChild(s); };
    add(portrait ? d.srcMobileAv1  : d.srcDesktopAv1,  'video/webm; codecs="av01.0.05M.08"');
    add(portrait ? d.srcMobileH264 : d.srcDesktopH264, 'video/mp4; codecs="avc1.640028"');
    v.load();
    v.play()
      .then(() => requestAnimationFrame(() => { v.dataset.ready = '1'; }))
      .catch(() => v.remove());                 // iOS Low Power, autoplay policy, decode failure
  };

  const start = () => {
    const go = () => (lcpSeen ? mount() : setTimeout(go, 250));
    'requestIdleCallback' in window ? requestIdleCallback(go, { timeout: 2500 }) : setTimeout(go, 800);
  };
  // Prerendered pages must not start media; Chrome throttles it there anyway.
  if (document.prerendering) {
    document.addEventListener('prerenderingchange', () => addEventListener('load', start, { once: true }), { once: true });
  } else {
    addEventListener('load', start, { once: true });
  }

  mq.addEventListener('change', (e) => { if (e.matches) { v.pause(); v.remove(); } });

  const io = new IntersectionObserver(([e]) => {
    if (!v.isConnected) return io.disconnect();
    e.isIntersecting ? v.play().catch(() => {}) : v.pause();
  });
  io.observe(v);
})();
```

The `navigator.connection` fallback is the one line that differs from the naive version and it is
the difference between a mobile budget that holds and one that does not: Safari and Firefox expose
no Network Information API, so "no API ⇒ poster only on phones" is the only honest default.

### 5.5 CLS to zero

| source | fix |
|---|---|
| hero height on mobile | `100svh`, never `dvh`, never bare `vh` |
| video mount | absolutely positioned into the poster's box; `opacity` only, no layout property animates |
| every image | `width` + `height` attributes; `aspect-ratio` on anything CSS-sized |
| font swap | metric-overridden fallback (§1.7), `size-adjust` from the real tables |
| sticky WhatsApp | `position: fixed`, present in the initial HTML, never JS-injected |
| cookie banner | `position: fixed`, out of flow |
| lazy sections | `content-visibility: auto` with a **publish-computed** `--sec-h` (§9.4), never a guessed constant |
| the hero itself | `content-visibility: visible` — deferring the LCP section would be self-defeating |

---

## 6. The 17 sections

### 6.1 Rules that hold for all of them

- **Element.** `<section class="section s-<type>" id="<sectionId>" data-tone="…"
  data-variant="…" style="--sec-h:<px>px" aria-labelledby="<sectionId>-h">`. The `aria-labelledby`
  promotes it to a named `region` landmark; the name is always the section's own headline, visible
  or `.vh`. A landmark without an accessible name is a WCAG 1.3.1 failure and the reason
  `deriveSectionSlots` gives *every* section a `headline` slot.
- **Heading levels.** Exactly one `<h1>` per page: the hero's headline on a page that has a hero,
  otherwise the first section's. Every other section headline is `<h2>`. Item titles are `<h3>`.
  Nothing skips a level; `axe-core`'s `heading-order` rule is in the PR gate.
- **Empty copy renders empty, never the slot id.** `textFor()` already falls back
  locale → default → `''`. A section whose headline resolves to `''` still emits the `<h2 class="vh">`
  with the business name as a fallback accessible name, because an unnamed region is worse than a
  generic one.
- **Tone.** Sections alternate `page` / `alt` by index unless the variant fixes the tone (marked
  below). The alternation is computed in `renderPage`, not chosen by the model.
- **`--sec-h`** is the `contain-intrinsic-size` estimate, computed at publish (§9.4).
- **Lists are lists.** Every repeated item group is `<ul role="list">` + `<li>` so AT announces
  "list, 6 items". `role="list"` is restated because the reset removes the marker, which removes
  list semantics in Safari.
- **Icons** are inline `<svg aria-hidden="true" focusable="false" width="24" height="24">` from the
  closed 12-entry `IconId` set. No icon font, no `<img>`, no model string in an `<svg>`.
- **Media** is always `<img loading="lazy" decoding="async" width height>` except the hero poster.
  `sizes` is emitted per layout, not `100vw` everywhere.
- **Prices** are copy slots (`SlotKind: 'price'`), so `€ 12,50` vs `12,50 €` is a transcreation
  decision, not a formatter's. site-kit never formats a currency.

### 6.2 Summary

| # | type | variants | tone | slot inventory (from `slots.ts`) | root element | CSS (br) |
|---|---|---|---|---|---|---|
| 1 | `hero` | `video_fullbleed` · `image_split` · `type_centered` · `image_offset_grid` | fixed `page` | `headline`, `subhead`, `trustline`?, `ctas.i.label` (0–2) | `<section>` + `<h1>` | 760 |
| 2 | `usp_trio` | `icons_row` · `numbered_cards` · `bordered_grid` | alternating | `headline`, `items.i.{title,body}` (2–6) | `<section><ul role=list>` | 300 |
| 3 | `about` | `text_image` · `image_text` · `wide_quote` · `timeline` | alternating | `headline`, `paragraphs.i.text` (1–6), `cta.label`? | `<section>` (+`<blockquote>` / `<ol>`) | 320 |
| 4 | `services_grid` | `cards_3col` · `list_split` · `image_tiles` · `accordion` | alternating | `headline`, `items.i.{title,body,price?}` (1–12) | `<section><ul role=list>` | 420 |
| 5 | `menu` | `two_column` · `cards` · `chalkboard` | alternating | `headline`, `groups.g.title` (1–8), `groups.g.items.i.{name,price,description?}` (1–24) | `<section>` + `<h3>`+`<dl>` per group | 380 |
| 6 | `gallery` | `masonry` · `carousel` · `grid_square` · `before_after` | alternating | `headline`, `media.i.caption`? (1–24) | `<section><ul role=list><figure>` | 470 |
| 7 | `reviews` | `cards_3col` · `single_large` · `marquee` · `google_badge` | alternating | `headline` only — bodies come from the shard's `reviews` table | `<section><ul role=list><blockquote>` | 380 |
| 8 | `team` | `portraits_grid` · `list_compact` | alternating | `headline`, `items.i.{name,role,bio?}` (1–12) | `<section><ul role=list>` | 300 |
| 9 | `process_steps` | `numbered_horizontal` · `vertical_timeline` · `arrow_flow` | alternating | `headline`, `items.i.{title,body}` (2–6) | `<section><ol>` | 340 |
| 10 | `stats_band` | `plain` · `boxed` · `accent_bg` | `accent_bg` → `accent` | `headline`, `items.i.{value,label}` (2–6) | `<section><dl>` | 260 |
| 11 | `faq` | `accordion` · `two_column` | alternating | `headline`, `items.i.{question,answer}` (1–12) | `<section>` + `<details><summary>` | 240 |
| 12 | `booking` | `inline_calendar` · `cta_to_provider` | alternating | `headline`, `body`, `ctaLabel` | `<section>` | 260 |
| 13 | `contact_form` | `split_map` · `stacked` · `boxed_accent` | `page`/`alt`/`surface` only | `headline`, `body`, `submitLabel`, `fields.i.label` (1–7) | `<section><form>` | 470 |
| 14 | `map_hours` | `map_left` · `map_right` · `hours_only` | alternating | `headline`, `body`, `routeCtaLabel`? | `<section>` + `<table>` of hours | 300 |
| 15 | `cta_band` | `accent_full` · `image_overlay` · `minimal_rule` | `accent_full` → `accent` | `headline`, `body`, `ctas.i.label` (0–2) | `<section>` | 300 |
| 16 | `blog_teaser` | `cards_2col` · `list` | alternating | `headline`, `linkLabel` | `<section><ul role=list><article>` | 260 |
| 17 | `rich_text` | `prose_narrow` · `prose_wide` | fixed `page` | `headline`, `paragraphs.i.text` (1–24) | `<section>` | 200 |

### 6.3 Per-section contracts

**1 · `hero`** — §5. A11y: owns the page's single `<h1>`; the poster is `alt=""`; the video is
`aria-hidden` + `tabindex="-1"`; CTAs are `<a class="btn">` with the slot label as their entire
accessible name (never an icon-only CTA). `showTrustline` adds one `<p class="hero__trust">`, not a
heading.

**2 · `usp_trio`** — 2–6 differentiators.

```html
<section class="section s-usp" id="s2" data-tone="alt" data-variant="icons_row"
         aria-labelledby="s2-h" style="--sec-h:420px">
  <div class="wrap">
    <h2 id="s2-h" class="vh">Waarom Bakkerij Jansen</h2>
    <ul role="list" class="grid-auto" style="--col:16rem">
      <li class="s-usp__item stack">
        <svg aria-hidden="true" focusable="false" width="28" height="28" viewBox="0 0 24 24">…</svg>
        <h3>Elke ochtend vers</h3>
        <p>Om 06:00 uit de oven, nooit van gisteren.</p>
      </li>
    </ul>
  </div>
</section>
```

A11y: the heading is `.vh` in `icons_row` (the design shows no title) and visible in the other two —
the *markup* is identical, only a class differs, so the accessible name never depends on the
variant. `numbered_cards` renders the index as a `::before` counter, never as text content, so
screen readers do not read "1" before every title.

**3 · `about`** — `paragraphs[i].emphasis` is `normal | lead`; `lead` adds `.lead` (one step up,
`--t-fg-muted`). `wide_quote` wraps paragraph 0 in `<blockquote>` with no `<cite>` (there is no
attribution slot — inventing one would be fabricated provenance). `timeline` renders `<ol>` with
`<li>`; the ordinal is CSS-generated. Media honours `MediaRef.focalPoint` via `object-position`.

**4 · `services_grid`** — `items[i].target` is a `LinkRef`; when non-null the whole card is
**not** a link (nested interactive content), the `<h3>` contains the `<a>` and the card gets
`.s-svc__item:has(a:hover)` styling plus a `::after` overlay for the hit area. `showPrice` emits
`<p class="s-svc__price">` and the price must also appear in JSON-LD `offers` if one is emitted
(§8) — visible and structured prices may never disagree.
`accordion` uses `<details><summary>`; `summary` contains the `<h3>`, not the reverse.

**5 · `menu`** — nested groups are containment, not recursion. Each group is
`<h3>` + `<dl class="s-menu__list">`, item name in `<dt>`, price in `<dd class="s-menu__price">`,
description in `<dd class="s-menu__desc">`. Tags render as
`<ul role="list" class="cluster"><li><span class="chip">` using `--t-chip-bg` / `--t-chip-fg`, with a `.vh` prefix (`"Dieet: "`) so "vegan" is not announced bare.
The `<dl>` is the right element: a menu is a name→(price, description) association list, and a table
would imply a grid the design does not have.

**6 · `gallery`** — `<figure>` per item; caption in `<figcaption>` when `showCaptions`, otherwise no
`<figcaption>` and `alt` comes from `MediaAsset.altText` (written by the media pipeline, never the
model) falling back to `""`. `carousel` is a CSS scroll-snap strip with `tabindex="0"` on the
scroller, `role="group"` and `aria-label` — no JS, so no INP. `before_after` is two stacked images
with a CSS-only `input[type=range]` wipe; the range has a real `<label class="vh">`.
`masonry` uses `columns` (not grid masonry, which is not Baseline) with
`break-inside: avoid`. Lightbox is a native `<dialog>`, ~400 B of JS, opened by a real `<button>`.

**7 · `reviews`** — **the only section whose text is not model copy.** Bodies come from the shard's
`reviews` table. `source` gates markup, not layout: `lint.ts` already errors when
`source !== 'manual'` and `facts.reviewsSource !== 'verified_platform'`. The renderer's own rule is
the mirror: **`aggregateRating`/`review` JSON-LD is emitted only for `verified_platform`** (§8), and
a `manual` section renders `<blockquote>` + `<footer>` with the Omnibus disclosure line
(`"Deze beoordelingen zijn door de ondernemer verzameld en niet geverifieerd."`) as a real
`<p class="u-fine">`, not a tooltip. `marquee` scrolls with a CSS animation that is disabled under
`prefers-reduced-motion` and duplicated content is `aria-hidden`.

**8 · `team`** — `<li>` per person: `<img>` portrait (or an initials avatar built from the name slot
when `media` is null), `<h3>` name, `<p class="s-team__role">` role, `<p>` bio when `showBio`. No
`<address>`, no email links — a generated staff page with harvestable addresses is a spam magnet.

**9 · `process_steps`** — `<ol>`; the number is `counter(step)` in `::before` so it is decorative;
the accessible order comes from the list. `iconId` is nullable and, when present, sits beside the
counter. `arrow_flow`'s arrows are `::after` glyphs, `aria-hidden` by virtue of being generated
content.

**10 · `stats_band`** — `<dl>` with `<div>` wrappers: `<dt>` is the **label**, `<dd>` is the
**value**, and CSS reverses the visual order (`flex-direction: column-reverse`), because a
description list means "term → description" and "12" is not a term. `stat_value` is a copy slot, so
`"12 jaar"` / `"12 Jahre"` localises. `accent_bg` sets `data-tone="accent"`.

**11 · `faq`** — `<details>` per item, `<summary>` contains an `<h3>`, `open` when
`expandedByDefault`. Zero JS, zero INP contribution, and `<details>` content is findable by
in-page search in Chrome. `emitFaqSchema` feeds §8 and is only honoured when the section has items —
`lint.ts` already errors otherwise.

**12 · `booking`** — `cta_to_provider` renders one `<a class="btn btn--primary">` to
`providerLink` (an `external` `LinkRef` resolved through the allowlist, so `rel="noopener"` and any
stored `rel`). `inline_calendar` renders our own first-party form; no third-party widget, ever
(zero third-party origins is a CSP-enforced invariant, not a preference).

**13 · `contact_form`** — `<form method="post" action="/api/leads" novalidate>`. Every field is a
real `<label for>` + control; `CONTACT_FIELD_NAMES` maps to `autocomplete` tokens
(`name→name`, `email→email`, `phone→tel`, `date→bday`-style `off`, `message→off`,
`consent→off`) for SC 1.3.5. `required` mirrors the schema flag. The consent field is a checkbox
whose label is the full consent sentence and is **never** pre-checked — `lint.ts` errors if it is
absent. Errors are `aria-describedby` text in `--t-danger`, plus a `--t-danger` inline-start border;
there is no filled danger surface anywhere in the system, which is why the token set has
`--color-danger` and no `--color-fg-on-danger`. Turnstile is injected on first `focusin` inside the
form, so it never touches initial load or LCP. `split_map` embeds the same static map image as
`map_hours` — never a Google Maps iframe.

**14 · `map_hours`** — hours render from `core/hours.ts`'s `formatHoursForLocale`, in a
`<table>` with `<caption class="vh">`, `<th scope="row">` for the day label and `<td>` with `<time>`
elements. The visible hours and the `openingHoursSpecification` in §8 come from the same
`OpeningHours` value, because Google cross-checks them. The map is a **static image** rendered to R2
at publish (`<img loading="lazy" width height alt="">`) wrapped in
`<a href="https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>">`, which opens the native
maps app on mobile. `showRouteCta` adds a `.btn` with the `routeCtaLabel` slot.
`hours_only` is the variant for service-area businesses with no address — `lint.ts` errors if a map
variant is used without one.

**15 · `cta_band`** — `accent_full` sets `data-tone="accent"`, so its buttons become inverted
(paper fill, accent ink) with no new tokens (§2). `image_overlay` places copy on a solid plate at
the §3.4 alpha, not a gradient. `minimal_rule` is a hairline `border-block` and no fill.

**16 · `blog_teaser`** — `<article>` per post with `<h3><a>` title, `<time datetime>` published
date, and the excerpt when `showExcerpts`. Dates are formatted by our own table-driven formatter,
never `Intl` (§9.3). `linkLabel` is the "all posts" link. `lint.ts` errors when the site has no
posts.

**17 · `rich_text`** — legal and editorial pages. `ProseStyle` maps `paragraph→<p>`, `lead→<p
class="lead">`, `note→<p class="u-fine">`. `prose_narrow` is `.wrap--narrow` (46 rem);
`prose_wide` is the default wrap. Still plain-text slots: there is no markdown parser in this
package and there never will be.

### 6.4 Chrome

**Header.** `<header>` → `banner` landmark, `<nav aria-label="Hoofdmenu">`, skip link first in the
DOM. Three `navStyle` values differ only in grid placement. Mobile uses a native `<dialog>` +
`showModal()` (≈180 B) or, for `minimal_burger`, a pure-CSS `:has()` checkbox pattern with a real
`<button aria-expanded>` — whichever the variant's markup already needs. `position: sticky` with
`scroll-padding-block-start` set in the reset so anchor targets are not hidden behind it.

**Footer.** `<footer>` → `contentinfo`. Carries the EU-mandated identity block —
`companyRegistrationId` (KvK/Handelsregister) and `vatId` from `facts` — the privacy/cookie/terms
links, the locale switcher (plain `<a>` links, one per enabled locale, `hreflang` and `lang` set),
and the "made with" line as **plain text or `rel="nofollow sponsored"`** (non-negotiable §28: a
sitewide followed backlink to the apex is the fastest route to a manual action).

---

## 7. The sticky WhatsApp widget

Zero JavaScript, site colours, opens the app directly on mobile, and cannot contribute to INP or CLS
because it is a native anchor that is present in the initial HTML.

```html
<a class="wa" data-no-prerender
   href="https://wa.me/31612345678?text=Hallo%20Bakkerij%20Jansen%2C%20ik%20heb%20een%20vraag"
   target="_blank" rel="noopener"
   aria-label="Stuur een WhatsApp-bericht naar Bakkerij Jansen">
  <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">
    <path fill="currentColor" d="M17.47 14.38c-.3-.15-1.75-.86-2.02-.96…"/>
  </svg>
  <span class="wa__label">WhatsApp</span>
</a>
```

```css
@layer chrome{
  .wa{
    position:fixed;
    inset-block-end:calc(var(--wa-lift,0px) + max(var(--space-4), env(safe-area-inset-bottom)));
    inset-inline-end:var(--space-4);
    z-index:60;
    display:inline-flex; align-items:center; gap:var(--space-2);
    min-block-size:48px; min-inline-size:48px;
    padding-block:var(--space-3); padding-inline:var(--space-4);
    border-radius:var(--radius-pill);
    background:var(--color-accent);
    color:var(--color-fg-on-accent);
    border:var(--hairline) solid var(--color-accent-edge);
    box-shadow:var(--shadow-1);
    text-decoration:none; font-weight:600; line-height:1;
    contain:layout paint;                 /* never repaints the page during scroll */
    transition:transform var(--dur) var(--ease);
  }
  .wa:hover{ background:var(--color-accent-hover) }
  .wa:active{ transform:translateY(1px) }
  @media (max-width:40em){ .wa__label{ display:none } }   /* icon-only on phones */
  @media print{ .wa{ display:none !important } }
}
```

Every decision here is a constraint, not taste:

- **`https://wa.me/<E.164 without +>`** is the official universal link: on Android and iOS it opens
  the installed app, on desktop it lands on WhatsApp Web. **Never `whatsapp://send`**, which fails
  hard on desktop and inside in-app browsers. The number comes from `facts.whatsappE164`, a
  `CHECK`-constrained column, and the `text=` prefill is built by code from the business name — no
  model string reaches the URL (invariant 2). `chrome.whatsappEnabled` with a null number is already
  a `lint.ts` error.
- **Site colours, not WhatsApp green.** `--color-accent` / `--color-fg-on-accent` /
  `--color-accent-edge` are read directly (this is chrome, not a toned section, so it reads palette
  tokens by design and the CSS lint allowlists this one fragment). The pair is proven ≥ 4.5:1 and the
  edge gives the pill a 3:1 boundary against any ground it floats over — including the hero video,
  which is why the edge matters more here than anywhere else.
- **Inline SVG with `currentColor`** — zero extra request, zero FOIT, and it inherits the theme.
- **48 px minimum in both axes**, icon-only below 40 em so it does not cover content on a 320 px
  screen.
- **No INP contribution at all.** A native anchor activation is not measured as an interaction with
  processing time. There is no listener on this element anywhere in the package.
- **No CLS.** `position: fixed` is out of flow, and the element is in the initial HTML — never
  injected — so it neither shifts anything nor is shifted.
- **`data-no-prerender`** keeps it out of the Speculation Rules prerender set (it is cross-origin
  and not prerenderable).

**Not overlapping the footer CTA or the cookie banner.** Three mechanisms, in order:

1. `--wa-lift` defaults to `0px`. The cookie banner — when it exists at all, which by default it
   does not (non-negotiable §25) — sets `--wa-lift: var(--banner-h)` on `:root` from the same ~300 B
   inline bootstrap that decides whether to show the banner. That is a style change on a
   `position: fixed` element: no layout, no CLS. The banner is `z-index: 70`, the widget `60`, so
   even mid-transition the banner wins.
2. The footer reserves the widget's footprint with
   `.site-footer{ padding-block-end: calc(var(--space-10) + 48px) }` on viewports below 40 em, so
   the pill never covers a footer link even at the very bottom of the scroll.
3. `cta_band` when it is the **last** section before the footer sets
   `padding-block-end: calc(var(--section-y) + 48px)` below 40 em, for the same reason. Assertion 2
   of §3.6 (tap targets and clear space) catches a regression here, because an occluded target
   fails the clear-space check.

---

## 8. JSON-LD — the `@graph` builder

Invariant 4: the model never authors JSON-LD. It supplies typed enum inputs (`JsonLdInputsGen`);
code builds the graph from D1 facts and serialises it through **one** function.

### 8.1 Serialisation

```ts
// packages/site-kit/src/seo/jsonld.ts
/**
 * The ONLY way a graph becomes markup.
 *
 * `<` is escaped as a JSON unicode escape, which is legal JSON and identical after parse, so no
 * string anywhere in the graph — a business name, a cuisine, a review body — can close the
 * <script> element it sits in. U+2028/U+2029 are escaped because they are literal line
 * terminators in JavaScript source but legal inside a JSON string, and a script parser sees
 * the element's raw text, not the JSON.
 */
export function ldScript(graph: readonly GraphNode[]): string {
  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph })
    .replace(/</gu, '\\u003c')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');
  return `<script type="application/ld+json">${json}</script>`;
}
```

There is no template literal in the builder, no string concatenation of user text, and
`escapeHtml()` is deliberately **not** used — HTML-escaping inside a `application/ld+json` block
would corrupt the JSON. The `<` substitution is the correct and sufficient escape, and it is
the only one.

### 8.2 `@type` resolution — facts beat model output

```ts
export function businessType(industryKey: string, modelChoice: SchemaOrgType): string | string[] {
  const industry = industryByKey(industryKey);        // D1 fact, from core/industries.ts
  const t = industry.schemaOrgType;
  if (!LOCALBUSINESS_SUBTYPES.has(t)) {
    throw new JsonLdError(`schema_org_type "${t}" for industry "${industryKey}" is not a LocalBusiness subtype`);
  }
  // The model's pick is a QA signal, never the source of truth: a wrong @type silently
  // disables every rich result, and the industry row is a server fact.
  if (modelChoice !== t) recordQaNote('jsonld.schemaOrgType.divergence', { industryKey, t, modelChoice });
  return t === 'LocalBusiness' ? 'LocalBusiness' : ['LocalBusiness', t];
}
```

`LOCALBUSINESS_SUBTYPES` is `seo/allowlist.ts` — generated from the schema.org JSON-LD context and
committed, so the check is a lookup and not a network call.

**`additionalType` is the honest alternative to inventing a `@type`.** `migrations/cp/0002_taxonomy.sql`
now has the column (`additional_type TEXT CHECK (… GLOB 'https://*')`) and `core/industries.ts` has
the value. A butcher is a `Store`; the meaning `Store` drops is carried by
`https://www.wikidata.org/wiki/Q329737`. A DJ is a `ProfessionalService` with
`https://www.wikidata.org/wiki/Q130857`. Neither invents `ButcherShop` or `DJService`, and 15 of
the 104 industries currently carry one.

### 8.3 Complete output — a butcher's home page

Industry `butcher` → `schemaOrgType: 'Store'`, `additionalType:
'https://www.wikidata.org/wiki/Q329737'`, `dnaId: 'warm_trattoria'`. Storefront, three locales
enabled, `reviewsSource: 'manual'` (so **no** `aggregateRating` and **no** `review` — §3.6 of
`dim-seo`, non-negotiable §13).

```html
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
{
  "@type": "WebSite",
  "@id": "https://slagerij-de-vries.mijnsaas.com/#website",
  "url": "https://slagerij-de-vries.mijnsaas.com/",
  "name": "Slagerij De Vries",
  "publisher": { "@id": "https://slagerij-de-vries.mijnsaas.com/#business" },
  "inLanguage": ["nl", "en", "de"]
},
{
  "@type": ["LocalBusiness", "Store"],
  "@id": "https://slagerij-de-vries.mijnsaas.com/#business",
  "additionalType": "https://www.wikidata.org/wiki/Q329737",
  "name": "Slagerij De Vries",
  "legalName": "Slagerij De Vries B.V.",
  "url": "https://slagerij-de-vries.mijnsaas.com/nl/",
  "description": "Ambachtelijke slagerij in Utrecht-Oost. Vlees van boeren uit de regio, dagelijks vers gesneden.",
  "image": [
    "https://slagerij-de-vries.mijnsaas.com/_a/gevel-1x1.3f9a1c.avif",
    "https://slagerij-de-vries.mijnsaas.com/_a/gevel-4x3.3f9a1c.avif",
    "https://slagerij-de-vries.mijnsaas.com/_a/gevel-16x9.3f9a1c.avif"
  ],
  "logo": {
    "@type": "ImageObject",
    "@id": "https://slagerij-de-vries.mijnsaas.com/#logo",
    "url": "https://slagerij-de-vries.mijnsaas.com/_a/logo.8b21e0.png",
    "width": 512, "height": 512,
    "caption": "Slagerij De Vries"
  },
  "telephone": "+31302345678",
  "email": "info@slagerijdevries.nl",
  "vatID": "NL812345678B01",
  "identifier": { "@type": "PropertyValue", "propertyID": "KVK", "value": "30123456" },
  "address": {
    "@type": "PostalAddress",
    "streetAddress": "Biltstraat 44",
    "addressLocality": "Utrecht",
    "postalCode": "3572 BC",
    "addressCountry": "NL"
  },
  "geo": { "@type": "GeoCoordinates", "latitude": 52.0977, "longitude": 5.1284 },
  "hasMap": "https://www.google.com/maps/place/?q=place_id:ChIJdXXXXXXXXXXXXXX",
  "sameAs": ["https://www.google.com/maps/place/?q=place_id:ChIJdXXXXXXXXXXXXXX"],
  "priceRange": "€€",
  "currenciesAccepted": "EUR",
  "paymentAccepted": "Cash, Debit Card, iDEAL, Credit Card",
  "openingHoursSpecification": [
    { "@type": "OpeningHoursSpecification",
      "dayOfWeek": ["Tuesday","Wednesday","Thursday"], "opens": "08:30", "closes": "18:00" },
    { "@type": "OpeningHoursSpecification",
      "dayOfWeek": ["Friday"], "opens": "08:30", "closes": "20:00" },
    { "@type": "OpeningHoursSpecification",
      "dayOfWeek": ["Saturday"], "opens": "08:00", "closes": "16:00" },
    { "@type": "OpeningHoursSpecification",
      "dayOfWeek": ["Sunday","Monday"], "opens": "00:00", "closes": "00:00" }
  ],
  "specialOpeningHoursSpecification": [
    { "@type": "OpeningHoursSpecification",
      "opens": "00:00", "closes": "00:00",
      "validFrom": "2026-12-25", "validThrough": "2026-12-26" }
  ],
  "areaServed": [{ "@type": "City", "name": "Utrecht" }],
  "knowsLanguage": ["nl", "en", "de"],
  "amenityFeature": [
    { "@type": "LocationFeatureSpecification", "name": "wheelchairAccessible", "value": true },
    { "@type": "LocationFeatureSpecification", "name": "parking", "value": true }
  ]
},
{
  "@type": "WebPage",
  "@id": "https://slagerij-de-vries.mijnsaas.com/nl/#webpage",
  "url": "https://slagerij-de-vries.mijnsaas.com/nl/",
  "name": "Slagerij De Vries — ambachtelijk vlees in Utrecht-Oost",
  "description": "Vlees van boeren uit de regio, dagelijks vers gesneden. Biltstraat 44, Utrecht. Open di t/m za.",
  "isPartOf": { "@id": "https://slagerij-de-vries.mijnsaas.com/#website" },
  "about":    { "@id": "https://slagerij-de-vries.mijnsaas.com/#business" },
  "inLanguage": "nl",
  "datePublished": "2026-05-14T09:00:00+02:00",
  "dateModified":  "2026-09-02T11:41:07+02:00",
  "primaryImageOfPage": {
    "@type": "ImageObject",
    "url": "https://slagerij-de-vries.mijnsaas.com/_a/hero-l-2400.3f9a1c.avif",
    "width": 2400, "height": 1350
  },
  "breadcrumb": { "@id": "https://slagerij-de-vries.mijnsaas.com/nl/#breadcrumb" }
},
{
  "@type": "BreadcrumbList",
  "@id": "https://slagerij-de-vries.mijnsaas.com/nl/#breadcrumb",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "Home",
      "item": "https://slagerij-de-vries.mijnsaas.com/nl/" }
  ]
}
]}</script>
```

Everything above that could carry a model string is either a closed enum (`priceRange` from
`PRICE_RANGES`, `paymentAccepted` from `PAYMENT_METHODS`, `amenityFeature` from `AMENITIES`) or a D1
fact (`name`, `legalName`, `telephone`, `address`, `vatID`, the KvK `identifier`). The only free
text in a graph anywhere is `description` (the page's own meta description) and `servesCuisine` on a
restaurant — both are emitted as JSON string *values* and never interpolated into markup, and both
go through `ldScript`'s `<` escape like everything else.

### 8.4 The rules the builder encodes

| rule | implementation |
|---|---|
| `@id` scoping | business and website `@id`s carry **no locale** — one real business, one entity. `WebPage`/`BreadcrumbList` `@id`s are the canonical URL + fragment, per locale. |
| `geo` | emitted only when `facts.address.geoSource ∈ {'geocoded','user_pin'}`. A guessed city centre that contradicts the postal address is worse than nothing. |
| `areaServed` | from `facts.serviceArea`: a `City` node for a storefront; a `GeoCircle` with `geoRadius` in **metres as a string** for a service-area business. `SERVICE_AREA_RADII` (`5\|10\|25\|50` km) × 1000. |
| service-area businesses | still emit `address` with at least `addressLocality` + `addressCountry` — Google requires an address for local rich results — and omit `geo` unless a real pin exists. |
| `openingHoursSpecification` | **`core/hours.ts`'s `toOpeningHoursSpecification()` verbatim.** It already handles split shifts (two specs), closed days (`00:00`→`00:00`), 24 h (`00:00`→`23:59`), midnight crossing (`closes < opens`), day collapsing and seasons. `specialOpeningHoursSpecification` carries holidays — never `openingHours`. `byAppointmentOnly` has no schema.org vocabulary and produces no markup. |
| visible ≡ structured | the hours table (§6.3 · 14) and this node consume the same `OpeningHours` value; likewise prices in `services_grid` and any `offers`. Google cross-checks both. |
| `aggregateRating` / `review` | **absent unless `facts.reviewsSource === 'verified_platform'`.** Rich-result-ineligible since 2019; UCPD Annex I 23b/23c makes unverified consumer-review claims a per-se unfair practice (NL Art. 6:193g BW, DE §5b UWG) with penalties to 4 % of turnover; copying GBP reviews breaches Maps Platform terms. `lint.ts` blocks the document; the builder is the second gate. |
| `FAQPage` | emitted **only** when a `faq` section with `emitFaqSchema` and ≥ 1 item is actually on that page. Never on a page that also emits `BlogPosting` unless the FAQ is a real section of it. Google restricted FAQ rich results to government/health sites in 2023; we emit it as a clean signal for AI Overviews and Bing, not as a rich-result play, and we never create an FAQ section *for* the markup. |
| `Service` | one node per `services_grid` item on the services page, referenced from `LocalBusiness.makesOffer`. `offers` is omitted entirely when there is no price — never `"price": "0"`. |
| `BlogPosting` | `author` and `publisher` are both `{ "@id": "…#business" }`. **Never a fabricated `Person`** — that is exactly what the scaled-content-abuse policy targets. `dateModified` equals `content_changed_at`, not the deploy time. `headline` ≤ 110 characters. |
| `sameAs` | the normalised GBP URL (resolved from `g.page`/`maps.app.goo.gl` shorteners once at onboarding) plus socials. Never a shortener, never the tenant's own URL, never `mijnsaas.com`. |
| `paymentAccepted` / `amenityFeature` | built from the closed `PAYMENT_METHODS` / `AMENITIES` enums through a fixed label map, emitted in **enum order, not model order**, so the bytes are stable (§9). |
| storage | the built graph is written to `page_translations.jsonld` at publish (16 KB cap, `json_valid()`), so the render path does zero assembly. |

**CI gate** (`site-kit/src/__tests__/jsonld.test.ts`): for each of the 104 industry fixtures build the
home graph and assert — every `@type` is in the allowlist; every `@id` referenced by another node
exists as a node in the same graph; every URL is absolute, `https:`, and on the canonical host;
`aggregateRating` is absent unless the gate passed; every date is ISO 8601 with an offset;
`additionalType` (when present) is the exact string from the industry row; the serialised string
contains no literal `<`; and the whole thing round-trips through a JSON-LD 1.1 expansion without
warnings.

---

## 9. The render contract

```ts
// packages/site-kit/src/render.ts
export interface RenderResult {
  readonly html: string;
  /** Lowercase hex SHA-256 of the CANONICAL SEMANTIC PROJECTION, not of `html`. See §9.2. */
  readonly renderSha256: string;
}

export async function renderPage(
  doc: SiteDoc,
  locale: Locale,
  pageId: string,
  ctx: RenderContext,     // origin, assetBase, indexState, publishedAt — server facts, not doc data
): Promise<RenderResult>;
```

`renderPage` is pure with respect to `(doc, locale, pageId, ctx)`: no `Date.now()`, no
`Math.random()`, no `crypto.randomUUID()`, no environment reads. `async` only because
`renderSha256` uses `crypto.subtle.digest`.

### 9.1 `<head>`, in order

The preload scanner reads top-down and starts fetches before the parser reaches them, so this order
is the specification, not a style:

```html
<!doctype html>
<html lang="nl" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">

<!-- 1. LCP candidates. Art-directed, so exactly one image is fetched. -->
<link rel="preload" as="image" fetchpriority="high" media="(max-width:767px)"
      href="/_a/hero-p-1170.3f9a1c.avif" type="image/avif">
<link rel="preload" as="image" fetchpriority="high" media="(min-width:768px)"
      href="/_a/hero-l-1920.3f9a1c.avif" type="image/avif">
<link rel="preload" as="font" type="font/woff2"
      href="/_a/playfair-latin.9a13c4.woff2" crossorigin>

<!-- 2. ALL CSS, inline, one element. Nothing render-blocking follows. -->
<style>/* §4.6 bundle */</style>

<!-- 3. Consent bootstrap, ~300 B, blocking on purpose: it must run before paint so a
        consented visitor never sees the banner flash. Omitted entirely when
        uses_non_essential is false, which is the default. -->
<script>…</script>

<!-- 4. Metadata. No fetches, so order below the CSS is free. -->
<title>Ambachtelijk vlees in Utrecht-Oost — Slagerij De Vries</title>
<meta name="description" content="…">
<link rel="canonical" href="https://slagerij-de-vries.mijnsaas.com/nl/">
<link rel="alternate" hreflang="nl" href="https://slagerij-de-vries.mijnsaas.com/nl/">
<link rel="alternate" hreflang="en" href="https://slagerij-de-vries.mijnsaas.com/en/">
<link rel="alternate" hreflang="de" href="https://slagerij-de-vries.mijnsaas.com/de/">
<link rel="alternate" hreflang="x-default" href="https://slagerij-de-vries.mijnsaas.com/">
<meta name="robots" content="noindex, nofollow">   <!-- only when indexState !== 'index' -->
<link rel="icon" href="/_a/icon-32.8b21e0.png" sizes="32x32">
<link rel="icon" href="/_a/icon.8b21e0.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/_a/icon-180.8b21e0.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#fcf5e9">        <!-- = --color-bg, converted to hex -->
<meta property="og:type" content="website">
<meta property="og:title" content="…">
<meta property="og:description" content="…">
<meta property="og:url" content="https://slagerij-de-vries.mijnsaas.com/nl/">
<meta property="og:locale" content="nl_NL">
<meta property="og:image" content="https://slagerij-de-vries.mijnsaas.com/_a/og-1200x630.3f9a1c.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">

<!-- 5. JSON-LD last: it is the largest text node in the head and blocks nothing. -->
<script type="application/ld+json">…</script>
</head>
```

`viewport-fit=cover` is required for `env(safe-area-inset-*)` on notched iPhones. There is no
`maximum-scale` and no `user-scalable=no` — that is an automatic Lighthouse accessibility failure
and a WCAG 1.4.4 violation. The hreflang cluster is built by `seo/hreflang.ts` and **omits, never
substitutes**: a locale with no translation of this page is absent from the cluster, because one
non-reciprocal entry drops the whole cluster.

Body order: skip link → `<header>` → `<main id="main">` (sections in `page.sections` order) →
`<footer>` → WhatsApp anchor → the three inline scripts → speculation rules.

### 9.2 `render_sha256`

It drives `lastmod`, and a sitemap that always says "now" gets ignored. Non-negotiable §8: it must
**not** move on a deploy, a template change, a footer year rollover, or a republish with identical
content. That rules out hashing the HTML — the HTML contains asset hashes, the CSS bundle and the
markup of whatever the template happens to be this week.

```ts
// packages/site-kit/src/project.ts
export interface PageProjection { /* … */ }

export function projectPage(doc: SiteDoc, locale: Locale, pageId: string): PageProjection;

export async function renderSha256(p: PageProjection): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(p));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
```

`stableStringify` sorts object keys, emits no whitespace, and rejects `undefined`, `NaN` and
non-finite numbers by throwing — a projection that cannot be canonicalised is a bug, not a fallback.

**What is IN the projection** (it changed ⇒ the page changed ⇒ `lastmod` moves):

- `v: 1` — a projection-format version, so a deliberate change to what counts as "content" is a
  one-time, explained `lastmod` move across the estate rather than an unexplained one.
- `locale`, `pageKey`, `path`, `role`, `noindex`.
- `title`, `description`.
- For each section in order: `type`, `variant`, every structural boolean and enum
  (`showTrustline`, `showPrice`, `showCaptions`, `showBio`, `showDescription`, `emitFaqSchema`,
  `expandedByDefault`, `showRouteCta`, `showExcerpts`, `source`, `provider`, field names and
  `required` flags, `MenuItemTag`s, `iconId`s, `emphasis`, `style`).
- For each section, its slots as an **ordered array of `[slotId, text]`** taken from
  `deriveSectionSlots` — never `Object.entries(copy)`, whose order is a JS-engine detail and whose
  contents include slots for other pages.
- Media identity as the asset **content hash** (already the leading component of `r2Key`), plus
  `focalPoint` and `altText`. Re-uploading the same bytes does not move `lastmod`; cropping does.
- Link targets in resolved form: `page:<pageKey>`, `anchor:<sectionId>`, `tel`, `whatsapp`, `email`,
  `route`, `external:<href>`. `pageKey`, not `pageId`, because `pageId` is regenerated and `pageKey`
  is the stable identity.
- The subset of `facts` this page actually renders (name, address, phone, hours, registration ids).
- The JSON-LD graph **with `dateModified`, `datePublished` and every absolute URL's host removed**.
- The hreflang membership set (which locales have this page) — because adding a locale changes the
  page's head and is a real content change.

**What is OUT** (it changed ⇒ nothing about the content changed):

`theme` and every token (styling), `versionId`, `siteId`, the CSS bundle and its bytes, asset URL
prefixes and the origin, `publishedAt`, the renderer's own markup, the footer's year, the
`indexState`, the inline script contents, and `dateModified`/`datePublished` — **that last one is
circular**: `dateModified` derives from `content_changed_at`, which moves when `render_sha256`
moves, so including it would make the hash depend on itself and move `lastmod` on every publish.
Excluding it is the whole reason the projection exists and is the easiest thing in this document to
get wrong.

### 9.3 Byte-identical re-render

`render_sha256` handles `lastmod`. A second, separate property matters for the edge cache and the
`ETag` (`W/"<versionId>-<renderSha16>"`): **identical inputs must produce identical HTML bytes.**
Five rules, all enforceable:

1. **Never iterate a record.** `doc.copy`, `doc.media`, `doc.links` and `page.perLocale` are
   `z.record(...)`; their key order is an engine detail. The renderer iterates
   `deriveSlotInventory` output, `doc.locales.enabled` and `page.sections` — all arrays.
2. **Fixed attribute order** per component, written in the JSX, never assembled from an object.
3. **No `Intl`, anywhere in the render path.** `Intl.DateTimeFormat`/`NumberFormat`/`ListFormat`
   output depends on the ICU data bundled with the runtime, so a `workerd` upgrade would silently
   change a published page's bytes and every tenant's `ETag`. `core/hours.ts` is already
   table-driven; blog dates and any other date use the same table.
4. **Numbers are pre-formatted strings.** Token values are quantised to 4 decimals by
   `resolveTheme` (§3.2); `--sec-h` is an integer; nothing else numeric is interpolated.
5. **`COMPONENT_ORDER` is a fixed array** (§4.6), so the CSS bundle is a function of the *set* of
   used components, not their order of first appearance.

A test renders each of the four canonical fixtures 100 times and asserts every byte identical, and
renders them again after shuffling `Object.keys` order in the input (a proxy that reverses key
enumeration) to prove rule 1 empirically rather than by inspection.

### 9.4 `--sec-h`, and why it is computed rather than guessed

`content-visibility: auto` without a correct `contain-intrinsic-size` trades CLS-on-load for
CLS-on-scroll, which is worse because it is invisible in a lab run that does not scroll. The value
is computed at publish, not authored:

```
sec-h(section) = base[type][variant]
               + ceil(itemCount / colsAt(360px)) * rowH[type]
               + lineEstimate(slotTextLengths, measure, stepPx) * lineH
```

The coefficients come from the Tier-2 render matrix: each nightly run records the real rendered
height of every (type, variant, itemCount, locale, viewport) it drew and fits the table, which is
committed as `css/intrinsic-sizes.generated.ts`. Assertion 4 of §3.6 (CLS = 0 over a scripted scroll
to the bottom and back) is what keeps the fit honest. The hero never gets `content-visibility` at
all.

---

## 10. What this package needs from elsewhere

Listed for the orchestrator; none of it is edited by this task.

**`packages/site-schema/src/lint.ts` — extend `CONTRAST_PAIRS`.** The current five pairs are a
subset of what §3.3 proves. Adding these six makes the publish-time lint catch a resolver regression
that the CI matrix would only catch on the next commit: `--color-fg`/`--color-bg-alt` (7.0),
`--color-fg-muted`/`--color-surface` (4.5), `--color-accent-text`/`--color-bg` (4.5),
`--color-fg-on-accent-subtle`/`--color-accent-subtle` (4.5), `--color-accent-edge`/`--color-bg`
(3.0), `--color-focus`/`--color-bg` (3.0). The existing `--color-fg`/`--color-bg` pair should be
raised from 4.5 to 7.0: the worst reachable value is 14.33:1, so a document that lands under 7 has
a resolver defect, not a tight palette.

**`packages/site-schema/src/index.ts` — no new exports needed.** site-kit consumes
`SiteDoc`, `textFor`, `copyFor`, `mediaFor`, `externalLinkFor`, `deriveSectionSlots`,
`deriveSlotInventoryForPages`, `SLOT_MAX_LENGTH`, `CONTRAST_PAIRS`, `contrastRatio`, `parseColor`,
`SECTION_TYPES`, every `*_VARIANTS` array, `LIMITS`, and the `gen/common` enums — all already
exported.

**`packages/core/src/index.ts` — no new exports needed.** site-kit consumes `formatHoursForLocale`,
`toOpeningHoursSpecification`, `industryByKey`/`INDUSTRIES`, `localeDefinition`, `localePath`, and
the `media*Key` builders — all already exported. **site-kit must not import `core`** under the
boundary rules (`site-kit` depends only on `site-schema`), so the two hours functions and the
industry row are passed **in** through `RenderContext`, not imported. `RenderContext` therefore
carries `{ origin, assetBase, indexState, publishedAt, industry: IndustryFacts, hoursJsonLd,
hoursDisplay }`, and `apps/renderer` is the composition root that calls `core` and hands the result
over. This is the same shape as the `Env`-injection rule and it is what keeps site-kit renderable in
a plain Node test.

**`packages/core/src/industries.ts` — eight `dnaId` corrections** (§1.8): `florist`,
`pet_grooming`, `dog_training`, `pet_store`, `bed_breakfast` → `warm_trattoria`; `self_storage`,
`car_wash` → `garage_steel`; `driving_school` → `clinical_trust`.

**Two `SCHEMA_ORG_TYPES` lists exist and diverge.** `core/industries.ts` has 69 entries;
`site-schema/gen/site-structure.ts` has 39. The model picks from the 39 and the industry row carries
one of the 69, and §8.2 resolves the conflict in favour of the D1 fact. That is the right runtime
behaviour, but the divergence should be closed deliberately — either the model-facing enum grows to
match, or the model stops being asked for a `schemaOrgType` at all, which would be the cleaner
answer given that it is a server fact.

**Dependencies to add to `packages/site-kit/package.json`:**

| package | version | scope |
|---|---|---|
| `hono` | `^4.13.7` (match the API app) | `dependencies` — `hono/jsx` only, no server |
| `@aibuilder/site-schema` | `workspace:*` | `dependencies` |
| `lightningcss` | `^1.30.2` | `devDependencies` — build-time CSS minification only, never shipped |
| `fontkit` | `^2.0.4` | `devDependencies` — reads `hhea`/`OS/2` for the metric overrides |
| `vitest` | `^4` (root) | `devDependencies` — plain Node pool, **no** `@cloudflare/vitest-pool-workers`: this package touches no runtime primitive |
| `@playwright/test`, `axe-core` | latest | `devDependencies` of the render-matrix job only |

**CI additions to `.github/workflows/ci.yml`:** the contrast matrix (§3.2, ~1 s), the CSS budget
gate over the worst-case assembly (§4.6), the JSON-LD gate over 104 fixtures (§8.4), the byte-identity
test (§9.3), the generated-file freshness checks (CSS, font metrics, intrinsic sizes), the Tier-1
render matrix (§3.6, ~4 min) and the nightly Tier-2 job with Lighthouse.
