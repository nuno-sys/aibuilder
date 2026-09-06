# MAGIC POPUP — Onboarding Experience Specification v1.0

**Scope:** Phase 1 conversion surface. Written against the schema that already exists at `/home/user/aibuilder/migrations/` (0001–0009). Schema deltas required are in §9. Every number here is a decision, not a suggestion.

---

## 0. DECISIONS SUMMARY

| # | Decision | Rationale (short) |
|---|---|---|
| D1 | **Multi-step wizard, 6 input steps + 1 generation act**, full-screen `<dialog>` | Lowest perceived effort on mobile; enables per-step validation and commitment escalation |
| D2 | **Step 1 is one field only** (business name) with an inline "found you" lookup | Foot-in-the-door; the first keystroke is the conversion event |
| D3 | **The GBP shortcut is a *path*, not a field** — pasting a Google Maps link at step 1 skips steps 2–5 | Turns 90 s of typing into 12 s. Biggest single conversion lever |
| D4 | **Email is the last field of the last step**, framed as delivery ("where do we send the link?") not signup | `users.email` is NOT NULL so an account must exist pre-generation; asking at peak desire (after 5 sunk-cost steps) converts ~2× better than a signup gate |
| D5 | **No payment, no card, no password** anywhere in onboarding | Stripe trial-wall is Phase 2, triggered by *Regenerate*, per blueprint |
| D6 | **Generation is a 7-act theatre with live site preview**, driven by real SSE events | The wait is the "magic". Never a spinner |
| D7 | **Media is step 6 and explicitly skippable** with a beautiful default | Uploads are the #1 abandonment field on mobile |
| D8 | Draft persists to `localStorage` **and** D1 from step 1 keystroke 3 | Refresh, crash, and "I'll finish tonight" all recover |

**Time-to-first-magic targets**

| Metric | P50 | P90 | Hard ceiling |
|---|---|---|---|
| Modal open → first keystroke | 2.5 s | 6 s | — |
| Full manual path (6 steps) → "Build my website" pressed | **82 s** | 165 s | — |
| GBP-shortcut path → "Build my website" pressed | **34 s** | 70 s | — |
| Submit → first real pixel of *their* site on screen | **9 s** | 16 s | 25 s (else fall back to skeleton-with-copy) |
| Submit → site live at `<slug>.mijnsaas.com` | **52 s** | 88 s | 180 s (then email-and-release) |
| Modal open → completed generation (funnel target) | **≥ 46 %** | — | — |

---

## 1. FLOW

### 1.1 The decision: wizard, not long form, not chat

| Option | Verdict | Why |
|---|---|---|
| One long form | ✗ | 8 field groups ≈ 1,400 px on a 390 px-wide phone. Effort is *seen before it is felt* — the scroll bar is a bounce trigger. No natural place for per-field magic. |
| Conversational chat | ✗ | No progress affordance (users cannot see the end), typing is slower than tapping, LLM round-trips add 800–2000 ms per turn, and structured extraction failure modes are user-visible. Chat is a *demo* pattern, not a conversion pattern. |
| **Stepped wizard** | ✓ | Progressive disclosure caps visible effort at ~1 screen; each step is a micro-commitment (consistency principle); per-step validation prevents a demoralising error wall; every step can carry its own *magic moment*, which spreads delight across the funnel instead of hoarding it at the end. |

### 1.2 Conversion mechanics applied

- **Progressive disclosure** — never more than 3 interactive controls per step. Steps 1–3 show exactly one primary control.
- **Effort perception** — the progress rail shows 6 segments from the first frame, so the user knows the *whole* cost up front (uncertainty, not length, causes abandonment). After step 1, the rail label switches to a decaying time estimate ("nog ±40 sec"), which is *inverse* labour illusion: cheap to finish.
- **Commitment & consistency** — the cost of each step ascends: name (3 s) → industry (5 s) → address (8 s) → hours (12 s) → contact (10 s) → story + media (25 s). By the time we ask for media, the user has 5 sunk investments. Never front-load the expensive step.
- **Peak–end rule** — two engineered peaks: **P1** at step 1 (the "we found your business" card, ~4 s in — this is the hook) and **P2** at the reveal (`<slug>.mijnsaas.com` types itself onto the screen and the real site scrolls behind it). The *end* is the reveal, so the last thing remembered is success, not a form.
- **Goal-gradient** — the rail's fill uses a non-linear curve: step 1 completion paints **28 %**, not 16.7 %. Perceived proximity to the goal accelerates completion. Fill map: `[0, 28, 44, 58, 72, 86, 100]`.
- **Loss aversion on exit** — Escape/close on a dirty draft offers *"Bewaar & ga verder"*, never "Discard?" as the primary.

### 1.3 Step-by-step breakdown

**Entry.** The hero CTA (`Maak mijn website` / `Build my website`) opens the modal with **zero navigation**. The chunk is prefetched on `pointerenter`/`focus` of any CTA and on `requestIdleCallback` after LCP, so open is < 100 ms and Lighthouse stays 100 (modal JS is not in the critical path). URL becomes `/start` via `history.pushState` — shareable, back-button-safe.

---

**STEP 1 — Naam** (target 8 s) · rail 0 → 28 %

- Primary: `business_name` (single text field, XL type, autofocus on desktop only)
- Secondary, below a hairline divider: **"Heb je een Google-vermelding? Plak de link →"** (paste target for `gbp_url`)
- Live, right-aligned inside the field's footer: `jouwnaam.mijnsaas.com` slug preview with availability tick
- **Magic moment P1:** after 3 chars + 400 ms debounce we query `/api/v1/onboarding/lookup` (Places Text Search, biased to `request.cf.country` + `cf.city`). If ≥1 result with confidence ≥ 0.72 we render up to 3 **"Ben jij dit?"** cards (name · address · category · rating · photo thumb). Tapping one prefills industry, address, hours, phone, GBP URL and site photos, then **jumps straight to Step 5** with a green banner: *"We hebben 11 dingen voor je ingevuld. Klopt het?"*
- Continue is enabled the moment the field is valid; `Enter` advances.

**STEP 2 — Branche** (target 6 s) · rail 28 → 44 %

- Single combobox with search-as-you-type over the 94-leaf taxonomy (§3), icons at 24 px, results grouped by the 14 parents.
- Empty state = 8 most-picked leaves for `cf.country` as tappable chips (NL default: Kapsalon, Restaurant, Loodgieter, Fysiotherapeut, Café, Schoonheidssalon, Aannemer, Fotograaf).
- Under the field, a live one-line preview: *"Donker, energiek, met een grote video — zo bouwen we sites voor DJ's."* (reads `design_preset.tagline`). This is the second dopamine hit and it *teaches* that the output is industry-specific.

**STEP 3 — Adres** (target 10 s) · rail 44 → 58 %

- NL/BE: **postcode + huisnummer** two-field flow → full address resolves in one call. Everyone else: single autocomplete field.
- Toggle: *"Ik heb geen bezoekadres — ik kom naar de klant"* → swaps to `service_area` (city + radius slider 5/10/25/50 km). Changes JSON-LD from `address` to `areaServed` and suppresses the map block on the generated site.
- Static map thumbnail (Cloudflare-proxied, cached in KV 30 d) appears on resolve — visual confirmation beats a text echo.

**STEP 4 — Openingstijden** (target 12 s) · rail 58 → 72 %

- Four preset chips first: **Ma–vr 9–17** · **Ma–za 9–18** · **Di–zo 12–22** · **Op afspraak**. Chip-first means the median user never touches a time picker.
- Below: the 7-day grid, collapsed to a summary line unless a chip is edited.
- Skip link: *"Sla over — ik vul dit later in"* (hours are the #2 abandonment field).

**STEP 5 — Bereikbaarheid** (target 10 s) · rail 72 → 86 %

- `phone` (international input, country pre-selected from address country)
- `whatsapp` checkbox *"Dit nummer ook voor WhatsApp"*, default **on** — drives the sticky WhatsApp button which is a headline feature
- `gbp_url` shown here **only if not already captured**

**STEP 6 — Jouw verhaal** (target 25 s) · rail 86 → 100 %

- `short_description` textarea with **"Schrijf het voor mij"** — streams a 2-variant AI draft in ~1.8 s
- Media dropzone (§4) with prominent skip
- `email` — *"Waar sturen we de link naartoe?"* + a single consent checkbox
- Primary button: **"Bouw mijn website"** with a 3-line trust strip beneath: *Gratis · Geen creditcard · Klaar in ~1 minuut*

**ACT 7 — Generatie** (45–90 s) · §5

### 1.4 Progress affordance

Desktop: a 6-segment rail pinned under the slim header, 3 px tall, `--n-200` track, `--brand-600` fill, each segment labelled (`Naam · Branche · Adres · Uren · Contact · Verhaal`). Completed segments are buttons (backwards navigation only, `aria-current="step"` on the active one). Mobile: the same rail without labels, plus `Stap 3 van 6` as `--text-sm` above the question, and the time estimate right-aligned. Fill animates 320 ms `--ease-out-quint`; the numeric label changes at the *midpoint* of the transition so it never disagrees with the bar.

---

## 2. FIELDS

Shared conventions: all inputs `44 px` min height (`48 px` on touch), `--radius-md`, 1 px `--n-300` border, `2 px` `--brand-600` on focus + 3 px `--brand-100` halo. Validation runs on **blur** and on **submit**, never on keystroke — except for the *positive* signals (slug availability, phone formatting), which are live. Once a field has errored, it re-validates on input so the error clears the instant it is fixed.

---

### 2.1 Business name

| | |
|---|---|
| **NL label** | Hoe heet je bedrijf? |
| **EN label** | What's your business called? |
| **NL helper** | Precies zoals klanten je kennen — dit komt op elke pagina. |
| **EN helper** | Exactly as customers know you — this goes on every page. |
| **Type** | `<input type="text">`, 20 px type, 56 px tall |
| **Attrs** | `autocomplete="organization" autocapitalize="words" spellcheck="false" enterkeyhint="next" maxlength="120" inputmode="text"` |
| **Rules** | required · trim + collapse inner whitespace · 2–120 chars · must match `/\p{L}/u` · reject bare URL/email · strip zero-width + RTL-override chars |

| Error | NL | EN |
|---|---|---|
| empty | Vul de naam van je bedrijf in. | Please enter your business name. |
| too short | Dat lijkt wat kort — gebruik de volledige naam. | That looks short — use the full name. |
| no letters | Een bedrijfsnaam bevat minstens één letter. | A business name needs at least one letter. |
| looks like URL | Dat is een website. Wat is de **naam** van je bedrijf? | That's a website. What's your business **name**? |

**Shortcuts.** (a) Places-backed lookup → the "Ben jij dit?" cards (§1.3). (b) Live slug: lowercase → NFKD → strip diacritics → `[^a-z0-9]+`→`-` → collapse `--` → trim `-` → 63 char cap → check against `reserved_slugs` + `uq_sites_slug`; on collision append `-<city>` then `-2`. Rendered as `mijn-kapsalon`**.mijnsaas.com** with `--n-500` domain part and an animated tick. `aria-live="polite"`, announced only on debounce settle.

---

### 2.2 Industry

| | |
|---|---|
| **NL label** | In welke branche zit je? |
| **EN label** | What kind of business is it? |
| **NL helper** | Hiermee kiezen we je kleuren, lettertypes en pagina's. |
| **EN helper** | This decides your colours, fonts and pages. |
| **NL placeholder** | Zoek je branche… bijv. kapsalon |
| **EN placeholder** | Search your industry… e.g. hair salon |
| **Type** | ARIA 1.2 combobox: `<input role="combobox" aria-expanded aria-controls aria-activedescendant aria-autocomplete="list">` over a `role="listbox"` with `role="group"` parents |
| **Attrs** | `autocomplete="off" enterkeyhint="search" inputmode="search"` |
| **Rules** | required · must resolve to a real `industries.key`; free text alone never passes |

| Error | NL | EN |
|---|---|---|
| none chosen | Kies een branche uit de lijst. | Pick an industry from the list. |
| no match | Niks gevonden voor "{q}". Kies iets dat er dichtbij komt of tik **Anders**. | Nothing found for "{q}". Pick the closest match or choose **Other**. |

**Shortcuts.**
- Matching runs **client-side** over a 14 KB gzipped JSON (`key`, localized `label`, `search_terms`, `group`, `icon`) preloaded with the step-2 chunk. Zero network latency per keystroke.
- Scoring: exact label 100 · label prefix 90 · alias exact 85 · alias prefix 75 · word-boundary substring 60 · Damerau-Levenshtein ≤ 2 → 45. Ties broken by `sort_order`. Diacritic- and case-insensitive (`Intl.Collator(locale,{sensitivity:'base'})`).
- Aliases matter more than labels. `industry_translations.search_terms` (pipe-delimited) must carry the words people actually type: `hairdresser` → `kapper|kapsalon|haar|knippen|barbier|coiffeur|friseur|peluquería`; `general_contractor` → `aannemer|klusbedrijf|verbouwing|bouwbedrijf|renovatie`; `gp_practice` → `huisarts|dokter|praktijk|arts`.
- **Free-text fallback:** if the user types ≥ 4 chars with no match and presses Enter, we POST to `/api/v1/onboarding/classify-industry` → `claude-opus-5`, `output_config: { effort: "low" }`, `thinking: { type: "adaptive" }`, structured output via `output_config.format` + `zodOutputFormat(z.object({ industry_key: z.string(), confidence: z.number() }))` through `client.messages.parse()`. The 94-key taxonomy sits in the **cached stable prefix** (`cache_control: { type: "ephemeral", ttl: "1h" }`) so this costs ~40 ms of billable input. Confidence ≥ 0.7 → auto-select with an undoable toast; below → show top-3 as chips.
- Each row: 24 px stroke icon (`--n-600`, inherits `--brand-600` when active), label, and the parent group as `--text-xs --n-500` on the right.

---

### 2.3 Address

| | |
|---|---|
| **NL label** | Waar vinden klanten je? |
| **EN label** | Where do customers find you? |
| **NL helper** | We zetten je adres, kaart en routebeschrijving automatisch op de site. |
| **EN helper** | We'll add your address, a map and directions automatically. |

**NL/BE two-field flow** (shown when country ∈ {NL, BE}):

| Field | NL label | EN label | inputmode | autocomplete | pattern |
|---|---|---|---|---|---|
| postcode | Postcode | Postcode | `text` (uppercase transform) | `postal-code` | NL `^[1-9][0-9]{3} ?[A-Za-z]{2}$` · BE `^[1-9][0-9]{3}$` |
| house no. | Huisnummer | House number | `numeric` | `address-line2` | `^[0-9]{1,5}\s?[A-Za-z\-]{0,4}$` |

On both valid → single request to `/api/v1/geo/resolve` → street + city + lat/lng, rendered read-only with an **Wijzig** (Edit) link. This is ~4 s of typing for a complete verified address.

**All other countries:** one autocomplete `<input role="combobox" autocomplete="street-address" enterkeyhint="search">`, debounce 180 ms, min 3 chars, max 5 suggestions, proxied through the Worker (`/api/v1/geo/autocomplete` → Geoapify) so the provider key never ships to the client and responses cache in KV for 24 h keyed by `sha256(normalized_query|country)`.

**Manual fallback** always available (`Handmatig invullen`): `address_line1` (`address-line1`), `address_line2` (`address-line2`), `postal_code` (`postal-code`), `city` (`address-level2`), `country` (`country`, `<select>` defaulted from `cf.country`, EU countries first).

| Error | NL | EN |
|---|---|---|
| empty | Vul je adres in, of zet aan dat je naar klanten toe komt. | Enter your address, or tell us you visit customers. |
| bad postcode NL | Een Nederlandse postcode ziet er zo uit: 1012 AB. | A Dutch postcode looks like this: 1012 AB. |
| not found | We konden dit adres niet vinden. Controleer het of vul het handmatig in. | We couldn't find that address. Check it or enter it manually. |
| lookup down | Onze adreszoeker doet het even niet. Vul het adres zelf in — je site wordt er niet minder van. | Our address lookup is down. Type it in — your site won't suffer. |

**Service-area mode:** toggle *"Ik kom naar de klant"* / *"I travel to customers"* → city input + radius slider (5/10/25/50 km, `role="slider"` with `aria-valuetext="25 kilometer"`), 44 px thumb.

---

### 2.4 Opening hours

| | |
|---|---|
| **NL label** | Wanneer ben je open? |
| **EN label** | When are you open? |
| **NL helper** | Kies een sjabloon en pas aan wat anders is. |
| **EN helper** | Pick a template, then change what's different. |

**Presets (chips, 44 px, single-select, `role="radiogroup"`):**

| Chip NL | Chip EN | Expands to |
|---|---|---|
| Ma–vr 9–17 | Mon–Fri 9–17 | Mo–Fr 09:00–17:00, weekend closed |
| Ma–za 9–18 | Mon–Sat 9–18 | Mo–Sa 09:00–18:00, Sun closed |
| Di–zo 12–22 | Tue–Sun 12–22 | Tu–Su 12:00–22:00, Mon closed |
| Op afspraak | By appointment | `byAppointmentOnly: true`, no grid |
| 24/7 | 24/7 | Mo–Su 00:00–23:59 |

**Grid row anatomy** (7 rows): `[day label 3ch] [Open/Gesloten switch] [from ▾] [to ▾] [+ pauze] [⋯]`.
- Time controls are `<select>` at 15-min granularity in 24 h format (Europe: never AM/PM), 96 options, keyboard-typeable ("14" jumps to 14:00). Not `<input type="time">` — inconsistent mobile UX and no coarse stepping.
- **`+ pauze`** adds a second interval (lunch/dinner split, essential for restaurants). Max 3 intervals/day.
- **Copy-to-all:** the `⋯` menu on any row offers *"Kopieer naar alle dagen"*, *"Kopieer naar ma–vr"*, *"Kopieer naar za–zo"*. Announced: `"Maandag 09:00 tot 17:00 gekopieerd naar 6 dagen."`
- Summary line above the grid, always current: *"Ma–vr 09:00–17:00 · za 10:00–16:00 · zo gesloten"*.

| Error | NL | EN |
|---|---|---|
| end ≤ start | De sluitingstijd moet ná de openingstijd liggen. | Closing time must be after opening time. |
| overlap | Deze tijden overlappen met een ander blok op dezelfde dag. | These hours overlap another block on the same day. |
| all closed | Alle dagen staan op gesloten. Klopt dat? [Ja, klopt] [Aanpassen] | Every day is closed. Is that right? [Yes] [Change] |

**Storage** (`sites.opening_hours`, ≤ 4096 chars, valid JSON), already schema.org-shaped:

```json
{"tz":"Europe/Amsterdam","byAppointmentOnly":false,"spec":[
  {"dayOfWeek":["Monday","Tuesday","Wednesday","Thursday","Friday"],"opens":"09:00","closes":"17:00"},
  {"dayOfWeek":["Saturday"],"opens":"10:00","closes":"16:00"}],
 "closed":["Sunday"],
 "exceptions":[{"date":"2026-12-25","closed":true,"name":"Eerste Kerstdag"}]}
```

---

### 2.5 Google Business Profile URL

| | |
|---|---|
| **NL label** | Google-vermelding (optioneel) |
| **EN label** | Google Business Profile (optional) |
| **NL helper** | Plak de link en we halen je adres, openingstijden en reviews op. Scheelt je 2 minuten. |
| **EN helper** | Paste the link and we'll pull your address, hours and reviews. Saves you 2 minutes. |
| **Type** | `<input type="url" inputmode="url" autocomplete="url" spellcheck="false" enterkeyhint="go">` |

**Accepted forms** (normalised server-side): `google.com/maps/place/…`, `google.<cctld>/maps/…`, `maps.app.goo.gl/*`, `goo.gl/maps/*`, `g.page/*`, `g.page/r/*`, `business.google.com/…`, `?cid=<id>`, raw `place_id`.

**Resolution pipeline** (`POST /api/v1/onboarding/resolve-gbp`, Worker-side only):
1. Expand short links (`maps.app.goo.gl`, `g.page`) with a single `fetch(redirect:'manual')`, max 3 hops, 4 s budget.
2. Extract `place_id` / `cid` / (name + coords) from the expanded URL.
3. Google **Places Details** with `fields=id,displayName,formattedAddress,location,nationalPhoneNumber,internationalPhoneNumber,regularOpeningHours,primaryType,rating,userRatingCount,reviews,photos`.
4. Map `primaryType` → our `industries.key` via a static lookup table (fallback: the AI classifier of §2.2).
5. Return a **diff preview**, never a silent overwrite: *"We vonden 11 gegevens. Vink uit wat je niet wilt."* with each derived field as an uncheckable row. Consent + `3.3.7 Redundant Entry` in one gesture.

**Legal/ToS constraints that the implementation must honour:** only `place_id` may be stored indefinitely. All other Places content is cached ≤ 30 days (`gbp_cache` in KV, TTL 30 d) and refreshed by a cron Worker; reviews are rendered with visible Google attribution and a link to the listing, and `site_reviews.source` must record `google`. Photos are referenced by Places photo URI at build time, not re-hosted in R2.

| Error | NL | EN |
|---|---|---|
| not a Google URL | Dat lijkt geen Google-link. Zoek je bedrijf op Google Maps en gebruik **Delen → Link kopiëren**. | That doesn't look like a Google link. Find your business on Google Maps and use **Share → Copy link**. |
| not found | We konden deze vermelding niet openen. Geen probleem — je kunt alles zelf invullen. | We couldn't open that listing. No problem — you can fill everything in yourself. |
| timeout | Google reageert traag. [Opnieuw] of ga gewoon verder. | Google is slow right now. [Retry] or just continue. |

---

### 2.6 Short description

| | |
|---|---|
| **NL label** | Vertel in het kort wat je doet |
| **EN label** | Tell us briefly what you do |
| **NL helper** | 2–3 zinnen. Geen zin? Laat het ons schrijven. |
| **EN helper** | 2–3 sentences. Not in the mood? Let us write it. |
| **Type** | `<textarea rows="3">` auto-growing to max 8 rows, `maxlength="600"`, `enterkeyhint="enter"`, `spellcheck="true"`, `autocapitalize="sentences"` |
| **Rules** | optional-but-nudged · 0 or 40–600 chars · ≥ 6 words if non-empty · no URLs/phone numbers (they belong in contact) |

Counter appears at 480 chars (`--n-500`), turns `--warning-600` at 560, `--danger-600` at 600.

| Error | NL | EN |
|---|---|---|
| too short | Nog een paar woorden erbij — of laat ons het schrijven. | A few more words — or let us write it. |
| too long | Iets korter graag (max 600 tekens). Je kunt later meer toevoegen. | A little shorter please (600 characters max). You can add more later. |

**"Schrijf het voor mij" / "Write it for me".** Enabled once name + industry exist. Tone chips: **Warm** · **Zakelijk** · **Speels** (Warm / Professional / Playful). `POST /api/v1/onboarding/draft-description` → `claude-opus-5`, `effort: "low"`, `thinking: { type: "adaptive" }`, `stream: true`, `max_tokens: 400`. The system prompt (brand voice + tone rules + few-shot per industry group) is the **cached stable prefix**; only `{name, industry, city, hours_summary}` varies. Text streams into the textarea at ~55 chars/frame-budget with a soft cursor; **Nog een variant** regenerates; **Ongedaan maken** restores the previous value (kept in a 5-deep undo ring). Never auto-writes without the explicit tap.

---

### 2.7 Phone / WhatsApp

| | |
|---|---|
| **NL label** | Telefoonnummer |
| **EN label** | Phone number |
| **NL helper** | Klanten bellen of appen je hiermee direct vanaf je site. |
| **EN helper** | Customers call or WhatsApp you straight from your site. |
| **Type** | Country `<button>` (flag + dial code, opens a searchable listbox) + `<input type="tel">` |
| **Attrs** | `inputmode="tel" autocomplete="tel-national" enterkeyhint="next"` on the number; the country button carries the `tel-country-code` semantics |

**Country detection order:** (1) country chosen at step 3; (2) `cf.country`, injected server-side as `<html data-cf-country="NL">`; (3) `navigator.language` region; (4) `NL`. EU countries pinned to the top of the list.

**Formatting/validation:** `libphonenumber-js/max` loaded **lazily on step 5 focus** (~145 KB, never in the initial bundle; the `/min` build cannot distinguish MOBILE from FIXED_LINE, which we need for the WhatsApp warning). `AsYouType(country)` formats live; on blur we store `parsePhoneNumber().number` as E.164 → `sites.phone_e164` (schema: `+[0-9]*`, 8–16 chars).

| Error | NL | EN |
|---|---|---|
| empty | Vul een telefoonnummer in — dit is je belangrijkste contactknop. | Enter a phone number — it's your most important contact button. |
| invalid | Dit nummer klopt niet voor {land}. Voorbeeld: {example}. | That number isn't valid for {country}. Example: {example}. |
| WhatsApp on landline | Dit lijkt een vast nummer. WhatsApp werkt alleen op mobiel. [Ander nummer] [Toch gebruiken] | That looks like a landline. WhatsApp only works on mobile. [Use another] [Use anyway] |

**WhatsApp:** checkbox *"Dit nummer ook voor WhatsApp"* default **checked**; unchecking reveals a second phone input. Stored to `sites.whatsapp_e164`. Generated link: `https://wa.me/<E164 minus +>?text=<urlencoded greeting in site locale>` — on mobile this opens the app directly; desktop falls through to WhatsApp Web.

---

### 2.8 Email (last field, step 6)

| | |
|---|---|
| **NL label** | Waar sturen we de link naartoe? |
| **EN label** | Where should we send the link? |
| **NL helper** | Je site is over ~1 minuut klaar. We mailen je de link zodat je hem nooit kwijtraakt. |
| **EN helper** | Your site is ready in ~1 minute. We'll email the link so you never lose it. |
| **Type** | `<input type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" enterkeyhint="done">` |
| **Rules** | required · HTML5 + `^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$` · normalise lower + trim · typo correction against a 40-domain list (gmail/hotmail/outlook/ziggo/kpnmail/live/icloud/telenet/…) |

| Error | NL | EN |
|---|---|---|
| empty | We hebben een e-mailadres nodig om je site op te slaan. | We need an email address to save your site. |
| invalid | Dit e-mailadres lijkt niet te kloppen. | That email address doesn't look right. |
| typo | Bedoelde je **{suggestion}**? [Ja] [Nee, klopt zo] | Did you mean **{suggestion}**? [Yes] [No, it's right] |
| already used | Dit adres heeft al een account. [Inloggen] — je concept blijft bewaard. | That address already has an account. [Log in] — your draft is saved. |

Consent line under it (checkbox, unchecked, **not** required for signup): *"Stuur me tips om meer klanten te krijgen (max 1× per maand)."* → `users.marketing_opt_in`. Below the submit button, `--text-xs --n-500`: *"Door verder te gaan ga je akkoord met de [Voorwaarden] en [Privacyverklaring]."*

---

## 3. INDUSTRY TAXONOMY

**14 groups · 94 leaves.** Stored in `industries` (existing table) + `industry_groups` (new, §9). `dna` is written into `industries.design_preset` JSON as `{"dna":"<key>", …}`; the DNA registry (§3.2) expands it to the concrete `bg/fg/accent/font_*/radius` values the existing seed format already uses.

Footnote **†** = no adequate schema.org LocalBusiness subtype; emit `"@type":"LocalBusiness"` **plus** `"additionalType":"<wikidata/productontology URI>"`.

### 3.1 The list

| # | key | EN | NL | schema.org @type | DNA |
|---|---|---|---|---|---|
| **G1 — Food & Drink · Eten & drinken (9)** ||||||
|1|`restaurant`|Restaurant|Restaurant|`Restaurant`|`cream-terracotta`|
|2|`cafe`|Café / lunchroom|Café / lunchroom|`CafeOrCoffeeShop`|`espresso-warm`|
|3|`bakery`|Bakery & patisserie|Bakkerij & patisserie|`Bakery`|`espresso-warm`|
|4|`bar_pub`|Bar & pub|Bar & café|`BarOrPub`|`midnight-neon`|
|5|`takeaway`|Takeaway & fast food|Afhaal & fastfood|`FastFoodRestaurant`|`playful-primary`|
|6|`food_truck`|Food truck|Foodtruck|`FoodEstablishment`|`playful-primary`|
|7|`ice_cream`|Ice cream parlour|IJssalon|`IceCreamShop`|`playful-primary`|
|8|`catering`|Catering|Catering|`FoodEstablishment`|`gold-heritage`|
|9|`brewery`|Brewery & distillery|Brouwerij & distilleerderij|`Brewery`|`steel-industrial`|
| **G2 — Beauty & Personal Care · Schoonheid & verzorging (7)** ||||||
|10|`hairdresser`|Hair salon|Kapsalon|`HairSalon`|`editorial-blush`|
|11|`barbershop`|Barbershop|Barbershop|`HairSalon`|`midnight-neon`|
|12|`beauty_salon`|Beauty salon|Schoonheidssalon|`BeautySalon`|`editorial-blush`|
|13|`nail_studio`|Nail studio|Nagelstudio|`NailSalon`|`editorial-blush`|
|14|`day_spa`|Spa & sauna|Wellness & sauna|`DaySpa`|`linen-botanical`|
|15|`massage`|Massage therapy|Massagepraktijk|`HealthAndBeautyBusiness`|`linen-botanical`|
|16|`tattoo_studio`|Tattoo & piercing|Tattoo & piercing|`TattooParlor`|`midnight-neon`|
| **G3 — Health & Medical · Gezondheid & zorg (8)** ||||||
|17|`gp_practice`|GP practice|Huisartsenpraktijk|`Physician`|`clinical-calm`|
|18|`dentist`|Dental practice|Tandartspraktijk|`Dentist`|`clinical-calm`|
|19|`physiotherapist`|Physiotherapy|Fysiotherapie|`Physiotherapy`|`clinical-calm`|
|20|`chiropractor`|Chiropractor & osteopath|Chiropractor & osteopaat|`MedicalBusiness`|`clinical-calm`|
|21|`psychologist`|Psychologist & therapy|Psycholoog & therapie|`Psychiatric`|`linen-botanical`|
|22|`optician`|Optician|Opticien|`Optician`|`studio-white`|
|23|`pharmacy`|Pharmacy|Apotheek|`Pharmacy`|`clinical-calm`|
|24|`home_care`|Home care|Thuiszorg|`MedicalBusiness`|`pastel-care`|
| **G4 — Sport & Fitness (7)** ||||||
|25|`gym`|Gym & fitness|Sportschool|`ExerciseGym`|`energy-volt`|
|26|`crossfit_box`|CrossFit & functional|CrossFit & functional|`ExerciseGym`|`energy-volt`|
|27|`yoga_studio`|Yoga & pilates|Yoga & pilates|`SportsActivityLocation`|`linen-botanical`|
|28|`personal_trainer`|Personal trainer|Personal trainer|`SportsActivityLocation`|`energy-volt`|
|29|`martial_arts`|Martial arts & boxing|Vechtsport & boksen|`SportsClub`|`midnight-neon`|
|30|`dance_school`|Dance school|Dansschool|`SportsActivityLocation`|`editorial-blush`|
|31|`racket_club`|Tennis, padel & golf|Tennis, padel & golf|`TennisComplex`|`forest-earth`|
| **G5 — Home & Trades · Bouw & installatie (10)** ||||||
|32|`plumber`|Plumber|Loodgieter|`Plumber`|`hi-vis-utility`|
|33|`electrician`|Electrician|Elektricien|`Electrician`|`hi-vis-utility`|
|34|`hvac_heatpump`|Heating, cooling & heat pumps|Cv, koeling & warmtepompen|`HVACBusiness`|`hi-vis-utility`|
|35|`general_contractor`|Builder & contractor|Aannemer|`GeneralContractor`|`steel-industrial`|
|36|`painter_decorator`|Painter & decorator|Schilder & stukadoor|`HousePainter`|`steel-industrial`|
|37|`roofer`|Roofer|Dakdekker|`RoofingContractor`|`steel-industrial`|
|38|`carpenter`|Carpenter & joinery|Timmerman & meubelmaker|`HomeAndConstructionBusiness`|`forest-earth`|
|39|`locksmith`|Locksmith|Slotenmaker|`Locksmith`|`hi-vis-utility`|
|40|`landscaper`|Gardener & landscaping|Hovenier & tuinaanleg|`HomeAndConstructionBusiness`|`forest-earth`|
|41|`solar_installer`|Solar & energy|Zonnepanelen & energie|`HomeAndConstructionBusiness`|`forest-earth`|
| **G6 — Automotive & Transport · Auto & vervoer (7)** ||||||
|42|`car_repair`|Garage & repair|Autogarage|`AutoRepair`|`steel-industrial`|
|43|`car_dealer`|Car dealer|Autodealer|`AutoDealer`|`showroom-mono`|
|44|`car_bodywork`|Bodywork & paint|Autoschadeherstel|`AutoBodyShop`|`steel-industrial`|
|45|`tyre_service`|Tyres & wheels|Bandenservice|`TireShop`|`steel-industrial`|
|46|`car_wash`|Car wash & detailing|Carwash & detailing|`AutoWash`|`showroom-mono`|
|47|`bike_shop`|Bicycle shop & repair|Fietsenwinkel & reparatie|`BikeStore`|`forest-earth`|
|48|`driving_school`|Driving school|Rijschool|`AutomotiveBusiness` †|`energy-volt`|
| **G7 — Retail · Winkels (12)** ||||||
|49|`clothing_store`|Clothing & fashion|Kleding & mode|`ClothingStore`|`editorial-blush`|
|50|`shoe_store`|Shoes & leather|Schoenen & lederwaren|`ShoeStore`|`gold-heritage`|
|51|`jeweller`|Jewellery & watches|Juwelier & horloges|`JewelryStore`|`gold-heritage`|
|52|`florist`|Florist|Bloemist|`Florist`|`linen-botanical`|
|53|`bookshop`|Bookshop & stationery|Boekhandel & kantoorboek|`BookStore`|`paper-craft`|
|54|`toy_store`|Toys & baby|Speelgoed & baby|`ToyStore`|`playful-primary`|
|55|`furniture_store`|Furniture & interior|Meubels & wonen|`FurnitureStore`|`showroom-mono`|
|56|`electronics_store`|Electronics & phones|Elektronica & telefoons|`ElectronicsStore`|`tech-graphite`|
|57|`sports_store`|Sports & outdoor|Sport & outdoor|`SportingGoodsStore`|`energy-volt`|
|58|`pet_store`|Pet shop|Dierenwinkel|`PetStore`|`pastel-care`|
|59|`butcher`|Butcher|Slagerij|`Store` †|`market-fresh`|
|60|`farm_shop`|Greengrocer & farm shop|Groentewinkel & boerderijwinkel|`GroceryStore`|`market-fresh`|
| **G8 — Professional Services · Zakelijke diensten (11)** ||||||
|61|`accountant`|Accountant & bookkeeper|Accountant & boekhouder|`AccountingService`|`trust-navy`|
|62|`lawyer`|Lawyer|Advocaat|`LegalService`|`trust-navy`|
|63|`notary`|Notary|Notaris|`Notary`|`trust-navy`|
|64|`tax_adviser`|Tax adviser|Belastingadviseur|`AccountingService`|`trust-navy`|
|65|`insurance_broker`|Insurance broker|Verzekeringsadviseur|`InsuranceAgency`|`trust-navy`|
|66|`mortgage_adviser`|Mortgage & financial advice|Hypotheek- & financieel advies|`FinancialService`|`trust-navy`|
|67|`consultant`|Consultant|Adviesbureau|`ProfessionalService`|`studio-white`|
|68|`marketing_agency`|Marketing & advertising|Marketing- & reclamebureau|`ProfessionalService`|`studio-white`|
|69|`it_services`|IT services & web|IT-diensten & webdesign|`ProfessionalService`|`tech-graphite`|
|70|`recruitment_agency`|Recruitment & staffing|Werving & uitzendbureau|`EmploymentAgency`|`trust-navy`|
|71|`architect`|Architect & engineering|Architect & ingenieursbureau|`ProfessionalService`|`showroom-mono`|
| **G9 — Events & Entertainment (8)** ||||||
|72|`dj`|DJ|DJ|`LocalBusiness` †|`midnight-neon`|
|73|`live_band`|Band & musician|Band & muzikant|`LocalBusiness` †|`midnight-neon`|
|74|`wedding_planner`|Wedding & event planner|Bruiloft- & eventplanner|`ProfessionalService`|`gold-heritage`|
|75|`photographer`|Photographer|Fotograaf|`ProfessionalService` †|`studio-white`|
|76|`videographer`|Videographer|Videograaf|`ProfessionalService` †|`midnight-neon`|
|77|`nightclub`|Nightclub|Nachtclub|`NightClub`|`midnight-neon`|
|78|`party_rental`|Party & equipment rental|Feest- & materiaalverhuur|`LocalBusiness` †|`playful-primary`|
|79|`art_gallery`|Art gallery|Kunstgalerie|`ArtGallery`|`paper-craft`|
| **G10 — Education & Training · Onderwijs (5)** ||||||
|80|`language_school`|Language school|Talenschool|`EducationalOrganization`|`paper-craft`|
|81|`music_school`|Music school|Muziekschool|`EducationalOrganization`|`paper-craft`|
|82|`tutoring`|Tutoring & exam prep|Bijles & examentraining|`EducationalOrganization`|`trust-navy`|
|83|`business_coach`|Training & coaching|Training & coaching|`EducationalOrganization`|`studio-white`|
|84|`childcare`|Childcare & preschool|Kinderopvang & peuterspeelzaal|`ChildCare`|`playful-primary`|
| **G11 — Real Estate · Vastgoed (4)** ||||||
|85|`estate_agent`|Estate agent|Makelaar|`RealEstateAgent`|`showroom-mono`|
|86|`property_manager`|Property management|Vastgoedbeheer|`RealEstateAgent`|`trust-navy`|
|87|`self_storage`|Self storage|Opslagruimte|`SelfStorage`|`tech-graphite`|
|88|`surveyor`|Surveyor & valuation|Taxateur|`ProfessionalService`|`trust-navy`|
| **G12 — Travel & Hospitality · Reizen & verblijf (5)** ||||||
|89|`hotel`|Hotel|Hotel|`Hotel`|`sun-coast`|
|90|`bed_breakfast`|B&B & guesthouse|B&B & pension|`BedAndBreakfast`|`linen-botanical`|
|91|`campsite`|Campsite & glamping|Camping & glamping|`Campground`|`forest-earth`|
|92|`travel_agency`|Travel agency|Reisbureau|`TravelAgency`|`sun-coast`|
|93|`tour_operator`|Tours & guides|Excursies & gidsen|`TouristInformationCenter`|`sun-coast`|
| **G13 — Pets & Animals · Huisdieren (4)** ||||||
|94|`veterinarian`|Veterinary practice|Dierenarts|`VeterinaryCare`|`pastel-care`|
|95|`pet_grooming`|Pet grooming|Trimsalon|`LocalBusiness` †|`pastel-care`|
|96|`dog_training`|Dog training & daycare|Hondentraining & -opvang|`LocalBusiness` †|`pastel-care`|
|97|`equestrian_centre`|Stables & equestrian|Manege & paardensport|`SportsActivityLocation`|`forest-earth`|
| **G14 — Craft, Services & Other · Ambacht & overig (7)** ||||||
|98|`artisan_maker`|Artisan & maker|Ambachtsman & maker|`LocalBusiness` †|`paper-craft`|
|99|`tailor`|Tailor & alterations|Kleermaker & kledingreparatie|`ClothingStore` †|`gold-heritage`|
|100|`dry_cleaner`|Dry cleaning & laundry|Stomerij & wasserij|`DryCleaningOrLaundry`|`studio-white`|
|101|`cleaning_company`|Cleaning company|Schoonmaakbedrijf|`ProfessionalService`|`studio-white`|
|102|`print_shop`|Printing & signage|Drukkerij & signing|`ProfessionalService`|`paper-craft`|
|103|`funeral_services`|Funeral services|Uitvaartverzorging|`LocalBusiness` †|`gold-heritage`|
|104|`other`|Something else|Iets anders|`LocalBusiness`|`studio-white`|

*(Numbering is the display `sort_order ÷ 10`; 104 rows shown = 94 distinct trade leaves + 9 sub-variants + `other`. If a hard cap is wanted, drop `#6 food_truck`, `#20 chiropractor`, `#26 crossfit_box`, `#36 painter_decorator`, `#45 tyre_service`, `#76 videographer`, `#81 music_school`, `#88 surveyor`, `#96 dog_training`, `#101 cleaning_company` — each collapses into a near neighbour without design loss.)*

**† additionalType URIs:** `driving_school` `wikidata.org/wiki/Q2143665` · `butcher` `wikidata.org/wiki/Q329737` · `dj` `wikidata.org/wiki/Q130857` · `live_band` `schema.org/MusicGroup` · `party_rental` `wikidata.org/wiki/Q1092268` · `photographer`/`videographer` `wikidata.org/wiki/Q33231` / `Q1027872` · `pet_grooming` `wikidata.org/wiki/Q3355098` · `dog_training` `wikidata.org/wiki/Q1194479` · `artisan_maker` `wikidata.org/wiki/Q1294787` · `tailor` `wikidata.org/wiki/Q874405` · `funeral_services` `wikidata.org/wiki/Q1195942`.

### 3.2 Design-DNA registry (20 keys)

Each key expands to the `industries.design_preset` JSON already used by the seed. `hero` selects the hero archetype the generator must build; `stock` seeds the Pexels/Unsplash query when no media is uploaded.

| DNA key | Mood | bg | fg | accent | accent-2 | Display font | Body font | radius | Hero archetype | Motion |
|---|---|---|---|---|---|---|---|---|---|---|
|`midnight-neon`|dark, charged|`#0A0A0F`|`#F5F5F7`|`#7C3AED`|`#22D3EE`|Space Grotesk|Inter|`2px`|full-bleed video, huge type over it|fast, hard cuts|
|`cream-terracotta`|warm, appetising|`#FFFDF7`|`#1A1310`|`#B3261E`|`#C9803A`|Playfair Display|Inter|`4px`|dish close-up, split hero|slow fades|
|`espresso-warm`|cosy, artisanal|`#FBF6EF`|`#241C15`|`#8A5A2B`|`#C9A227`|Fraunces|Inter|`6px`|interior wide, warm grade|gentle parallax|
|`linen-botanical`|calm, natural|`#F7F5F1`|`#22261F`|`#4F7355`|`#C6B79B`|Cormorant Garamond|Inter|`14px`|soft-focus texture, generous white|drift, 600 ms|
|`clinical-calm`|clean, reassuring|`#F7FBFA`|`#12211E`|`#0E9384`|`#2E90FA`|Inter|Inter|`10px`|people-first photo, trust bar|minimal|
|`trust-navy`|authoritative|`#FFFFFF`|`#0B1B2B`|`#12467B`|`#B58B2C`|Source Serif 4|Inter|`4px`|architectural still, credential strip|restrained|
|`steel-industrial`|solid, capable|`#F4F5F6`|`#15181B`|`#D6541F`|`#2B3138`|Archivo|Inter|`2px`|work-in-progress photo, diagonal cut|mechanical|
|`hi-vis-utility`|urgent, reliable|`#FFFFFF`|`#0F1B2A`|`#0B62D6`|`#F5B301`|Inter Tight|Inter|`8px`|call-now band above the fold|snappy 160 ms|
|`showroom-mono`|premium, precise|`#FFFFFF`|`#0B0B0C`|`#0B0B0C`|`#8A8F98`|Inter Tight|Inter|`0px`|edge-to-edge product/property, no chrome|slow scale|
|`energy-volt`|high-energy|`#0E0F12`|`#FAFAFA`|`#D6FF3D`|`#FF3D71`|Anton|Inter|`4px`|motion video, kinetic type|aggressive|
|`editorial-blush`|refined, feminine|`#FAF7F5`|`#2B2320`|`#C99A86`|`#7A5C50`|Cormorant Garamond|Inter|`12px`|portrait crop, magazine grid|silky|
|`sun-coast`|open, inviting|`#FFFDFA`|`#152A33`|`#0E7C9E`|`#F2A65A`|Sora|Inter|`16px`|landscape video, booking bar|floaty|
|`playful-primary`|fun, family|`#FFFFFF`|`#1B1B1F`|`#FF5A1F`|`#2E90FA`|Nunito|Nunito|`20px`|smiling faces, big rounded cards|bouncy spring|
|`paper-craft`|literary, tactile|`#FBFAF7`|`#1C1B19`|`#4A5D3F`|`#A8452B`|Libre Baskerville|Inter|`2px`|flat-lay still, serif headline|paper-turn|
|`market-fresh`|fresh, local|`#FEFDF8`|`#1A2016`|`#3B7A32`|`#D94A2B`|Bitter|Inter|`8px`|produce macro, chalkboard band|crisp|
|`tech-graphite`|technical, sharp|`#0D0F12`|`#E8EBF0`|`#3B82F6`|`#22D3EE`|JetBrains Mono (display)|Inter|`6px`|abstract gradient/grid, mono labels|precise|
|`pastel-care`|gentle, caring|`#FFFBFA`|`#28211F`|`#E08A7A`|`#7FB3A3`|Quicksand|Inter|`18px`|animal/person close-up, soft shadow|soft|
|`gold-heritage`|luxury, timeless|`#FBF9F4`|`#191512`|`#8A6A2F`|`#2E2A24`|Cormorant Garamond|Inter|`0px`|dark still-life, gold rule|slow, weighty|
|`forest-earth`|grounded, green|`#F6F7F2`|`#1B2118`|`#3F6B3A`|`#8B6B3E`|Sora|Inter|`10px`|outdoor wide, seasonal grade|organic|
|`studio-white`|neutral, editorial|`#FFFFFF`|`#101828`|`#1570EF`|`#101828`|Inter Tight|Inter|`8px`|clean photo, big whitespace|understated|

---

## 4. MEDIA UPLOAD UX

**NL label** *Foto's & video van je zaak (optioneel)* · **EN** *Photos & video of your business (optional)*
**NL helper** *Sleep ze hierheen of maak nu een foto. Eén goede foto maakt je site 10× persoonlijker.*
**EN helper** *Drag them in or take one now. One good photo makes your site 10× more personal.*

### 4.1 Anatomy

- **Dropzone**: 180 px tall, dashed `2px --n-300`, `--radius-lg`, `--n-25` fill. On `dragover` (document-level listener, counter-based so child elements don't flicker): border → `--brand-600`, fill → `--brand-50`, scale `1.01`, 120 ms. Full-window drop is accepted, not just the box.
- Two buttons, both 44 px, side by side:
  - `📷 Foto maken` — mobile only (`<input type="file" accept="image/*" capture="environment">`)
  - `Bestanden kiezen` — `<input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/quicktime" multiple>`
- **Skip affordance** — a full-width secondary card, always visible, *never* smaller than the dropzone's CTA:
  > **NL** *Sla over — wij kiezen prachtige beelden voor je* · *We zoeken professionele stockvideo die bij een {branche} past. Later zelf foto's toevoegen kan altijd.*
  > **EN** *Skip — we'll pick beautiful footage for you* · *We'll find professional stock video that suits a {industry}. You can add your own photos any time.*
  Tapping it shows 3 stock thumbnails for the industry's `stock_query` so "skip" feels like *choosing*, not *giving up*.

### 4.2 Limits

| | Images | Video |
|---|---|---|
| Max files | 12 | 1 |
| Max size (pre-compression) | 25 MB | 200 MB |
| Max size (post-compression, what we upload) | 1.6 MB target | unchanged |
| Accepted | JPEG, PNG, WebP, AVIF, HEIC/HEIF | MP4 (H.264/HEVC), MOV |
| Min dimensions | 800 × 600 | 720 p |
| Max duration | — | 60 s (hero uses first 12 s) |

### 4.3 Client-side compression

Runs in a dedicated Web Worker so the main thread never drops a frame:
1. `createImageBitmap(file, { imageOrientation: 'from-image' })` — decodes off-thread and applies EXIF rotation. HEIC on non-Safari falls back to a lazily-imported `heic2any` chunk (only fetched when a HEIC is actually dropped).
2. Resize longest edge to **2560 px** (`OffscreenCanvas`, `resizeQuality: 'high'`); a second 1280 px render is kept for the preview grid.
3. Encode WebP `quality 0.82`. If output > 1.6 MB, retry at `0.72`, then `0.62`. Keep the original only if the encode is *larger*.
4. Strip all EXIF except orientation (already baked). **GPS is dropped** — a home-address leak via a photo is a GDPR incident.
5. Compute `sha256` of the encoded bytes → sent as the dedup key (`media_assets.sha256` / `idx_media_dedup`), and extract a 4×3 **blurhash** + dominant colour, both stored so the generated site can render `LQIP` placeholders and hit its Lighthouse targets.

Videos are **not** transcoded client-side. We validate container/duration via a hidden `<video>` `loadedmetadata`, capture a poster frame at `t=1.0 s` (that frame *is* compressed and uploaded as the poster image), and upload the original.

### 4.4 Upload transport

- `POST /api/v1/onboarding/media/sign` → Worker returns an R2 **presigned PUT** (S3 API), 15-minute expiry, key `drafts/{draft_id}/{ulid}.{ext}`, with `Content-Length` and `x-amz-checksum-sha256` bound into the signature.
- Uploads go **browser → R2 directly** via `XMLHttpRequest` (needed for `upload.onprogress`; `fetch` still has no upload progress in Safari). Concurrency 3, FIFO queue.
- Files > 8 MB (i.e. video) use R2 **multipart**, 8 MB parts, per-part retry with exponential backoff (`400 ms × 2^n`, jitter ±20 %, 5 attempts). A failed part re-PUTs alone; the rest of the upload is never re-sent.
- On success the client calls `/api/v1/onboarding/media/commit` with `{r2_key, sha256, mime, bytes, width, height, duration_ms, blurhash, dominant_color}` → row in `draft_media` (§9), promoted into `media_assets` when the site row is created.
- Server-side after commit: MIME sniff from magic bytes (never trust `Content-Type`), dimension re-verify, and a Workers-side scan; failures set `media_assets.status='quarantined'` and the tile shows a neutral error.

### 4.5 Tile states & reordering

Grid: 3 columns mobile / 4 desktop, 1:1 tiles, `--radius-md`, 8 px gap. The **first tile is badged `Hero`** — this is the strongest possible teaching signal about ordering.

| State | Visual | SR text |
|---|---|---|
| queued | 40 % opacity, blurhash fill | "In de wachtrij" |
| compressing | shimmer sweep + "Verkleinen…" | "Foto wordt verkleind" |
| uploading | radial progress ring (2 px, `--brand-600`) + % centred | `aria-valuenow` on a `role="progressbar"` |
| done | full-colour thumb, 200 ms fade + `scale(0.96→1)`, tick pips in top-right for 900 ms | "Geüpload" |
| error | `--danger-50` overlay + retry button | error text |

**Reorder** must satisfy WCAG 2.2 **2.5.7 Dragging Movements** — pointer drag is an *enhancement*, never the only route:
- Pointer: `pointerdown` + 6 px threshold (so taps still open the preview), FLIP-animated reflow at 200 ms `--ease-out-quint`.
- Keyboard: each tile is a button; `Space` picks up (announces *"Foto 3 opgepakt. Gebruik pijltjestoetsen om te verplaatsen, spatie om neer te zetten."*), arrows move (announcing *"Foto 3, positie 2 van 7"*), `Space` drops, `Escape` cancels and restores.
- Always-visible `⟨ ⟩` move buttons on each tile at ≥ 44 px on touch (visible on focus/hover on desktop).

### 4.6 Errors

| Case | NL | EN |
|---|---|---|
| wrong type | We kunnen `{name}` niet gebruiken. Gebruik JPG, PNG, WebP of MP4. | We can't use `{name}`. Use JPG, PNG, WebP or MP4. |
| too large | `{name}` is {size} — dat is te groot. Video's mogen tot 200 MB. | `{name}` is {size} — too large. Videos can be up to 200 MB. |
| too small | Deze foto is te klein ({w}×{h}) en wordt wazig op grote schermen. [Toch gebruiken] | This photo is small ({w}×{h}) and will look blurry on big screens. [Use anyway] |
| video too long | Je video duurt {n} sec. We gebruiken de eerste 12 seconden. [Prima] [Andere kiezen] | Your video is {n} s. We'll use the first 12 seconds. [Fine] [Choose another] |
| too many | Twaalf foto's is het maximum — meer kun je later in de editor toevoegen. | Twelve photos is the maximum — add more later in the editor. |
| upload failed | Uploaden van `{name}` is mislukt. [Opnieuw proberen] | `{name}` failed to upload. [Try again] |
| offline | Je bent offline. We gaan verder zodra je weer verbinding hebt. | You're offline. We'll continue as soon as you're back. |
| all failed at submit | We konden je foto's niet uploaden. Wil je doorgaan met stockbeelden? [Ja, bouw mijn site] [Opnieuw] | We couldn't upload your photos. Continue with stock imagery? [Yes, build it] [Retry] |

**Uploads never block submit.** If files are still in flight when *Bouw mijn website* is pressed, generation starts immediately and the media phase (`media_fetch`) waits on them for up to 20 s, then proceeds with stock and hot-swaps the real photos into the draft version when they land.

---

## 5. MOTION & CRAFT

### 5.1 Tokens (see §8.7 for the full set)

`--dur-1 80ms` · `--dur-2 120ms` · `--dur-3 180ms` · `--dur-4 240ms` · `--dur-5 320ms` · `--dur-6 480ms` · `--dur-7 720ms`
`--ease-out-quint cubic-bezier(.22,1,.36,1)` · `--ease-in-out cubic-bezier(.65,0,.35,1)` · `--ease-in cubic-bezier(.32,0,.67,0)` · `--ease-spring linear(0,.006,.025 2.8%,.101 6.1%,.539 18.9%,.721 25.3%,.849 31.5%,.937 38.1%,.968 41.8%,.991 45.7%,1.006 50.1%,1.015 55%,1.017 63.9%,1.001)`

### 5.2 Entrance

| t | Layer | From → To | Duration / easing |
|---|---|---|---|
| 0 | CTA button | `scale(1) → .97` then release | 90 ms `--ease-in` |
| 0 | `::backdrop` | `opacity 0 → 1`, `backdrop-filter: blur(0) → blur(20px) saturate(1.1)` | 200 ms `--ease-out-quint` |
| 40 ms | Panel | `opacity 0→1`, `translateY(16px)→0`, `scale(.985)→1` | 320 ms `--ease-out-quint` |
| 140 ms | Header + rail | `opacity 0→1`, `translateY(-6px)→0` | 240 ms `--ease-out-quint` |
| 180 ms | Question headline | `opacity 0→1`, `translateY(10px)→0` | 260 ms |
| 220 ms | Field | same, +40 ms stagger | 260 ms |
| 260 ms | Helper + button | same, +40 ms stagger | 260 ms |
| 340 ms | Focus lands on the field (desktop) | — | — |

Focus is set **after** the transition so screen readers don't read a moving target and iOS doesn't yank the viewport mid-animation. On touch we focus the field but **do not** open the keyboard on step 1 (`readonly` released on first tap) — an unrequested keyboard covering the hero card is the single most common mobile-modal mistake.

Backdrop is `rgba(9,12,18,.55)` + blur. `body { overflow: hidden }` plus `overscroll-behavior: contain` on the scroll container; scrollbar-width compensation via `scrollbar-gutter: stable`.

### 5.3 Exit

Backdrop `opacity 1→0` 160 ms `--ease-in`; panel `opacity 1→0`, `translateY(0→8px)`, `scale(1→.99)` 180 ms `--ease-in`. Total ≤ 200 ms — exits must always feel faster than entrances. Focus returns to the trigger element with `{ preventScroll: false }` and a 2-frame delay.

### 5.4 Step transitions

Directional slide + crossfade, on a container whose height is animated from measured to measured:

```
outgoing: opacity 1→0, translateX(0 → ∓24px), 160ms var(--ease-in)
incoming: opacity 0→1, translateX(±24px → 0), 240ms var(--ease-out-quint), delay 80ms
height:   from→to, 260ms var(--ease-out-quint)   (ResizeObserver-measured, or interpolate-size)
```

Forward = incoming from `+24px`; back = from `−24px`. The progress rail fill runs 320 ms `--ease-out-quint` in parallel. Total perceived transition ≈ 320 ms — under the 400 ms boundary where a transition starts to feel like a wait. The container gets `will-change: transform, opacity` only during the transition, removed on `transitionend`.

Cross-step continuity: when the "Ben jij dit?" card is selected at step 1, its title **FLIP-morphs** into the step-5 confirmation header (shared `view-transition-name`, or a manual FLIP fallback), 380 ms `--ease-out-quint`.

### 5.5 The generation experience (45–90 s)

This is the product. Layout: on ≥ 1024 px the dialog splits into **status rail 380 px (left) + live preview (right)**; below that, a single column with the preview pinned to the top 45 vh and status scrolling beneath.

**Seven acts**, mapped 1:1 onto the `generation_job_events.phase` enum that already exists in `0005_ai_generation.sql`:

| Act | phase | Progress | Typical window | Headline (NL / EN) | Preview does |
|---|---|---|---|---|---|
| 0 | `queued` | 0–3 | 0–1 s | *We beginnen…* / *Getting started…* | empty canvas, breathing |
| 1 | `prompt_built` | 3–10 | 1–3 s | *We lezen alles over {naam}* / *Reading everything about {name}* | the user's own data flies in as pill chips and lands in a grid |
| 2 | `api_call` + `thinking` | 10–24 | 3–12 s | *We kiezen kleuren en lettertypes voor een {branche}* / *Choosing colours and type for a {industry}* | the DNA palette paints in — 5 colour swatches wipe across, then the type specimen sets itself |
| 3 | `streaming` | 24–58 | 12–45 s | *We schrijven je pagina's* / *Writing your pages* | **skeleton blocks fill with real streamed copy, line by line** |
| 4 | `parsing` + `pages_written` | 58–70 | 45–55 s | *{n} pagina's opgemaakt* / *{n} pages laid out* | page thumbnails deal out like cards, 60 ms stagger |
| 5 | `media_fetch` | 70–84 | 55–68 s | *We zoeken de mooiste beelden* / *Finding your best imagery* | blurhash placeholders **morph to real photos**, one every ~250 ms |
| 6 | `build` | 84–93 | 68–78 s | *Optimaliseren voor Google en mobiel* / *Optimising for Google and mobile* | a live Lighthouse-style gauge sweeps to 100 |
| 7 | `deploy` | 93–99 | 78–86 s | *Live zetten op {slug}.mijnsaas.com* / *Publishing to {slug}.mijnsaas.com* | URL bar types the domain, char by char, 28 ms/char |
| 8 | `done` | 100 | — | **Je website is live.** / **Your website is live.** | full-page scroll-through of the real site behind a translucent success card |

**Progress that never lies and never stalls.** The bar is driven by real SSE events, but between events it *asymptotically approaches* the next act's floor:
`displayed = target_prev + (target_next − target_prev) × (1 − e^(−elapsed/τ))`, `τ = 6 s`. It therefore always moves, never reaches the next milestone early, and snaps forward with a 400 ms `--ease-out-quint` on each real event. If no event arrives for 15 s we surface an honest line: *"Dit duurt iets langer dan normaal — we zijn er bijna."* At 45 s of silence we offer the email-and-release path.

**Skeleton-to-real morph.** Every skeleton block carries `data-slot="hero.headline"`, `data-slot="services.item.3"`, etc. When a `streaming` event delivers a slot's text we: (1) measure the skeleton rect, (2) swap in the real text with `opacity 0`, (3) FLIP the size change over 220 ms `--ease-out-quint`, (4) fade the text in over 160 ms with a 4 px rise. Images: blurhash canvas → `<img>` decoded off-screen → `opacity` crossfade 260 ms plus `filter: blur(12px) → blur(0)`.

**Micro-craft in the status rail.** Each act is a row that completes with a 180 ms tick-draw (SVG `stroke-dashoffset`), then dims to `--n-500` and slides up 4 px as the next row brightens. Completed rows keep a real detail: *"Kleurenpalet: 'Editorial Blush'"*, *"4 pagina's, 2 blogposts"*, *"11 foto's geoptimaliseerd (1,2 MB → 340 kB)"*. Concrete numbers are what makes a wait feel like work being done for you.

**The reveal (peak P2).** At `done`: preview un-blurs and scales `0.96 → 1` over 520 ms `--ease-out-quint`; the success card rises 24 px with a spring; the domain gets a 700 ms sheen sweep; 14 confetti particles (SVG, GPU-composited, 900 ms, auto-removed) — suppressed entirely under reduced motion. Then the panel auto-scrolls the preview through the whole homepage over 6 s (`scroll-behavior: smooth`, pausable on any interaction). Two buttons: **Bekijk mijn website** (primary) and **Aanpassen in de editor** (secondary).

**Abandonment safety.** The job runs in a **Durable Object** per `job_id`, fanning SSE out to any number of connected clients and buffering events for reconnects. Closing the tab does not cancel it. On completion the Worker emails the link. Reopening `/start?job=job_…` replays from `generation_job_events` at the client's `Last-Event-ID` cursor (that's exactly what `idx_job_events_poll` is for) and rejoins live.

### 5.6 Reduced motion

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration:.01ms!important; animation-iteration-count:1!important;
                            transition-duration:.01ms!important; scroll-behavior:auto!important; }
}
```
Then re-enable *opacity-only* essentials so the UI still reads as alive: modal enter/exit = 120 ms crossfade, no transform, no blur; step change = 100 ms crossfade, no slide, height jumps; progress bar = width transitions kept (a progress bar that doesn't move is a broken progress bar) but the asymptotic interpolation is disabled — it steps on real events only; skeleton shimmer → static `--n-100` fill; blurhash→photo = instant swap; confetti, sheen, auto-scroll and the typing domain are **removed**, replaced by static final states. Also honour `prefers-contrast: more` (borders → `--n-700`, shadows → outlines) and `forced-colors: active` (all decorative gradients dropped, `border: 1px solid CanvasText` on every surface, focus ring → `outline: 3px solid Highlight`).

---

## 6. ACCESSIBILITY — WCAG 2.2 AA

### 6.1 Dialog

Use the native `<dialog>` element with `showModal()`. It gives, for free and correctly: top-layer stacking, `inert` on everything behind it, a real focus trap, `::backdrop`, and `Escape`. Do not hand-roll a trap.

```html
<dialog id="magic" aria-labelledby="magic-title" aria-describedby="magic-step-desc">
  <div class="panel" role="document">
    <header>
      <h1 id="magic-title" class="sr-only">Maak je website — stap 3 van 6</h1>
      <nav aria-label="Voortgang"><ol> …6 <li> with aria-current="step"… </ol></nav>
      <button class="close" aria-label="Sluiten en later verdergaan">…</button>
    </header>
    <p id="magic-step-desc" class="sr-only">Stap 3 van 6: Adres. Nog 4 stappen te gaan.</p>
    <div id="live-polite"  aria-live="polite" aria-atomic="true" class="sr-only"></div>
    <div id="live-assertive" role="alert" class="sr-only"></div>
    <form novalidate> … </form>
  </div>
</dialog>
```

`aria-modal="true"` is implicit on `showModal()` — do not add it manually alongside `<dialog>` (double-announcement in some AT). `role="document"` on the inner panel keeps JAWS/NVDA in browse mode for the helper prose.

### 6.2 Focus

- **Initial focus:** step heading container (`tabindex="-1"`) on steps ≥ 2, so the full step context is read before the field; step 1 focuses the input directly (fastest path to typing). Set after the 320 ms entrance completes.
- **Restoration:** store `document.activeElement` before `showModal()`; on close, `el.focus()` — with a fallback to the hero CTA if the trigger was removed from the DOM.
- **Between steps:** move focus to the new step's heading, never leave it on the (now-detached) Continue button.
- **2.4.11 Focus Not Obscured (Minimum):** the sticky footer with the primary button is `position: sticky; bottom: 0` — the scroll container therefore carries `scroll-padding-bottom: calc(var(--footer-h) + var(--space-4))`, and `scroll-margin-bottom` on every focusable. Also `padding-bottom: env(safe-area-inset-bottom)`.
- **Focus ring:** `:focus-visible { outline: 2px solid var(--brand-600); outline-offset: 2px; box-shadow: 0 0 0 4px var(--brand-100); }` — 3.6:1 against both `--n-0` and `--n-50` (SC 1.4.11).

### 6.3 Escape and unsaved data

`Escape` (and the close button) → if the draft is dirty and past step 1, open a nested `<dialog>`:

> **NL** *Je concept is bewaard.* — *We hebben alles opgeslagen. Je kunt later verder waar je gebleven bent.*  Buttons: **Verder invullen** (primary, returns focus to the field you left) · **Sluiten** (secondary).
> **EN** *Your draft is saved.* — *We've saved everything. You can pick up where you left off.*  **Keep going** · **Close**

Never present a destructive default. If the draft is clean or on step 1, `Escape` closes immediately. During **generation** `Escape` does *not* close: it swaps the primary action to *"Sluit dit venster — we mailen je de link zodra hij klaar is"*, because the job keeps running.

### 6.4 Announcements

| Event | Region | Text (NL) |
|---|---|---|
| step change | `#live-polite` | `Stap 3 van 6: Adres.` (fired 150 ms after the transition begins so it isn't clipped) |
| field valid + magic | `#live-polite` | `mijn-kapsalon.mijnsaas.com is beschikbaar.` |
| GBP resolved | `#live-polite` | `11 gegevens gevonden en ingevuld. Controleer ze hieronder.` |
| validation error | `#live-assertive` | `Fout: Vul een telefoonnummer in.` |
| error summary on submit | focus moves to summary | (summary is `role="alert" tabindex="-1"`) |
| upload complete | `#live-polite` | `Foto 3 van 5 geüpload.` (throttled to 1 per 1200 ms) |
| generation act change | `#live-polite` | `We schrijven je pagina's. 41 procent.` (max 1 per 4 s — never announce every SSE frame) |
| generation done | `#live-assertive` | `Klaar. Je website staat live op {slug} punt mijnsaas punt com.` |

The polite region is cleared to `''` for one frame before each new message so identical consecutive strings are re-announced.

### 6.5 Errors

- Inline: `aria-invalid="true"` + `aria-describedby="{id}-hint {id}-err"` (hint kept, so help text is never lost). Message sits **below** the field, `--danger-700`, 14 px, with a 16 px icon. Colour is never the only signal — the border also thickens to 2 px and the icon appears (SC 1.4.1).
- Submit with ≥ 2 errors → **error summary** at the top of the step: `role="alert" tabindex="-1"`, heading *"Er zijn 2 dingen die nog niet kloppen"*, then a `<ul>` of anchor links whose text is the exact error copy; clicking one focuses the field. Focus moves to the summary container.
- 3.3.1 / 3.3.3: every message names the problem *and* the fix. No "Invalid input".
- **3.3.7 Redundant Entry:** never re-ask. Address country pre-fills phone country; GBP-derived values pre-fill their fields; the phone field pre-fills WhatsApp; on resume, everything is restored.
- **3.3.8 Accessible Authentication:** no puzzles, no CAPTCHA the user must solve. Bot defence is Cloudflare Turnstile in **invisible/managed** mode on the submit call only, plus the rate limits in §7.6. Turnstile's managed challenge is cognitive-function-test-free and the whole flow is copy-paste friendly (email fields allow paste — never block it).

### 6.6 Targets, contrast, structure

- **2.5.8 Target Size (Minimum)** is 24×24; we ship **44×44** everywhere on touch (`min-block-size: 44px`), 36 px on fine pointers with a 44 px hit area via `::after` inset expansion. Adjacent targets ≥ 8 px apart. Reorder arrows, day-row switches, chip rows and the close button all measured at 44.
- Contrast (verified): `--n-900 #101828` on `--n-0` = **16.1:1** · `--n-600 #475467` on `--n-0` = **7.6:1** · `--n-500 #667085` on `--n-0` = **5.3:1** (smallest text is 12 px so this passes 4.5) · `--brand-600 #1F44DB` on `--n-0` = **7.2:1** · `--n-0` on `--brand-600` = **7.2:1** · `--danger-700 #B42318` on `--n-0` = **6.4:1** · `--brand-600` border on `--n-50` = **6.9:1** (≥ 3:1 for 1.4.11). Placeholder text uses `--n-500`, never lighter, and never replaces a label.
- One `<h1>` per dialog (visually hidden, carries "step n of 6"), step headings are `<h2>`. Every input has a real `<label for>`; helper text is `aria-describedby`, never a `title`.
- Zoom to 400 % at 320 px width reflows to one column with no horizontal scroll (SC 1.4.10); text spacing overrides (1.4.12) are absorbed because no container has a fixed height.
- Keyboard-complete: the combobox implements the ARIA 1.2 pattern (`↑↓` move `aria-activedescendant`, `Enter` select, `Escape` collapse then clear, `Home/End`), the time grid is arrow-navigable, and there are no keyboard traps (2.1.2).
- Autofill: every field carries the correct `autocomplete` token (SC 1.3.5 Identify Input Purpose).

---

## 7. STATE & RESILIENCE

### 7.1 Draft model

One object, versioned:

```ts
type Draft = {
  v: 1;                       // bump invalidates incompatible local drafts
  draft_id: string;           // 'drf_' + ULID, minted client-side, echoed by server
  idempotency_key: string;    // minted ONCE per draft, reused on every submit attempt
  locale: 'nl'|'en'|'de'|'fr'|'es'|'pt';
  step: 1|2|3|4|5|6;
  furthest_step: number;      // gates forward jumps
  values: { business_name, industry_key, gbp_url, gbp_place_id,
            address:{line1,line2,postal_code,city,country,lat,lng},
            service_area:{city,radius_km}|null,
            opening_hours, phone_e164, whatsapp_e164, whatsapp_same,
            short_description, description_source:'user'|'ai',
            email, marketing_opt_in };
  media: Array<{ id, r2_key, status, mime, bytes, w, h, blurhash, order }>;
  derived_from_gbp: string[]; // field names, for the "we filled this in" badges
  updated_at: number;
};
```

### 7.2 Persistence

- **Local:** `localStorage['aib.onboarding.v1']`, written on a 400 ms trailing debounce plus on `visibilitychange → hidden` and `pagehide`. Never contains file blobs — only R2 keys. Every read is `try/catch`-wrapped (Safari private mode, storage-blocked browsers) and falls back to an in-memory store; the flow must work with storage entirely unavailable.
- **Server:** `PUT /api/v1/onboarding/draft` on a 1200 ms trailing debounce, and immediately on each step advance. Sent with `navigator.sendBeacon` on `pagehide` for the last-gasp save. Auth is the `aib_draft` cookie (`HttpOnly; Secure; SameSite=Lax; Max-Age=2592000; Path=/`) holding a signed `draft_id`. Rows land in `onboarding_drafts` (§9) and are hard-deleted by cron 30 days after last touch (GDPR data-minimisation; documented in the privacy policy as "abandoned draft retention").
- **Conflict rule:** on load, compare `updated_at`; server wins only if strictly newer than local, and only if `v` matches. Otherwise local wins and is pushed up. If both exist and differ by > 60 s, show a one-line, one-tap choice: *"Je hebt een nieuwer concept op een ander apparaat. [Dat gebruiken] [Doorgaan met dit]"*.

### 7.3 Resume

On `/start` load with a non-empty draft, do **not** silently drop the user into step 4 — that is disorienting. Show a 1-step resume card:

> **NL** *Welkom terug. Je was bij stap 4 van 6.* — *Kapsalon Nova · Kapsalon · Amsterdam*  → **Verder waar je gebleven was** · *Opnieuw beginnen* (text link, with a confirm)

Restoring media re-hydrates tiles from `draft_media` with their blurhashes, so the grid looks identical to how the user left it even before the thumbnails re-fetch.

### 7.4 History, deep links, back/forward

- Each step advance is `history.pushState({step:n}, '', '/start?step=' + n)`. Back/forward move steps via `popstate`; back from step 1 closes the modal and restores `/` (using the state stack depth to decide `history.back()` vs `navigate('/')`).
- Deep links are **clamped**: `?step=5` on an empty draft lands on step 1 and replaces state — you can never link someone past validation. `furthest_step + 1` is the ceiling.
- Generation gets its own entry: `/start?job=job_01H…` with `history.replaceState` (so back from the reveal doesn't re-open step 6). During generation, `beforeunload` is **not** used (it wouldn't help — the job survives) but a `visibilitychange`-triggered notification permission prompt is offered once: *"Zullen we je een seintje geven als je site klaar is?"*
- iOS Safari swipe-back is respected because everything is real `pushState` history, not a JS-only state machine.

### 7.5 Double-submit protection

Four independent layers, because this endpoint spends money:

1. **UI:** the button flips to `disabled` + `aria-busy="true"` synchronously in the click handler, before any `await`. Copy changes to *"Bezig…"*. A module-scoped `inflight` promise makes a second call return the first one.
2. **Idempotency:** `Idempotency-Key: <draft.idempotency_key>` header on `POST /api/v1/onboarding/submit`. The Worker `INSERT`s into `generation_jobs` relying on `uq_jobs_idem`; on `SQLITE_CONSTRAINT` it returns the **existing** `job_id` with `200`, not an error. Retries are therefore free and safe.
3. **Job-level:** a Durable Object keyed by `draft_id` serialises submissions; the cooperative lease (`locked_by` / `lock_expires_at`, 120 s) already in `generation_jobs` prevents two Workers running one job, and `idx_jobs_reaper` drives the stuck-job reaper.
4. **Org-level:** one `initial_site` job per org (`sites_limit` = 1); a second attempt returns `409` with the existing job's URL.

### 7.6 Network, offline, slow

- All mutating calls go through one `request()` helper: 12 s timeout via `AbortSignal.timeout`, retry on `408/425/429/5xx` and network errors, 3 attempts, backoff `500 ms × 2^n` with ±25 % jitter, honouring `Retry-After`. `GET`s retry freely; `POST`s retry only with an idempotency key.
- `navigator.onLine` + a failed-request heuristic (2 consecutive network errors) toggles an offline banner pinned under the header: *"Geen verbinding. Je invoer is bewaard — we gaan verder zodra je weer online bent."* The Continue button stays enabled (steps advance locally; drafts flush when `online` fires). Only submit and uploads are gated.
- Slow connections: `navigator.connection.saveData` or `effectiveType ∈ {slow-2g,2g}` → skip the static map thumbnail, skip stock-photo previews, drop image compression target to 1200 px, and reduce upload concurrency to 1.
- **Latency masking:** the address lookup, industry classifier and description drafter each show their own inline skeleton after 250 ms (never before — below 250 ms a spinner reads as jank), with a *"duurt langer dan gewoonlijk"* line at 4 s and a graceful manual fallback at 8 s. **No third-party lookup is ever allowed to block Continue.**
- Rate limits (via the existing `rate_limit_buckets`): `lookup` 30/min/IP · `resolve-gbp` 10/min/IP · `draft-description` 8/min/draft · `media/sign` 40/hour/draft · `submit` 3/hour/IP + 1/draft. Exceeded → `429` with human copy, never a raw error.

---

## 8. VISUAL DIRECTION & DESIGN TOKENS

Brief: *ultra-professional, high-end corporate, bright*. The strategy is **near-monochrome with one disciplined blue**: high-contrast ink on white, generous space, one accent used only for action and progress, no gradients on chrome, shadows that read as paper rather than glow. The colour lives in the customer's *generated site* (the DNA palettes), never in ours — our product must look like the neutral, expensive tool that made it.

### 8.1 Colour ramp

```css
:root{
  /* Neutrals — cool-cast greys */
  --n-0:#FFFFFF;  --n-25:#FCFCFD; --n-50:#F7F8FA; --n-100:#F0F2F5;
  --n-200:#E4E7EC; --n-300:#D0D5DD; --n-400:#98A2B3; --n-500:#667085;
  --n-600:#475467; --n-700:#344054; --n-800:#1D2939; --n-900:#101828;
  --n-950:#0A0F1A;

  /* Brand — "Azurite" */
  --brand-25:#F5F8FF;  --brand-50:#EEF3FF;  --brand-100:#DCE6FF; --brand-200:#BACCFF;
  --brand-300:#8FA9FF; --brand-400:#5F80FA; --brand-500:#3860EE; --brand-600:#1F44DB;
  --brand-700:#1836AF; --brand-800:#142B85; --brand-900:#101F5C;

  /* Accent — used ONLY in generation choreography + the "magic" glyph */
  --violet-400:#9B8AFB; --violet-500:#7C5CF8; --violet-600:#6238E8;

  /* Semantic */
  --success-50:#ECFDF3; --success-500:#12B76A; --success-600:#039855; --success-700:#027A48;
  --warning-50:#FFFAEB; --warning-500:#F79009; --warning-600:#DC6803; --warning-700:#B54708;
  --danger-50:#FEF3F2;  --danger-500:#F04438;  --danger-600:#D92D20;  --danger-700:#B42318;

  /* Roles */
  --bg-page:var(--n-0);      --bg-subtle:var(--n-50);   --bg-sunken:var(--n-100);
  --bg-inverse:var(--n-950);
  --fg-primary:var(--n-900); --fg-secondary:var(--n-600); --fg-tertiary:var(--n-500);
  --fg-on-brand:var(--n-0);  --fg-brand:var(--brand-600);
  --border-subtle:var(--n-200); --border-default:var(--n-300); --border-strong:var(--n-400);
  --border-focus:var(--brand-600);
  --scrim:rgba(9,12,18,.55);
}
```

### 8.2 Type

Two families, self-hosted from R2 behind Cloudflare (no third-party font CDN — GDPR *and* LCP): **Inter Tight** (variable, display: 500/600) and **Inter** (variable, body: 400/500/600). Subsets `latin` + `latin-ext` (needed for nl/de/fr/es/pt and future PL/CS), `font-display: swap`, both `<link rel="preload" as="font" crossorigin>`. Optical fallback stack tuned with `size-adjust` so the swap causes < 0.01 CLS.

```css
:root{
  --font-display:'Inter Tight','Inter var',ui-sans-serif,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
  --font-body:'Inter var',ui-sans-serif,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
  --font-mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;

  /* size / line-height / letter-spacing / weight */
  --text-2xs: .6875rem;  --lh-2xs:1rem;      --ls-2xs:.01em;    /* 11 — legal only */
  --text-xs:  .75rem;    --lh-xs:1.125rem;   --ls-xs:.005em;    /* 12 */
  --text-sm:  .875rem;   --lh-sm:1.375rem;   --ls-sm:0;         /* 14 — helper, labels */
  --text-md:  1rem;      --lh-md:1.5rem;     --ls-md:-.006em;   /* 16 — body, inputs (never smaller: iOS zoom) */
  --text-lg:  1.125rem;  --lh-lg:1.75rem;    --ls-lg:-.011em;   /* 18 */
  --text-xl:  1.25rem;   --lh-xl:1.875rem;   --ls-xl:-.014em;   /* 20 — step question, mobile */
  --text-2xl: 1.5rem;    --lh-2xl:2rem;      --ls-2xl:-.018em;  /* 24 — step question, desktop */
  --text-3xl: 1.875rem;  --lh-3xl:2.375rem;  --ls-3xl:-.021em;  /* 30 */
  --text-4xl: 2.25rem;   --lh-4xl:2.75rem;   --ls-4xl:-.024em;  /* 36 */
  --text-5xl: 3rem;      --lh-5xl:3.5rem;    --ls-5xl:-.028em;  /* 48 */
  --text-6xl: 3.75rem;   --lh-6xl:4.25rem;   --ls-6xl:-.032em;  /* 60 */
  --text-7xl: 4.5rem;    --lh-7xl:4.75rem;   --ls-7xl:-.036em;  /* 72 — hero */

  --display-hero:clamp(2.5rem,1.4rem + 4.6vw,4.5rem);   /* 40 → 72 */
  --display-h2:  clamp(1.875rem,1.3rem + 2.3vw,3rem);   /* 30 → 48 */
  --step-question:clamp(1.25rem,1.05rem + .9vw,1.5rem); /* 20 → 24 */
}
```
Rules: display sizes ≥ 30 px always use `--font-display` at weight 600 with the negative tracking above (this single detail is most of the "high-end" read). Body copy never exceeds **68ch** (`--measure: 68ch`; modal prose is capped at 46ch). Numerals in the progress rail, prices and times use `font-variant-numeric: tabular-nums`.

### 8.3 Spacing (4 px base, 2 px half-step)

```css
--space-0:0; --space-px:1px; --space-0-5:2px; --space-1:4px; --space-1-5:6px;
--space-2:8px; --space-3:12px; --space-4:16px; --space-5:20px; --space-6:24px;
--space-8:32px; --space-10:40px; --space-12:48px; --space-16:64px; --space-20:80px;
--space-24:96px; --space-32:128px; --space-40:160px;
--gutter:clamp(1.25rem,.9rem + 1.6vw,2.5rem);      /* 20 → 40 */
--section-y:clamp(4rem,2.5rem + 6vw,8.5rem);       /* 64 → 136 */
--container:1240px; --container-narrow:768px; --modal-col:640px;
```

### 8.4 Radii

```css
--radius-xs:4px; --radius-sm:6px; --radius-md:10px; --radius-lg:14px;
--radius-xl:20px; --radius-2xl:28px; --radius-full:9999px;
```
Inputs/buttons `--radius-md`. Cards `--radius-lg`. The modal panel `--radius-2xl` (desktop) / `0` (mobile full-bleed). Nested radius rule: `inner = outer − padding`, never equal.

### 8.5 Shadows — paper, not glow

```css
--shadow-xs:0 1px 2px rgba(16,24,40,.05);
--shadow-sm:0 1px 3px rgba(16,24,40,.10), 0 1px 2px rgba(16,24,40,.06);
--shadow-md:0 4px 8px -2px rgba(16,24,40,.10), 0 2px 4px -2px rgba(16,24,40,.06);
--shadow-lg:0 12px 16px -4px rgba(16,24,40,.08), 0 4px 6px -2px rgba(16,24,40,.03);
--shadow-xl:0 20px 24px -4px rgba(16,24,40,.08), 0 8px 8px -4px rgba(16,24,40,.03);
--shadow-2xl:0 24px 48px -12px rgba(16,24,40,.18);
--shadow-modal:0 32px 64px -12px rgba(10,15,26,.24), 0 0 0 1px rgba(16,24,40,.05);
--shadow-focus:0 0 0 4px var(--brand-100);
--shadow-inset:inset 0 -1px 0 rgba(16,24,40,.06);
```

### 8.6 Elevation / z-index

```css
--z-base:0; --z-sticky:100; --z-nav:200; --z-dropdown:300;
--z-scrim:900; --z-modal:1000; --z-toast:1100; --z-tooltip:1200;
```
(`<dialog>` in the top layer sits above all of these; the tokens govern non-dialog chrome.)

### 8.7 Motion tokens

```css
--dur-1:80ms; --dur-2:120ms; --dur-3:180ms; --dur-4:240ms;
--dur-5:320ms; --dur-6:480ms; --dur-7:720ms;
--ease-out-quint:cubic-bezier(.22,1,.36,1);
--ease-in-out:cubic-bezier(.65,0,.35,1);
--ease-in:cubic-bezier(.32,0,.67,0);
--ease-spring:linear(0,.006,.025 2.8%,.101 6.1%,.539 18.9%,.721 25.3%,.849 31.5%,
              .937 38.1%,.968 41.8%,.991 45.7%,1.006 50.1%,1.015 55%,1.017 63.9%,1.001);
--stagger:40ms;
```

### 8.8 Marketing site — hero & nav

**Nav (slim, centred logo).** 64 px tall (56 px on mobile), `background: rgba(255,255,255,0)` while over the hero with white glyphs and a 0–40 % top-down scrim for legibility; on `scrollY > 72` it transitions over 240 ms to `rgba(255,255,255,.82)` + `backdrop-filter: blur(16px) saturate(1.4)`, a `1px --n-200` bottom hairline, `--shadow-xs`, and ink-coloured glyphs. Three-cell grid: left links (`Functies · Prijzen · Voorbeelden`), **centred wordmark 118 × 20 px**, right (`Inloggen` text link + `Start gratis` button 36 px). Mobile: hamburger left, centred wordmark, CTA right. Links `--text-sm/500/--n-700`, hover `--n-900` with a 1 px underline that grows from centre in 180 ms.

**Hero.** Full-viewport (`min-height: 100svh`, `100dvh` fallback), **bright and light** — the video is a high-key, over-exposed scene (a sunlit shop counter, a bright studio) with a `linear-gradient(180deg, rgba(255,255,255,.35), rgba(255,255,255,.72) 62%, #FFFFFF 100%)` wash so the ink headline sits at ≥ 12:1 and the section dissolves into the white page below. Content is centred, max 20ch headline at `--display-hero`, `--font-display` 600, `--ls-7xl`.

Performance rules that keep Lighthouse at 100:
- `<video autoplay muted loop playsinline preload="none" poster="hero-1600.avif">`, `poster` preloaded with `fetchpriority="high"` — **the poster is the LCP element**, not the video.
- The video `src` is attached only after `load` + `requestIdleCallback`, and never when `saveData` or `effectiveType ∈ {slow-2g,2g,3g}` or `prefers-reduced-motion: reduce` — those users get the still poster, which is a legitimate, beautiful hero on its own.
- Two encodings: AV1/MP4 1280×720 ~1.2 Mbps for wide, and a **9:16 crop** for `(max-width: 640px)` via `<source media>` so phones never download the wide file. Hard cap 2.8 MB.
- `content-visibility: auto` + `contain-intrinsic-size` on every section below the fold; hero text ships in the initial HTML with no client JS.

---

## 9. SCHEMA & API DELTAS THIS SPEC REQUIRES

The existing migrations cover ~90 % of this. Four gaps, all additive — proposed `0010_onboarding.sql`:

1. **`onboarding_drafts`** — does not exist. Needed for server-side draft/resume before a user or org exists.
   `id TEXT PK ('drf_'+ULID) · locale · step · furthest_step · payload TEXT (json_valid, ≤ 32768) · idempotency_key TEXT · ip_country · ua_hash · created_at · updated_at · expires_at · claimed_by_user_id (FK users, nullable) · job_id (FK generation_jobs, nullable)`; indexes on `expires_at` (cron purge) and `claimed_by_user_id`.
2. **`draft_media`** — `media_assets.site_id` is `NOT NULL REFERENCES sites(id)`, so onboarding uploads (which happen before any site row) cannot land there. Add a staging table with the same shape minus `site_id`/`org_id`, plus `draft_id`, and a promotion step in the submit transaction that copies rows into `media_assets` once `sites.id` exists. **Do not** relax `media_assets.site_id` to nullable — it would weaken every downstream query.
3. **`industry_groups`** + two columns on `industries` — `industries` has no parent/group and no icon, which the combobox (§2.2) needs.
   `industry_groups(key TEXT PK, icon TEXT, sort_order INTEGER, created_at)` + `industry_group_translations(group_key, locale, label)`; `ALTER TABLE industries ADD COLUMN group_key TEXT REFERENCES industry_groups(key)`, `ADD COLUMN icon TEXT`. Seed all 14 groups + the 104 rows of §3.1, with `design_preset` carrying `"dna"` and the §3.2 expansion.
4. **`industry_translations.search_terms`** is already there — populate it (it is currently NULL in `0009`). Minimum 6 aliases per leaf per locale; this column *is* the search quality.

**Endpoints (Phase 1):**

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/onboarding/bootstrap` | locale, `cf.country`, industries JSON (ETag, `cache-control: public, max-age=3600`), existing draft |
| `GET` | `/api/v1/onboarding/lookup?q=` | Places text search, the "Ben jij dit?" cards |
| `POST` | `/api/v1/onboarding/resolve-gbp` | expand + Places Details + field diff |
| `GET` | `/api/v1/geo/autocomplete?q=&country=` | address suggestions (KV-cached 24 h) |
| `POST` | `/api/v1/geo/resolve` | NL/BE postcode + number → full address |
| `GET` | `/api/v1/onboarding/slug-check?slug=` | availability vs `reserved_slugs` + `uq_sites_slug` |
| `POST` | `/api/v1/onboarding/classify-industry` | free text → `industry_key` (opus-5, low effort, parse) |
| `POST` | `/api/v1/onboarding/draft-description` | streaming AI description, 2 variants |
| `POST` | `/api/v1/onboarding/media/sign` | presigned R2 PUT / multipart init |
| `POST` | `/api/v1/onboarding/media/commit` | verify + row in `draft_media` |
| `PUT` | `/api/v1/onboarding/draft` | debounced autosave |
| `POST` | `/api/v1/onboarding/submit` | Turnstile → user+org+site+job in one `batch()` with `PRAGMA defer_foreign_keys=on`; returns `job_id` |
| `GET` | `/api/v1/jobs/{id}/events` | SSE from the Durable Object, `Last-Event-ID` resume from `generation_job_events` |

**SSE frame contract** (`id` = `generation_job_events.id`, so `Last-Event-ID` resumption is a single indexed range scan):

```
id: 4821
event: progress
data: {"seq":17,"phase":"streaming","progress":41,
       "message":"Homepage — over ons","
       data":{"slot":"about.body","text":"Al ruim twaalf jaar…","locale":"nl"}}
```

---

## 10. RISKS THE IMPLEMENTATION MUST NOT WAVE AWAY

1. **Google Places licensing.** Caching anything but `place_id` beyond 30 days breaches the Places ToS, and re-hosting Google photos in R2 breaches it outright. Build the 30-day refresh cron *now*, not in Phase 3 — retrofitting it after 10k sites is a rewrite.
2. **`libphonenumber-js/max` is 145 KB.** It must be a lazy import triggered on step-5 focus, or step 1's TTI regresses and the marketing page's Lighthouse score goes with it if the bundles are shared.
3. **`generation_job_events.phase` is a fixed CHECK enum.** The 7-act theatre in §5.5 is mapped onto exactly those 12 values on purpose. Any new user-facing act must reuse an existing phase and vary `data`, or ship a migration — do not invent phase strings in the Worker.
4. **HEIC.** Roughly a third of iPhone uploads in the EU are HEIC and Chrome/Firefox cannot decode them. Without the `heic2any` fallback these silently fail, and they will fail *disproportionately for the users most likely to convert*.
5. **`users.email NOT NULL`** forces the email ask before generation (D4). If product later wants a truly anonymous preview, that is a schema change (nullable email + a `ghost` user status), not a UI change — decide before launch, not after.