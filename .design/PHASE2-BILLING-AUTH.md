# Phase 2 — Trial-first billing and authentication

**Status:** design, ready to implement. **Supersedes** `00-ARCHITECTURE.md` §3c wherever the two
disagree, because `DECISIONS.md` §D2 inverted the funnel after §3c was written. Where this document
and `VERIFIED-FACTS.md` disagree, `VERIFIED-FACTS.md` wins.

**What changed, in one line.** The Stripe 7-day trial now happens *before* the first generation.
`POST /v1/onboarding/submit` returns a Checkout URL and dispatches nothing; the
`checkout.session.completed` **webhook** dispatches the Workflow; the `success_url` redirect never
does, because a redirect is a browser navigation and not a payment guarantee.

---

## 0. Verification log

Everything below marked **[V]** was checked against the real artefact on 2026-09-06, not recalled.
Anything not marked **[V]** is a design decision and is argued for in place.

| # | Claim | How it was verified |
|---|---|---|
| V1 | `stripe` npm latest is **22.6.1**; its pinned API version is **`2026-08-26.dahlia`** | `npm pack stripe@latest`, read `package.json` + `esm/apiVersion.d.ts` |
| V2 | `Stripe.createSubtleCryptoProvider()`, `Stripe.createFetchHttpClient()` and `Stripe.webhooks.constructEventAsync()` all exist in v22 and are unchanged by the v22 breaking-change list | read `esm/stripe.core.d.ts`, `esm/platform/PlatformFunctions.d.ts`, `esm/Webhooks.d.ts`; read the v22 migration guide (breaking changes are types, callbacks, per-request `host`, positional API keys — nothing about webhooks or crypto providers) |
| V3 | `Webhook.DEFAULT_TOLERANCE` is **300 seconds** | read `esm/Webhooks.js` |
| V4 | `Subscription.current_period_start/end` **no longer exist**; the period lives on `subscription.items.data[i].current_period_{start,end}` (deprecated in `2025-03-31.basil`) | `tsc` probe: reading `sub.current_period_end` errors, `sub.items.data[0].current_period_end` is `number` |
| V5 | `Invoice.tax` **no longer exists**; the aggregate is `invoice.total_taxes: Array<{amount, tax_behavior, taxable_amount, …}> \| null` | same `tsc` probe + `esm/resources/Invoices.d.ts` |
| V6 | `Invoice.hosted_invoice_url` and `Invoice.invoice_pdf` are `string \| null \| undefined` (optional) | `tsc` probe error message |
| V7 | Checkout create accepts `payment_method_collection`, `subscription_data.trial_period_days`, `subscription_data.trial_settings.end_behavior.missing_payment_method`, `client_reference_id`, `automatic_tax`, `tax_id_collection`, `billing_address_collection`, `consent_collection.terms_of_service`, `expires_at`, `locale: 'nl'` | `tsc` probe compiled clean against 22.6.1 |
| V8 | `payment_method_collection` **can only be set in `subscription` mode**, default `always` | doc comment on `SessionCreateParams.payment_method_collection` |
| V9 | `customer_creation` **can only be set in `payment` and `setup` mode** — so in `subscription` mode a Customer is always created and the parameter must not be sent | doc comment on `SessionCreateParams.customer_creation` |
| V10 | `customer_update` is only accepted when `customer` is also provided | doc comment |
| V11 | `expires_at` is **30 minutes to 24 hours** after creation, default 24 h | doc comment |
| V12 | `missing_payment_method` ∈ `'cancel' \| 'create_invoice' \| 'pause'` | `esm/resources/Subscriptions.d.ts:870` |
| V13 | `Checkout.Session.status` ∈ `'complete' \| 'expired' \| 'open'`; `payment_status` ∈ `'no_payment_required' \| 'paid' \| 'unpaid'` | `esm/resources/Checkout/Sessions.d.ts:688,607` |
| V14 | `Subscription.status` ∈ `active, canceled, incomplete, incomplete_expired, past_due, paused, trialing, unpaid` — **plus `OtherString`**, i.e. the SDK explicitly models future values | `esm/resources/Subscriptions.d.ts:478` |
| V15 | `PaymentMethod.card.fingerprint` is `string \| null` and on some shapes **optional** — it can be absent | `esm/resources/PaymentMethods.d.ts:284,356`; `tsc` probe types it `string \| null \| undefined` |
| V16 | `Checkout.Session.locale` includes `'nl'` | `esm/resources/Checkout/Sessions.d.ts:530` |
| V17 | Billing portal `flow_data.type` includes `'subscription_cancel'` and `'payment_method_update'` | `esm/resources/BillingPortal/Sessions.d.ts:133` |
| V18 | Every event type this document handles exists in the SDK's event union, and `event.type` narrows `event.data.object` | grep + `tsc` narrowing probe |
| V19 | `RequestOptions` accepts `{ idempotencyKey, maxNetworkRetries }`; `Stripe.errors.StripeSignatureVerificationError` is a constructible class | `tsc` probe |
| V20 | Stripe waits **30 s** for a 2xx and retries with exponential backoff for **up to 3 days** (~16–25 attempts), then disables the endpoint | web search, multiple independent sources; consistent with our `stripe_events.attempts CHECK BETWEEN 0 AND 25` |
| V21 | **`ALTER TABLE … ADD COLUMN … NOT NULL DEFAULT 'x' CHECK (…)` works on a populated STRICT table and the CHECK is enforced on subsequent INSERT *and* UPDATE** | ran it under `node:sqlite` against a table with rows |
| V22 | Applying `migrations/shard/0001..0004` then the three Phase-2 `ADD COLUMN`s and the new partial index succeeds; an `awaiting_payment` row (`status='queued'`, `queue_ready_at=NULL`) satisfies every existing CHECK; `SQL_LIST_QUEUED_JOBS` does not see it; after release it does; the deadline query plan is `SEARCH … USING INDEX idx_jobs_awaiting_payment` (no SCAN, so the CI EQP gate passes) | ran the real migration files under `node:sqlite` |
| V23 | `@simplewebauthn/server@14.0.1` contains **zero** `node:` imports, bundles clean for the `workerd` condition (0 unresolved builtins, 85 KB min+gzip) and its option/verify functions run on Web Crypto alone | `npm pack`, grep, `esbuild --conditions=workerd,worker,browser`, executed the bundle |
| V24 | EU OSS: once combined cross-border B2C sales exceed **€10 000/calendar year**, the customer's country rate applies and OSS registration is the single-return mechanism; below it, the country-of-origin rate applies | web search (Stripe's own OSS guides, independent tax practices) |
| V25 | Stripe Checkout does **not** run a 3DS challenge when the subscription starts with a trial; it sets the card up for future off-session use via a SetupIntent, so the authentication risk moves to the **first real charge** at trial end | web search (Stripe support + SCA guides) |

Two facts from V4/V5 are load-bearing and easy to get wrong: `subscriptions.current_period_start/end`
and `invoices.tax_cents` in our own schema must be **derived**, not copied field-for-field.

---

## 1. The full sequence

Actors: **M** = the modal (`apps/marketing`), **A** = `apps/api`, **B** = `apps/billing` (new),
**G** = `apps/generator`, **S** = Stripe, **CP** = `aibuilder-cp`, **SH** = `aibuilder-shard-000`.

`B` is a new Worker. It is the only holder of `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`
(architecture §8: capability separation on Workers means splitting Workers). `A` reaches it through
a `BILLING` service binding exactly as it reaches `G` through `GENERATOR`. `B` has exactly one
public route — `POST /v1/stripe/webhook` — because Stripe must be able to reach it; everything else
on that Worker answers 404 and is reachable only over the service binding.

### Step 1 — `POST /v1/onboarding/submit` (M → A), unchanged prefix

`apps/api/src/routes/submit.ts` runs exactly the Phase 1 ladder, in order, unchanged:
`requireAnonSession` → `rateLimitByIp('RL_SUBMIT')` → `currentDraft` → Zod `IntakeSchema` →
`replaySubmitted` when the draft is not `open` → Turnstile (`action=submit`, `cdata=draft.id`) →
`QuotaDO.consume` → `BudgetDO.reserve` → Haiku policy screen → `resolveAvailableSlug`.

**HTTP so far:** `403 turnstile_failed` · `409 quota_exceeded` · `451 policy_rejected` ·
`422 validation_failed` · `409 slug_unavailable`. All unchanged.

### Step 2 — NEW: the pre-Checkout prior-trial screen (A → CP)

Immediately after the slug resolves and **before** any row is written:

```
SELECT 1 FROM trial_grants
WHERE email_normalized = ?1 AND outcome IN ('granted','converted') LIMIT 1
```

(`trial_grants` is a new CP table, §5.) On a hit: release the budget reservation
(`settleBudget(actual = 0)`) and the quota, write one `abuse_events` row, and answer

```
409 { error: "trial_already_used",
      message:  "Met dit e-mailadres is al een proefperiode gebruikt. Log in of neem contact op.",
      messageEn:"A trial has already been used with this e-mail address. Sign in, or contact us.",
      signInUrl: "https://app.<domain>/inloggen" }
```

`409` and not `402`: nothing about the request is unpaid, the identity is ineligible.

The card-fingerprint half of §D2's "e-mail **AND** `card.fingerprint`" **cannot run here** — the card
does not exist until the customer is inside Checkout. It runs in the webhook, §5.

### Step 3 — the control-plane batch (A → CP), unchanged statements

One atomic `batch()`, same four statements as Phase 1, same order (dictated by
`trg_sites_shard_ownership_ins` and the `onboarding_drafts.site_id` FK):

1. `cp.orgs.SQL_INSERT_PROVISIONAL_ORG` → `organisations(provisional=1, plan='free', entitlement='none', entitlement_until=NULL, shard_id=draft.shard_id, country)`
2. `cp.users.SQL_INSERT_USER` — only when `getUserByEmail` returned `null`. `email_verified_at` stays `NULL`. **Checkout does not prove control of a mailbox**; it collects an address and mails a receipt to it. Nothing in this flow may set `email_verified_at`; only a consumed `magic_link` token does (§6).
3. `cp.sites.SQL_INSERT_SITE` → `sites(status='onboarding', index_state='noindex', canonical_host='<slug>.<SITES_ROOT_DOMAIN>')`
4. `cp.drafts.markDraftSubmittedStatement` → `onboarding_drafts(status='submitted', site_id, org_id, generation_job_id, submitted_at)`

Concurrency is handled exactly as Phase 1 handles it: the transition's `meta.changes !== 1`, or a
collision on the total `uq_sites_slug_total`, both land on `replaySubmitted`.

### Step 4 — the shard batch (A → SH), one changed statement

```
runBatch(SH, [
  SQL_INSERT_GENERATION_JOB_AWAITING_PAYMENT(...),   // NEW statement, §8.3
  shard.media.promoteDraftMediaStatement(...),        // unchanged
])
```

The new statement writes:

| column | value | why |
|---|---|---|
| `kind` | `'initial_site'` | unchanged |
| `requires_entitlement` | **`1`** (was `0`) | §D2: everything is now gated. `CHECK (kind = 'initial_site' OR requires_entitlement = 1)` is a floor, so `1` on `initial_site` is legal — **verified [V22]** |
| `status` | `'queued'` | see the box below |
| `queue_ready_at` | **`NULL`** (was `now`) | the sentinel is what the drain seeks; a NULL sentinel means "exists, not runnable" |
| `payment_state` | **`'awaiting_payment'`** | new column, §8.1 |
| `payment_deadline_at` | `now + 30 min` | overwritten in step 6 with Stripe's own `expires_at` |
| `checkout_session_id` | `NULL` | attached in step 6 |
| `budget_reserved_micro` | `GENERATION_ESTIMATE_USD_MICRO` | unchanged |
| `created_by` | **`userId`** (was `null`) | the user row now exists in the same batch and the return route needs it to mint a session without re-deriving the identity from the draft |

> **Why `awaiting_payment` is not a `generation_jobs.status` value.**
> Widening `CHECK (status IN (…))` is a 12-step table rebuild, and `generation_jobs` is a cascade
> parent of `generation_calls` and `generation_job_events`. `migrations/shard/0004_generation.sql`'s
> own header, and architecture §5.4, forbid rebuilding a cascade parent on D1 outright: D1 rejects
> `PRAGMA foreign_keys=OFF`, `defer_foreign_keys` defers constraint *checking* and not FK *actions*,
> so the rebuild silently cascade-deletes every child while `foreign_key_check` reports success.
> The forward-safe encoding is therefore an **added column** plus the existing status vocabulary:
> `status='queued'` with `queue_ready_at IS NULL` is already a legal, non-runnable state
> (`CHECK (status IN ('queued','running','streaming') OR queue_ready_at IS NULL)` is satisfied
> vacuously by the left disjunct), and `idx_jobs_queue` is partial on `queue_ready_at IS NOT NULL`
> so the drain cannot see it. All of this was executed against the real migration files: **[V21][V22]**.

### Step 5 — release the budget reservation (A → BudgetDO)

`settleBudget({ reservationId, actualMicro: 0 })`. **No Opus spend has been authorised yet**, and
the reservation must not sit against the daily ceiling for the 30 minutes the customer spends
deciding. The reservation is re-taken by the generator's dispatcher when the webhook releases the
job — that is the moment spend becomes imminent. Quota is *not* released: a submit consumed a
generation slot whether or not the card lands, otherwise the quota is trivially farmed by
abandoning Checkout.

### Step 6 — create the Checkout Session (A → B → S)

`A` calls `env.BILLING.fetch('https://billing.internal/v1/checkout-sessions', { method: 'POST' })`
with identifiers only:

```jsonc
{ "orgId","userId","siteId","jobId","draftId","shardId",
  "email", "locale": "nl", "country": "NL", "businessName", "slug" }
```

`B` re-runs the `trial_grants` e-mail lookup (defence in depth: `B` owns the ledger, and `A` could
be replayed), then calls Stripe **once**:

```ts
const session = await stripe.checkout.sessions.create(
  {
    mode: 'subscription',
    line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
    client_reference_id: orgId,
    customer_email: email,
    payment_method_types: ['card'],
    payment_method_collection: 'always',
    billing_address_collection: 'required',
    tax_id_collection: { enabled: true },
    automatic_tax: { enabled: true },
    consent_collection: { terms_of_service: 'required' },
    locale: 'nl',
    subscription_data: {
      trial_period_days: 7,
      trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
      description: businessName.slice(0, 500),
      metadata: { org_id, user_id, site_id, job_id, draft_id, shard_id: String(shardId) },
    },
    metadata: { org_id, user_id, site_id, job_id, draft_id, shard_id: String(shardId) },
    expires_at: Math.floor(Date.now() / 1000) + 1800,
    success_url: `${env.API_ORIGIN}/v1/billing/return?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.APP_ORIGIN}/start/?job=${jobId}&checkout=cancelled`,
  },
  { idempotencyKey: `cs:${jobId}:${attempt}`, maxNetworkRetries: 2 },
);
```

`customer_creation` is **not** sent — it is rejected in `subscription` mode **[V9]**, where a
Customer is always created. `customer_update` is **not** sent — it is only accepted alongside an
existing `customer` **[V10]**.

`A` then attaches the session to the job:

```
UPDATE generation_jobs
   SET checkout_session_id = ?2, payment_deadline_at = ?3, updated_at = ?4
 WHERE id = ?1 AND payment_state = 'awaiting_payment'
```

A `meta.changes === 0` here means the webhook already won the race (the customer paid before this
statement landed — possible, Stripe is fast). That is not an error: `A` re-reads the row and
answers with whatever `payment_state` it now holds.

**Response.** `202` (first call) / `200` (idempotent replay):

```jsonc
{ "jobId": "job_…", "slug": "mijn-kapsalon",
  "siteUrl": "https://mijn-kapsalon.mijnsaas.com",
  "eventsUrl": "/v1/jobs/job_…/events",
  "paymentState": "awaiting_payment",            // NEW
  "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_…",   // NEW
  "checkoutExpiresAt": 1757203200000 }           // NEW, epoch ms
```

If `B` or Stripe fails, `A` answers `402 checkout_unavailable` with the job id. The job row exists
and is durable; `POST /v1/billing/checkout/:jobId` (§8.2) mints a session for it later. Nothing the
customer entered is lost — the same promise Phase 1's `budget_deferred` makes.

### Step 7 — the browser goes to Stripe (M)

`window.location.assign(checkoutUrl)` — a **top-level navigation**. Checkout must never be framed,
and `apps/api`'s `x-frame-options: DENY` plus Stripe's own frame-ancestors policy make that
structural rather than a convention.

### Step 8 — Stripe (S)

Card collected and set up for future off-session use. **No charge, and no 3DS challenge** — a
trial-start Checkout creates a SetupIntent, not a PaymentIntent **[V25]**. `payment_status` on the
completed session is `'no_payment_required'` **[V13]**, which is the correct value to assert against
and *not* `'paid'`.

### Step 9 — `checkout.session.completed` (S → B), the only dispatcher

Full handler in §4. Its writes, in order:

1. `stripe_events` insert-before-process + claim (§4.4).
2. **Re-read from the Stripe API**: `sessions.retrieve(id)` and
   `subscriptions.retrieve(session.subscription, { expand: ['default_payment_method','items.data.price'] })`.
3. Fingerprint trial-abuse check (§5). On a hit the flow diverges and the Workflow is never dispatched.
4. One CP `batch()`:
   - `INSERT OR REPLACE INTO stripe_customers (…, default_pm_brand, default_pm_last4, default_pm_fingerprint, tax_country, …)`
   - `INSERT OR REPLACE INTO subscriptions (…)` — `current_period_start/end` from `items.data[0]` **[V4]**
   - `cp.users.insertMembershipStatement(orgId, userId, 'owner', acceptedAt = now)`
   - `cp.orgs.deprovisionOrganisationStatement(orgId, billingEmail)` — **must be after the membership**, `trg_orgs_deprovision_needs_member` aborts otherwise
   - `cp.orgs.setEntitlementStatement(orgId, 'trialing', entitlementUntil = trial_end_ms, plan = 'pro')`
   - `cp.sites.SQL_SET_INDEX_STATE(siteId, 'eligible')`
   - `INSERT INTO trial_grants (…, outcome='granted')`
5. One SH write, guarded:
   ```
   UPDATE generation_jobs
      SET payment_state = 'paid', queue_ready_at = ?2, updated_at = ?2
    WHERE id = ?1 AND payment_state = 'awaiting_payment'
   ```
   `changes === 1` means *this* delivery won the release. `changes === 0` means a redelivery already
   did it — not an error, and the handler proceeds to step 6 anyway because dispatch is itself
   idempotent.
6. `env.GENERATOR.fetch('https://generator.internal/v1/generations', …)` with the same body
   `apps/api` sends today. The Workflow instance id **is** the job id, so a duplicate create answers
   409 and that counts as success.
7. `stripe_events` → `processed`. **200** to Stripe.

Note that step 4's batch is where §D2's "the claim-token dance is now driven by the webhook" lands:
the org is de-provisioned by the membership insert here, not by an e-mailed link. `site_claim_tokens`
and `GET /claim` survive **unchanged**, as the recovery path (§6.6).

### Step 10 — the customer returns (S → browser → A)

`GET /v1/billing/return?session_id=cs_…`, on `api.<domain>`, requires the `__Host-aib_draft` cookie.
Full behaviour, including the case where it arrives *before* step 9, is §2.3.

### Step 11 — SSE

`GET /v1/jobs/:jobId/events` — unchanged authorisation (draft cookie, on connect **and** on every
`Last-Event-ID` resume), with one addition described in §2.2: a synthetic, **id-less** `payment`
frame emitted before the JobHub stream is proxied.

---

## 2. The race

### 2.1 The job's payment states

`payment_state` is a new `generation_jobs` column, orthogonal to `status`.

```
                 submit
                   │
                   ▼
          ┌──────────────────┐  checkout.session.completed   ┌──────┐
          │ awaiting_payment │ ────────────────────────────► │ paid │──► Workflow
          └──────────────────┘                               └──────┘
             │            ▲
   checkout. │            │ POST /v1/billing/checkout/:jobId
   session.  │            │ (re-mint, ≤ 5 times)
   expired   ▼            │
          ┌───────────┐───┘
          │ abandoned │
          └───────────┘
                   │  30 days, provisional-org purge
                   ▼
              (row deleted)
```

`not_required` is the fourth value: `regenerate_site` and every other later `kind` is created by an
already-entitled org and never sees Checkout.

**`abandoned` is deliberately not terminal on `status`.** The temptation is to write
`status='blocked_paywall'`, but that status requires `finished_at IS NOT NULL` and
`SQL_FINISH_JOB_FAILED` refuses to transition out of a terminal status — which would make "pay after
all" impossible without a second job row, a second `idempotency_key`, and a second slug reservation.
So an abandoned checkout leaves `status='queued', queue_ready_at=NULL` and only moves
`payment_state`. One draft has exactly one job for its whole life; it may have many Checkout
Sessions.

### 2.2 What the SSE stream sends

`apps/api/src/routes/jobs.ts`, before proxying to `JobHub`:

```
event: payment
data: {"paymentState":"awaiting_payment","deadlineAt":1757203200000,
       "resumeUrl":"/v1/billing/checkout/job_01J…"}

```

**The frame carries no `id:` field, on purpose.** Per the SSE specification a message without an
`id:` does not update the client's last-event-id, so this frame cannot corrupt the `Last-Event-ID`
cursor that the JobHub's `seq` numbers own. Using `id: 0` would have been a bug the first time a
client reconnected.

Then the handler proxies `JobHub` exactly as it does today. During `awaiting_payment` the DO's log
is empty, so the client sees only `: ping` heartbeats every 15 s — which is what keeps the
connection alive through the intermediaries that would otherwise close it.

**Nothing polls.** When the webhook releases the job it dispatches the Workflow, whose very first
act is `emitter.emit('claimed', { phase: 'queued' })` (`apps/generator/src/workflow.ts:365`). That
event flows through the DO to every connected subscriber within a second of the release. The API
adds no polling loop, holds no timer, and makes no extra D1 read: the transition arrives as an
ordinary progress event. If dispatch fails, the generator's queue drain picks the job up on its next
pass and the same event is emitted then.

On reconnect the handler re-reads the job and re-emits the `payment` frame if and only if
`payment_state !== 'paid'`, so a client that reconnects after the release does not see a stale
payment frame.

`GET /v1/jobs/:jobId` (the polling fallback) gains two fields:

```jsonc
{ "status":"queued", "phase":"queued", "progress":0, "message":null,
  "paymentState":"awaiting_payment", "checkoutExpiresAt":1757203200000 }
```

and `phaseForStatus`/`progressForStatus` are made payment-aware so an `awaiting_payment` job does
not report `phase:"queued", progress:0` as though the model were already thinking.

### 2.3 The redirect that beats the webhook

`GET /v1/billing/return?session_id=cs_…` (new route, `apps/api/src/routes/billing.ts`):

1. `requireAnonSession`. No draft cookie → 303 to `${APP_ORIGIN}/start/`. **The `session_id` alone
   is never sufficient**: it appears in a URL, it can be shoulder-surfed, and it must not by itself
   mint a session. Possession of the draft cookie *and* a completed session for that draft's job is
   the pair we act on.
2. `session_id` must match `/^cs_[A-Za-z0-9_]{8,64}$/`. Otherwise 303 to `/start/`.
3. Resolve `draft → generation_job`. Reject unless `job.checkout_session_id === session_id`. This is
   the authorisation: the draft cookie proves ownership of the draft, the draft owns exactly one
   job, and the job names exactly one session.
4. Branch on `job.payment_state`:

| `payment_state` | meaning | action |
|---|---|---|
| `paid` | webhook won the race | mint session (§2.4), 303 → `${APP_ORIGIN}/start/?job=…` |
| `awaiting_payment` | **the race** | ask Stripe: `B → sessions.retrieve(id)`. `status === 'complete'` → payment is proven, mint the session, 303 → `${APP_ORIGIN}/start/?job=…&payment=confirming`. `status === 'open'` → the customer came back without paying; 303 → `…&checkout=cancelled`. `status === 'expired'` → `…&checkout=expired` |
| `abandoned` | session expired earlier | 303 → `…&checkout=expired` |
| `not_required` | impossible on this route | 303 → `/start/` |

**The return route never dispatches the Workflow, never writes `payment_state`, never writes
`subscriptions`, and never creates the membership.** Everything that mutates billing state belongs
to the webhook, and to exactly one code path, because two writers of the same state across two
transports is how a double dispatch happens. A `status === 'complete'` seen here only unlocks the
*browser session*, which is a different concern from entitlement.

**What the UI shows in `payment=confirming`.** The generation theatre opens on a ninth act placed
*before* `queued`:

| act | copy (nl) | copy (en) |
|---|---|---|
| `awaiting_payment` | "Je proefperiode wordt bevestigd…" · sub: "Dit duurt meestal een paar seconden. Je hoeft niets te doen." | "Confirming your trial…" · "This usually takes a few seconds. Nothing for you to do." |

The progress rail sits at its 0 % floor and does **not** animate — a bar that creeps while nothing is
happening is the specific lie this rail was built not to tell. A spinner plus honest copy is the
whole state. After 20 seconds the copy gains a second line ("Nog even geduld — betalingen kunnen bij
drukte iets langer duren."); after 90 seconds it offers the release card that already exists
("we mailen je zodra je site klaarstaat"), because at that point a webhook is genuinely late and the
job is durable anyway.

### 2.4 Minting the browser session at return

```ts
const token = crypto.getRandomValues(new Uint8Array(32));
await cp.users.insertSession(env.CP, {
  tokenHash: sha256(token), id: mintId('session'),
  userId: job.created_by,                     // set by the new insert; see §1 step 4
  activeOrgId: job.org_id,
  ipHash, userAgent, now, expiresAt: now + SESSION_TTL_MS,
});
// __Host-aib_session; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=…
```

with `auth_method = 'checkout_return'` (new column, §6.3). Two deliberate differences from
`GET /claim`:

- **The session is minted fresh, never derived from the anonymous token.** That is the session
  fixation defence, and it is the same one the claim route uses.
- **The draft cookie is NOT cleared.** In the claim flow the anon cookie is destroyed because the
  person who proved the e-mail may not be the person holding that cookie. Here the draft cookie *is*
  the thing that authorised the exchange, and it is a *draft capability*, not an authentication
  credential — the SSE stream and the theatre still authorise on it, and killing it mid-generation
  would break the one screen the customer is looking at. It expires on its own 30-day `Max-Age`, and
  `POST /v1/auth/logout` clears both.

Because the org may still be provisional at this instant, the minted session's `active_org_id`
points at an organisation with **zero memberships** — which the tenancy isolation invariant
(architecture §5.2) makes unreachable by every authenticated path. That is the correct behaviour and
not a gap: the customer holds an identity, and it grants nothing until the webhook creates the
membership. `requireEntitlement()` (§7.3) refuses on the missing membership, not on the entitlement.

### 2.5 The customer who never returns

Nothing depends on the return. The webhook has already created the membership, de-provisioned the
org, set `entitlement='trialing'`, moved `index_state` to `eligible` and dispatched the Workflow.
The site builds and publishes with the tab closed. The customer's route back in is `POST
/v1/auth/magic-link` with the address they gave Stripe, which is §6's ordinary login. This is also
why `email_verified_at` matters: the magic link is what sets it, and it is the only thing that does.

### 2.6 The abandoned Checkout — what exists, for how long, and who removes it

After an abandoned Checkout the following exist:

| Row / object | Where | Lifetime |
|---|---|---|
| `users` (possibly new) | CP | permanent — the address is reserved by `uq_users_email_total` forever, by design |
| `organisations` `provisional=1` | CP | **30 days**, then hard-deleted by the purge cron |
| `sites` `status='onboarding'` | CP | cascade-deleted with the org |
| the **slug** | CP | cascade-deleted with the site; because the site is *hard*-deleted and never soft-deleted, `trg_sites_retire_slug` does not fire and the label returns to the pool. Correct: a slug that was never published has no 301s and no backlinks to protect |
| `onboarding_drafts` `status='submitted'` | CP | cascade-deleted with the org (FK is `ON DELETE SET NULL` on `org_id`, so the purge deletes the draft explicitly — it already does) |
| `generation_jobs` `payment_state='abandoned'` | **SH** | **no FK to the control plane exists**, so the purge must delete it explicitly |
| `media_assets` promoted to the site | SH | same |
| `drafts/{draftId}/` R2 prefix | R2 | same |
| Stripe Checkout Session | Stripe | expires at `expires_at` (30 min); Stripe emits `checkout.session.expired` |
| Stripe Customer | — | **none exists** — a Customer is only created when the session completes |

**Who cleans up.** Two mechanisms, and neither is new:

1. **`checkout.session.expired`** (§4.3) flips `payment_state` to `abandoned` and clears
   `checkout_session_id`, within seconds of the 30-minute window closing. This is a *state* fix, not
   a *storage* fix: it exists so the UI can tell "we are waiting for Stripe" apart from "you did not
   finish", and so a resume mints a fresh session instead of linking to a dead one.
2. **The 30-day provisional-organisation purge** (architecture §3b step 8, `idx_orgs_provisional`,
   `cp.orgs.SQL_LIST_EXPIRED_PROVISIONAL_ORGS`) is the storage fix, and Phase 2 must actually
   implement its delete half. **Order matters and is not free**, because
   `stripe_customers.org_id` is `ON DELETE RESTRICT` (0004's comment: silently orphaning a paying
   customer is a business-critical bug):

   ```
   for each provisional org older than 30 days:
     0. re-assert:  provisional = 1
                    AND NOT EXISTS (SELECT 1 FROM subscriptions
                                     WHERE org_id = ? AND status IN
                                       ('trialing','active','past_due','unpaid','paused'))
        — a live subscription on a provisional org is a support ticket, never a delete.
     1. SH:  DELETE FROM generation_jobs WHERE org_id = ?     (cascades calls + events)
             DELETE FROM media_assets    WHERE org_id = ?
             …the rest of migrations/shard, ordered child-first
     2. R2:  delete the drafts/{draftId}/ prefix
     3. CP:  DELETE FROM subscriptions    WHERE org_id = ?   -- RESTRICT parent of nothing
             DELETE FROM stripe_customers WHERE org_id = ?   -- RESTRICT: must precede the org
             DELETE FROM organisations    WHERE id = ? AND provisional = 1
                (cascades sites, drafts, claim tokens; SET NULLs abuse_events and stripe_events)
   ```

   `trial_grants` is **not** deleted. It is the prior-trial ledger and it deliberately outlives the
   organisation, which is the whole point of it existing as its own table (§5.2).

3. **`users` rows with no membership and no site**, older than 30 days, are *not* deleted. Deleting
   them would free the address for re-registration and hand back the trial that `trial_grants`
   just recorded. They are inert: no session can be minted for them without a magic link, and the
   magic link is exactly the "sign in instead" path we want.

---

## 3. Stripe object design

### 3.1 Product and Price

One Product, one Price, both created **once by hand** in the Stripe Dashboard (or by a one-shot
script), never by application code, and the price id lives in `vars` as `STRIPE_PRICE_ID`.
Application code holds a **server-side allowlist of exactly one id** and never accepts a price from
a client — architecture §3c step 3.

```
Product:  name "aibuilder Compleet"
          tax_code  txcd_10103001   (Software as a service (SaaS) — electronically supplied)

Price:    currency        "eur"
          unit_amount     11988          // 119,88 EUR, in cents. INTEGER, never REAL.
          recurring       { interval: "year", interval_count: 1 }
          tax_behavior    "exclusive"
          lookup_key      "compleet_annual_eur_v1"
          nickname        "Compleet — 1 jaar"
```

**How "€9,99 per maand, jaarlijks gefactureerd" maps onto that, honestly.** It does not map onto a
monthly Price. There is exactly one billing event per year and it is for €119,88; the €9,99 is a
*derived unit rate*, not a charge. `apps/marketing/src/content/pricing.ts` already encodes this
correctly and already fails the build if `monthlyEur × 12 ≠ annualTotalEur`
(`assertAnnualTotalMatches`), which is the arithmetic a reader can check. Three rules follow and
they are testable:

1. **The annual total is shown wherever the monthly rate is shown, with equal prominence.** That is
   the Omnibus-amended UCPD / Prijzenwet requirement the existing file's header already cites, and
   it is why `annualTotalEur` is a first-class field rather than a footnote.
2. **Stripe's own surfaces must say the same thing.** Checkout renders the Price, so it will read
   "€119,88 per jaar" — and that is *correct*, not a discrepancy to hide. The modal's pre-Checkout
   summary therefore states "€119,88 per jaar (€9,99 per maand), na 7 dagen gratis proberen" so the
   number the customer sees next is the number they were promised.
3. **`tax_behavior: 'exclusive'`, because `pricing.ts` declares `vatIncluded: false`.** The target
   market is businesses and the price is quoted ex-VAT; a Dutch consumer buying at 21 % pays
   €145,05. Changing `tax_behavior` after the first live subscription requires a *new* Price object
   (Stripe treats it as immutable in practice), so this is a one-way door and it is closed here
   deliberately in the direction `pricing.ts` already committed to. If the client ever wants
   consumer-inclusive pricing, that is a new Price and a `lookup_key` bump to `…_v2`, not an edit.

Our own mirror columns follow directly: `subscriptions.unit_amount_cents = 11988`,
`billing_interval = 'year'`, `interval_count = 1`, `currency = 'eur'`.

### 3.2 The trial

```
subscription_data.trial_period_days: 7
subscription_data.trial_settings.end_behavior.missing_payment_method: 'cancel'   [V12]
payment_method_collection: 'always'                                              [V8]
```

`'always'` + `'cancel'` is a belt-and-braces pair, not a redundancy: `'always'` makes Checkout
refuse to complete without a payment method, and `'cancel'` makes Stripe cancel rather than invoice
if a payment method somehow disappears before day 7 (a customer can detach one from the portal).
`'create_invoice'` would leave us chasing an unpaid €119,88 invoice from a business that never
wanted the product; `'pause'` would leave a zombie subscription that our entitlement machine would
have to model. `'cancel'` is the only end behaviour with a clean terminal state.

`trial_period_days` is applied at session creation and materialises as `subscription.trial_start` /
`trial_end`, which we mirror and which drive `organisations.entitlement_until`.

### 3.3 Tax: Stripe Tax, EU VAT and OSS

**Stripe Tax is on (`automatic_tax: { enabled: true }`) from the first live session.** Retrofitting
tax onto live subscriptions means re-rating every one of them.

- `billing_address_collection: 'required'`. Stripe Tax cannot compute without a customer location,
  and for electronically supplied services the EU expects two non-contradicting pieces of evidence.
  Address plus the card's issuing country (Stripe records both) is the practical pair.
- `tax_id_collection: { enabled: true }`. A Dutch/Belgian business entering a valid VAT number is
  the common case in this market. For a cross-border EU B2B sale with a validated VAT number Stripe
  applies the **reverse charge** and the tax line is €0; the customer self-accounts. Our
  `organisations.vat_number` / `vat_validated_at` columns are written from
  `session.customer_details.tax_ids` and from `customer.updated`.
- **OSS.** Below €10 000 of combined cross-border EU B2C sales per calendar year, the supplier's own
  country rate (NL, 21 %) applies to all of it; above it, the customer's country rate applies and a
  single quarterly OSS return covers every member state **[V24]**. At €119,88 ex-VAT that threshold
  is ~84 cross-border consumer subscriptions — reachable in the first year. Stripe Tax's threshold
  monitoring is the alarm; **registering for OSS is an operator action with a lead time, not
  something code can do**, and it belongs on the launch checklist with a named owner. Until the
  registration exists, Stripe Tax must be configured with NL as the only registration, which makes
  it apply 21 % everywhere in the EU — correct below the threshold and *wrong the day after it is
  crossed*. The mitigation is the monitoring plus a hard calendar reminder, and it is stated here
  because pretending an API parameter solves it would be a lie.
- Invoices: `invoices.tax_cents` is `sum(invoice.total_taxes[].amount)`, **not** `invoice.tax`,
  which no longer exists **[V5]**. `subtotal_cents = invoice.subtotal`, `total_cents = invoice.total`.

### 3.4 SCA / 3DS

Checkout does not challenge at trial signup; it sets the card up for off-session use **[V25]**. The
risk therefore lands on the **first real charge on day 7**, where the issuer may require
authentication. That produces:

- `invoice.payment_action_required` → we surface `hosted_invoice_url` in the dashboard and mail it.
  This is the *only* honest remedy: an off-session charge that needs a challenge cannot be completed
  without the customer, and there is no server-side workaround.
- Entitlement goes to `past_due`, not `canceled` — the customer did nothing wrong.
- Dunning is Stripe's (Smart Retries + the customer e-mails configured in the Dashboard). We do not
  build a retry engine; we mirror the outcome.

### 3.5 `client_reference_id`, and why metadata is not the mapping

`client_reference_id = org_id` (30 chars, well inside the 200-char limit). It is the *bootstrap*
mapping and it exists only on `checkout.session.*`.

The **durable** mapping is `stripe_customers(stripe_customer_id → org_id)` with
`uq_stripe_customers_org`, written by `checkout.session.completed` and read by every later event.
Metadata is written onto both the Session and the Subscription as a debugging aid and a
disaster-recovery hint, and is **never trusted as authoritative**: metadata is editable from the
Stripe Dashboard by anyone with access, and an authorisation decision that a Dashboard user can edit
is not an authorisation decision. The resolution order in every handler is:

```
stripe_customers.org_id  →  (first event only) client_reference_id  →  give up: status='skipped'
```

### 3.6 The customer portal

Cancellation, payment-method updates and invoice history are the **Stripe Billing customer portal**.
We do not build a cancellation UI: a hand-rolled cancel flow has to reproduce proration, trial
handling, dunning state and invoice access, and every one of those is a place to get it subtly wrong
against the system of record.

- Portal configuration (Dashboard, once): allow `payment_method_update`, `subscription_cancel` at
  **period end** (never immediate — a customer who cancels on day 3 keeps the trial they were
  promised), invoice history on, plan switching off (there is one plan).
- `POST /v1/billing/portal` (session-authenticated, `owner` role required) →
  `B → stripe.billingPortal.sessions.create({ customer, return_url: `${DASHBOARD_ORIGIN}/facturatie`, locale: 'nl' })` **[V17]**
  → 303 to the returned URL. The session URL is single-use and short-lived; it is never stored.
- Cancellation arrives back as `customer.subscription.updated` with `cancel_at_period_end = true`,
  then `customer.subscription.deleted` at the period end. §7 handles both.

---

## 4. Webhook handling

### 4.1 The endpoint

`POST https://billing.<control-plane-domain>/v1/stripe/webhook`, in `apps/billing`.

`apps/api`'s global middleware stack (`originGuard`, `appCors`, `jsonContentTypeGuard`) **must not**
be mounted on it: Stripe sends no `Origin`, and `originGuard` rejects a missing Origin on POST by
design. That is one of the two reasons the webhook lives in its own Worker rather than as a route on
the API; the other is that `STRIPE_WEBHOOK_SECRET` and `STRIPE_SECRET_KEY` then never enter the
public-facing Worker's binding set. `securityHeaders` is still applied.

The endpoint sets no cookies, reads no cookies, and answers no CORS.

### 4.2 Signature verification — the raw-body-first rule

```ts
// FIRST. Before any parse, any log, any branch.
const raw = await request.text();
const sig = request.headers.get('stripe-signature');
if (sig === null) return new Response('missing signature', { status: 400 });

let event: Stripe.Event;
try {
  event = await Stripe.webhooks.constructEventAsync(
    raw, sig, await readSecret(env.STRIPE_WEBHOOK_SECRET, 'STRIPE_WEBHOOK_SECRET'),
    undefined,                                   // tolerance -> DEFAULT_TOLERANCE = 300 s [V3]
    Stripe.createSubtleCryptoProvider(),         // [V2]
  );
} catch (error) {
  if (error instanceof Stripe.errors.StripeSignatureVerificationError) {
    return new Response('bad signature', { status: 400 });   // 400, never 500: no retry wanted
  }
  throw error;
}
```

Four rules, each of which is a real bug if broken:

1. **`request.text()` before anything else.** A `Request` body can be read exactly once; calling
   `request.json()` first — or letting a framework body parser run — makes the signature
   unverifiable and produces the well-known "Body has already been used" failure on Workers. The raw
   string, byte-for-byte, is what the HMAC covers.
2. **`constructEventAsync`, never `constructEvent`.** The synchronous form reaches for Node's
   `crypto` and throws on workerd.
3. **`Stripe.createSubtleCryptoProvider()` explicitly**, as the *fifth* positional argument
   (`payload, header, secret, tolerance, cryptoProvider`) **[V2]**. Passing `undefined` for
   `tolerance` keeps the 300-second default **[V3]**; passing the provider in the wrong position
   silently passes it as a tolerance and disables the timestamp window.
4. **A bad signature is `400`, not `500`.** A 5xx makes Stripe retry for three days and then disable
   the endpoint **[V20]** — for a request that will never verify.

The Stripe client itself is constructed once per isolate:

```ts
new Stripe(await readSecret(env.STRIPE_SECRET_KEY, 'STRIPE_SECRET_KEY'), {
  apiVersion: '2026-08-26.dahlia',          // pinned, matching stripe@22.6.1 [V1]
  httpClient: Stripe.createFetchHttpClient(),  // Node http is not available on workerd [V2]
  maxNetworkRetries: 2,
})
```

### 4.3 `event.livemode` vs `ENVIRONMENT`

```ts
const expectLive = env.ENVIRONMENT === 'production';
if (event.livemode !== expectLive) {
  // Recorded, acknowledged, never processed.
  await insertStripeEvent({ ...event, status: 'skipped' });
  return new Response(null, { status: 200 });
}
```

A test-mode event reaching production means a misconfigured endpoint or a test key pasted into a
live Dashboard; processing it would grant a real entitlement for a test card. Returning **200** and
not 400 is deliberate — a 4xx would make the Dashboard show a failing endpoint and eventually
disable it, when the correct outcome is "we saw it, it is not ours".

### 4.4 Insert before process, with a claim token

D1 has no interactive transactions, so a bare `SELECT status … ; if (status !== 'processed')` races:
two concurrent redeliveries both read `received` and both run the side effects. The guard is a
**compare-and-swap in the `WHERE` clause plus a `meta.changes === 1` assertion**, which is the same
pattern `consumeAuthToken` and `consumeClaimToken` already use.

```sql
-- 1. INSERT, unconditionally. A duplicate is expected and is not an error.
INSERT INTO stripe_events (stripe_event_id, type, api_version, livemode, stripe_created_at,
                           object_id, org_id, status, attempts, payload_sha256, received_at)
VALUES (?1,?2,?3,?4,?5,?6,?7,'received',0,?8,?9)
ON CONFLICT(stripe_event_id) DO NOTHING;

-- 2. CLAIM. 16 random bytes; a crashed handler's claim expires and becomes re-claimable.
UPDATE stripe_events
   SET status = 'processing', claim_token = ?2, claim_expires_at = ?3, attempts = attempts + 1
 WHERE stripe_event_id = ?1
   AND (status = 'received'
        OR status = 'failed'
        OR (status = 'processing' AND claim_expires_at < ?4));
-- assert meta.changes === 1; 0 means someone else holds it or it is already 'processed'.
```

`claim_expires_at = now + 120_000`, comfortably above Stripe's 30-second delivery timeout **[V20]**
and far below its 5-minute first retry.

`changes === 0` → **200 with no side effects**. Either a peer is processing it (its 200 is the one
that counts) or it is already `processed` (a redelivery of work we did). Returning 500 here would
manufacture a retry storm out of correct behaviour.

Completion:

```sql
UPDATE stripe_events SET status='processed', processed_at=?2, claim_token=NULL, claim_expires_at=NULL
 WHERE stripe_event_id=?1 AND claim_token=?3;      -- we still hold the claim
```

Failure: `status='failed'`, `last_error = message.slice(0, 1000)` (the column is bounded at 1 KB
because the table is `WITHOUT ROWID` and this row is read on every delivery), release the claim,
and **return 500 so Stripe retries**. The full error goes to the log, never to the column.

`payload_sha256` is `sha256(raw)`; the raw JSON goes to R2 under `stripe/events/{id}.json` because a
single event can exceed D1's 2 MB row cap.

A reconciliation cron (hourly) walks `idx_stripe_events_retry` for rows stuck in
`received`/`processing`/`failed` older than 15 minutes, re-fetches each from
`stripe.events.retrieve(id)` and reprocesses. This is the safety net for the case Stripe cannot
help with: we returned 200 and then crashed.

### 4.5 Why we re-read the object from the Stripe API

**Stripe does not guarantee delivery order, and the event payload is a snapshot of the object at the
moment the event was created, not now.** Three concrete failures follow from trusting the payload:

1. `customer.subscription.updated` (trial → active) is delivered *after* `customer.subscription.deleted`
   because the first delivery attempt failed and was retried 5 minutes later. Applying payloads in
   arrival order resurrects a cancelled subscription.
2. `checkout.session.completed` carries `subscription` as an **id string**, not an object; the trial
   end, the price, the default payment method and its card fingerprint are simply not in the
   payload.
3. A customer updates their card between the event and our processing of it. The payload's
   fingerprint is stale, and the trial-abuse check in §5 would test the wrong card.

So every handler does: verify → claim → **`retrieve` the subscription (and, where relevant, the
session/invoice) from the API with the expansions it needs** → persist *that*. Ordering then stops
mattering, because every delivery converges on the same current state. The
`WHERE stripe_updated_at < ?event_created_ms` guard on `subscriptions` (0004's ORDERING header)
stays as a second line of defence for the case where two handlers run concurrently and the *later*
event's re-read completes first.

Cost of the extra round trip: one `GET` per event, ~100 ms, on a path nobody is waiting on.

### 4.6 The event table

| Event | Resolve org via | Writes | Notes |
|---|---|---|---|
| **`checkout.session.completed`** | `client_reference_id` (bootstrap) | `stripe_customers` upsert · `subscriptions` upsert · `memberships` insert (`owner`) · `organisations.provisional=0, billing_email` · `entitlement='trialing'`, `entitlement_until=trial_end`, `plan='pro'` · `sites.index_state='eligible'` · `trial_grants` insert · SH `generation_jobs.payment_state='paid'`, `queue_ready_at=now` · dispatch Workflow | The only dispatcher. Membership **before** de-provision (`trg_orgs_deprovision_needs_member`). Assert `session.status === 'complete'` and `payment_status === 'no_payment_required'` **[V13]** |
| **`checkout.session.expired`** | `client_reference_id` | SH `generation_jobs.payment_state='abandoned'`, `checkout_session_id=NULL` (guarded `WHERE payment_state='awaiting_payment' AND checkout_session_id=?`) | No CP write. Never terminates the job (§2.1) |
| **`customer.subscription.created`** | `stripe_customers` | `subscriptions` upsert · entitlement per §7.2 | Usually redundant with `checkout.session.completed`; both are idempotent, and this one is the safety net if the session event is lost |
| **`customer.subscription.updated`** | `stripe_customers` | `subscriptions` upsert (incl. `cancel_at_period_end`, `canceled_at`) · entitlement per §7.2 | The workhorse: trial→active, active→past_due, cancel-at-period-end, plan pause |
| **`customer.subscription.deleted`** | `stripe_customers` | `subscriptions.status='canceled'`, `ended_at`, `canceled_at` · `entitlement='canceled'`, `entitlement_until = ended_at` · `plan='free'` · `trial_grants.outcome='churned'` | `CHECK (status <> 'canceled' OR canceled_at IS NOT NULL)` — `canceled_at` must be non-NULL; fall back to `ended_at` then to `now` |
| **`invoice.paid`** | `stripe_customers` | `invoices` upsert · re-read subscription → entitlement (`active`, `entitlement_until = items.data[0].current_period_end`) · `trial_grants.outcome='converted'` when `billing_reason='subscription_cycle'` and it is the first paid invoice | `tax_cents = sum(total_taxes[].amount)` **[V5]**; `hosted_invoice_url`/`invoice_pdf` are optional **[V6]** |
| **`invoice.payment_failed`** | `stripe_customers` | `invoices` upsert (`status='open'`) · re-read subscription → entitlement (`past_due`, `entitlement_until = now + DUNNING_GRACE_MS`) | We do not decide when to give up; Stripe's retry schedule does, and `customer.subscription.deleted`/`updated(unpaid)` is its verdict |
| **`invoice.payment_action_required`** | `stripe_customers` | `invoices` upsert · flag for the dashboard banner + one e-mail carrying `hosted_invoice_url` | The SCA case (§3.4). The only remedy is the customer |
| **`customer.subscription.trial_will_end`** | `stripe_customers` | no state change · one e-mail, 3 days out | Stripe fires this 3 days before `trial_end`. Idempotent by `stripe_events`, so a redelivery cannot double-mail |
| **`charge.dispute.created`** | charge → `payment_intent` → `invoice` → `subscription` → `stripe_customers`; fall back to `stripe_customers` by `customer` | `abuse_events(kind='manual_report', severity='block')` · **immediately** `sites.index_state='gone'` and `sites.status='suspended'` · `entitlement='canceled'` · alert an operator | A chargeback on a €119,88 SaaS subscription in the first weeks is, empirically, either stolen-card fraud or an abandoned business. Serving the site while contesting a dispute is how a platform ends up hosting a fraudster's storefront at its own expense. Reversible by an operator |
| **`charge.dispute.closed`** | as above | if `status='won'` → restore `index_state='eligible'`, `status='published'`, entitlement from a re-read; if `lost` → leave suspended, `trial_grants.outcome='disputed'` | **[V:** `Dispute.status` ∈ `won, lost, warning_*, needs_response, under_review, prevented` **]** |
| **`radar.early_fraud_warning.created`** | charge → customer | `abuse_events` · alert · do **not** auto-suspend | An EFW is a warning, not a chargeback. Auto-suspending on it would punish false positives; the operator decides, and the runbook says "refund proactively to avoid the dispute" |
| **`customer.updated`** | `stripe_customers` | `organisations.billing_address`, `country`, `vat_number`, `vat_validated_at` · `stripe_customers.email`, `tax_country` | Keeps the tax evidence current after a portal edit |
| **anything else** | — | `stripe_events` row with `status='skipped'` | Recorded so the endpoint's configured event list can be audited against reality |

**A webhook for an unknown org.** If neither `stripe_customers` nor `client_reference_id` resolves an
organisation:

- write the `stripe_events` row with `org_id = NULL`, `status = 'skipped'`, `last_error = 'org_unresolved'`
- **return 200.** Retrying for three days cannot make an organisation appear, and letting Stripe
  disable the endpoint over it would take down billing for everyone else.
- emit an ops alert. A live subscription with no organisation means a real customer is being billed
  for nothing; the runbook is to cancel and refund it from the Dashboard, and it is a *human*
  decision because the alternative — auto-cancelling on any unresolved event — is a
  self-inflicted outage the first time a migration is half-applied.

**Endpoint configuration.** The Dashboard endpoint subscribes to exactly the fourteen types above.
Subscribing to `*` costs nothing in correctness (unknown types are skipped) but fills
`stripe_events` with noise that the retry index then walks.

---

## 5. Trial abuse

### 5.1 Where the two checks actually run

§D2 says "look up prior trials by `email_normalized` **and** by `card.fingerprint`". Those two
lookups cannot happen at the same moment, and pretending otherwise produces a check that never runs:

| Signal | Available | Where the check lives | Effect of a hit |
|---|---|---|---|
| `email_normalized` | at submit, before any Stripe call | `apps/api` step 2 + `apps/billing` before `sessions.create` | **Refuse**: `409 trial_already_used`. No rows written, no Stripe object created |
| `card.fingerprint` | **only after the customer enters a card in Checkout** — the fingerprint is a property of a PaymentMethod that does not exist until then | `apps/billing`, inside `checkout.session.completed`, immediately after the subscription re-read | **Convert, do not refuse** — see 5.3 |

The fingerprint comes from
`subscription.default_payment_method.card.fingerprint` after
`subscriptions.retrieve(id, { expand: ['default_payment_method'] })`. It is **`string | null` and on
some shapes optional [V15]**: some payment methods have no fingerprint at all. `undefined`/`null` is
treated as "no signal" and the trial proceeds — a check that fails closed on a missing optional
field would refuse legitimate customers for a reason we cannot explain to them.

### 5.2 `trial_grants` — the ledger

A new CP table (§8.1), deliberately **not** a view over `stripe_customers`:

- `stripe_customers.org_id` is `ON DELETE RESTRICT`, so those rows are deleted when a provisional org
  is purged — taking the evidence with them. `trial_grants` has **no FK to `organisations`** and
  therefore survives the purge, which is the entire reason it exists.
- `abuse_events.subject_type` has no `card` value, and widening that CHECK is a table rebuild we do
  not need to take.
- The fingerprint is stored as `sha256(fingerprint || TRIAL_FINGERPRINT_PEPPER)`, 32-byte BLOB, not
  in the clear. It is a stable cross-merchant-ish identifier for a payment instrument; it is
  pseudonymous personal data under the same reading architecture §8 applies to `ip_hash`, and it is
  listed as such in the ROPA.

```sql
CREATE TABLE trial_grants (
  id                  TEXT PRIMARY KEY,          -- trg_<ULID>
  email_normalized    TEXT NOT NULL CHECK (email_normalized = lower(email_normalized)),
  card_fingerprint_sha256 BLOB CHECK (card_fingerprint_sha256 IS NULL
                        OR length(card_fingerprint_sha256) = 32),
  org_id              TEXT,                      -- no FK: this row outlives the organisation
  stripe_customer_id  TEXT,
  stripe_subscription_id TEXT,
  outcome             TEXT NOT NULL DEFAULT 'granted'
                        CHECK (outcome IN ('granted','converted','churned','refused','disputed')),
  granted_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK (length(id) = 30 AND id GLOB 'trg_[0-7]*'
         AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
) STRICT;

CREATE INDEX idx_trial_grants_email ON trial_grants(email_normalized, granted_at DESC);
CREATE INDEX idx_trial_grants_card  ON trial_grants(card_fingerprint_sha256, granted_at DESC)
  WHERE card_fingerprint_sha256 IS NOT NULL;
```

The row is inserted with `outcome='granted'` in `checkout.session.completed`, in the same batch as
the entitlement write, so a trial cannot be granted without being recorded.

### 5.3 What we do on a fingerprint hit

**Not "refuse".** By the time we know, the customer has completed Checkout, a Customer and a
Subscription exist in Stripe, and the person is sitting on `success_url`. Silently cancelling and
showing an error is both a bad experience and an easy way to punish the legitimate case (a partner
signing up a second business on the company card, a bookkeeper paying for two clients).

**Charge immediately instead of trialling.** The trial is a *risk allowance*, and the risk is that
we spend ~€1 of Opus before anyone has paid us anything. A returning card has already demonstrated
it can be charged, so:

```ts
await stripe.subscriptions.update(subscriptionId, { trial_end: 'now', proration_behavior: 'none' });
```

Stripe immediately invoices €119,88 + VAT against the card on file. Then:

- **Payment succeeds** (`invoice.paid` arrives) → entitlement `active`, job released, generation
  runs, `trial_grants.outcome = 'converted'`. The customer sees "Je proefperiode is al eerder
  gebruikt met deze kaart, dus je abonnement is direct gestart." — honest, and they got what they
  came for.
- **Payment fails** → `invoice.payment_failed` → entitlement `past_due`, the job stays
  `awaiting_payment`, and the theatre shows the payment-failed card with the
  `hosted_invoice_url`. **No Opus is spent.**

The one case where we refuse outright is `trial_grants.outcome = 'disputed'` on the same
fingerprint: cancel the subscription, leave the job unreleased, alert. A card that has already
charged us back is not a card we extend credit to.

Every branch writes an `abuse_events` row. `kind` reuses the existing `quota_exceeded` vocabulary
with `detail = {"reason":"prior_trial_fingerprint","outcome":"charged_immediately"}` — deliberately
**not** a new `kind` value, because widening that CHECK is a table rebuild for a label.

### 5.4 Card testing against Checkout

Stripe-hosted Checkout is the right surface for this threat and it is not defenceless: Radar's base
rules run on every session, the page is rate-limited by Stripe, and we never see raw card data. What
an attacker gets from us is a *free Checkout Session generator*, and that is what the layers below
constrain:

- `POST /v1/onboarding/submit` still sits behind the whole six-layer funnel (WAF, zone rate limit,
  Origin, Turnstile ×2, `RL_SUBMIT` at 1/60 s/IP, `QuotaDO`). One completed intake yields **one**
  Checkout Session.
- `POST /v1/billing/checkout/:jobId` (the re-mint) is capped at **5 sessions per job, lifetime**,
  counted in a new `checkout_attempts` column, and rate-limited by a new `RL_CHECKOUT` binding at
  3/60 s/IP.
- `expires_at = now + 30 min` (the minimum Stripe allows **[V11]**) keeps the window of a live
  session small.
- Radar rules (Dashboard): block if `:card_country:` differs from `:ip_country:` **and** risk is
  elevated; review on `:cvc_check: = 'fail'`.
- `radar.early_fraud_warning.created` is monitored and alerted (§4.6).

### 5.5 What `BudgetDO` and `QuotaDO` still protect

The threat model shrank; the controls do not.

- **`BudgetDO` ($500/day, staged degradation).** Still the last line, and still necessary, because
  spend is now triggered by a **webhook**, which is a code path no human is watching in real time. A
  bug that released every job, or a Stripe test-clock experiment against production, would otherwise
  run unbounded. Its reservation now happens at *dispatch* (webhook or drain), not at submit — §1
  step 5.
- **`QuotaDO`.** Consumed at submit and **not refunded on abandonment**, which is what stops
  "abandon Checkout in a loop" from being a free slug-reservation and draft-row generator. It also
  keeps the 2-regenerations-per-30-days limit, which §D2 identifies as the real limiter now that
  everyone with a site has an entitlement.
- **Turnstile, `RL_*`, the Haiku screen, slug/homoglyph blocking.** Unchanged. They now protect
  against a card tester rather than a free-generation farmer — a smaller threat, but the endpoint is
  still unauthenticated and still writes rows.

---

## 6. Authentication

Phase 1 mints exactly one session, on `GET /claim`. Phase 2 needs real login.

### 6.1 What to build with — recommendation, and why

**Magic link: hand-rolled, on the tables that already exist.** `auth_tokens` is already the right
shape — `WITHOUT ROWID` on a 32-byte token hash, single-use via
`UPDATE … WHERE consumed_at IS NULL` + `meta.changes === 1`, `purpose IN ('magic_link','email_verify','org_invite')`,
`expires_at`, `ip_hash`, and `idx_auth_tokens_email` for send-rate limiting. `cp.users` already
exports `insertAuthToken`, `consumeAuthToken`, `insertSession`, `getSessionByTokenHash`,
`touchSession`, `revokeSession`, `revokeUserSessions`, `purgeExpiredAuthTokens`. There is nothing
left for a library to do, and every general-purpose auth library for Workers (Better Auth, Lucia's
successors, Auth.js on Workers) wants to own the schema — which here means owning `users`,
`sessions` and `organisations`, the three tables the rest of this system's constraints and triggers
are built on. **Adopting one is a schema rewrite disguised as a dependency.** Rejected.

**Passkeys: `@simplewebauthn/server`, pinned to `14.0.1`.** Hand-rolling WebAuthn verification means
implementing COSE key decoding, CBOR attestation parsing, ES256/RS256/EdDSA signature verification
and the origin/RP-ID/sign-count checks — a security-critical parser, from scratch, for no benefit.
Verified for this runtime rather than assumed **[V23]**: the package contains **zero** `node:`
imports, bundles clean under the `workerd` export condition with no unresolved builtins, is
**85 KB minified+gzipped**, and its option-generation and verification paths run on Web Crypto
alone. Its only awkward transitive dependency, `reflect-metadata`, is pulled in by the X.509
certificate-path validator, which `attestationType: 'none'` never reaches; it is pure JS and loads
on workerd regardless.

The client side is `navigator.credentials` directly, or `@simplewebauthn/browser` (~3 KB) if the
base64url plumbing proves tedious. The onboarding modal already ships React; the dashboard is
`apps/app`.

### 6.2 The flows

**Magic link (first factor).**

```
POST /v1/auth/magic-link   { email, turnstileToken }
  → always 202 { ok: true }.  ALWAYS.  A 404 for an unknown address is an account-existence oracle.
  → rate limit: RL_AUTH (3/60 s/IP) + a per-address cap read off idx_auth_tokens_email
    (5 sends / 15 min / address), enforced before the mail is queued.
  → token = 32 random bytes, base64url; store sha256(token); expires_at = now + 15 min;
    purpose='magic_link'; ip_hash; payload = {"next":"/dashboard"} (bounded, allowlisted paths only).
  → the link is https://app.<domain>/inloggen/verifieren?t=<token>

GET  /v1/auth/magic-link/verify?t=…      (or the app route POSTing to it)
  → consumeAuthToken (atomic; null → 410, never 500 — a link opened twice is a user event)
  → users.email_verified_at = coalesce(email_verified_at, now); users.last_login_at = now
  → mint a fresh session, auth_method='magic_link'
  → 303 to the allowlisted `next`, or /dashboard
```

E-mail links are prefetched by scanners and by mail clients. Two mitigations, both required:
`expires_at` is 15 minutes, and the verify endpoint is reached by a **POST from an interstitial
page** ("Doorgaan als je@adres.nl") so a `GET` prefetch cannot burn the token. The `GET` route
renders that page; it does not consume.

**Passkey registration (upgrade, offered at first login).** After a successful magic-link login the
dashboard shows a single non-dismissive-but-skippable card: *"Log de volgende keer in zonder e-mail."*

```
POST /v1/auth/passkey/register/options   (session required)
  → generateRegistrationOptions({ rpName, rpID: env.WEBAUTHN_RP_ID,
      userID: utf8(user.id), userName: user.email, userDisplayName: user.full_name ?? user.email,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      excludeCredentials: existing })
  → challenge stored server-side in the SESSION row (see 6.3), 5-minute TTL. Never in a cookie the
    client can replay against a different ceremony.

POST /v1/auth/passkey/register/verify    (session required)
  → verifyRegistrationResponse({ expectedChallenge, expectedOrigin: DASHBOARD_ORIGIN,
                                 expectedRPID: env.WEBAUTHN_RP_ID, requireUserVerification: false })
  → INSERT INTO webauthn_credentials (…)
  → ROTATE the session (6.4) — the account's authentication factors just changed.
```

**Passkey authentication.** `generateAuthenticationOptions` with **no `allowCredentials`** (discoverable
credentials; the platform picks), challenge in a short-lived unauthenticated
`__Host-aib_webauthn` cookie bound to the ceremony, `verifyAuthenticationResponse`, then
`UPDATE webauthn_credentials SET counter = ?, last_used_at = ?` and a fresh session with
`auth_method='passkey'`. A **decreasing** sign counter (when both stored and returned counters are
non-zero) is a cloned-authenticator signal: refuse the login, revoke every session of that user, and
alert. Many passkeys report a constant `0`; that is not a signal and must not be treated as one.

### 6.3 Storage

`sessions` gains two columns (`ALTER TABLE ADD COLUMN`, verified safe **[V21]**; `sessions` is a
cascade *child* only, and ADD COLUMN never rebuilds anyway):

```sql
ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'claim_link'
  CHECK (auth_method IN ('claim_link','checkout_return','magic_link','passkey'));
ALTER TABLE sessions ADD COLUMN pending_challenge BLOB
  CHECK (pending_challenge IS NULL OR length(pending_challenge) BETWEEN 16 AND 64);
ALTER TABLE sessions ADD COLUMN pending_challenge_expires_at INTEGER;
```

The default is `'claim_link'` so the Phase 1 rows and the Phase 1 code path stay valid without a
backfill.

`webauthn_credentials` is a **new** table (adding a table is always safe):

```sql
CREATE TABLE webauthn_credentials (
  credential_id   BLOB PRIMARY KEY CHECK (length(credential_id) BETWEEN 16 AND 1023),
  id              TEXT NOT NULL,                 -- pky_<ULID>
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key      BLOB NOT NULL CHECK (length(public_key) BETWEEN 32 AND 1024),
  counter         INTEGER NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports      TEXT CHECK (transports IS NULL OR
                    (json_valid(transports) AND json_type(transports) = 'array'
                     AND length(transports) <= 128)),
  aaguid          TEXT CHECK (aaguid IS NULL OR length(aaguid) = 36),
  backed_up       INTEGER NOT NULL DEFAULT 0 CHECK (backed_up IN (0,1)),
  device_type     TEXT CHECK (device_type IS NULL OR device_type IN ('singleDevice','multiDevice')),
  nickname        TEXT CHECK (nickname IS NULL OR length(nickname) BETWEEN 1 AND 64),
  -- THE ONE-WAY DOOR. Recorded per credential so a future rpID change is detectable rather than
  -- silently unrecoverable. See 6.5.
  rp_id           TEXT NOT NULL CHECK (length(rp_id) BETWEEN 3 AND 253 AND rp_id = lower(rp_id)),
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER,
  CHECK (length(id) = 30 AND id GLOB 'pky_[0-7]*'
         AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX uq_webauthn_id   ON webauthn_credentials(id);
CREATE INDEX        idx_webauthn_user ON webauthn_credentials(user_id, created_at DESC);
```

`WITHOUT ROWID` on `credential_id` for the same reason `sessions` is: the authentication lookup is a
point read on the primary key and the row is small.

### 6.4 Cookies, rotation, fixation, logout

**Cookie.** `__Host-aib_session=<base64url 32 bytes>; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`.
The `__Host-` prefix is browser-enforced: `Secure`, `Path=/`, and **no `Domain` attribute**, so the
cookie is host-only. Combined with the two-registrable-domain split, attacker-influenced tenant HTML
on `*.mijnsaas.com` can never write a cookie this Worker reads. `SameSite=Lax` and not `Strict`
because `app.<domain>` calls `api.<domain>` — cross-origin, same-site — and because `originGuard`
already refuses genuinely cross-site state-changing requests.

Only the token's **sha256** is stored, so a database read cannot mint a cookie.

**Idle vs absolute lifetime.** `expires_at = now + 30 days` (absolute), slid by `touchSession` at
most once per hour (`last_seen_at` older than 3 600 000 ms) so authentication does not become a D1
write per request. `SQL_GET_SESSION` already carries `revoked_at IS NULL AND expires_at > ?2` as
predicates, so a stale session is never read and then separately validated.

**Rotation on privilege change** — `rotateSession()`, one helper, called on every one of these:

| Trigger | Why |
|---|---|
| magic-link verify | first factor proven |
| passkey authenticate | first factor proven |
| passkey registered or deleted | the account's factors changed |
| e-mail address changed | the identity the magic link binds to changed |
| membership role changed, or a new membership added | the session's authority changed |
| active org switched | `active_org_id` is an authorisation input |
| `/v1/billing/return` | a session is being minted where none existed |

`rotateSession()` = insert a new row (new token, same `user_id`, same `active_org_id`, carrying the
*new* `auth_method`) → `revokeSession(oldTokenHash)` → `Set-Cookie` with the new value. In that
order: minting first means a failure leaves the user logged in with the old cookie rather than
logged out with neither.

**Session fixation.** Three places, three answers:

1. `GET /claim` (Phase 1, unchanged): the anon cookie is destroyed and a fresh session minted. The
   anon cookie's holder may not be the person who proved the e-mail, so it must not survive.
2. `GET /v1/billing/return` (new): a fresh session is minted and the anon cookie is **kept** (§2.4).
   The anon cookie is a *draft capability* that the SSE stream still authorises on; it is not
   promoted into an authenticated credential, which is what fixation actually requires.
3. Magic link / passkey: always a brand-new row. An attacker who plants a `__Host-aib_session` value
   in someone's browser holds a token that is revoked the moment the victim logs in.

**Logout.** `POST /v1/auth/logout` (Origin-guarded, session required) → `revokeSession` →
`Set-Cookie: __Host-aib_session=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax` **and** the
same for `__Host-aib_draft`. `POST /v1/auth/logout-all` → `revokeUserSessions`, which already exists
and already returns the count.

### 6.5 The `rpID` one-way door

Architecture §10, one-way door 7. **`WEBAUTHN_RP_ID = "app.<control-plane-domain>"` — the
subdomain, never the apex.**

A WebAuthn credential is scoped to its RP ID and **cannot be migrated**. Changing the RP ID
invalidates every credential ever created, with no recovery path that does not involve every user
re-registering. Two failure modes make the apex the wrong choice here:

1. A registrable domain listed on the **Public Suffix List** cannot be used as an RP ID — browsers
   reject it. This product's roadmap contains a PSL submission (§9 one-way door 5, for
   `mijnsaas.com`). Submitting the *control-plane* domain later — for any reason, including a
   subdomain-isolation hardening decision — would instantly invalidate every apex-scoped passkey.
2. An apex RP ID is valid for every subdomain of the apex, including future ones we do not control
   the security of.

So the value is fixed now, written as a comment on the constant, recorded per credential in
`webauthn_credentials.rp_id`, and **asserted by a test** (§9, T-A5):

```ts
// apps/api/src/__tests__/webauthn-rpid.test.ts
it('never changes the WebAuthn RP ID', () => {
  // ONE-WAY DOOR (architecture §10, door 7). A WebAuthn credential is bound to its RP ID and
  // cannot be migrated: changing this string invalidates every passkey ever registered, and the
  // only recovery is every user re-enrolling. It is a subdomain and not the apex so that a future
  // Public Suffix List entry on the registrable domain cannot make it invalid.
  expect(env.WEBAUTHN_RP_ID).toBe('app.aibuilder.app');
  expect(env.WEBAUTHN_RP_ID.split('.').length).toBeGreaterThanOrEqual(3);
  expect(new URL(env.DASHBOARD_ORIGIN).hostname).toBe(env.WEBAUTHN_RP_ID);
});
```

The third assertion is the one that catches the realistic mistake: someone moves the dashboard to a
different host and the ceremony's `expectedOrigin` silently stops matching `expectedRPID`.

The domain placeholder swap (§D1) touches this string. It must happen **before the first passkey is
registered**, which is a strictly earlier deadline than §D1's own "before the first tenant slug is
indexed". That is stated in `README.md`'s bootstrap section as part of this change.

### 6.6 The claim link keeps its job

`GET /claim` and `site_claim_tokens` are **not** deleted. They become the recovery path for the two
cases the webhook cannot serve:

- the webhook's membership write failed and was later repaired by an operator;
- the customer completed Checkout on a phone, never returned, and lands on a desktop with no draft
  cookie — an operator (or an automated 24-hour "your site is ready" mail) sends a claim link.

Its behaviour is unchanged, including clearing the anon cookie and promoting `index_state` to
`eligible`. Its statements (`insertClaimToken`, `consumeClaimToken`, `bumpClaimSendCount`,
`getLiveClaimTokenForSite`) already exist and already enforce the 5-send cap that architecture §10
risk 7 asks for.

---

## 7. Entitlement

### 7.1 What the column is

`organisations.entitlement` is a **denormalisation of Stripe's subscription status**, and the only
reason it exists is that the paywall must be one primary-key row read and never a join into
`subscriptions` (architecture §5.2). `cp.orgs.SQL_GET_ENTITLEMENT` and `setEntitlementStatement`
already exist. The invariant that makes the denormalisation safe: **`subscriptions` and
`organisations.entitlement` are written in the same `batch()`, always.** Never in two calls, never in
two handlers.

The schema enforces one thing the code must respect:
`CHECK (entitlement NOT IN ('trialing','active','past_due') OR entitlement_until IS NOT NULL)` —
a live entitlement without an expiry is an entitlement nobody can revoke by lapse. Every write to a
live state must compute a deadline.

### 7.2 The state machine

```
                        ┌──────┐
                        │ none │  (org created at submit; provisional)
                        └──┬───┘
      checkout.session.completed │ trial_end
                           ▼
                     ┌──────────┐   invoice.paid          ┌────────┐
                     │ trialing │ ────────────────────────►│ active │◄──┐
                     └────┬─────┘   (subscription_cycle)   └───┬────┘   │
                          │                                    │        │ invoice.paid
        subscription.deleted│              invoice.payment_failed│        │
        (trial ended, no PM)│                                    ▼        │
                          │                              ┌──────────┐    │
                          │                              │ past_due │────┘
                          │                              └────┬─────┘
                          │                                   │ subscription.deleted / unpaid
                          ▼                                   ▼
                     ┌──────────┐                        ┌──────────┐
                     │ canceled │◄───────────────────────│ canceled │
                     └──────────┘   subscription.deleted └──────────┘
```

The mapping is computed by **one pure function**, from the re-read Stripe subscription, and never by
a per-event switch:

```ts
// packages/core/src/entitlement.ts — pure, injected-facts, no bindings, unit-tested exhaustively.
export interface EntitlementDecision {
  readonly entitlement: Entitlement;          // 'none'|'trialing'|'active'|'past_due'|'canceled'
  readonly entitlementUntil: number | null;
  readonly plan: 'free' | 'pro';
}

export function decideEntitlement(input: {
  readonly stripeStatus: string;              // NOT a closed union — see below
  readonly trialEndMs: number | null;
  readonly currentPeriodEndMs: number | null; // from items.data[0]  [V4]
  readonly endedAtMs: number | null;
  readonly canceledAtMs: number | null;
  readonly nowMs: number;
  readonly dunningGraceMs: number;            // DUNNING_GRACE_MS = 14 days
}): EntitlementDecision;
```

| Stripe `subscription.status` | `entitlement` | `entitlement_until` | `plan` |
|---|---|---|---|
| `trialing` | `trialing` | `trial_end` (fallback `now + 7d`) | `pro` |
| `active` | `active` | `items.data[0].current_period_end` (fallback `now + 1y`) **[V4]** | `pro` |
| `past_due` | `past_due` | `now + DUNNING_GRACE_MS` | `pro` |
| `unpaid` | `past_due` | `now + DUNNING_GRACE_MS` | `pro` |
| `paused` | `canceled` | `ended_at ?? now` | `free` |
| `canceled` | `canceled` | `ended_at ?? canceled_at ?? now` | `free` |
| `incomplete` | `none` | `NULL` | `free` |
| `incomplete_expired` | `canceled` | `canceled_at ?? now` | `free` |
| **anything else** | `past_due` | `now + DUNNING_GRACE_MS` | `pro` |

**The last row is the important one.** The SDK types `Subscription.status` as a union **plus
`OtherString` [V14]** — Stripe reserves the right to ship a new status — while our
`subscriptions.status` CHECK is a closed set that a rebuild-forbidden table cannot widen. So:

- The **mirror** clamps: an unrecognised status is stored as `'past_due'` and the raw string goes to
  the log and to an ops alert. Storing it verbatim would fail the CHECK and turn a new Stripe status
  into a webhook that 500s and retries for three days.
- The **entitlement** fails *open for the customer, closed for us*: `past_due` keeps the site
  serving and keeps `regenerate` blocked, which is the right way round for an unknown state. It
  expires in 14 days, so an unnoticed alert cannot become a permanent free ride.

`cancel_at_period_end = true` is **not** a state change. The subscription is still `active`; the
entitlement stays `active` with `entitlement_until = current_period_end`. The customer paid for the
period and keeps it. `customer.subscription.deleted` at the end does the transition.

### 7.3 The gate

One exported function; every protected route calls it and no route re-implements it.

```ts
// apps/api/src/lib/entitlement.ts
export type GateFailure =
  | 'no_session' | 'no_membership' | 'insufficient_role'
  | 'org_suspended' | 'not_entitled' | 'entitlement_lapsed';

export interface Gate {
  readonly orgId: OrganisationId;
  readonly userId: UserId;
  readonly role: MembershipRole;
  readonly entitlement: Entitlement;
  readonly shardId: ShardId;
}

/**
 * The one place entitlement is decided.
 *
 * Order is the security model, cheapest and most fundamental first: a session, then a MEMBERSHIP
 * (which is the tenancy isolation invariant — an organisation with zero memberships is unreachable,
 * and that is what makes a provisional org safe to exist), then the role, then the organisation's
 * own status, and only then the paywall. Reversing the last two would tell a suspended tenant
 * whether their subscription is live, which is an oracle we have no reason to hand out.
 */
export async function requireEntitlement(
  env: Env,
  session: SessionRow,
  orgId: OrganisationId,
  opts: { readonly minRole: MembershipRole; readonly allow: readonly Entitlement[] },
): Promise<Gate | GateFailure>;
```

Reads: `cp.users.getMembership` (covering, one seek on `idx_memberships_user`) then
`cp.orgs.getEntitlement` (one primary-key row read, no join). Two reads, both indexed, both bounded.

Rules:

- `allow` defaults to `['trialing','active']` — exactly architecture §3c step 2.
- `entitlement_until < now` is **`entitlement_lapsed`**, even when `entitlement` still says
  `trialing`. Webhooks can be lost; a deadline that is never checked is not a deadline. A nightly
  cron (`idx_orgs_entitlement_expiry`) reconciles lapsed rows against Stripe and corrects them, and
  the gate does not wait for it.
- Failures map to HTTP as: `no_session` → 401 · `no_membership` → **404** (never 403 — a 403 confirms
  the org exists) · `insufficient_role` → 403 · `org_suspended` → 403 · `not_entitled` /
  `entitlement_lapsed` → **402** with `{ error:'payment_required', portalUrl }`.

Called by, at minimum: `POST /v1/sites/:id/regenerate`, every `SiteDraftDO` write route, publish,
custom-domain routes, media sign/commit for an owned site, `POST /v1/billing/portal`, and every
`apps/app` loader that reads tenant data.

`POST /v1/sites/:id/regenerate` keeps its Phase 1 shape exactly: a refusal writes
`generation_jobs.status='blocked_paywall'` with `finished_at` set (which the CHECK requires) and
answers 402. §D2 is explicit that this stays a correctness boundary and not a growth mechanism; in
practice it now fires only on a lapsed subscription, and the real limiter is `QuotaDO`'s
2-per-30-days.

---

## 8. What changes in existing Phase 1 files

### 8.1 Migrations — additive only

| File | Change |
|---|---|
| **`migrations/shard/0007_billing_gate.sql`** (new) | `ALTER TABLE generation_jobs ADD COLUMN payment_state TEXT NOT NULL DEFAULT 'not_required' CHECK (payment_state IN ('not_required','awaiting_payment','paid','abandoned'))`; `ADD COLUMN checkout_session_id TEXT CHECK (… GLOB 'cs_*' AND length BETWEEN 8 AND 66)`; `ADD COLUMN payment_deadline_at INTEGER`; `ADD COLUMN checkout_attempts INTEGER NOT NULL DEFAULT 0 CHECK (checkout_attempts BETWEEN 0 AND 5)`; `CREATE INDEX idx_jobs_awaiting_payment ON generation_jobs(payment_deadline_at) WHERE payment_state = 'awaiting_payment'`. **All four ADD COLUMNs and the index were executed against the real 0001–0004 files [V22].** The header must state why this is not a `status` enum widening (§1 step 4 box). |
| **`migrations/cp/0008_trials_passkeys.sql`** (new) | `CREATE TABLE trial_grants` (§5.2) · `CREATE TABLE webauthn_credentials` (§6.3) · `ALTER TABLE sessions ADD COLUMN auth_method / pending_challenge / pending_challenge_expires_at` (§6.3). No existing table is rebuilt. |

Nothing else in `migrations/` is touched. `0004_billing.sql` is already correct for everything in
§3–§4 — it was written for this and its ORDERING header already describes §4.5.

### 8.2 `apps/api`

| File | Change |
|---|---|
| `src/env.ts` | `Env` gains `BILLING: Fetcher`, `RL_CHECKOUT: RateLimitBinding`, `RL_AUTH: RateLimitBinding`, `DASHBOARD_ORIGIN: string`, `API_ORIGIN: string`, `WEBAUTHN_RP_ID: string`, `SESSION_HMAC_KEY?` (not needed — the session token is opaque and hashed, no HMAC). `RateLimitBindingName` gains `'RL_CHECKOUT' \| 'RL_AUTH'`. `AppVariables` gains `session?: SessionRow` and `gate?: Gate`. **`exactOptionalPropertyTypes` is on**: declare these as `session: SessionRow \| undefined`, not `session?: SessionRow`, wherever they can receive a possibly-undefined value. |
| `src/index.ts` | mount `billingRoutes` at `/v1/billing` and `authRoutes` at `/v1/auth`. Middleware order is unchanged and is still the security model. |
| `src/middleware/origin.ts` | `isAppOrigin(origin, appOrigin)` becomes `isAllowedOrigin(origin, origins: readonly string[])`, still `===` per entry, still **no regex and no suffix match**, still rejecting a *missing* Origin on state-changing methods. `appCors` echoes whichever entry matched and keeps `Vary: Origin` on every response. The allowlist is `[APP_ORIGIN, DASHBOARD_ORIGIN]`. `isAppOrigin` is exported but has no caller outside the module (`src/__tests__/origin.test.ts` drives the middleware, not the predicate), so it may simply be replaced rather than kept as a shim. |
| `src/middleware/session.ts` | **new.** `requireSession` — read `__Host-aib_session`, `sha256`, `cp.users.getSessionByTokenHash`, slide via `touchSession` at most hourly, put the row on the context. 401 `no_session` otherwise. |
| `src/routes/submit.ts` | (a) prior-trial e-mail check after slug resolution (§1 step 2); (b) `SQL_INSERT_GENERATION_JOB` → `SQL_INSERT_GENERATION_JOB_AWAITING_PAYMENT` with `requires_entitlement = 1` and `queue_ready_at = NULL`; (c) `dispatchGeneration()` is **removed from this route** and replaced by `createCheckoutSession()` over the `BILLING` binding; (d) `settleBudget(0)` unconditionally before returning — no reservation may survive the response; (e) `acceptedBody()` gains `paymentState`, `checkoutUrl`, `checkoutExpiresAt`; (f) `replaySubmitted()` gains an `awaiting_payment` branch that returns the *live* checkout URL when the stored session is still open, and re-mints one when it is not. The whole "WHAT HAPPENS WHEN SOMETHING FAILS HALF-WAY" comment block needs rewriting: the failure modes changed. |
| `src/routes/jobs.ts` | (a) synthetic id-less `event: payment` frame before proxying (§2.2); (b) `phaseForStatus`/`progressForStatus` become payment-aware; (c) `JobStatusBody` gains `paymentState` and `checkoutExpiresAt`; (d) `authorizedJob()` accepts **either** the draft cookie **or** a session with a membership in the job's org, so the dashboard can watch a regeneration. |
| `src/routes/billing.ts` | **new.** `GET /v1/billing/return` (§2.3) · `POST /v1/billing/checkout/:jobId` (re-mint, `RL_CHECKOUT`, capped by `checkout_attempts`) · `POST /v1/billing/portal` (session + `owner`). |
| `src/routes/auth.ts` | **new.** magic-link request/verify, passkey register/authenticate options+verify, `POST /v1/auth/logout`, `POST /v1/auth/logout-all`, `GET /v1/auth/me`. |
| `src/lib/entitlement.ts` | **new.** `requireEntitlement()` (§7.3). |
| `src/lib/budget.ts` | `reserveBudget` is no longer called on the submit path. It moves to the dispatch path (webhook / drain). The module's header comment says "before dispatch"; it now actually is. |
| `src/routes/claim.ts` | one line: `mintSessionId()` moves to `mintId('session')` once `ID_PREFIXES` gains `session: 'ses'`; the local `monotonicFactory` and its explanatory comment are deleted. Behaviour unchanged. |
| `wrangler.jsonc` | `services` += `{ binding: 'BILLING', service: 'aibuilder-billing' }`; `ratelimits` += `RL_CHECKOUT` (ns 1005, 3/60) and `RL_AUTH` (ns 1006, 3/60); `vars` += `DASHBOARD_ORIGIN`, `API_ORIGIN`, `WEBAUTHN_RP_ID`. `compatibility_date` stays **`2026-08-22`**. |

### 8.3 `packages/db`

New statements only; no existing statement changes.

| File | Added |
|---|---|
| `src/shard/generation-jobs.ts` | `SQL_INSERT_GENERATION_JOB_AWAITING_PAYMENT` · `SQL_ATTACH_CHECKOUT_SESSION` (`WHERE id=? AND payment_state='awaiting_payment'`) · `SQL_RELEASE_PAID_JOB` (`SET payment_state='paid', queue_ready_at=?`, guarded) · `SQL_ABANDON_CHECKOUT` · `SQL_LIST_EXPIRED_CHECKOUTS` (seeks `idx_jobs_awaiting_payment`) · `SQL_BUMP_CHECKOUT_ATTEMPTS`. `GenerationJobRow` gains the four new columns. |
| `src/cp/billing.ts` | **new module.** `stripe_customers`, `subscriptions`, `stripe_events` (insert / claim / complete / fail / list-stuck), `invoices` — all as `SQL_`-prefixed constants beside their runners, so the EQP gate sees them. |
| `src/cp/trials.ts` | **new module.** `SQL_FIND_TRIAL_BY_EMAIL`, `SQL_FIND_TRIAL_BY_FINGERPRINT`, `SQL_INSERT_TRIAL_GRANT`, `SQL_SET_TRIAL_OUTCOME`. |
| `src/cp/auth.ts` | **new module.** `webauthn_credentials` CRUD, `SQL_SET_SESSION_CHALLENGE`, `SQL_CONSUME_SESSION_CHALLENGE` (atomic, `meta.changes === 1`), `SQL_SET_SESSION_AUTH_METHOD`. |
| `src/cp/orgs.ts` | `SQL_SET_ORG_BILLING_PROFILE` (address / VAT / country from `customer.updated`) · a `purgeProvisionalOrganisation` ordered-delete helper (§2.6). |
| `src/types.ts` | `TrialOutcome`, `AuthMethod`, `PaymentState`, `TrialGrantRow`, `WebauthnCredentialRow`; `SessionRow` gains `auth_method`, `pending_challenge`, `pending_challenge_expires_at`; `GenerationJobRow` gains the four new columns. |
| `src/statements.ts` | register every new `SQL_` constant so the EQP gate covers it. |

### 8.4 `packages/core`

| File | Change |
|---|---|
| `src/ids.ts` | `ID_PREFIXES` += `session: 'ses'`, `trialGrant: 'trg'`, `webauthnCredential: 'pky'`. `ses` is already required by `migrations/cp/0001`'s `CHECK (id GLOB 'ses_[0-7]*')`; the claim route currently spells it out locally. |
| `src/entitlement.ts` | **new.** `decideEntitlement()` (§7.2) — pure, no bindings, exhaustively unit-tested including the `OtherString` fallback. |
| `src/errors.ts` | `TrialAlreadyUsedError`, `EntitlementLapsedError`. |

### 8.5 `apps/marketing`

| File | Change |
|---|---|
| `src/lib/api.ts` | `SubmitResponse` gains `paymentState`, `checkoutUrl`, `checkoutExpiresAt`; `JobStatusResponse` gains `paymentState`, `checkoutExpiresAt`; new `resumeCheckout(jobId)`. The "a request carrying a Turnstile token is never retried" rule is unchanged and still applies to submit. |
| `src/islands/OnboardingModal.tsx` | on a `202` carrying `checkoutUrl`, `window.location.assign(checkoutUrl)` — **top-level navigation, never an iframe**. The draft is already flushed and frozen at that point, so a returning browser resumes correctly. New URL states read on mount: `?job=…` (resume the theatre), `&payment=confirming`, `&checkout=cancelled`, `&checkout=expired`. |
| `src/islands/GenerationTheatre.tsx` | a ninth act, `awaiting_payment`, placed **before** `queued`. `ACTS` becomes 10 entries, `ActIndex` 0–9, `ACT_FLOOR` gains a leading `0`, `PHASE_TO_ACT` shifts by one. The rail does **not** animate in this act (§2.3). New props: `paymentState`, `checkoutDeadlineAt`, `onResumeCheckout`. |
| `src/islands/hooks/useSSE.ts` | handle the named `payment` event; do **not** treat a frame without `id:` as advancing `Last-Event-ID`; `close()` the `EventSource` when `paymentState` is `abandoned` (an `EventSource` reconnects forever otherwise). |
| `src/lib/copy.ts` | `generation.acts.awaitingPayment`, the 20 s and 90 s escalation lines, the payment-failed card, the "trial already used" 409 copy, the resume-checkout button — nl **and** en. |
| `src/content/pricing.ts` | unchanged. It is already correct and its `assertAnnualTotalMatches` build guard is what §3.1 relies on. |

### 8.6 New apps and root files

| Path | Purpose |
|---|---|
| `apps/billing/src/index.ts` | `POST /v1/stripe/webhook` (public) + the service-binding surface: `POST /v1/checkout-sessions`, `GET /v1/checkout-sessions/:id`, `POST /v1/portal-sessions`, `GET /health`. |
| `apps/billing/src/stripe.ts` | client factory: `apiVersion: '2026-08-26.dahlia'`, `createFetchHttpClient()`, `maxNetworkRetries: 2`, one instance per isolate. |
| `apps/billing/src/webhook/{verify,dispatch,handlers/*}.ts` | §4, one file per event family. |
| `apps/billing/src/mirror.ts` | Stripe object → our row shapes. Owns the `items.data[0]` period extraction **[V4]**, the `sum(total_taxes)` tax **[V5]**, and the status clamp **[V14]**. |
| `apps/billing/wrangler.jsonc` | `compatibility_date: "2026-08-22"`, `nodejs_compat`; `routes: [{ pattern: "billing.aibuilder.app/*", zone_name: "aibuilder.app" }]`; `d1_databases`: CP + SHARD_000; `services`: `GENERATOR`; `secrets_store_secrets`: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `TRIAL_FINGERPRINT_PEPPER`; `r2_buckets`: `BLOBS` (event archive); `vars`: `ENVIRONMENT`, `APP_ORIGIN`, `API_ORIGIN`, `DASHBOARD_ORIGIN`, `SITES_ROOT_DOMAIN`, `STRIPE_PRICE_ID`. |
| `.dev.vars.example` | uncomment and fill the `apps/billing` block that is already stubbed there; add `TRIAL_FINGERPRINT_PEPPER`. |
| `.env.example`, `README.md` | `billing.aibuilder.app` and `app.aibuilder.app` join the §D1 find-and-replace list. README's bootstrap section gains: create the Stripe Product/Price, configure Stripe Tax with the NL registration, configure the portal, register the webhook endpoint with the fourteen event types, **and swap the domain placeholder before the first passkey is registered** (§6.5). |

---

## 9. Test plan

Pool config copies `apps/api/vitest.config.ts` verbatim: `cloudflareTest({...})` from
`@cloudflare/vitest-pool-workers` as a **Vite plugin** — there is no `defineWorkersConfig` and no
`/config` subpath — with `compatibilityDate: '2026-08-22'`. `apps/billing` needs
`durableObjects: [{ className: 'JobHub', useSQLite: true }]` only if a test drives the DO;
otherwise typed doubles as in `apps/api/src/__tests__/doubles.ts`. `cloudflare:test`'s `env` is typed
by augmenting the global `Cloudflare.Env` namespace — copy `apps/generator/src/__tests__/cloudflare-test.d.ts`.

Signed webhook fixtures come from `Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret, cryptoProvider })` **[V2]** — real signatures, no stubbing of the verifier.

### Billing — sequence

- **T-B1** submit returns `202` with `paymentState:'awaiting_payment'` and a `checkoutUrl`; the job row is `status='queued'`, `queue_ready_at IS NULL`, `payment_state='awaiting_payment'`, `requires_entitlement=1`.
- **T-B2** `SQL_LIST_QUEUED_JOBS` does **not** return an `awaiting_payment` job; after `SQL_RELEASE_PAID_JOB` it does. (This is the whole design in one assertion — proven once already at **[V22]**.)
- **T-B3** submit dispatches **nothing**: the `GENERATOR` double records zero calls.
- **T-B4** the budget reservation is settled at 0 before the response; the `BudgetDO` double shows no outstanding reservation.
- **T-B5** replay of submit for an `awaiting_payment` draft returns `200` with the **same** `jobId` and a still-valid `checkoutUrl`; no second job row, no second org, no second slug.
- **T-B6** an existing user's e-mail with a `trial_grants` row → `409 trial_already_used`, zero rows written, zero Stripe calls.

### Billing — webhook

- **T-B7 (redelivery race)** two `checkout.session.completed` deliveries of the **same** `event.id`, issued concurrently: exactly one claims the row (`meta.changes === 1`), exactly one dispatches, both answer 200, and `memberships`/`trial_grants` each hold exactly one row.
- **T-B8 (expired claim)** a `stripe_events` row left `processing` with `claim_expires_at` in the past is re-claimable; one left `processing` with a live claim is not.
- **T-B9 (out-of-order)** `customer.subscription.deleted` delivered *before* `customer.subscription.updated(active)`; the API double returns a `canceled` subscription for both re-reads; final entitlement is `canceled`. Proves §4.5.
- **T-B10 (unknown org)** an event whose customer and `client_reference_id` resolve to nothing → `stripe_events.status='skipped'`, `org_id IS NULL`, **HTTP 200**, no CP or SH writes.
- **T-B11 (livemode)** `livemode:false` against `ENVIRONMENT='production'` → `skipped`, 200, no writes; and the mirror case.
- **T-B12 (signature)** tampered body → **400**; body read as `text()` first is asserted by the test's own fixture construction; a valid signature 4 minutes old passes and 6 minutes old fails (`DEFAULT_TOLERANCE = 300` **[V3]**).
- **T-B13** `invoice.paid` writes `tax_cents = sum(total_taxes[].amount)` and tolerates `total_taxes: null`; `hosted_invoice_url`/`invoice_pdf` absent is not a crash **[V5][V6]**.
- **T-B14** the subscription mirror writes `current_period_start/end` from `items.data[0]`, and a subscription with an **empty** `items.data` produces `NULL`s rather than a throw **[V4]**.
- **T-B15** an unrecognised `subscription.status` is clamped to `'past_due'` in the mirror and to `past_due` + `now + 14d` in the entitlement, and raises an alert **[V14]**.
- **T-B16** `charge.dispute.created` flips `index_state='gone'` and `status='suspended'`; `dispute.closed(won)` restores both.
- **T-B17** the membership insert precedes the de-provision in the batch; reversing the order makes `trg_orgs_deprovision_needs_member` abort the whole batch (assert the abort, so the ordering is protected by a test and not by a comment).

### Billing — the races

- **T-B18 (redirect beats webhook)** `payment_state='awaiting_payment'`, Stripe double returns `status:'complete'` → `/v1/billing/return` mints a session, 303s with `payment=confirming`, and **does not** write `payment_state`, dispatch, or create a membership.
- **T-B19** the same, but the Stripe double returns `status:'open'` → no session minted, 303 with `checkout=cancelled`.
- **T-B20** `/v1/billing/return` with a valid `session_id` but **no** draft cookie → 303 to `/start/`, no session minted. With a draft cookie whose job names a *different* `checkout_session_id` → same.
- **T-B21 (abandoned Checkout)** `checkout.session.expired` sets `payment_state='abandoned'` and leaves `status='queued'` (**not** terminal); `POST /v1/billing/checkout/:jobId` then mints a fresh session and returns the state to `awaiting_payment`; the 6th attempt is refused.
- **T-B22 (purge order)** an org with a `stripe_customers` row is deleted only after that row is; deleting the org first raises the RESTRICT foreign-key error (assert it, so the ordering is enforced by a test). A provisional org with a `trialing` subscription is **skipped** by the purge.
- **T-B23 (SSE)** connecting to an `awaiting_payment` job yields a `payment` frame with **no `id:` line** and then heartbeats; after the release the JobHub's `queued` event arrives with `id: 1`; a reconnect carrying `Last-Event-ID: 1` does not replay the payment frame.

### Trial abuse

- **T-T1** a fingerprint hit converts the trial: `subscriptions.update(id,{trial_end:'now'})` is called exactly once, entitlement stays `trialing` until `invoice.paid`, and the job is **not** released before it.
- **T-T2** a missing/`null` fingerprint **[V15]** is "no signal": the trial proceeds normally.
- **T-T3** a fingerprint whose prior grant is `outcome='disputed'` cancels the subscription and never releases the job.
- **T-T4** `trial_grants` survives `purgeProvisionalOrganisation`.

### Entitlement

- **T-E1** `decideEntitlement` is exhaustive over all eight known statuses plus one unknown; a snapshot table test.
- **T-E2** every `trialing`/`active`/`past_due` decision returns a non-null `entitlementUntil`, so the `organisations` CHECK can never be violated. Property test over random inputs.
- **T-E3** `cancel_at_period_end=true` leaves entitlement `active` with `until = current_period_end`.
- **T-E4** `requireEntitlement` returns `no_membership` (→404) for a provisional org even when its entitlement says `trialing` — the tenancy isolation invariant.
- **T-E5** an `entitlement_until` in the past yields `entitlement_lapsed` (→402) even when the column still reads `trialing`.
- **T-E6** `POST /v1/sites/:id/regenerate` on a lapsed org writes `status='blocked_paywall'` with `finished_at` non-null and answers 402.

### Authentication

- **T-A1** `POST /v1/auth/magic-link` answers `202` identically for a known and an unknown address (no existence oracle); the per-address cap is enforced.
- **T-A2** a magic-link token consumed twice: the first mints a session, the second answers **410**; exactly one session row exists. A `GET` of the link's URL renders the interstitial and does **not** consume.
- **T-A3** every rotation trigger in §6.4's table revokes the old session and sets a new cookie; the old token then fails `getSessionByTokenHash`.
- **T-A4** `__Host-aib_session` is emitted with `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` and **no `Domain`** — a string assertion on the header, because a `Domain` attribute silently voids the `__Host-` prefix.
- **T-A5** the `rpID` one-way-door test (§6.5), verbatim.
- **T-A6** passkey registration and authentication round-trip against fixtures generated by `@simplewebauthn/server`'s own helpers, inside workerd. This is also the smoke test that the library runs on this runtime — it does **[V23]**, and the test keeps it true.
- **T-A7** a **decreasing** sign counter is refused and revokes the user's sessions; a counter of `0 → 0` is accepted.
- **T-A8** logout clears both cookies and revokes the row; `logout-all` revokes every session and returns the count.

### Gates already in CI

- **EQP:** every new `SQL_` constant is in `statements.ts` and produces no `SCAN`. The one that matters is `SQL_LIST_EXPIRED_CHECKOUTS` → already proven `SEARCH … USING INDEX idx_jobs_awaiting_payment` **[V22]**.
- **Migration row-count gate:** applies to `shard/0007` and `cp/0008`. Both are ADD COLUMN / CREATE TABLE only, so the before/after per-table counts must be identical — which is exactly the assertion that catches an accidental rebuild.

---

## 10. Handover — exports, dependencies, and the two open items

### New workspace dependencies

| Package | Version | Where | Why |
|---|---|---|---|
| `stripe` | `^22.6.1` | `apps/billing` **only** | Pinned API version `2026-08-26.dahlia` **[V1]**. Import the default export; the `workerd` export condition resolves to the fetch/SubtleCrypto build automatically **[V2]**. Verified to typecheck under this repo's `strict` + `exactOptionalPropertyTypes` + `moduleResolution: "bundler"` with `types: ["@cloudflare/workers-types"]` and **no `@types/node`** (`skipLibCheck` absorbs the package's `/// <reference types="node" />`). |
| `@simplewebauthn/server` | `14.0.1` (exact) | `apps/api` | **[V23]** |
| `@simplewebauthn/browser` | `^14` | `apps/app` (optional) | base64url plumbing only |

`apps/billing` also needs the usual devDependency set copied from `apps/api/package.json`
(`@cloudflare/vitest-pool-workers`, `@cloudflare/workers-types`, `typescript`, `vitest`, `wrangler`)
and `hono` if the router is wanted — two routes probably do not need one, matching
`apps/generator/src/index.ts`'s reasoning.

### Exports another agent must wire up

- `packages/core/src/index.ts` → re-export `./entitlement` (`decideEntitlement`, `EntitlementDecision`) and the two new error classes.
- `packages/core/src/ids.ts` → `ID_PREFIXES` += `session: 'ses'`, `trialGrant: 'trg'`, `webauthnCredential: 'pky'`.
- `packages/db/src/cp/index.ts` → `export * as billing from './billing'`, `export * as trials from './trials'`, `export * as auth from './auth'`.
- `packages/db/src/statements.ts` → register every new `SQL_` constant (the EQP gate reads this file).
- `packages/db/src/types.ts` → `PaymentState`, `TrialOutcome`, `AuthMethod`, `TrialGrantRow`, `WebauthnCredentialRow`; extend `SessionRow` and `GenerationJobRow`.
- Root `eslint.config.js` → the `boundaries` element type for `apps/billing` (same shape as `apps/generator`: may import `@aibuilder/db` and `@aibuilder/core`, may not be imported by a package).
- Root `package.json` → no new scripts; `turbo` picks the new app up from `pnpm-workspace.yaml`.

### Two things a human must do, that no code can

1. **Register for VAT OSS before cross-border EU B2C sales pass €10 000 in a calendar year**
   (~84 consumer subscriptions at this price) **[V24]**. Stripe Tax's threshold monitoring is the
   alarm; the registration has a lead time. Until it exists, Stripe Tax is configured with NL only,
   which is correct below the threshold and wrong the day after.
2. **Swap the `aibuilder.app` placeholder (§D1) before the first passkey is registered.** That is a
   strictly earlier deadline than §D1's own "before the first tenant slug is indexed", because
   `WEBAUTHN_RP_ID` is a one-way door and a changed RP ID invalidates every credential with no
   recovery (§6.5).

### One decision deliberately deferred

**iDEAL is not enabled at launch.** It is the dominant Dutch payment method and its absence will cost
conversion, so this is a real trade and not an oversight. Card-only is chosen because every control
in §5 depends on `card.fingerprint`, because `payment_method_collection: 'always'` +
`missing_payment_method: 'cancel'` have well-understood semantics on cards, and because iDEAL for a
*recurring* subscription means an iDEAL-initiated SEPA Direct Debit mandate — a different mandate
lifecycle, a different failure mode (returns up to 8 weeks later), a different fingerprint field
(`sepa_debit.fingerprint`), and a different dunning story. Enabling it later is a bounded change:
add `'ideal'` to `payment_method_types`, extend the fingerprint lookup to both instrument types,
handle `charge.refunded`/`charge.dispute.created` for SEPA returns, and re-test §5. That belongs in
Phase 3 with a measured conversion number behind it, not in Phase 2 on a hunch.

---

## Sources

- [stripe-node CHANGELOG](https://github.com/stripe/stripe-node/blob/master/CHANGELOG.md) · [v22 migration guide](https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v22) · [stripe on npm](https://www.npmjs.com/package/stripe?activeTab=versions)
- [Deprecate subscription `current_period_start`/`end` (2025-03-31.basil)](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end) · [Mixed interval subscriptions](https://docs.stripe.com/billing/subscriptions/mixed-interval)
- [Verifying Stripe webhook signatures with Cloudflare Workers](https://jross.me/verifying-stripe-webhook-signatures-cloudflare-workers/) · [Stripe webhook in Cloudflare Workers](https://gebna.gg/blog/stripe-webhook-cloudflare-workers) · [workers-sdk #2816 — "Body has already been used"](https://github.com/cloudflare/workers-sdk/issues/2816)
- [Stripe: receive events in your webhook endpoint](https://docs.stripe.com/webhooks) · [Stripe webhook retry policy](https://www.webhookwatch.com/article/stripe-webhook-retry-policy-explained) · [Stripe webhook retry & reliability](https://eventdock.app/webhooks/stripe-webhook-retry)
- [Stripe: free trials in Checkout](https://docs.stripe.com/payments/checkout/free-trials) · [Saving payment methods for subscriptions after SCA](https://support.stripe.com/questions/saving-payment-methods-for-subscriptions-after-strong-customer-authentication-(sca)-regulations-take-effect?locale=en-GB) · [SCA best practices for recurring revenue](https://stripe.com/guides/sca-best-practices-for-recurring-revenue)
- [Stripe: introduction to EU VAT and VAT OSS](https://stripe.com/guides/introduction-to-eu-vat-and-european-vat-oss) · [How the VAT OSS scheme works for Dutch companies](https://stripe.com/resources/more/one-stop-shop-oss-vat-scheme) · [One Stop Shop 2026 guide](https://norman.finance/blog/one-stop-shop)
- [SimpleWebAuthn changelog (isomorphic architecture)](https://github.com/MasterKale/SimpleWebAuthn/blob/master/CHANGELOG.md) · [@simplewebauthn/server docs](https://simplewebauthn.dev/docs/packages/server/) · [Cloudflare Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
