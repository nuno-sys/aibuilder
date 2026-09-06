import { monotonicFactory } from 'ulid';

/**
 * Prefixed ULIDs minted by this Worker.
 *
 * PHASE 2 NOTE: `@aibuilder/core`'s `ID_PREFIXES` has no `trialGrant` entry yet (design §8.4 adds
 * `session: 'ses'`, `trialGrant: 'trg'` and `webauthnCredential: 'pky'`). Until it does, the one
 * prefix this Worker mints is spelled out here rather than widening a shared map from an app that
 * owns none of it — the same choice, and the same reasoning, as `apps/api/src/routes/claim.ts`.
 *
 * The body is a MONOTONIC ULID. Two grants minted in the same millisecond must not collide, and
 * `CHECK (id GLOB 'trg_[0-7]*')` requires the Crockford base32 shape a ULID already has.
 */

/** Monotonic within an isolate, which is where two same-millisecond mints can meet. */
const nextUlid = monotonicFactory();

/** A `trg_…` id for one row in the trial ledger. */
export function mintTrialGrantId(): string {
  return `trg_${nextUlid()}`;
}

/** Sixteen random bytes: the `stripe_events` claim token. Matches `length(claim_token) = 16`. */
export function mintClaimToken(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}
