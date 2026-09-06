import { RowNotFoundError, UnexpectedChangeCountError } from './errors';

/**
 * Helpers for `D1Database.batch()` and for the guard that makes single-use writes actually single
 * use.
 *
 * D1 has no interactive transactions. A `batch()` is atomic and implicit — all statements commit or
 * none do — but there is no `BEGIN`, no `SAVEPOINT`, and no way to read a row, decide, and then
 * write inside one transaction. Every "consume exactly once" operation in this system is therefore
 * expressed the same way:
 *
 *   UPDATE … SET consumed_at = ?2 WHERE token_hash = ?1 AND consumed_at IS NULL
 *
 * and the proof that it consumed the token is `meta.changes === 1`. A caller that skips that check
 * has written a double-spend: two concurrent redeliveries of the same magic link both run the
 * UPDATE, both succeed, and the second one silently mints a second session.
 */

/**
 * The part of `D1Meta` these helpers need.
 *
 * Structural rather than `D1Meta` itself so a workers-types release that adds or renames a
 * telemetry field cannot break the guard that protects single-use tokens.
 */
export interface ChangeMeta {
  readonly changes: number;
}

/**
 * Throws unless the write changed exactly `expected` rows.
 *
 * This is the atomicity assertion for single-use consumption. `context` names the operation and
 * appears in the thrown message, so a production log line says which token failed to consume rather
 * than only that a count was wrong.
 */
export function assertChanges(meta: ChangeMeta, expected: number, context: string): void {
  if (meta.changes !== expected) {
    throw new UnexpectedChangeCountError(context, expected, meta.changes);
  }
}

/**
 * Throws unless the write changed exactly one row.
 *
 * The overwhelmingly common case: consuming a token, taking a job lease, claiming a Stripe event,
 * winning an optimistic-concurrency autosave.
 */
export function assertSingleChange(meta: ChangeMeta, context: string): void {
  assertChanges(meta, 1, context);
}

/**
 * True when the write changed exactly one row, without throwing.
 *
 * For the callers that must distinguish "already consumed" from "error" and answer 410 or 409
 * rather than 500 — a claim link opened twice is a user event, not an incident.
 */
export function changedOne(meta: ChangeMeta): boolean {
  return meta.changes === 1;
}

/** Returns the first row, or throws `RowNotFoundError` naming the lookup that came up empty. */
export function firstOrThrow<T>(row: T | null, context: string): T {
  if (row === null) {
    throw new RowNotFoundError(context);
  }
  return row;
}

/**
 * Runs a batch and returns its results.
 *
 * A thin wrapper that exists for two reasons: `batch()` wants a mutable array while every call site
 * here builds a `readonly` one, and centralising the call gives the atomic-write path a single
 * place to grow instrumentation.
 *
 * D1 caps a query at 100 bound parameters, so bulk writes are a batch of single-row statements
 * rather than one multi-row `VALUES` — a 16-column insert would otherwise cap at six rows per
 * statement.
 */
export async function runBatch<T = Record<string, unknown>>(
  db: D1Database,
  statements: readonly D1PreparedStatement[],
): Promise<D1Result<T>[]> {
  if (statements.length === 0) {
    return [];
  }
  return db.batch<T>([...statements]);
}

/**
 * Runs a batch and asserts the change count of each statement against `expected`.
 *
 * `expected[i]` applies to `statements[i]`; a shorter array leaves the remaining statements
 * unchecked. Because the batch already committed by the time this throws, the assertion is a
 * detector, not a rollback — which is exactly why the WHERE clauses have to carry the guard too.
 */
export async function runBatchAsserting(
  db: D1Database,
  statements: readonly D1PreparedStatement[],
  expected: readonly number[],
  context: string,
): Promise<void> {
  const results = await runBatch(db, statements);
  for (let i = 0; i < expected.length; i += 1) {
    const want = expected[i];
    const got = results[i];
    if (want === undefined || got === undefined) {
      continue;
    }
    assertChanges(got.meta, want, `${context}[${i}]`);
  }
}
