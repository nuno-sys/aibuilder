/**
 * `@aibuilder/db` — the D1 row types and every prepared statement the product ships.
 *
 * WHAT THIS PACKAGE IS
 *   Two migration sets (`migrations/cp/**` for the control plane, `migrations/shard/**` for each
 *   shard), the hand-written row types that mirror them, and one exported statement per operation.
 *   No ORM: VERIFIED-FACTS.md "Deliberate deviations" 1 defers Drizzle to Phase 2, so that every
 *   shipped statement is greppable and feedable to the `EXPLAIN QUERY PLAN` gate. `statements.ts`
 *   is what makes that gate possible.
 *
 * WHAT THIS PACKAGE IS NOT
 *   It is the bottom of the dependency graph and imports nothing from the workspace — see the
 *   boundary policy in `eslint.config.js`. It holds no business rules: whether an organisation may
 *   regenerate is a question the API asks of `getEntitlement()`, not one this package answers.
 *
 * THE TWO DATABASES
 *   Reads and writes never cross. A statement in `cp` takes the control-plane binding; a statement
 *   in `shard` takes the binding that `shard-router.shardById(row.shard_id, env)` resolved from a
 *   STORED shard id. There are no foreign keys between them and there cannot be, so the ordering of
 *   writes across the two — and the explicit teardown when a tenant is deleted — is the caller's
 *   responsibility, stated in the header of `migrations/shard/0001_versions_pages.sql`.
 *
 * @example
 * ```ts
 * import { cp, shard, shardById } from '@aibuilder/db';
 *
 * const site = await cp.sites.getLiveSiteBySlug(env.CP, 'kapsalon-anna');
 * if (site === null || site.published_version_id === null) return notFound();
 *
 * // The binding comes from the STORED shard id, never from a recomputation.
 * const db = shardById(site.shard_id, env);
 * const version = await shard.versions.getSiteVersion(db, site.published_version_id);
 * ```
 */

export * as cp from './cp';
export * as shard from './shard';

export * from './batch';
export * from './bytes';
export * from './errors';
export * from './shard-router';
export * from './statements';
export * from './types';
