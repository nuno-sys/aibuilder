# D1 Schema — aibuilder

**31 tables, 91 indexes, 9 triggers.** Committed as `1baaa3c` in `/home/user/aibuilder/migrations/` (9 forward-only files) + `/home/user/aibuilder/wrangler.toml`.

Everything below was **executed, not asserted**. Against SQLite 3.45.1: all migrations apply clean, `integrity_check`/`foreign_key_check` pass, 15 invariants proven to abort, all 20 query patterns confirmed via `EXPLAIN QUERY PLAN` with **zero table scans**. Verification caught 3 real defects, listed at the end.

---

## Verified D1 limits (these drove the design)

| Limit | Value | Consequence here |
|---|---|---|
| Max database size | **10 GB** (paid) | Hard ceiling → drives the R2 pointer pattern and the shard plan |
| Max row / string / BLOB | **2 MB** | A 6-locale site manifest exceeds this. Inline storage isn't a trap, it's *impossible* |
| Max columns per table | **100** | Widest table (`generation_jobs`) is 39. OK |
| **Max bound params per query** | **100** | **Biggest surprise.** 16-col insert → max 6 rows per multi-VALUES. Bulk writes must be `batch()` of single-row statements |
| Queries per Worker invocation | **1000** (paid) | A 6×8 generation is ~110 statements. Fits |
| Max query duration | **30 s** | Backfills must be chunked; can't run in one migration statement |
| Max LIKE/GLOB pattern | **50 bytes** | Every validation pattern here is ≤ 34 bytes |
| Databases / storage per account | 50,000 / 1 TB | The shard runway |
| Time Travel | 30 days | Rollback of last resort for a bad migration |
| `PRAGMA foreign_keys=OFF` | **Not supported** | `defer_foreign_keys=on` is the only escape hatch |
| Batch semantics | Atomic, implicit txn, all-or-nothing | No `BEGIN/COMMIT/SAVEPOINT` |
| Read replication | Sessions API + bookmarks, **Worker binding only** | See consistency section |

---

## Decisions

### 1. Tenancy: organisation-scoped, auto-created, invisible in Phase 1

Single-user tenancy is a one-way door. A spouse needing access, an accountant wanting invoices, a business being sold, an agency reselling — each requires re-parenting every FK in the schema. Org-scoping costs **one extra join today**; retrofitting costs a migration across 15 tables with live paying tenants.

So: signup creates one `organisations` row + one `memberships` row (`role='owner'`). Subscriptions attach to the **org**, never the user. Phase 1 UI never shows the word "team". The FK graph is already right.

### 2. IDs: prefixed ULID, `ste_01JQZQ8XKF3M2N4P5R6S7T8V9W` (30 chars, TEXT)

Rejected UUIDv4/cuid2 on **b-tree locality**: random keys scatter inserts across the whole index, splitting pages everywhere. Time-ordered keys append to the right edge — near-zero splits, and hot pages stay in cache. On D1 this is billed twice over: page reads count toward `rows_read`, and every dirtied page ships to read replicas.

ULID over UUIDv7 on **key width**: 26 chars vs 36. Every index entry stores the full key, and this schema has 91 of them.

The `ste_` prefix costs 4 bytes and buys a **CHECK-enforced type system**:

```sql
CHECK (id GLOB 'ste_[0-7]*' AND length(id) = 30)
```

Passing a `ver_…` where a `ste_…` belongs now fails at write time instead of silently reading another tenant's row. Verified: `enforced: wrong ID prefix (type confusion)`.

Two deliberate exceptions use `INTEGER PRIMARY KEY AUTOINCREMENT` — `audit_log` and `generation_job_events`. Append-only, high-volume, `ORDER BY id DESC` is a free reverse scan with no sort step. `AUTOINCREMENT` (not bare rowid) so ids are never reused after purge — the SSE cursor would otherwise replay stale events.

### 3. Where content lives — measured, not guessed

I built a 200-tenant database (3 versions × 8 pages × 6 locales = 28,800 `page_translations` rows) and measured both designs:

| | Per tenant | Tenants per 10 GB D1 |
|---|---|---|
| **Pointer pattern (chosen)** | **175 KB** | **~59,850** |
| Page trees inline in D1 | 12.5 MB | ~817 |

**73× more tenants per database.** And the inline version doesn't actually work: a 6-locale manifest blows the 2 MB row cap.

The rule, enforced by CHECK rather than convention:

```sql
content_sha256 TEXT REFERENCES content_blobs(sha256) ON DELETE RESTRICT,
content_inline TEXT,
CHECK ((content_sha256 IS NULL) <> (content_inline IS NULL)),        -- exactly one
CHECK (content_inline IS NULL OR
       (json_valid(content_inline) AND length(content_inline) <= 65536))
```

**Threshold: 64 KB**, and page component trees always go to R2 regardless of size.

The key insight that makes this cheap: **the R2 key is a pure function of the hash** — `blobs/<kind>/<sha[0:2]>/<sha[2:4]>/<sha>.json.gz`. The render path never joins `content_blobs`; that table exists only for refcounting and GC. Content-addressing also makes rollback free — a version points at already-existing blobs, and a regenerate that changes 3 of 8 pages writes only 3 objects.

D1 holds only what you filter, sort, join, or authorise on. `theme_tokens` (<8 KB) stays inline — the editor reads it every keystroke and an R2 round trip there is pure latency tax.

### 4. Multi-locale: adding a 7th language is 3 INSERTs

There is **not one locale-named column anywhere** in the schema.

- `locales` — global registry (seeded en/nl/de/fr/es/pt)
- `site_locales` — which locales *this* site publishes, which is `x-default`
- `pages` — the logical page, **locale-independent**
- `page_translations` — one row per (page, locale): path, SEO, content pointer

Adding Italian to a live site:
```sql
INSERT INTO locales (code,...)      VALUES ('it', ...);   -- once, globally
INSERT INTO site_locales (...)      VALUES (:site,'it',...);
INSERT INTO page_translations (...) VALUES ...;           -- one per page
```
No `ALTER TABLE`. No deploy. Which matters because D1's `ALTER TABLE` is additive-only.

`x-default` correctness is enforced by a **partial unique index**, not app code:
```sql
CREATE UNIQUE INDEX uq_site_locales_default ON site_locales(site_id) WHERE is_default = 1;
```

### 5. Immutability is a trigger, not a comment

D1 has no stored procedures, so "immutable" is either enforced in the DB or it isn't real. Sealed versions freeze content columns while `status`/`label` stay mutable (a published version must still be archivable):

```sql
CREATE TRIGGER trg_site_versions_sealed
BEFORE UPDATE ON site_versions FOR EACH ROW
WHEN OLD.sealed_at IS NOT NULL
 AND (NEW.manifest_sha256 IS NOT OLD.manifest_sha256
   OR NEW.theme_tokens IS NOT OLD.theme_tokens ...)
BEGIN
  SELECT RAISE(ABORT, 'site_version is sealed: fork a new version instead');
END;
```

Triggers live in **their own migration** — wrangler's statement splitter has a known failure on trigger bodies (breaks on `BEGIN`, "incomplete input"). Isolated, a splitter bug can never block a schema migration.

Also trigger-enforced: a site's version pointer cannot reference another site's version. Cross-tenant pointer = data leak; cheap to make impossible.

---

## The 12 query patterns — every one index-covered

`EXPLAIN QUERY PLAN` output, actual:

| # | Query | Plan |
|---|---|---|
| 1 | subdomain → published version | `SEARCH sites USING INDEX uq_sites_slug` |
| 2 | custom hostname → site | `SEARCH custom_domains USING INDEX uq_domains_hostname` |
| 3 | **render page** (version, locale, path) | `SEARCH USING INDEX uq_page_tr_path` |
| 4 | hreflang alternates | `SEARCH USING **COVERING INDEX** idx_page_tr_hreflang` |
| 5 | sitemap.xml | `SEARCH USING **COVERING INDEX** idx_page_tr_enumerate` |
| 6 | dashboard: my sites | `SEARCH USING **COVERING INDEX** idx_memberships_user` |
| 7 | **auth: session by token** | `SEARCH sessions USING PRIMARY KEY` |
| 8 | editor: pages of draft | `SEARCH USING INDEX idx_pages_version_order` |
| 9 | AI job queue drain | `SEARCH USING INDEX idx_jobs_queue` |
| 10 | job progress SSE poll | `SEARCH USING **COVERING INDEX** idx_job_events_poll` |
| 11 | Stripe webhook idempotency | `SEARCH stripe_events USING PRIMARY KEY` |
| 12 | **paywall entitlement check** | `SEARCH organisations USING PRIMARY KEY` |

Plus 8 more verified (leads inbox, blog index, SSL polling cron, trial-ending cron, site locales, audit log, media library, blob GC). **Zero table scans across all 20.**

Two notes on cost, not just coverage:

**Q7 (auth, hottest query).** `sessions` is `WITHOUT ROWID` with `token_hash` as PK, so the row lives *in* the PK b-tree — authentication is a **single page read**. Raw tokens are never stored, only `sha256`.

**Q12 (paywall).** `organisations.entitlement` is a **deliberate denormalisation** of subscription state. The regenerate gate must be one row read on the hot path, not a join to `subscriptions`. The Stripe webhook writes both in the same `batch()`.

The only residual sort is Q6 (`ORDER BY s.created_at DESC` across orgs) — a handful of rows for the 99% single-org case. Acceptable.

---

## What verification caught

Writing the SQL wasn't the hard part; running it was. Three defects I would otherwise have shipped:

1. **`idx_jobs_queue` degraded to a full table SCAN.** I wrote it partial: `WHERE status IN ('queued','running','streaming')`. SQLite's partial-index prover cannot show that `status='queued'` *implies* that predicate, so the queue drain scanned every job ever run. Fixed to a plain composite — `status` is the leading column, so it seeks the live range anyway.

2. **`content_inline` was in an index.** My render index listed it among the covering columns. SQLite stores the full key in every index entry, so that would have **duplicated up to 64 KB of page payload into the b-tree per row**. Removed, index narrowed to `(site_version_id, locale, path, page_id)`. The point lookup doesn't need it — `uq_page_tr_path` is a UNIQUE seek, strictly cheaper than any covering index.

3. **`idx_leads_inbox` carried `name` + `email`** (~500 bytes/row). Narrowed; 25 table lookups per inbox page beat that payload in every entry.

Also verified: the pointer XOR fires both ways, the 64 KB cap fires, duplicate paths and double `x-default` are rejected, `regenerate_*` cannot be inserted with `requires_entitlement=0`, blobs can't be deleted while referenced, all three seal triggers abort, and a sealed version can still be archived.

---

## Migration strategy

Forward-only, `NNNN_verb_object.sql`, applied via `wrangler d1 migrations apply` (tracked in `d1_migrations`).

1. **Never edit an applied migration.** To undo, write a new one.
2. **Additive only.** SQLite `ALTER TABLE` does ADD/RENAME/DROP COLUMN and nothing else. New columns must be nullable or carry a *constant* default (`CURRENT_TIMESTAMP` is rejected).
3. **Never rebuild a table that is the parent of an `ON DELETE CASCADE` FK** without `PRAGMA defer_foreign_keys=on` first. D1 will cascade-delete children during the 12-step rebuild. `PRAGMA foreign_keys=OFF` is not available as an escape hatch.
4. **Chunk backfills.** 30 s query cap — loop `WHERE id > ? LIMIT 500` from a cron, not one statement in a migration.
5. **Expand → migrate → contract** for renames: add column, dual-write, backfill, switch reads, drop in a *later* release.
6. **Triggers in their own file, uppercase `BEGIN`/`END`.**
7. `CREATE INDEX` on a large table is a full scan — its own migration, watch the 30 s cap.
8. Time Travel (30 days) is the rollback of last resort; bookmark the pre-migration timestamp in CI.

**Circular FK** (`sites` ↔ `site_versions`) is handled by nullable pointers: INSERT site → INSERT version → UPDATE site, or one `batch()` with `defer_foreign_keys=on`. SQLite doesn't resolve FK targets at DDL time, so the forward reference in `0003` is legal.

## Read replication

- **Public site render** — read-only, tolerates lag → `withSession('first-unconstrained')`. Lowest global TTFB, which is what the 100/100 Lighthouse target actually needs.
- **Dashboard/editor after a write** → store the bookmark in a cookie, `withSession(bookmark)` for read-your-writes.
- **Stripe webhooks** → `withSession('first-primary')`.
- **Rate limiting** → not D1 at all. `rate_limit_buckets` holds coarse durable quota windows only; per-request/per-IP limiting uses the Workers Rate Limiting binding (wired in `wrangler.toml`). A write-per-request into a replicated SQLite database is an architecture bug, not a rate limiter.

## Scale runway

~60k tenants per 10 GB database, measured. `leads` and `audit_log` are the growth risk — both carry retention columns (`purge_after`, `idx_audit_purge`) and need a purge cron from day 1. Beyond that, shard on `org_id` → database; the account allows 50,000 databases and 1 TB.

## One thing I'd flag

`generation_jobs.duration_ms` is a `VIRTUAL` generated column. D1 documents generated-column support and it applies cleanly here, but it's the only construct in the schema I haven't seen confirmed against D1's specific SQLite build in the docs I could reach (`developers.cloudflare.com` is egress-blocked from this environment; I used the docs repo mirror). If `wrangler d1 migrations apply --remote` rejects it, drop the column and compute it in the Worker — nothing else depends on it.

**Sources:** [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) · [Read replication & Sessions API](https://developers.cloudflare.com/d1/best-practices/read-replication/) · [Migrations](https://developers.cloudflare.com/d1/reference/migrations/) · [Foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/) · [Query JSON](https://developers.cloudflare.com/d1/sql-api/query-json/) · [wrangler trigger splitter bug](https://github.com/cloudflare/workers-sdk/issues/10998) · [D1 CASCADE migration hazard](https://www.brachkow.com/notes/d1-on-delete-cascade/)