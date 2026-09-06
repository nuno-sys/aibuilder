/**
 * Errors this package throws.
 *
 * Declared locally rather than imported from `@aibuilder/core`: the boundary policy in
 * `eslint.config.js` puts `db` at the bottom of the dependency graph with no local dependencies at
 * all, so that a statement module stays loadable in a migration test, an EXPLAIN QUERY PLAN gate or
 * a plain Node script with nothing else in scope.
 */

/** Base class for every error raised by `@aibuilder/db`. */
export class DbError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DbError';
  }
}

/**
 * A write affected a different number of rows than the caller required.
 *
 * This is the failure mode of every atomic single-use operation in the system — consuming a magic
 * link, consuming a claim token, claiming a Stripe event, taking a job lease. D1 has no interactive
 * transactions, so the guard is the `WHERE` clause and the proof is `meta.changes`. A caller that
 * checks neither has a double-spend, not a bug it will notice.
 */
export class UnexpectedChangeCountError extends DbError {
  /** Rows the statement actually changed. */
  readonly actual: number;
  /** Rows the caller required it to change. */
  readonly expected: number;

  constructor(context: string, expected: number, actual: number) {
    super(`${context}: expected ${expected} changed row(s), got ${actual}`);
    this.name = 'UnexpectedChangeCountError';
    this.expected = expected;
    this.actual = actual;
  }
}

/** A row that must exist did not. */
export class RowNotFoundError extends DbError {
  constructor(context: string) {
    super(`${context}: no row`);
    this.name = 'RowNotFoundError';
  }
}

/**
 * A shard index has no binding in this Worker's environment.
 *
 * Reaching this means either an organisation carries a `shard_id` that was never provisioned, or a
 * Worker was deployed without the binding for a shard that is already in use. Both are deployment
 * faults and both must be loud: silently falling back to shard 000 would read one tenant's data
 * from another tenant's database.
 */
export class UnknownShardError extends DbError {
  /** The shard index that could not be resolved. */
  readonly shardId: number;

  constructor(shardId: number) {
    super(
      `no D1 binding for shard ${shardId}: add it to ShardBindings and to every ` +
        'wrangler.jsonc that reads tenant data',
    );
    this.name = 'UnknownShardError';
    this.shardId = shardId;
  }
}

/** A BLOB column did not hold the 32 bytes a sha256 must have. */
export class InvalidDigestError extends DbError {
  constructor(context: string, byteLength: number) {
    super(`${context}: expected a 32-byte sha256, got ${byteLength} bytes`);
    this.name = 'InvalidDigestError';
  }
}

/** `fromHex()` was handed something that is not hex. */
export class MalformedHexError extends DbError {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedHexError';
  }
}
