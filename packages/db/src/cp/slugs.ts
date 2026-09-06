import { changedOne } from '../batch';
import type { ReservedSlugReason, ReservedSlugRow, SiteId, Timestamp } from '../types';

/**
 * Slug availability.
 *
 * A slug is a subdomain of `${SITES_ROOT_DOMAIN}`, so "is it free" is three separate questions and
 * this module answers all three separately rather than collapsing them into one boolean:
 *
 *   1. Is the label RESERVED — a system surface, a protocol label, a brand, or a retired tenant
 *      slug? `reserved_slugs`, enforced at write time by the triggers in 0006.
 *   2. Is it TAKEN — held by any site, including a soft-deleted one? The TOTAL `uq_sites_slug_total`
 *      index. A soft-deleted site keeps reserving its name on purpose.
 *   3. Is it WELL-FORMED, after transliteration and homoglyph folding? That is
 *      `packages/core/src/slug.ts`, not this file: it needs Unicode tables and a trademark distance
 *      check, neither of which belongs in a SQL statement.
 *
 * `GET /v1/slug-check` asks 1 and 2 here and 3 there, and validates the FINAL slug — post
 * transliteration, post collision suffix, ≤63 characters — so a non-Latin business name fails at
 * step 1 of the modal and never inside the submit batch.
 */

/** Is this exact label reserved, and why? */
export const SQL_GET_RESERVED_SLUG = `
SELECT slug, reason, note, created_at FROM reserved_slugs WHERE slug = ?1
`;

/**
 * Reads a reservation, or `null` when the label is not reserved.
 *
 * The `reason` is returned rather than a boolean because the API answers with it: "reserved" reads
 * very differently to a customer whose own trading name collided with a brand entry than it does
 * for `www`, and support needs to tell them apart.
 */
export async function getReservedSlug(
  db: D1Database,
  slug: string,
): Promise<ReservedSlugRow | null> {
  return db.prepare(SQL_GET_RESERVED_SLUG).bind(slug).first<ReservedSlugRow>();
}

/** Is this label held by any site, live or soft-deleted? */
export const SQL_IS_SLUG_TAKEN = `
SELECT id FROM sites WHERE slug = ?1
`;

/**
 * True when a site already holds this slug.
 *
 * Deliberately reads `sites` and not `live_sites`: this is the availability question, and a
 * soft-deleted tenant's slug is NOT available. That is the whole point of the schema carrying a
 * total unique index alongside the partial live one.
 */
export async function isSlugTaken(db: D1Database, slug: string): Promise<boolean> {
  const row = await db.prepare(SQL_IS_SLUG_TAKEN).bind(slug).first<{ id: SiteId }>();
  return row !== null;
}

/**
 * Batch availability for the collision-suffix search.
 *
 * The modal proposes `kapsalon-anna`, then `kapsalon-anna-2`, `kapsalon-anna-3`… Asking one
 * statement per candidate is a round trip per candidate against a single-threaded database; this
 * asks once. The IN list is capped by the caller well under D1's 100-bound-parameter limit.
 */
export const SQL_FILTER_TAKEN_SLUGS = `
SELECT slug FROM sites WHERE slug IN (SELECT value FROM json_each(?1))
UNION
SELECT slug FROM reserved_slugs WHERE slug IN (SELECT value FROM json_each(?1))
`;

/**
 * Returns the subset of `candidates` that is unavailable, reserved or taken.
 *
 * `candidates` is passed as a JSON array in ONE bound parameter, which sidesteps the 100-parameter
 * cap entirely and keeps the statement text constant so the EXPLAIN QUERY PLAN gate can check it.
 */
export async function filterUnavailableSlugs(
  db: D1Database,
  candidates: readonly string[],
): Promise<ReadonlySet<string>> {
  if (candidates.length === 0) {
    return new Set<string>();
  }
  const result = await db
    .prepare(SQL_FILTER_TAKEN_SLUGS)
    .bind(JSON.stringify(candidates))
    .all<{ slug: string }>();
  return new Set(result.results.map((row) => row.slug));
}

/** Adds a reservation. Idempotent, so re-running the reserved-slug seed is safe. */
export const SQL_RESERVE_SLUG = `
INSERT INTO reserved_slugs (slug, reason, note, created_at)
VALUES (?1, ?2, ?3, ?4)
ON CONFLICT(slug) DO NOTHING
`;

/**
 * Reserves a label.
 *
 * Retirement on soft delete is handled by `trg_sites_retire_slug`, not by a call to this function —
 * a trigger cannot be forgotten by a new code path. This exists for the manual cases: an abuse
 * takedown, a newly registered brand, a protocol label a provider starts using.
 */
export async function reserveSlug(
  db: D1Database,
  args: {
    readonly slug: string;
    readonly reason: ReservedSlugReason;
    readonly note: string | null;
    readonly now: Timestamp;
  },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_RESERVE_SLUG)
    .bind(args.slug, args.reason, args.note, args.now)
    .run();
  return changedOne(result.meta);
}

/**
 * Every reserved label of one kind.
 *
 * Read at cold start by the slug validator so the homoglyph and trademark-distance checks in
 * `packages/core/src/slug.ts` run against the real list rather than a hardcoded copy of it.
 */
export const SQL_LIST_RESERVED_SLUGS = `
SELECT slug, reason, note, created_at FROM reserved_slugs WHERE reason = ?1 ORDER BY slug
`;

/** Lists reserved labels by reason. */
export async function listReservedSlugs(
  db: D1Database,
  reason: ReservedSlugReason,
): Promise<readonly ReservedSlugRow[]> {
  const result = await db.prepare(SQL_LIST_RESERVED_SLUGS).bind(reason).all<ReservedSlugRow>();
  return result.results;
}
