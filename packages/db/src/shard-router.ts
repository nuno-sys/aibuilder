import { UnknownShardError } from './errors';
import type { OrganisationId, ShardId } from './types';

/**
 * The shard indirection.
 *
 * Architecture §5.1 takes the sharding decision now because it is the real one-way door: one
 * control-plane D1 plus N shard D1s keyed by `org_id`, LAUNCHING WITH EXACTLY ONE. The critiques
 * were right that the "~60k tenants" measurement was taken on a database with zero rows in `leads`,
 * `audit_log`, `media_assets` and `generation_job_events`, and that a D1 database is single-threaded
 * — write throughput binds years before 10 GB does.
 *
 * Everything that makes shard 001 a config change rather than a migration lives in this file and in
 * three schema decisions: global uniqueness (slugs, hostnames, e-mail) is in the control plane,
 * `content_blobs` is shard-local, and no shard table has a foreign key that crosses databases.
 *
 * TO ADD A SHARD:
 *   1. `wrangler d1 create aibuilder-shard-001 --location eu`, apply `migrations/shard/`.
 *   2. Add `SHARD_001` to `ShardBindings` below and to every wrangler.jsonc that reads tenant data.
 *   3. Add the case to `shardById()` and raise `SHARD_COUNT`.
 * That is the whole change. Existing organisations keep their `shard_id` — `assignShard()` is
 * consulted only for a NEW organisation, and `trg_orgs_shard_immutable` in the control plane
 * refuses to move one that already owns a site.
 */

/** The zero-based index of the first shard. */
export const FIRST_SHARD: ShardId = 0;

/**
 * How many shards exist.
 *
 * Phase 1 ships exactly one. Raising this changes only where NEW organisations land; it never
 * re-homes an existing one, because every site, version, page, media asset and job is reached
 * through the `shard_id` stored on the organisation row.
 */
export const SHARD_COUNT = 1;

/**
 * The D1 bindings a Worker needs in order to read tenant data.
 *
 * Deliberately one named property per shard rather than an index signature: a missing binding is
 * then a deploy-time type error in the Worker's `Env` instead of a runtime `undefined` that
 * `shardById()` has to turn into an exception.
 */
export interface ShardBindings {
  /** `aibuilder-shard-000`. */
  readonly SHARD_000: D1Database;
}

/** The wrangler binding name for a shard index, e.g. `0` -> `SHARD_000`. */
export function shardBindingName(shardId: ShardId): string {
  return `SHARD_${String(shardId).padStart(3, '0')}`;
}

/** The D1 database name for a shard index, e.g. `0` -> `aibuilder-shard-000`. */
export function shardDatabaseName(shardId: ShardId): string {
  return `aibuilder-shard-${String(shardId).padStart(3, '0')}`;
}

/**
 * Resolves a STORED `shard_id` to its D1 binding.
 *
 * This is the function every read path uses, because the shard of an existing tenant is a fact on
 * its `organisations` / `sites` / `onboarding_drafts` row, never a recomputation. Throws rather
 * than falling back: a silent fallback to shard 000 would serve one tenant's data from another
 * tenant's database, which is the single worst failure this architecture can have.
 */
export function shardById(shardId: ShardId, env: ShardBindings): D1Database {
  switch (shardId) {
    case 0:
      return env.SHARD_000;
    default:
      throw new UnknownShardError(shardId);
  }
}

/**
 * Chooses the shard for a NEW organisation.
 *
 * Called exactly once per organisation, at creation, and the answer is then persisted on the row.
 * With `SHARD_COUNT === 1` the answer is always shard 0; the hash below is not dead code but the
 * placement policy, and it is written now so that raising `SHARD_COUNT` distributes new tenants
 * without any other change.
 *
 * The hash is FNV-1a over the id. It is not cryptographic and does not need to be: the input is a
 * server-minted ULID, so an attacker cannot choose it, and the only property required is a roughly
 * even spread. Deliberately NOT `hash % SHARD_COUNT` over a monotonic counter — ULIDs are
 * time-ordered, and a modulus over the counter would put every organisation created in the same
 * millisecond window on the same shard.
 */
export function assignShard(orgId: OrganisationId, shardCount: number = SHARD_COUNT): ShardId {
  if (shardCount <= 1) {
    return FIRST_SHARD;
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < orgId.length; i += 1) {
    hash ^= orgId.charCodeAt(i);
    // FNV-1a's 32-bit prime, as shifts, because `hash * 16777619` overflows a float64 mantissa.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash % shardCount;
}

/**
 * Resolves the shard database for an organisation whose `shard_id` is not already loaded.
 *
 * Prefer `shardById()` with the stored value wherever the caller already has the row: this overload
 * recomputes the placement, so it is correct ONLY for an organisation created under the current
 * `SHARD_COUNT`. It exists for the one call site that has an org id and nothing else — minting the
 * organisation itself — and every other caller should be reading `shard_id` from a row.
 */
export function shardFor(orgId: OrganisationId, env: ShardBindings): D1Database {
  return shardById(assignShard(orgId), env);
}
