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
