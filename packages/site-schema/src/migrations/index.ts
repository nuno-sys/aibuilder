import { SCHEMA_VERSION, parseSiteDoc } from '../doc';
import type { SiteDoc } from '../doc';
import { UnsupportedSchemaVersionError } from '../errors';

/**
 * Upgrade-on-read for stored site documents.
 *
 * AI-generated documents outlive schema revisions and cannot be regenerated to fix
 * them: regeneration costs real money and, worse, produces a *different* site than
 * the customer approved. So every stored document carries `schemaVersion`, every
 * schema change ships a pure `vN -> vN+1` function here, the renderer upgrades on
 * read, and the upgraded form is persisted on the next publish.
 *
 * Migrations must be:
 *   - PURE. No clock, no randomness, no I/O. The same input always yields the same
 *     output, so a rendered page is reproducible from an old blob.
 *   - TOTAL. They take whatever the previous version could contain, including the
 *     documents that were valid then and would not be valid now.
 *   - ADDITIVE where possible. Deleting a field deletes a customer's content.
 */

/** The version this build writes. */
export const LATEST_SCHEMA_VERSION: number = SCHEMA_VERSION;

/** The oldest version this build can still upgrade from. */
export const OLDEST_SUPPORTED_SCHEMA_VERSION = 1;

/** A stored document before validation: a bag of unknown fields with a version. */
export type StoredDocument = Record<string, unknown>;

/** One pure step of the upgrade ladder. */
export interface Migration {
  readonly from: number;
  readonly to: number;
  /** One line, present tense, for the audit log: "moves hero trustline into copy". */
  readonly describe: string;
  readonly migrate: (document: StoredDocument) => StoredDocument;
}

/**
 * The ladder, ordered by `from`.
 *
 * Empty in Phase 1 because v1 is the first version to exist. When v2 arrives, add
 * `{ from: 1, to: 2, describe, migrate }` here -- do not edit `SiteDocSchema` without
 * one, or every already-published site becomes unreadable.
 */
export const MIGRATIONS: readonly Migration[] = [];

/** Why an upgrade could not produce a valid document. */
export type UpgradeFailure =
  | 'not_an_object'
  | 'missing_version'
  | 'unsupported_version'
  | 'no_migration_path'
  | 'invalid_document';

export type UpgradeResult =
  | {
      readonly ok: true;
      readonly doc: SiteDoc;
      /** `describe` of each migration applied, in order. Empty when already current. */
      readonly applied: readonly string[];
      /** True when the caller should persist the upgraded document on next publish. */
      readonly changed: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: UpgradeFailure;
      readonly foundVersion: number | null;
      readonly issues: readonly string[];
    };

/** Reads `schemaVersion` from an untrusted blob, or `null` when it is absent. */
export function readSchemaVersion(input: unknown): number | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const version = (input as StoredDocument).schemaVersion;
  return typeof version === 'number' && Number.isInteger(version) ? version : null;
}

/**
 * Throws `UnsupportedSchemaVersionError` when this build cannot handle `version`.
 *
 * For write paths that must fail loudly; read paths should use `upgradeToLatest()`,
 * which reports the same condition without throwing.
 */
export function assertSupportedVersion(version: number): void {
  if (version < OLDEST_SUPPORTED_SCHEMA_VERSION || version > LATEST_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(version, LATEST_SCHEMA_VERSION);
  }
}

/**
 * Upgrades a stored document to the current schema version and validates it.
 *
 * Guarantees: never throws; pure; applies each migration exactly once in order; and
 * returns `changed: true` only when a migration actually ran, so the publish path can
 * skip rewriting R2 for documents that were already current.
 *
 * A version *newer* than this build fails with `unsupported_version` rather than
 * being coerced: the deploy is behind the data, and rendering a v3 document with v2
 * rules would silently drop whatever v3 added.
 */
export function upgradeToLatest(input: unknown): UpgradeResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: 'not_an_object', foundVersion: null, issues: [] };
  }

  const version = readSchemaVersion(input);
  if (version === null) {
    return { ok: false, reason: 'missing_version', foundVersion: null, issues: [] };
  }
  if (version > LATEST_SCHEMA_VERSION || version < OLDEST_SUPPORTED_SCHEMA_VERSION) {
    return { ok: false, reason: 'unsupported_version', foundVersion: version, issues: [] };
  }

  let current: StoredDocument = { ...(input as StoredDocument) };
  let currentVersion = version;
  const applied: string[] = [];

  while (currentVersion < LATEST_SCHEMA_VERSION) {
    const step = MIGRATIONS.find((migration) => migration.from === currentVersion);
    if (step === undefined) {
      return { ok: false, reason: 'no_migration_path', foundVersion: currentVersion, issues: [] };
    }
    current = { ...step.migrate(current), schemaVersion: step.to };
    currentVersion = step.to;
    applied.push(step.describe);
  }

  const parsed = parseSiteDoc(current);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: 'invalid_document',
      foundVersion: version,
      issues: parsed.issues,
    };
  }
  return { ok: true, doc: parsed.doc, applied, changed: applied.length > 0 };
}
