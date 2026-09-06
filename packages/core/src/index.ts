/**
 * `@aibuilder/core` — the domain layer.
 *
 * Everything here is pure policy over plain values: the onboarding contract, the locale and
 * industry registries, slug rules, opening-hours mapping, R2 key shapes, id minting and the
 * prompt-input redactor. Nothing in this package imports `cloudflare:*` or touches a binding
 * directly — anything that needs one takes an injected `Env` (architecture §2), which is what keeps
 * the whole layer runnable in a plain vitest process.
 */

export * from './errors';
export * from './hours';
export * from './ids';
export * from './industries';
export * from './intake';
export * from './keys';
export * from './locales';
export * from './redact';
export * from './slug';
