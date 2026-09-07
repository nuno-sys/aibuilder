# Client decisions — 2026-09-06

These override `00-ARCHITECTURE.md` wherever they conflict. Recorded because three of them are
one-way doors and the fourth inverts the product's conversion flow.

## D1. Separate control-plane domain — ACCEPTED

Marketing, dashboard, API and preview move to a control-plane domain that the client is registering.
`mijnsaas.com` stays the tenant plane (`<slug>.mijnsaas.com`, custom hostnames, `cdn.`).

**The name is not yet known.** Until it is, the placeholder `aibuilder.app` stands, and it appears in
exactly these places — nowhere else, by design:

- `apps/*/wrangler.jsonc` → `routes[].pattern`, `routes[].zone_name`, `vars.APP_ORIGIN`
- `.env.example`, `.dev.vars.example`
- `README.md` bootstrap section

Swapping it is a find-and-replace over those files plus a redeploy. **It must happen before the
first tenant slug is indexed**, not before the first deploy.

## D2. Stripe trial BEFORE the first generation — ACCEPTED, and it inverts the funnel

The blueprint made the first generation free and put the paywall on Regenerate. The client has
chosen the opposite: no Opus spend happens until a card is on file.

### What this changes

**The submit flow.** `POST /v1/onboarding/submit` no longer dispatches the Workflow. It validates,
screens, reserves the slug, creates user + organisation + site + a `generation_jobs` row in
`awaiting_payment`, and returns a Stripe Checkout URL. The Workflow is dispatched by the
`checkout.session.completed` webhook — **never by the `success_url` redirect**, which is not a
payment guarantee and which a user can skip by closing the tab.

**A race the UI must handle.** The user can land on `success_url` before the webhook arrives. The
job page therefore has a real `awaiting_payment` state with its own copy, and the SSE stream opens
against a job that has not started yet. It must not look like a failure.

**Idempotency moves up a level.** Stripe redelivers. Dispatch is keyed on the job id, and
`stripe_events` is written insert-before-process with a claim token — a bare `status <> 'processed'`
test is not enough, because D1 has no interactive transactions and two concurrent redeliveries both
pass it.

**Identity gets stronger, so two Phase 1 mitigations relax.** A card is the strongest anti-spam
signal available and Checkout confirms the e-mail. The provisional-organisation and claim-token
dance stays (the org is still unreachable until a membership exists) but it is now driven by the
webhook rather than by an e-mailed link. `index_state` no longer waits for card-on-file, because
card-on-file is now a precondition of the site existing at all; it still waits for the quality gate.

**Regenerate stops being the conversion trigger.** Everyone who has a site has an entitlement. The
server-side gate on `POST /v1/sites/:id/regenerate` stays exactly as specified — it is a correctness
boundary, not a growth mechanism — but in practice it now fails only on a lapsed subscription. The
real limiter is the quota: 2 regenerations per 30 days.

**Abuse economics improve, the controls stay.** `BudgetDO`'s $500/day cap, `QuotaDO`, the rate-limit
bindings, Turnstile and the Haiku intake screen all remain. They now protect against a card-testing
attacker rather than a free-generation farmer, which is a smaller but not empty threat.

### Trial abuse

Before creating a Checkout Session, look up prior trials by `email_normalized` **and by
`card.fingerprint`**. The fingerprint is what actually stops "new e-mail, same card"; the e-mail
check alone stops nothing.

## D3. Workers Static Assets instead of Cloudflare Pages — ACCEPTED

No change to what is built. One deployment primitive across all deployables.

## D4. Phase 2 in full — editor and trial-wall

Scope agreed. Note the ordering constraint: the live editor previews a rendered site, so
`packages/site-kit` and `apps/renderer` — descoped from Phase 1 — are prerequisites, not optional
extras. They are built first within Phase 2.

## D5. A pre-built media library, not a stock search — ACCEPTED

Requested directly: pre-download and optimise three to four clips per category, have the builder
call them during generation so a site is ready instantly, and choose on the site's colours and real
relevance. Accepted as specified, and it replaces the per-generation stock search that the first
media design assumed.

**What it removes.** A third-party API on the critical path of the one operation a customer is
watching; a rate-limited quota spent per signup; unvetted results; and a transcode a Worker cannot
perform. Selection becomes an array filter over data already in the bundle.

**What it costs.** The library has to be filled deliberately. That is a feature: it is the only way
to guarantee a human has looked at every clip that ships.

**Keyed on the industry GROUP** (14), not the industry (104) and not the archetype (4). A bakery and
a coffee bar want the same kind of scene; below the group the library is unfillable, above it the
footage stops being about the trade.

**Luminance is a hard constraint, hue is a soft preference.** Both are measured off the pixels at
ingest, never declared in a sidecar: they are the two properties a human judges worst and the
renderer depends on most. Dark footage under a light theme's ink is unreadable — that is a defect.
A hue mismatch is a missed opportunity. Selection is seeded on the site id, so the choice is stable
across re-runs and different between two businesses in the same trade.

### The three gaps this closed

Every piece of the video path had been built and none of it reached a page. Worth recording,
because all three failed silently and none of them broke a test:

1. **`heroFor()` in the render step returned `video: null`** behind a comment saying video was out
   of scope. The library was ingested, the catalogue bundled, the selector run and
   `SiteDoc.heroVideo` populated — and the composition root dropped it. Every generated site had a
   still header.
2. **There was no URL for a library object.** `assetPath` had no `library` kind, so even a wired-up
   renderer could not have addressed one. Now `/_a/l/<key>` → `library/<key>`, same-origin, parsed
   against a closed grammar, with `media:upload` putting the bytes there.
3. **`checkPosterInvariant` had no caller.** The §7.17 guard existed and was tested for months
   without ever running, because the guard and the feature arrived separately. It runs on every
   rendered page now, together with a per-breakpoint byte budget.

### The phone gets its own everything

A phone handed the 1920×1080 file is the single decision that gives background video its bad
reputation. Each clip therefore carries a 720×1280 encode at a tighter CRF — measured at roughly a
quarter of the bytes — and each poster carries a 9:16 ladder as well as a 16:9 one.

The portrait ladder is not art direction for its own sake. LCP scores an image at
`min(visible area, intrinsic area)`, so cover-fitting a 16:9 still into a 9:16 viewport picks a rung
*smaller* than the hero is displayed at: the poster is scored down, the portrait video is scored at
the full box, and the video takes the LCP entry. Every portrait rung is larger than any phone hero
is displayed at, so the poster is never capped and the video can at best tie — and a tie keeps the
poster, because the algorithm only replaces a candidate with a strictly larger one.

### Refusal is on evidence, never on absence

The mount gate refuses a video when the platform positively reports a reason: Data Saver on, a
measured 2g/3g connection, a measured downlink under 1.5 Mbps, or a device reporting under 2 GB.
The Network Information API does not exist in Safari or Firefox, so treating "unknown" as "slow"
withholds the header from every iPhone — the majority of the phones this is read on, and exactly
the device the full-screen video was asked for.

### The marketing site is a tenant of its own pipeline

The sales page's header is the `brand` clip, ingested by the same encoder with the same budgets and
staged into `apps/marketing/public/`. It previously named binaries that existed only in a comment,
so the page that sells a fast video header shipped an empty box. A promise about speed is only
credible while the page making it serves the bytes the product produces.

### Open, and the client's to decide

- **Licence.** Pexels requires a visible credit on every customer site; a one-off paid library
  licence for ~56 clips does not. The schema carries `credit` per clip and the footer renders it,
  so either answer works — but the choice changes what a customer's footer says.
- **Curation.** 14 groups × 4 clips, minimum two light and two dark per group. The pipeline runs
  end to end on abstract stand-ins today; every one is labelled `placeholder: true` in its sidecar.
