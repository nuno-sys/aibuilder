# aibuilder

An AI website builder for European small businesses. A shop owner answers six questions in a modal,
and about two minutes later a real, indexable, multi-page website is live on
`<slug>.${SITES_ROOT_DOMAIN}` — copy, structure, palette, images, JSON-LD and sitemap included.
Generation runs on `claude-opus-5`; everything else runs on Cloudflare. Primary UI language is Dutch,
with `en`, `de`, `fr`, `es` and `pt` supported.

This README is the operator's runbook. The decided design lives in
[`.design/00-ARCHITECTURE.md`](.design/00-ARCHITECTURE.md); where that document and
[`.design/VERIFIED-FACTS.md`](.design/VERIFIED-FACTS.md) disagree, **VERIFIED-FACTS wins**.

---

## Architecture in fifteen lines

Two registrable domains, and that split is the security boundary: attacker-influenced tenant HTML
must never share a registrable domain with the session cookie. The control-plane domain carries
marketing, the dashboard and the API; the tenant domain carries every generated site and the media
CDN. Cookies are `__Host-` prefixed on the control plane; the tenant domain is submitted to the
Public Suffix List so no tenant can set a cookie for its neighbours.

Six deployables, one primitive: every surface is a Worker, bound as a **Route** (routes beat Custom
Domains on the same hostname, and a more specific route beats `*/*`). Generated sites are _not_
per-site builds — the renderer is a library that runs inside workerd, so draft preview and publish
share one code path. A visitor request is KV → Cache API → R2 and never touches D1. Publishing is a
KV pointer flip; the version is inside the cache key, so there is no purge, no purge quota and no
purge race. Rollback is the same flip, backwards.

Generation is a Cloudflare Workflow — one Anthropic call per step, memoised per step, with no
15-minute wall clock. It is the only Worker holding an Anthropic key. Data lives in EU-resident D1
(one control plane plus N shards keyed by `org_id`, launching with one), EU-jurisdiction R2, and
Durable Objects pinned to the `eu` jurisdiction. Those three residency choices are set at creation
and can never be changed.

### Surfaces

| Surface                             | Runtime                                  | Cloudflare product                     | Bound as                             |
| ----------------------------------- | ---------------------------------------- | -------------------------------------- | ------------------------------------ |
| Marketing `www.<control-plane>`     | Astro, `output: 'static'`, no adapter    | Workers Static Assets (no `main`)      | Route `www.<control-plane>/*`        |
| API `api.<control-plane>`           | Hono                                     | Workers, D1, R2, KV, Queues, Images    | Route `api.<control-plane>/*`        |
| Generator (no public route)         | Cloudflare Workflows + 3 Durable Objects | Workflows, DO (SQLite), Queues, D1, R2 | Service binding from the API         |
| Tenant renderer `*.<tenant-domain>` | Hono + `packages/site-kit`               | Workers, R2, KV, Cache API             | Route `*/*` on the tenant zone       |
| Media `cdn.<tenant-domain>`         | Hono, read-only                          | Workers, R2                            | Route `cdn.<tenant-domain>/*`        |
| Dashboard `app.<control-plane>`     | React Router v7 — **Phase 2**            | Workers                                | Route `app.<control-plane>/*`        |
| Billing webhook                     | Hono, separate Worker — **Phase 2**      | Workers                                | Route (more specific than the API's) |

### Storage and residency

| Store                            | Contents                                                       | Residency                                     |
| -------------------------------- | -------------------------------------------------------------- | --------------------------------------------- |
| D1 `aibuilder-cp`                | identity, orgs, sessions, billing, slug registry, site routing | `--jurisdiction eu` — **immutable**           |
| D1 `aibuilder-shard-000`         | versions, pages, media, leads, generation ledger, audit        | `--jurisdiction eu` — **immutable**           |
| R2 `aibuilder-blobs`             | SiteDoc JSON, materialised HTML, sitemaps, AI transcripts      | `--jurisdiction eu` — **immutable**           |
| R2 `aibuilder-media`             | uploads, derivatives, re-hosted stock                          | `--jurisdiction eu` — **immutable**           |
| R2 `aibuilder-quarantine`        | unverified uploads, 24 h lifecycle delete                      | `--jurisdiction eu` — **immutable**           |
| KV `ROUTING`, KV `GEO`           | host → site manifest; postcode cache                           | edge                                          |
| DO `JobHub` `BudgetDO` `QuotaDO` | SSE log, spend ceiling, quota counters                         | `.jurisdiction('eu')` in code — **immutable** |

---

## Monorepo map

```
aibuilder/
├─ apps/
│  ├─ marketing/     Astro static site. Hero, pricing, legal. Hosts the onboarding modal island.
│  ├─ api/           Hono. Drafts, uploads, slug/geo, submit, SSE proxy, leads, claim.
│  ├─ generator/     Workflow entrypoint + JobHub/BudgetDO/QuotaDO. Sole holder of the Anthropic key.
│  ├─ renderer/      [not in this delivery] Serves *.<tenant-domain> from R2. No D1 binding.
│  ├─ media/         [not in this delivery] Serves cdn.<tenant-domain> with forced headers.
│  ├─ app/           [Phase 2] React Router v7 dashboard + live editor.
│  └─ billing/       [Phase 2] Sole holder of the Stripe key.
│
├─ packages/
│  ├─ site-schema/   THE CONTRACT. Model-facing Zod schemas, SiteDoc, normalize/genToDoc, lint.
│  ├─ site-kit/      hono/jsx sections, design-DNA tokens, CSS assembly, JSON-LD. Depends only on site-schema.
│  ├─ core/          Publish pipeline, R2 keys, slug policy, sitemap, quality gate. Takes Env as a parameter.
│  ├─ ai/            Anthropic client, prompt blocks, cache layout, repair ladder, usage → cost ledger.
│  ├─ db/            D1 schema, shard router, every shipped statement, EXPLAIN QUERY PLAN fixtures.
│  ├─ ui/            React components shared by the marketing island and (Phase 2) the dashboard.
│  └─ config/        Shared tsconfig / tailwind presets.
│
├─ migrations/
│  ├─ cp/            Control-plane D1 migrations
│  └─ shard/         Shard D1 migrations
│
└─ .github/workflows/ci.yml
```

Internal packages are **unbuilt**: they export `"exports": { ".": "./src/index.ts" }` and are bundled
by each app's Vite/esbuild pass. There is no build ordering to get wrong and no stale `dist/` to
debug. `Env` types are generated by `wrangler types` in each app's `pretypecheck` and are never
hand-written.

**Boundaries are enforced, not documented.** `eslint-plugin-boundaries` in
[`eslint.config.js`](eslint.config.js) fails the build on any of: `site-schema` importing another
workspace package; `site-kit` importing a workspace package other than `site-schema`; any package
importing `cloudflare:*` (bindings reach `core` only as an injected `Env`); any package importing an
app; any app importing another app. Third-party dependencies are unrestricted — the rule is about the
shape of _our_ graph. The graph itself is a single object at the top of that file.

---

## Prerequisites

- **Node 22** — the version in [`.nvmrc`](.nvmrc). `nvm use` picks it up.
- **pnpm 10** — `corepack enable` is enough; the exact version is pinned in `package.json`
  under `packageManager`.
- **A Cloudflare account on the Workers Paid plan.** Workflows, Durable Objects with SQLite storage,
  Queues and the Images binding are all paid-plan features.
- **`wrangler login`** (or `CLOUDFLARE_API_TOKEN` in `.env` for non-interactive use).
- **An Anthropic API key** with a workspace spend limit already set. The first generation costs real
  money on an endpoint that is reachable without an account; the limit is not optional.

```bash
git clone <this repo> && cd aibuilder
nvm use
pnpm install
```

`pnpm install` is the only install: pnpm 10 will not run dependency lifecycle scripts unless they are
approved, and the approvals (`esbuild`, `workerd`, `sharp`, `@tailwindcss/oxide`) are already listed
under `onlyBuiltDependencies` in [`pnpm-workspace.yaml`](pnpm-workspace.yaml).

---

## Bootstrap

> ### Read this before running anything
>
> **Three of the commands below close doors that cannot be reopened.**
>
> 1. **D1 `--jurisdiction`** is fixed at creation. There is no "move this database to the EU" API.
> 2. **R2 `--jurisdiction`** is fixed at creation _and_ changes the S3 endpoint host
>    (`https://<account>.eu.r2.cloudflarestorage.com`). That host is covered by the presigning
>    signature, so a bucket created in the wrong jurisdiction produces URLs that cannot be repaired
>    after the fact.
> 3. **Durable Object jurisdiction** is not a CLI flag at all — it is `.jurisdiction('eu')` in the
>    code that derives every DO id. Adding it later changes every id, which silently resets every
>    quota counter and every budget ledger.
>
> Everything is still free to decide right now: `database_id` is a placeholder everywhere and nothing
> has been applied `--remote`. It stops being free the moment you run
> `pnpm migrate:cp:remote`. Architecture §10 lists all ten one-way doors; these three are the ones
> this section can get wrong for you.
>
> **Settle [open question 1](#open-questions) — the control-plane domain — before you start.** It
> cannot be retrofitted once tenant slugs are indexed.

### The short way: run it from GitHub

Put `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the repository's Actions secrets, then
Actions → **Bootstrap Cloudflare** → Run workflow. It creates every resource the wrangler configs
bind — reading the list out of the configs themselves, so it cannot drift from what the code
expects — and opens a PR with the 27 ids filled in. `dry_run` is the default and prints the plan
without touching the account; it is safe to run twice, because every resource is listed before it is
created and the id is always read back.

It does not create secrets (values, not resources), zones (a nameserver change at your registrar) or
migrations (`pnpm migrate:*:remote` is where forward-only starts, and that is a decision, not a side
effect). Steps 6, 7 and 9 below are still yours.

### The long way, by hand

`pnpm bootstrap` only confirms which Cloudflare account you are pointed at and then stops. Creating
immutable resources is deliberately not automated here: run the commands below one at a time and
record each id in `.env` as it is printed.

### 1. Verify the account

```bash
cp .env.example .env          # then fill in CLOUDFLARE_* if you are not using `wrangler login`
pnpm bootstrap                # == wrangler whoami + a reminder of the paragraph above
```

Confirm the account id matches the one you intend to bill. Everything below lands in that account.

### 2. D1 — control plane and first shard

`--jurisdiction eu` is the residency control and is what makes these databases EU-resident.

```bash
pnpm exec wrangler d1 create aibuilder-cp        --jurisdiction eu
pnpm exec wrangler d1 create aibuilder-shard-000 --jurisdiction eu
```

Record the two `database_id` values in `.env` as `D1_CP_DATABASE_ID` and `D1_SHARD_000_DATABASE_ID`.

> The architecture document writes this as `--location eu`. That flag exists but is a _placement
> hint_ and its values are `weur | eeur | apac | oc | wnam | enam` — `eu` is not one of them, and the
> command fails. `--jurisdiction` (values `eu | fedramp | us`) is the residency control. You may add
> `--location weur` alongside it to pin the primary replica to Western Europe.

### 3. R2 — three buckets, all EU-jurisdiction

`--jurisdiction` and `--location` are **mutually exclusive** for R2; wrangler rejects both together.
Pass the jurisdiction.

```bash
pnpm exec wrangler r2 bucket create aibuilder-blobs      --jurisdiction eu
pnpm exec wrangler r2 bucket create aibuilder-media      --jurisdiction eu
pnpm exec wrangler r2 bucket create aibuilder-quarantine --jurisdiction eu
```

All three are **binding-only**. Do not attach a public R2 domain to any of them: a public custom
domain conflicts with the EU-jurisdiction decision, and that decision outranks it. The quarantine
bucket additionally needs a 24-hour lifecycle rule (dashboard → R2 → aibuilder-quarantine → Settings
→ Object lifecycle rules) so unverified uploads expire on their own.

### 4. KV — routing manifest and geo cache

```bash
pnpm exec wrangler kv namespace create aibuilder-routing
pnpm exec wrangler kv namespace create aibuilder-geo
pnpm exec wrangler kv namespace create aibuilder-stock-cache
```

Three, not two. `STOCK_CACHE` is bound by the generator and was missing from this list — the kind of
drift the GitHub workflow above avoids by reading the configs instead of a written-down list.

The positional argument is the namespace _title_; the binding names inside `wrangler.jsonc` stay
`ROUTING` and `GEO`, and only the printed `id` is ever referenced.

Record the ids in `.env` as `KV_ROUTING_NAMESPACE_ID`, `KV_GEO_NAMESPACE_ID` and
`KV_STOCK_CACHE_NAMESPACE_ID`. KV is deliberately
edge-global: it holds no personal data, only `host → {siteId, shardId, liveVersion, locales,
defaultLocale, indexState}`.

### 5. Queues — media pipeline and its dead-letter queue

```bash
pnpm exec wrangler queues create aibuilder-media
pnpm exec wrangler queues create aibuilder-media-dlq
```

Create the DLQ _before_ the consumer references it, or the generator's first deploy fails.

### 6. Secrets Store — the API Worker's secrets

The API Worker binds its secrets through the Secrets Store (`secrets_store_secrets` in
`apps/api/wrangler.jsonc`) rather than as plain Worker secrets, so they can be rotated and audited
independently of a deploy. This part of wrangler is in open beta.

```bash
pnpm exec wrangler secrets-store store create aibuilder --remote

# Record the printed store id in .env as SECRETS_STORE_ID, then put it in your shell for this
# session and create one secret per name:
export SECRETS_STORE_ID=<printed store id>
pnpm exec wrangler secrets-store secret create "$SECRETS_STORE_ID" \
  --name turnstile_secret --scopes workers --remote
```

Repeat for `draft_hmac_key`, `ip_salt`, `r2_access_key_id`, `r2_secret_key` and `geocoder_key`. Omit
`--value` and let wrangler prompt, so the secret never enters your shell history.

Generate the HMAC key and IP salt with real entropy:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Create the R2 credentials in the dashboard (R2 → Manage API tokens) **scoped to
`aibuilder-quarantine` only**. They are used to presign uploads that unauthenticated browsers
perform, so their blast radius must be one bucket.

### 7. The generator's secrets

The generator holds the money keys, so they stay plain Worker secrets on a Worker with no public
route:

```bash
pnpm exec wrangler secret put ANTHROPIC_API_KEY --config apps/generator/wrangler.jsonc
pnpm exec wrangler secret put PEXELS_KEY        --config apps/generator/wrangler.jsonc
pnpm exec wrangler secret put INDEXNOW_KEY      --config apps/generator/wrangler.jsonc
pnpm exec wrangler secret put IP_SALT           --config apps/generator/wrangler.jsonc
```

`wrangler secret put` targets a deployed Worker; before the generator's first deploy it will offer to
create the script for you. Either accept, or run this step again after step 10.

`IP_SALT` must be the **same value** the API Worker uses, or every cross-check between the abuse
ledger and the quota counters silently misses.

### 8. Paste the ids into the wrangler configs

For each app, open `apps/<app>/wrangler.jsonc` and replace every placeholder with the recorded value:
`database_id` for both D1 bindings, `id` for both KV namespaces, `store_id` for the Secrets Store
bindings, and the `vars` block from `.env` (`APP_ORIGIN`, `SITES_ROOT_DOMAIN`, `MEDIA_ORIGIN`,
`R2_S3_ENDPOINT`, `ENVIRONMENT`, `ANTHROPIC_MODEL`).

`R2_S3_ENDPOINT` **must** carry the `.eu.` label — `https://<account-id>.eu.r2.cloudflarestorage.com`.
The plain `<account-id>.r2.cloudflarestorage.com` host will authenticate and then fail to find the
jurisdictional bucket, and because the host is signed you cannot fix an already-issued URL.

### 9. Migrations

Local first, always. Applying `--remote` is the moment "forward-only" starts: from then on a shipped
migration may never be edited, only superseded.

```bash
pnpm migrate:cp:local
pnpm migrate:shard:local

# and, when you have reviewed the SQL and accepted that it is permanent:
pnpm migrate:cp:remote
pnpm migrate:shard:remote
```

Both databases are declared in `apps/api/wrangler.jsonc`, which is why the migrate scripts point at
that config; `migrations_dir` resolves to `migrations/cp` and `migrations/shard` respectively.

### 10. Run it

```bash
cp .dev.vars.example apps/api/.dev.vars        # then delete every block that is not this Worker's
cp .dev.vars.example apps/generator/.dev.vars  # same, keeping the generator block
pnpm dev
```

---

## Local development

`wrangler dev` reads `.dev.vars` from the directory holding the Worker's config, not from the repo
root — hence the two copies above. [`.dev.vars.example`](.dev.vars.example) is the master template
and documents which Worker holds which secret.

For the API Worker's Secrets Store bindings, `wrangler dev` uses a **local** secrets store. Create the
same names without `--remote` and they resolve offline:

```bash
pnpm exec wrangler secrets-store store create aibuilder      # omit --remote for the local store
export LOCAL_STORE_ID=<printed store id>
pnpm exec wrangler secrets-store secret create "$LOCAL_STORE_ID" \
  --name turnstile_secret --scopes workers
```

Cloudflare publishes Turnstile test keys that always pass and always fail; use those locally rather
than a real site key.

`pnpm dev` runs every app's dev server through Turborepo. To work on one surface, filter:

```bash
pnpm exec turbo run dev --filter=@aibuilder/api
```

### Secrets, and which Worker holds each one

Capability separation is a design invariant. Adding a secret to a second Worker deletes the property
the two-domain, six-Worker split was bought for.

| Secret                     | Worker                | Notes                                                                     |
| -------------------------- | --------------------- | ------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`        | generator **only**    | Separate key per environment. Console workspace spend limit set.          |
| `PEXELS_KEY`               | generator **only**    | Default tier is 200 req/h, 20 000/month — request the upgrade pre-launch. |
| `INDEXNOW_KEY`             | generator             | Served at `/<key>.txt` per tenant host. Minted once, never rotated.       |
| `TURNSTILE_SECRET`         | api                   | Verifies the token minted at draft creation.                              |
| `DRAFT_HMAC_KEY`           | api                   | Signs `__Host-aib_draft`. `kid`-versioned, dual-accept while rotating.    |
| `IP_SALT`                  | api **and** generator | Rotated daily by cron; two generations retained for a 24 h lookback.      |
| `R2_ACCESS_KEY_ID`         | api                   | Scoped to `aibuilder-quarantine` only.                                    |
| `R2_SECRET_KEY`            | api                   | Same token; same scope.                                                   |
| `GEOCODER_KEY`             | api                   | NL/BE postcode lookup.                                                    |
| `STRIPE_SECRET_KEY`        | billing **only**      | The only Worker that holds it. Never add it to a second one.              |
| `STRIPE_WEBHOOK_SECRET`    | billing **only**      | Verifies the hook signature via `constructEventAsync` + Web Crypto.       |
| `TRIAL_FINGERPRINT_PEPPER` | billing **only**      | Peppers `sha256(card.fingerprint)`. Rotating it blinds the trial ledger.  |
| `PREVIEW_HMAC_KEY`         | app **only**          | Signs the short-lived host-scoped preview cookie. Never a query token.    |

Non-secret configuration (`ENVIRONMENT`, `APP_ORIGIN`, `SITES_ROOT_DOMAIN`, `MEDIA_ORIGIN`,
`R2_S3_ENDPOINT`, `ANTHROPIC_MODEL`) lives in each Worker's `vars` block and is mirrored in
[`.env.example`](.env.example) so there is one list to read.

---

## Scripts

| Command                                                  | What it does                                                                                                                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm bootstrap`                                         | `wrangler whoami` plus the one-way-door reminder. Creates nothing.                                                                                                          |
| `pnpm dev`                                               | Every app's dev server, via Turborepo.                                                                                                                                      |
| `pnpm build`                                             | Every app's production build.                                                                                                                                               |
| `pnpm typecheck`                                         | `tsc --noEmit` per package, after each app regenerates its `Env`.                                                                                                           |
| `pnpm lint`                                              | One root ESLint pass, including the architecture boundary rules.                                                                                                            |
| `pnpm format`                                            | Prettier over the repo. `pnpm format:check` in review.                                                                                                                      |
| `pnpm test`                                              | Vitest everywhere, including the D1 `EXPLAIN QUERY PLAN` gate in `packages/db`.                                                                                             |
| `pnpm verify`                                            | typecheck + lint + test — the same three steps CI runs.                                                                                                                     |
| `pnpm migrate:cp:local`                                  | Apply control-plane migrations to the local D1.                                                                                                                             |
| `pnpm migrate:cp:remote`                                 | Apply them to the real database. **Irreversible; forward-only from here.**                                                                                                  |
| `pnpm migrate:shard:local` / `pnpm migrate:shard:remote` | The same, for `aibuilder-shard-000`.                                                                                                                                        |
| `pnpm seed:taxonomy`                                     | Regenerates the taxonomy block of `migrations/cp/0007_seed.sql` from `packages/core/src/industries.ts`. Run it after touching the registry; a stale seed fails `pnpm test`. |

Lint is a single root pass rather than a per-package fan-out on purpose: `eslint-plugin-boundaries`
classifies a file by its path from the repo root, so running ESLint inside `apps/api` would match no
element patterns and silently disable every architecture rule while still reporting success.

### Compatibility date

Every Worker pins `compatibility_date: "2026-08-22"`, and so does every Vitest pool. That is not an
arbitrary date: it is the newest date the `workerd` binary bundled with the installed wrangler
accepts, and a test pool configured past it fails to boot with `ERR_RUNTIME_FAILURE`. Production and
the test pool are deliberately pinned to the _same_ date — a suite running on an older runtime than
the one that serves traffic proves less than it appears to. It is still past 2026-08-04, so
`nodejs_compat` v2 is implicit. Raise both together, never one alone.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs `pnpm install --frozen-lockfile`,
typecheck, lint, test, and a gitleaks history scan. The `EXPLAIN QUERY PLAN` no-`SCAN` gate and the
per-table migration row-count snapshot run inside `pnpm test` from `packages/db`, because both are
Vitest tests against a seeded and `ANALYZE`d database rather than separate jobs.

The Lighthouse and contrast gates are present as a commented-out `# Phase 2` job. They measure
surfaces that do not exist in this delivery, and a gate that cannot fail is worse than no gate.

Deploying is a separate workflow — [`deploy.yml`](.github/workflows/deploy.yml), see
[Deployment](#deployment). It re-runs the same three gates against the commit it is about to deploy
rather than trusting that CI was green on this branch at some point.

## Deployment

Deploys run from GitHub Actions: [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

A push to `main` deploys the **control plane** — generator, billing, api, app, marketing — after
`typecheck`, `lint` and `test` pass against that exact commit. The **tenant zone** (`renderer`,
`media`) is `workflow_dispatch` only and a merge can never trigger it: `apps/renderer` carries a
`*/*` route, so one bad deploy takes every customer site down at once. Actions → Deploy → Run
workflow, pick the target.

The two jobs use two GitHub Environments, `production` and `tenant-zone`, so a required reviewer can
sit in front of the tenant zone even when the control plane deploys straight through.

### The two credentials

Repository → Settings → Secrets and variables → Actions:

| GitHub secret           | Where it comes from                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare → My Profile → API Tokens. Scopes: Workers Scripts:Edit, D1:Edit, Workers KV Storage:Edit, Workers R2 Storage:Edit, Queues:Edit, Account Settings:Read. |
| `CLOUDFLARE_ACCOUNT_ID` | `wrangler whoami`, or the URL of any dashboard page.                                                                                                               |

Nothing else belongs in GitHub. Every application secret lives on the Cloudflare side, which is what
keeps the deploy credential the single thing to rotate.

### Vars go in git, secrets go in the dashboard

Getting this backwards is the one mistake that looks like it worked:

- **Plain vars** — `ENVIRONMENT`, `APP_ORIGIN`, `DASHBOARD_ORIGIN`, `API_ORIGIN`,
  `SITES_ROOT_DOMAIN`, `MEDIA_ORIGIN`, `R2_S3_ENDPOINT`, `ANTHROPIC_MODEL`, `STRIPE_PRICE_ID` —
  belong in each `apps/<app>/wrangler.jsonc` under `vars`, committed. `wrangler deploy` **replaces**
  a Worker's plain vars with what the config says, so a value typed into the dashboard's Variables
  panel is gone at the next deploy. The config is the source of truth; the dashboard shows you what
  the last deploy set.
- **Secrets** — every API key, HMAC key and Stripe key — are set once in the dashboard (Worker →
  Settings → Variables and Secrets → _Encrypt_) or with `wrangler secret put`, and are **not**
  touched by a deploy. They survive every run of this workflow.

### Secrets Store, or plain secrets on the Worker

Four Workers declare their secrets as [Secrets Store](https://developers.cloudflare.com/secrets-store/)
bindings (`secrets_store_secrets` in their `wrangler.jsonc`): one store, rotatable and auditable
without a deploy, managed under Account → Secrets Store rather than on the Worker itself.

If you would rather add them on the Worker directly, that works and costs **no code change**: every
Worker reads through `readSecret()`, which accepts a Secrets Store binding or a plain string
(`apps/*/src/env.ts`). Delete the `secrets_store_secrets` block from that app's `wrangler.jsonc` and
add each name as an encrypted secret on the Worker. What you lose is rotation without a deploy and
one place to audit; what you gain is one fewer resource to create.

### Deploying by hand

Still supported, and the order is not a preference — a service binding cannot name a Worker that
does not exist yet:

```bash
pnpm exec wrangler deploy --config apps/generator/wrangler.jsonc
```

```
generator  ->  billing  ->  api  ->  app
renderer, media          (independent; the tenant zone, deploy last)
```

The generator must exist before billing (which dispatches the Workflow through a service binding)
and before the API (which binds the generator's three Durable Objects). Billing must exist before
the API, which binds it as `BILLING`. `renderer` and `media` bind nothing on the control plane and
can go at any point — but they carry the `*/*` route on the tenant zone, so they are the deploy that
can break every customer site at once. Deploy them last, and on their own.

---

## Scope of this delivery

Phases 1 and 2 are implemented.

**Phase 1** — the onboarding modal, the API behind it, the D1 schema for both databases, and the
generator that builds and dispatches the Anthropic prompt.

**Phase 2** — `packages/site-kit` (the tenant component library, with contrast proven analytically
over the full knob space rather than sampled), `apps/renderer` and `apps/media` (the tenant serving
path, with publish as a KV pointer flip), `apps/billing` and the trial-first funnel, `packages/auth`
(magic link + passkeys), and `apps/app` (the dashboard and the live editor).

Deliberately still open:

- **Publish from the editor.** The editor autosaves to `SiteDraftDO` and says so; it does not render
  a Publish button that would do nothing. The draft -> version -> R2 -> KV flip exists in
  `packages/core/publish.ts` and is driven by the generator today.
- **Phase 3** — Cloudflare for SaaS custom hostnames, the blog in non-primary locales, user video
  (needs Containers and ffmpeg; no build compute runs in a Worker), Places/GBP import, and the
  Playwright/axe render matrix that covers what the analytical contrast proof cannot (layout, tap
  targets, overflow).
- **The lead endpoint** `POST /v1/leads/:siteId`, which needs the per-tenant origin allowlist and
  spam scoring that go with a live contact form.

## Open questions

Three decisions belong to the client and are needed before code freeze. Each one is cheap now and
expensive later.

1. **Nominate the control-plane domain.** The architecture uses `aibuilder.app` as a placeholder.
   Everything in the two-domain split depends on it, and it cannot be retrofitted after tenant slugs
   are indexed and printed on business cards.
2. **Workers Static Assets instead of Pages** is a deviation from a stated non-negotiable and needs
   explicit sign-off. The honest argument is not the one usually given — the `@astrojs/cloudflare`
   v13 Pages removal affects SSR only, and a static Astro build needs no adapter at all. It is that
   Cloudflare directs new projects to Workers, Pages is in maintenance, Workers Static Assets bills
   static assets identically (free, zero invocations), Workflows/Cron/Secrets Store are Workers-only,
   and one deployment primitive across six deployables beats two.
3. **Whether the first generation is free.** It is roughly $1.20 of Anthropic spend on an endpoint
   reachable without an account, amortised at about $8 per paying customer at 15% conversion.
   Requiring the Stripe trial before the _first_ generation removes both the largest financial risk
   and the largest source of abuse, at a conversion cost. The blueprint says regeneration is the
   paywall, so this architecture keeps the first generation free — but that should be a decision,
   not something discovered from an invoice.
