import { mintId } from '@aibuilder/core';
import type { AuthTokenId, SessionId } from '@aibuilder/db';
import { monotonicFactory } from 'ulid';

/**
 * The two ids this package mints.
 *
 * `tok_…` goes through `@aibuilder/core`'s `mintId`, which is the single source of truth for id
 * shapes and is asserted equal to the D1 CHECK constraints by that package's own tests.
 *
 * `ses_…` does not, and that is a temporary state with a name. `ID_PREFIXES` has no `session`
 * entry — Phase 1 minted exactly one session, on `GET /claim`, and spelled the prefix out locally
 * rather than widening a shared map from an app that owned none of it. Phase 2 makes sessions a
 * first-class surface, so `ID_PREFIXES` gains `session: 'ses'` in the same change that lands
 * `migrations/cp/0008` (see this task's handover notes). Until it does, this is the second and last
 * place that spells `ses_`, and `migrations/cp/0001`'s
 * `CHECK (id GLOB 'ses_[0-7]*' AND substr(id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')` is what proves
 * the two spellings agree.
 */

/**
 * One monotonic factory per isolate.
 *
 * Two ids minted in the same millisecond are then strictly increasing rather than randomly ordered,
 * which keeps `idx_sessions_user (user_id, expires_at DESC)` inserting at the hot end of its b-tree.
 */
const nextUlid = monotonicFactory();

/** Mints a `ses_…` id satisfying the `sessions` table's id CHECK. */
export function mintSessionId(): SessionId {
  return `ses_${nextUlid()}`;
}

/** Mints a `tok_…` id for `auth_tokens`. */
export function mintAuthTokenId(): AuthTokenId {
  return mintId('authToken');
}
