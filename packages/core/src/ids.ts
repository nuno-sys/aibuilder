import { decodeTime, monotonicFactory } from 'ulid';

import { InvalidIdError } from './errors';

/**
 * Prefixed ULID minting and validation.
 *
 * Architecture §5.4: every primary key is a 30-character `TEXT` — a three-letter entity prefix, an
 * underscore, and a 26-character Crockford base32 ULID. The justification is debuggability and
 * index-cache locality only (D1 bills rows, not bytes), but both are real: a `job_…` in a log line
 * needs no join to identify, and a time-sorted key keeps B-tree inserts at the hot end of the index.
 */

/** Total length of every id in the system. Mirrored by `length(id) = 30` in D1. */
export const ID_LENGTH = 30;

/** Length of the ULID body (Crockford base32, 48-bit time + 80-bit randomness). */
export const ULID_LENGTH = 26;

/**
 * Every entity that owns prefixed ids, and its prefix.
 *
 * This map is the source of truth for the `CHECK (id GLOB '<prefix>_[0-7]*')` constraints in
 * `migrations/cp/**` and `migrations/shard/**`. Prefixes are three lowercase letters so the total
 * length is always 30, and they are never reused between the control plane and a shard.
 */
export const ID_PREFIXES = {
  // Control plane.
  user: 'usr',
  organisation: 'org',
  membership: 'mem',
  authToken: 'tok',
  siteClaimToken: 'clm',
  anonSession: 'ans',
  onboardingDraft: 'drf',
  site: 'ste',
  customDomain: 'dom',
  subscription: 'sub',
  invoice: 'inv',
  abuseEvent: 'abs',
  cspReport: 'csp',
  // Shard.
  siteVersion: 'ver',
  page: 'pag',
  pageTranslation: 'ptr',
  pageSlugAlias: 'psa',
  blogPost: 'blp',
  blogPostTranslation: 'bpt',
  mediaAsset: 'med',
  uploadSession: 'ups',
  siteReview: 'rev',
  lead: 'led',
  generationJob: 'job',
  generationCall: 'gcl',
  generationJobEvent: 'evt',
  deployment: 'dep',
  auditEntry: 'aud',
  consentEntry: 'cns',
} as const;

/** An entity that owns prefixed ids. */
export type IdEntity = keyof typeof ID_PREFIXES;

/** The three-letter prefix of an entity's ids. */
export type IdPrefix = (typeof ID_PREFIXES)[IdEntity];

/** A prefixed ULID belonging to `E`, e.g. `ste_01JQZQ8XKF3M2N4P5R6S7T8V9W`. */
export type PrefixedId<E extends IdEntity> = `${(typeof ID_PREFIXES)[E]}_${string}`;

/** Any prefixed ULID. */
export type AnyId = PrefixedId<IdEntity>;

/**
 * The Crockford base32 alphabet, minus `I`, `L`, `O` and `U` — the four characters that make a
 * transcribed id ambiguous. The first body character is capped at `7` because the 48-bit timestamp
 * cannot overflow into the top bits before the year 10889.
 */
const ID_PATTERN = /^[a-z]{3}_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/**
 * The same rule as `ID_PATTERN`, for the D1 CHECK constraints.
 *
 * Note for whoever writes the migrations: architecture §5.4 spells the anchoring constraint
 * `id NOT GLOB '*[^0-9A-HJKMNP-TV-Z_]*'`, and that negated class rejects **every** id we mint,
 * because the three-letter prefix is lowercase. The class needs `a-z` as well. Use exactly what
 * `d1IdCheck()` returns and the two layers cannot drift.
 */
export function d1IdCheck(column: string, entity: IdEntity): string {
  const prefix = ID_PREFIXES[entity];
  return (
    `CHECK (${column} GLOB '${prefix}_[0-7]*' ` +
    `AND length(${column}) = ${ID_LENGTH} ` +
    `AND ${column} NOT GLOB '*[^0-9A-HJKMNP-TV-Za-z_]*')`
  );
}

/**
 * One monotonic factory per isolate.
 *
 * Two ids minted in the same millisecond are then strictly increasing rather than randomly ordered,
 * which matters for the DO event log and for any keyset pagination that sorts on the id alone.
 */
const nextUlid = monotonicFactory();

/** Mints a new id for `entity`. Sortable by creation time, unique across isolates. */
export function mintId<E extends IdEntity>(entity: E): PrefixedId<E> {
  return `${ID_PREFIXES[entity]}_${nextUlid()}` as PrefixedId<E>;
}

/** True when `value` is a well-formed prefixed ULID for any entity. */
export function isAnyId(value: unknown): value is AnyId {
  return typeof value === 'string' && value.length === ID_LENGTH && ID_PATTERN.test(value);
}

/**
 * True when `value` is a well-formed id belonging to `entity`.
 *
 * This is the check that makes an id usable as an authorisation input: a `ste_…` where a `job_…`
 * was expected is rejected before it reaches a query or an R2 key.
 */
export function isId<E extends IdEntity>(entity: E, value: unknown): value is PrefixedId<E> {
  return isAnyId(value) && value.startsWith(`${ID_PREFIXES[entity]}_`);
}

/** Narrows `value` to an id of `entity` or throws `InvalidIdError`. */
export function assertId<E extends IdEntity>(entity: E, value: unknown): PrefixedId<E> {
  if (!isId(entity, value)) throw new InvalidIdError(String(value), ID_PREFIXES[entity]);
  return value;
}

/** Returns the entity an id belongs to, or `null` for a malformed id or an unknown prefix. */
export function idEntity(value: unknown): IdEntity | null {
  if (!isAnyId(value)) return null;
  const prefix = value.slice(0, 3);
  for (const [entity, candidate] of Object.entries(ID_PREFIXES)) {
    if (candidate === prefix) return entity as IdEntity;
  }
  return null;
}

/**
 * Returns the creation time encoded in an id, in epoch milliseconds.
 *
 * Useful for TTL sweeps (`drf_` at 30 days, `ans_` at 7) without a `created_at` read. Throws
 * `InvalidIdError` rather than returning `NaN` for a malformed id.
 */
export function idTimestamp(value: unknown): number {
  if (!isAnyId(value)) throw new InvalidIdError(String(value), null);
  return decodeTime(value.slice(4));
}
