import { assertSingleChange, firstOrThrow } from '../batch';
import type {
  Entitlement,
  EntitlementRow,
  OrganisationId,
  OrganisationRow,
  ShardId,
  Timestamp,
} from '../types';

/**
 * Statements over `organisations` in the control plane.
 *
 * Every statement is exported as a `SQL_`-prefixed constant next to the function that runs it. That
 * is what makes the CI EXPLAIN QUERY PLAN gate possible: `statements.ts` enumerates them and the
 * gate fails the build on any `SCAN`. A statement built inline inside a function is invisible to
 * that gate, so there are none.
 */

/**
 * Creates a provisional organisation — zero memberships, `provisional = 1`.
 *
 * Architecture §3b step 3: submit creates this before any e-mail has been verified. An
 * organisation with no memberships is unreachable by every authenticated path, which is what makes
 * it safe to exist; `trg_orgs_deprovision_needs_member` refuses to clear the flag until an owner
 * membership exists.
 */
export const SQL_INSERT_PROVISIONAL_ORG = `
INSERT INTO organisations (id, name, shard_id, provisional, country, created_at, updated_at)
VALUES (?1, ?2, ?3, 1, ?4, ?5, ?5)
`;

/** Inserts a provisional organisation on the shard chosen by `shard-router.assignShard()`. */
export async function insertProvisionalOrganisation(
  db: D1Database,
  args: {
    readonly id: OrganisationId;
    readonly name: string;
    readonly shardId: ShardId;
    readonly country: string;
    readonly now: Timestamp;
  },
): Promise<void> {
  const result = await db
    .prepare(SQL_INSERT_PROVISIONAL_ORG)
    .bind(args.id, args.name, args.shardId, args.country, args.now)
    .run();
  assertSingleChange(result.meta, 'insertProvisionalOrganisation');
}

/**
 * The paywall read. ONE row, by primary key, no join.
 *
 * `entitlement` is a deliberate denormalisation of subscription state (architecture §5.2): the
 * regenerate gate runs on every attempt and must not join `subscriptions`. The Stripe webhook
 * writes both in the same `batch()`, so they cannot drift.
 */
export const SQL_GET_ENTITLEMENT = `
SELECT entitlement, entitlement_until, plan, status, shard_id
FROM organisations
WHERE id = ?1 AND deleted_at IS NULL
`;

/** Reads the entitlement row that the regenerate gate decides on. `null` when the org is gone. */
export async function getEntitlement(
  db: D1Database,
  orgId: OrganisationId,
): Promise<EntitlementRow | null> {
  return db.prepare(SQL_GET_ENTITLEMENT).bind(orgId).first<EntitlementRow>();
}

/** The full organisation row, for the dashboard and for billing. */
export const SQL_GET_ORG = `
SELECT * FROM organisations WHERE id = ?1
`;

/** Reads one organisation by id, including a soft-deleted one. */
export async function getOrganisation(
  db: D1Database,
  orgId: OrganisationId,
): Promise<OrganisationRow | null> {
  return db.prepare(SQL_GET_ORG).bind(orgId).first<OrganisationRow>();
}

/** As `getOrganisation`, but throws `RowNotFoundError` when the row must exist. */
export async function getOrganisationOrThrow(
  db: D1Database,
  orgId: OrganisationId,
): Promise<OrganisationRow> {
  return firstOrThrow(await getOrganisation(db, orgId), `getOrganisation(${orgId})`);
}

/**
 * Writes entitlement state from a Stripe webhook.
 *
 * The `stripe_updated_at` ordering guard lives on `subscriptions`; this statement is written into
 * the same `batch()` as that update, so the two cannot disagree even though Stripe does not
 * guarantee webhook delivery order.
 */
export const SQL_SET_ENTITLEMENT = `
UPDATE organisations
SET entitlement = ?2, entitlement_until = ?3, plan = ?4, updated_at = ?5
WHERE id = ?1 AND deleted_at IS NULL
`;

/** Builds the entitlement update, for inclusion in the webhook's batch. */
export function setEntitlementStatement(
  db: D1Database,
  args: {
    readonly orgId: OrganisationId;
    readonly entitlement: Entitlement;
    readonly entitlementUntil: Timestamp | null;
    readonly plan: 'free' | 'pro';
    readonly now: Timestamp;
  },
): D1PreparedStatement {
  return db
    .prepare(SQL_SET_ENTITLEMENT)
    .bind(args.orgId, args.entitlement, args.entitlementUntil, args.plan, args.now);
}

/**
 * Clears `provisional` when the claim token is consumed.
 *
 * Must be batched AFTER the owner membership insert: `trg_orgs_deprovision_needs_member` aborts an
 * organisation that would become reachable-and-billable with nobody able to sign in to it.
 */
export const SQL_DEPROVISION_ORG = `
UPDATE organisations
SET provisional = 0, billing_email = ?2, updated_at = ?3
WHERE id = ?1 AND provisional = 1 AND deleted_at IS NULL
`;

/** Builds the de-provision update for the claim batch. */
export function deprovisionOrganisationStatement(
  db: D1Database,
  args: {
    readonly orgId: OrganisationId;
    readonly billingEmail: string;
    readonly now: Timestamp;
  },
): D1PreparedStatement {
  return db.prepare(SQL_DEPROVISION_ORG).bind(args.orgId, args.billingEmail, args.now);
}

/**
 * Unclaimed provisional organisations, oldest first.
 *
 * Fed by the 30-day purge cron (architecture §3b step 8), which hard-deletes the org, the draft and
 * the `drafts/{draft_id}/` R2 prefix together. Chunked with a LIMIT because D1 caps a query at 30
 * seconds and a purge that times out half-way leaves R2 objects with no row pointing at them.
 */
export const SQL_LIST_EXPIRED_PROVISIONAL_ORGS = `
SELECT id, created_at
FROM organisations
WHERE provisional = 1 AND created_at < ?1
ORDER BY created_at
LIMIT ?2
`;

/** Lists provisional organisations created before `before`, for the purge cron. */
export async function listExpiredProvisionalOrganisations(
  db: D1Database,
  args: { readonly before: Timestamp; readonly limit: number },
): Promise<readonly Pick<OrganisationRow, 'id' | 'created_at'>[]> {
  const result = await db
    .prepare(SQL_LIST_EXPIRED_PROVISIONAL_ORGS)
    .bind(args.before, args.limit)
    .all<Pick<OrganisationRow, 'id' | 'created_at'>>();
  return result.results;
}
