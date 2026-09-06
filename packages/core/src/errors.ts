/**
 * Typed errors shared by the domain layer.
 *
 * `core` follows the same discipline as `site-schema`: the normal operating mode is a *result
 * value*, not an exception. `slugify()` falls back rather than throwing, `toOpeningHoursSpecification()`
 * drops malformed entries rather than throwing, `redactForModel()` always returns a string. Throwing
 * is reserved for three situations: a caller passed something that cannot be repaired without
 * inventing data (an id with the wrong prefix, a key segment containing a path traversal), a search
 * space was genuinely exhausted, or a Phase 2 code path was reached.
 */

/** Stable, greppable discriminator carried by every error this package throws. */
export type CoreErrorCode =
  | 'not_implemented_phase_1'
  | 'invalid_id'
  | 'invalid_key_segment'
  | 'invalid_slug'
  | 'slug_space_exhausted'
  | 'unknown_industry'
  | 'unknown_locale';

/** Base class for every error thrown by `@aibuilder/core`. */
export class CoreError extends Error {
  public readonly code: CoreErrorCode;

  public constructor(code: CoreErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'CoreError';
    // esbuild/Vite downlevel `extends Error` on some targets, which severs the prototype chain and
    // breaks `instanceof` across bundle boundaries. Every app bundles this package separately, so
    // this is not hypothetical.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by typed functions whose behaviour is scoped to a later phase.
 *
 * Guarantees a real, final-signature call site exists today so consumers compile against it, while
 * making the gap loud at runtime instead of silently returning a plausible-but-wrong value.
 */
export class NotImplementedInPhase1 extends CoreError {
  public constructor(what: string) {
    super('not_implemented_phase_1', `Not implemented in Phase 1: ${what}`);
    this.name = 'NotImplementedInPhase1';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a string that must be a prefixed ULID is not one, or carries the wrong prefix. */
export class InvalidIdError extends CoreError {
  public readonly value: string;
  public readonly expectedPrefix: string | null;

  public constructor(value: string, expectedPrefix: string | null) {
    super(
      'invalid_id',
      expectedPrefix === null
        ? `"${value}" is not a valid prefixed ULID.`
        : `"${value}" is not a valid "${expectedPrefix}" id.`,
    );
    this.value = value;
    this.expectedPrefix = expectedPrefix;
    this.name = 'InvalidIdError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a value interpolated into an R2 key is not a safe single path segment.
 *
 * Every key this package builds is fed to `R2Bucket.put/get`, where a `..` or a newline in a
 * caller-supplied id would silently address a different tenant's object. Keys are built from
 * validated segments only — never from raw concatenation at the call site.
 */
export class InvalidKeySegmentError extends CoreError {
  public readonly label: string;
  public readonly value: string;

  public constructor(label: string, value: string) {
    super('invalid_key_segment', `R2 key segment "${label}" is not a safe path segment.`);
    this.label = label;
    this.value = value;
    this.name = 'InvalidKeySegmentError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Why a slug was refused.
 *
 * These are exactly the four values `GET /v1/slug-check` returns in its `reason` field
 * (architecture §S4), so the API route maps them straight through with no translation table.
 */
export type SlugRejectionReason = 'invalid' | 'reserved' | 'taken' | 'homoglyph';

/** Thrown when a slug that must already be valid (a stored one, a retired one) is not. */
export class InvalidSlugError extends CoreError {
  public readonly value: string;
  public readonly reason: SlugRejectionReason;

  public constructor(value: string, reason: SlugRejectionReason) {
    super('invalid_slug', `Slug "${value}" was rejected: ${reason}.`);
    this.value = value;
    this.reason = reason;
    this.name = 'InvalidSlugError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the collision ladder ran out of candidates for a seed.
 *
 * Reaching this means the numeric ladder *and* the random-suffix rounds were all taken, which is
 * either a genuine hot seed or a bug in the availability predicate. Both need a human, so it is an
 * error rather than a silent 63-character random string.
 */
export class SlugSpaceExhaustedError extends CoreError {
  public readonly seed: string;
  public readonly attempts: number;

  public constructor(seed: string, attempts: number) {
    super(
      'slug_space_exhausted',
      `No slug available for seed "${seed}" after ${attempts} candidates.`,
    );
    this.seed = seed;
    this.attempts = attempts;
    this.name = 'SlugSpaceExhaustedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when an industry key that must exist in the taxonomy does not. */
export class UnknownIndustryError extends CoreError {
  public readonly industryKey: string;

  public constructor(industryKey: string) {
    super('unknown_industry', `Unknown industry key: "${industryKey}".`);
    this.industryKey = industryKey;
    this.name = 'UnknownIndustryError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a locale code that must be in the registry is not. */
export class UnknownLocaleError extends CoreError {
  public readonly locale: string;

  public constructor(locale: string) {
    super('unknown_locale', `Unknown locale: "${locale}".`);
    this.locale = locale;
    this.name = 'UnknownLocaleError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
