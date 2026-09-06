import { assertSingleChange, changedOne } from '../batch';
import { toArrayBuffer } from '../bytes';
import type { BlobEncoding, BlobKind, ContentBlobRow, Timestamp } from '../types';

/**
 * Statements over `content_blobs`, and the two-phase reaper they implement.
 *
 * The refcount itself is maintained entirely by triggers (see
 * `migrations/shard/0006_triggers.sql`): INSERT increments, DELETE decrements, and the
 * `AFTER UPDATE OF content_sha256` pair moves a reference when an editor save repoints a page from
 * blob A to blob B. That update pair was the live data-loss bug architecture §5.4 fixed — without
 * it, A stayed at 1 and B stayed at 0, and the reaper deleted B: a live R2 object.
 *
 * NOTHING IN THIS FILE WRITES `refcount`. It is derived state, and every statement here either
 * creates a blob, moves it between `live` and `tombstoned`, or reads it for the reaper.
 *
 * THE TWO-PHASE REAPER, in full:
 *
 *   1. MARK   `listBlobsToMark(before)` -> `tombstoneBlob(sha)`. Refcount 0 and untouched for
 *             longer than the grace window. Nothing is deleted from R2.
 *   2. WAIT   at least one more grace window. Any publish or editor save in between RESURRECTS the
 *             blob through the increment triggers, which set `state = 'live'` and clear
 *             `tombstoned_at`, so it simply falls out of phase 2's result set.
 *   3. SWEEP  `listBlobsToSweep(before)` -> delete from R2 -> `deleteTombstonedBlob(sha)`, whose
 *             WHERE clause RE-VERIFIES `refcount = 0 AND state = 'tombstoned'` in the same batch.
 *
 * The re-verification is the point. A refcount read minutes earlier is a snapshot of a
 * single-writer database that has since accepted writes, and `DELETE FROM r2` is not reversible.
 */

/**
 * Registers a blob, or takes a reference on one that already exists.
 *
 * The conflict clause makes the dedupe hit RESURRECT rather than no-op: if the reaper had
 * tombstoned this hash between the writer's existence check and its write, skipping the R2 PUT
 * would leave the new page pointing at an object queued for deletion. `refcount` is deliberately
 * absent from the SET list — the page-translation insert that follows increments it through the
 * trigger, and writing it here as well would double-count.
 */
export const SQL_UPSERT_CONTENT_BLOB = `
INSERT INTO content_blobs (sha256, bytes, content_type, encoding, kind, refcount, state,
                           created_at, last_ref_at)
VALUES (?1, ?2, ?3, ?4, ?5, 0, 'live', ?6, ?6)
ON CONFLICT(sha256) DO UPDATE SET
  state         = 'live',
  tombstoned_at = NULL,
  last_ref_at   = excluded.last_ref_at
`;

/** Registers or resurrects a content blob. Call before the row that will reference it. */
export async function upsertContentBlob(
  db: D1Database,
  args: {
    readonly sha256: Uint8Array;
    readonly bytes: number;
    readonly contentType: string;
    readonly encoding: BlobEncoding;
    readonly kind: BlobKind;
    readonly now: Timestamp;
  },
): Promise<void> {
  const result = await db
    .prepare(SQL_UPSERT_CONTENT_BLOB)
    .bind(
      toArrayBuffer(args.sha256),
      args.bytes,
      args.contentType,
      args.encoding,
      args.kind,
      args.now,
    )
    .run();
  assertSingleChange(result.meta, 'upsertContentBlob');
}

/** Builds the blob upsert, for the publish batch that writes the whole page set at once. */
export function upsertContentBlobStatement(
  db: D1Database,
  args: {
    readonly sha256: Uint8Array;
    readonly bytes: number;
    readonly contentType: string;
    readonly encoding: BlobEncoding;
    readonly kind: BlobKind;
    readonly now: Timestamp;
  },
): D1PreparedStatement {
  return db
    .prepare(SQL_UPSERT_CONTENT_BLOB)
    .bind(
      toArrayBuffer(args.sha256),
      args.bytes,
      args.contentType,
      args.encoding,
      args.kind,
      args.now,
    );
}

/** One blob by digest. */
export const SQL_GET_CONTENT_BLOB = `
SELECT * FROM content_blobs WHERE sha256 = ?1
`;

/** Reads a blob row. */
export async function getContentBlob(
  db: D1Database,
  sha256: Uint8Array,
): Promise<ContentBlobRow | null> {
  return db.prepare(SQL_GET_CONTENT_BLOB).bind(toArrayBuffer(sha256)).first<ContentBlobRow>();
}

/** PHASE 1 — unreferenced live blobs whose grace window has passed. */
export const SQL_LIST_BLOBS_TO_MARK = `
SELECT sha256, bytes, kind, last_ref_at
FROM content_blobs
WHERE refcount = 0 AND state = 'live' AND last_ref_at < ?1
ORDER BY last_ref_at
LIMIT ?2
`;

/**
 * Lists blobs eligible for tombstoning.
 *
 * The `refcount = 0 AND state = 'live'` predicate is repeated VERBATIM from
 * `idx_blobs_mark`'s WHERE clause. SQLite's partial-index prover matches on the text of the
 * predicate, so paraphrasing it here would silently turn a covering seek into a full table scan of
 * the largest table in the shard.
 */
export async function listBlobsToMark(
  db: D1Database,
  args: { readonly before: Timestamp; readonly limit: number },
): Promise<readonly Pick<ContentBlobRow, 'sha256' | 'bytes' | 'kind' | 'last_ref_at'>[]> {
  const result = await db
    .prepare(SQL_LIST_BLOBS_TO_MARK)
    .bind(args.before, args.limit)
    .all<Pick<ContentBlobRow, 'sha256' | 'bytes' | 'kind' | 'last_ref_at'>>();
  return result.results;
}

/** PHASE 1 — tombstones one blob. Still nothing is deleted from R2. */
export const SQL_TOMBSTONE_BLOB = `
UPDATE content_blobs SET state = 'tombstoned', tombstoned_at = ?2
WHERE sha256 = ?1 AND refcount = 0 AND state = 'live'
`;

/** Tombstones a blob. Returns false when it gained a reference in the meantime. */
export async function tombstoneBlob(
  db: D1Database,
  args: { readonly sha256: Uint8Array; readonly now: Timestamp },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_TOMBSTONE_BLOB)
    .bind(toArrayBuffer(args.sha256), args.now)
    .run();
  return changedOne(result.meta);
}

/** PHASE 2 — tombstoned blobs whose second grace window has passed. */
export const SQL_LIST_BLOBS_TO_SWEEP = `
SELECT sha256, bytes, kind, tombstoned_at
FROM content_blobs
WHERE state = 'tombstoned' AND tombstoned_at < ?1
ORDER BY tombstoned_at
LIMIT ?2
`;

/** Lists blobs whose R2 objects may now be deleted. */
export async function listBlobsToSweep(
  db: D1Database,
  args: { readonly before: Timestamp; readonly limit: number },
): Promise<readonly Pick<ContentBlobRow, 'sha256' | 'bytes' | 'kind' | 'tombstoned_at'>[]> {
  const result = await db
    .prepare(SQL_LIST_BLOBS_TO_SWEEP)
    .bind(args.before, args.limit)
    .all<Pick<ContentBlobRow, 'sha256' | 'bytes' | 'kind' | 'tombstoned_at'>>();
  return result.results;
}

/**
 * PHASE 2 — deletes the row, RE-VERIFYING that it is still unreferenced.
 *
 * `AND refcount = 0 AND state = 'tombstoned'` re-reads the truth at delete time rather than
 * trusting the listing that produced this digest. Ordering matters and is not negotiable: run this
 * FIRST and only delete the R2 object once it reports true. The reverse order deletes the object
 * and then discovers the row was resurrected, and the page pointing at it is now a 404 on a paying
 * customer's live site.
 */
export const SQL_DELETE_TOMBSTONED_BLOB = `
DELETE FROM content_blobs WHERE sha256 = ?1 AND refcount = 0 AND state = 'tombstoned'
`;

/** Deletes a tombstoned blob row. Delete the R2 object only when this returns true. */
export async function deleteTombstonedBlob(db: D1Database, sha256: Uint8Array): Promise<boolean> {
  const result = await db.prepare(SQL_DELETE_TOMBSTONED_BLOB).bind(toArrayBuffer(sha256)).run();
  return changedOne(result.meta);
}

/** Blobs whose refcount does not match reality. Should always be empty. */
export const SQL_AUDIT_BLOB_REFCOUNTS = `
SELECT b.sha256, b.refcount, b.state,
       (SELECT count(*) FROM page_translations t WHERE t.content_sha256 = b.sha256)
     + (SELECT count(*) FROM blog_post_translations bt WHERE bt.body_sha256 = b.sha256) AS actual
FROM content_blobs b
WHERE b.refcount <> (
        (SELECT count(*) FROM page_translations t WHERE t.content_sha256 = b.sha256)
      + (SELECT count(*) FROM blog_post_translations bt WHERE bt.body_sha256 = b.sha256))
LIMIT ?1
`;

/** One row of refcount drift. */
export interface BlobRefcountDrift {
  readonly sha256: ArrayBuffer;
  readonly refcount: number;
  readonly state: string;
  readonly actual: number;
}

/**
 * Audits stored refcounts against the real number of referencing rows.
 *
 * A nightly integrity check, not a request-path query. It should never return a row: the triggers
 * maintain the counter and `CHECK (refcount >= 0)` makes a double-decrement abort loudly rather
 * than drift. If it ever does return one, the reaper is stopped until it is explained — the counter
 * being wrong in the OTHER direction is how live objects get deleted.
 */
export async function auditBlobRefcounts(
  db: D1Database,
  limit: number,
): Promise<readonly BlobRefcountDrift[]> {
  const result = await db.prepare(SQL_AUDIT_BLOB_REFCOUNTS).bind(limit).all<BlobRefcountDrift>();
  return result.results;
}
