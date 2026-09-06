/**
 * Error types owned by the site-document contract.
 *
 * The package's normal operating mode is *result objects*, not exceptions:
 * `normalize()` repairs and never throws, `genToDoc()` collects issues, `lint()`
 * returns findings, `upgradeToLatest()` returns a discriminated result. Throwing is
 * reserved for two situations only — a caller asked for the strict variant of an
 * operation (`parseSiteDocOrThrow`), or a code path that Phase 1 deliberately does
 * not implement was reached.
 */

/** Stable, greppable discriminator carried by every error this package throws. */
export type SiteSchemaErrorCode =
  'not_implemented_phase_1' | 'unsupported_schema_version' | 'invalid_site_doc';

/** Base class for every error thrown by `@aibuilder/site-schema`. */
export class SiteSchemaError extends Error {
  public readonly code: SiteSchemaErrorCode;

  public constructor(code: SiteSchemaErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'SiteSchemaError';
    // esbuild/Vite downlevel `extends Error` in some targets, which severs the
    // prototype chain and breaks `instanceof` across bundle boundaries. Workers
    // bundles are built per app, so this is not hypothetical.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by typed functions whose behaviour is scoped to a later phase.
 *
 * Guarantees a real, typed call site exists today (so consumers compile against the
 * final signature) while making the gap loud at runtime instead of silently
 * returning a plausible-but-wrong value.
 */
export class NotImplementedInPhase1 extends SiteSchemaError {
  public constructor(what: string) {
    super('not_implemented_phase_1', `Not implemented in Phase 1: ${what}`);
    this.name = 'NotImplementedInPhase1';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a stored document declares a `schemaVersion` this build cannot reach:
 * either newer than `LATEST_SCHEMA_VERSION` (the deploy is behind the data) or older
 * than the oldest migration we still carry.
 */
export class UnsupportedSchemaVersionError extends SiteSchemaError {
  public readonly found: number;
  public readonly latest: number;

  public constructor(found: number, latest: number) {
    super(
      'unsupported_schema_version',
      `Stored document declares schemaVersion ${found}; this build supports up to ${latest}.`,
    );
    this.found = found;
    this.latest = latest;
    this.name = 'UnsupportedSchemaVersionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown by `parseSiteDocOrThrow` when a stored document fails `SiteDocSchema`. */
export class InvalidSiteDocError extends SiteSchemaError {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super('invalid_site_doc', `SiteDoc failed validation: ${issues.join('; ')}`);
    this.issues = issues;
    this.name = 'InvalidSiteDocError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
