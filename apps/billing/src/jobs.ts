import { changedOne } from '@aibuilder/db';
import type { GenerationJobId, GenerationJobRow, OrganisationId, Timestamp } from '@aibuilder/db';

/**
 * The `generation_jobs` payment lifecycle, from the webhook's side.
 *
 * PHASE 2 NOTE: design §8.3 puts these four statements in
 * `packages/db/src/shard/generation-jobs.ts`, beside the rest of the job vocabulary and inside the
 * EXPLAIN QUERY PLAN gate's reach. They are declared here because that file belongs to the shard
 * schema change that lands with `migrations/shard/0007_billing_gate.sql`; moving them is a copy and
 * an import change, and the SQL text is written to be moved verbatim.
 *
 * WHY `payment_state` IS A COLUMN AND NOT A `status` VALUE. Widening
 * `CHECK (status IN (…))` is a 12-step table rebuild, and `generation_jobs` is a cascade parent of
 * `generation_calls` and `generation_job_events`. D1 rejects `PRAGMA foreign_keys=OFF` and
 * `defer_foreign_keys` defers constraint CHECKING rather than FK ACTIONS, so that rebuild silently
 * cascade-deletes every child while `foreign_key_check` reports success. `status='queued'` with
 * `queue_ready_at IS NULL` is already a legal, non-runnable state, and `idx_jobs_queue` is partial
 * on `queue_ready_at IS NOT NULL`, so the drain cannot see a job that has not been paid for.
 */

/** Where a job sits in the payment funnel. Orthogonal to `status`. */
export type PaymentState = 'not_required' | 'awaiting_payment' | 'paid' | 'abandoned';

/**
 * `generation_jobs` with the four columns `migrations/shard/0007_billing_gate.sql` adds.
 *
 * PHASE 2 NOTE: these belong on `GenerationJobRow` in `packages/db/src/types.ts` (design §8.3).
 * Declared as an extension here so this Worker is typed against the real row today.
 */
export interface PaymentAwareJobRow extends GenerationJobRow {
  readonly payment_state: PaymentState;
  readonly checkout_session_id: string | null;
  readonly payment_deadline_at: Timestamp | null;
  readonly checkout_attempts: number;
}

/**
 * The job a Checkout Session belongs to.
 *
 * THE SESSION ID IS THE MAPPING, NOT THE EVENT'S METADATA. `apps/api` wrote `checkout_session_id`
 * onto the job row when it created the session, so this lookup is a fact the product controls end
 * to end. Session and subscription metadata are editable from the Stripe Dashboard by anyone with
 * access, and an authorisation decision a Dashboard user can edit is not an authorisation decision
 * (design §3.5).
 *
 * Seeks `idx_jobs_checkout_session`, which `0007` creates partial on `checkout_session_id IS NOT
 * NULL`.
 */
export const SQL_GET_JOB_BY_CHECKOUT_SESSION = `
SELECT * FROM generation_jobs WHERE checkout_session_id = ?1
`;

/** Reads the job a Checkout Session was created for. */
export async function getJobByCheckoutSession(
  db: D1Database,
  checkoutSessionId: string,
): Promise<PaymentAwareJobRow | null> {
  return db
    .prepare(SQL_GET_JOB_BY_CHECKOUT_SESSION)
    .bind(checkoutSessionId)
    .first<PaymentAwareJobRow>();
}

/**
 * An organisation's job that is still waiting for payment.
 *
 * Used by `invoice.paid` on the trial-converted-immediately path (design §5.3), where the release
 * happens on the invoice rather than on the session. Seeks the `org_id` prefix of
 * `uq_jobs_idem(org_id, idempotency_key)`.
 */
export const SQL_FIND_AWAITING_PAYMENT_JOB = `
SELECT * FROM generation_jobs
WHERE org_id = ?1 AND payment_state = 'awaiting_payment'
ORDER BY created_at
LIMIT 1
`;

/** Finds the organisation's unpaid job, if it has one. */
export async function findAwaitingPaymentJob(
  db: D1Database,
  orgId: OrganisationId,
): Promise<PaymentAwareJobRow | null> {
  return db.prepare(SQL_FIND_AWAITING_PAYMENT_JOB).bind(orgId).first<PaymentAwareJobRow>();
}

/**
 * Releases a paid job into the queue.
 *
 * `AND payment_state = 'awaiting_payment'` is the compare-and-swap that makes a redelivery safe:
 * `changes === 1` means THIS delivery won the release, `changes === 0` means a peer already did it.
 * Neither is an error, and the caller dispatches either way because dispatch is itself idempotent
 * on the job id.
 *
 * Setting `queue_ready_at` is what makes the job visible to `idx_jobs_queue` — until this statement
 * runs, the drain cannot see it and no Opus is spent.
 */
export const SQL_RELEASE_PAID_JOB = `
UPDATE generation_jobs
SET payment_state = 'paid', queue_ready_at = ?2, updated_at = ?2
WHERE id = ?1 AND payment_state = 'awaiting_payment'
`;

/** Releases the job. `true` when this call performed the release. */
export async function releasePaidJob(
  db: D1Database,
  args: { readonly jobId: GenerationJobId; readonly now: Timestamp },
): Promise<boolean> {
  const result = await db.prepare(SQL_RELEASE_PAID_JOB).bind(args.jobId, args.now).run();
  return changedOne(result.meta);
}

/**
 * Marks an expired Checkout as abandoned.
 *
 * Deliberately NOT terminal on `status`. `blocked_paywall` requires `finished_at`, and
 * `SQL_FINISH_JOB_FAILED` refuses to transition out of a terminal status — which would make "pay
 * after all" impossible without a second job row, a second idempotency key and a second slug
 * reservation. One draft has exactly one job for its whole life; it may have many Checkout
 * Sessions.
 *
 * `checkout_session_id` is cleared so a resume mints a fresh session instead of linking to a dead
 * one, and the session-id predicate stops a late `expired` event for a SUPERSEDED session from
 * abandoning a job that is already waiting on a newer one.
 */
export const SQL_ABANDON_CHECKOUT = `
UPDATE generation_jobs
SET payment_state = 'abandoned', checkout_session_id = NULL, payment_deadline_at = NULL,
    updated_at = ?3
WHERE id = ?1 AND payment_state = 'awaiting_payment' AND checkout_session_id = ?2
`;

/** Abandons the job's checkout. `false` when the session was already superseded or paid. */
export async function abandonCheckout(
  db: D1Database,
  args: {
    readonly jobId: GenerationJobId;
    readonly checkoutSessionId: string;
    readonly now: Timestamp;
  },
): Promise<boolean> {
  const result = await db
    .prepare(SQL_ABANDON_CHECKOUT)
    .bind(args.jobId, args.checkoutSessionId, args.now)
    .run();
  return changedOne(result.meta);
}
