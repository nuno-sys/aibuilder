import * as cp from './cp';
import * as shard from './shard';

/**
 * The registry every shipped SQL statement appears in, and the reason each statement is exported
 * as a `SQL_`-prefixed constant rather than built inline.
 *
 * Architecture §5.4 makes a CI gate part of the soft-delete decision: run `EXPLAIN QUERY PLAN` over
 * every statement this package ships, against a seeded database with `ANALYZE` applied, and fail
 * the build on any `SCAN`. That gate is only as complete as its input, so the input is collected by
 * REFLECTION rather than by a hand-maintained list — a statement cannot be forgotten, only
 * deliberately exempted, and an exemption has to be written down here with a reason.
 *
 * `ANALYZE` matters and is not optional: D1 does not run it, and several of these plans flip once
 * `sqlite_stat1` exists. A gate that runs against an empty database proves nothing about
 * production.
 */

/** Which database a statement runs against. */
export type DatabaseName = 'cp' | 'shard';

/** One shipped statement, addressed the way the gate reports it. */
export interface Statement {
  /** `cp` or `shard` — which migration set defines the tables it touches. */
  readonly database: DatabaseName;
  /** The aggregate module, e.g. `sites`. */
  readonly module: string;
  /** The exported constant, e.g. `SQL_GET_LIVE_SITE_BY_SLUG`. */
  readonly name: string;
  /** The SQL text, exactly as shipped. */
  readonly sql: string;
}

/**
 * Statements that legitimately produce a `SCAN`, and why.
 *
 * Keyed `<database>.<module>.<name>`. The bar for adding an entry is high: the statement must be an
 * offline aggregate that no request path waits on. Anything a user's request blocks on belongs in an
 * index, not in this list.
 */
export const SCAN_EXEMPT: Readonly<Record<string, string>> = {
  // A GROUP BY over every call in a window is a full aggregate by definition. It runs in the daily
  // ops digest and is the query architecture §10 risk 2 exists to enable — the measured cost model
  // that replaces §6.5's estimate. No request waits on it.
  'shard.generationCalls.SQL_STEP_COST_SUMMARY':
    'offline cost-model aggregate; daily ops digest only',
  // A correlated whole-table integrity audit. Nightly, and deliberately exhaustive: its entire
  // purpose is to prove that no blob's stored refcount disagrees with reality, which cannot be
  // established from an index.
  'shard.blobs.SQL_AUDIT_BLOB_REFCOUNTS': 'nightly refcount integrity audit; exhaustive by design',
};

/**
 * A `SCAN` line the gate must NOT fail on even outside the exemption list.
 *
 * `json_each` is a table-valued function over a bound JSON array — a handful of in-memory rows the
 * caller just supplied, not a table. It appears wherever a variable-length `IN` list is passed as
 * ONE bound parameter, which is how `filterUnavailableSlugs` and `countRecentAbuseForSubject` stay
 * within D1's 100-parameter cap while keeping their statement text constant enough to be gated at
 * all.
 */
export const SCAN_LINE_IGNORE_PATTERN = /VIRTUAL TABLE/;

/** Anything not a plain object cannot be a statement module. */
function isNamespace(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Collects the `SQL_`-prefixed string exports of every module in `modules`.
 *
 * `Object.entries` on a narrowed `object` widens to `any`, so the namespace is re-typed through the
 * `isNamespace` guard, which is the narrowest form that keeps this file free of `any`.
 */
function collect(
  database: DatabaseName,
  modules: Readonly<Record<string, unknown>>,
): readonly Statement[] {
  const out: Statement[] = [];
  for (const [moduleName, namespace] of Object.entries(modules)) {
    if (!isNamespace(namespace)) {
      continue;
    }
    for (const [name, value] of Object.entries(namespace)) {
      if (name.startsWith('SQL_') && typeof value === 'string') {
        out.push({ database, module: moduleName, name, sql: value.trim() });
      }
    }
  }
  return out;
}

/** Every control-plane statement this package ships. */
export const CP_STATEMENTS: readonly Statement[] = collect('cp', cp);

/** Every shard statement this package ships. */
export const SHARD_STATEMENTS: readonly Statement[] = collect('shard', shard);

/** Every statement this package ships, control plane first. */
export const ALL_STATEMENTS: readonly Statement[] = [...CP_STATEMENTS, ...SHARD_STATEMENTS];

/** The key `SCAN_EXEMPT` uses for a statement. */
export function statementKey(statement: Statement): string {
  return `${statement.database}.${statement.module}.${statement.name}`;
}

/** True when this statement is allowed to produce a `SCAN`. */
export function isScanExempt(statement: Statement): boolean {
  return statementKey(statement) in SCAN_EXEMPT;
}

/**
 * How many bound parameters a statement uses.
 *
 * D1 caps a query at 100. That cap is the reason bulk writes are a `batch()` of single-row
 * statements rather than one multi-row `VALUES` — a 16-column insert would otherwise cap at six
 * rows — and the reason variable-length `IN` lists are passed as a single JSON parameter. The
 * migration test asserts this stays under the cap for every shipped statement, so the limit is
 * discovered in CI rather than in production at the size where it starts to matter.
 */
export function boundParameterCount(sql: string): number {
  const numbered = sql.match(/\?\d+/g) ?? [];
  let highest = 0;
  for (const token of numbered) {
    highest = Math.max(highest, Number.parseInt(token.slice(1), 10));
  }
  // Anonymous `?` placeholders cannot be renumbered, so they are counted individually. A statement
  // must not mix the two forms; the migration test asserts that as well.
  const anonymous = (sql.match(/\?(?!\d)/g) ?? []).length;
  return highest + anonymous;
}
