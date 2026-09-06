import { assertId } from '@aibuilder/core';
import type { DraftId, GenerationJobId, OrganisationId, ShardId, SiteId } from '@aibuilder/db';

import type { SiteGenerationParams } from './env';

/**
 * The one place a dispatch's `string` identifiers become the branded types `@aibuilder/db` binds.
 *
 * `SiteGenerationParams` is a durable Workflow parameter record: it crosses a service binding as
 * JSON and is stored by the platform, so its fields are `string` and cannot be anything else. Every
 * statement in `@aibuilder/db` takes a template-literal type (`job_${string}`, `ste_${string}`),
 * which exists precisely so a site id cannot be passed where an org id belongs.
 *
 * Bridging those two with a cast at each call site would put twenty unchecked assertions in the
 * step files and would make the prefix guarantee decorative. Bridging them here, once, with
 * `assertId()` — which VERIFIES the prefix and the ULID body rather than asserting it — means a
 * malformed dispatch fails immediately, with a named error, before it can address a row.
 *
 * @throws InvalidIdError when any identifier is not a well-formed prefixed ULID of its entity.
 */
export interface RunIds {
  readonly jobId: GenerationJobId;
  readonly orgId: OrganisationId;
  readonly siteId: SiteId;
  readonly draftId: DraftId;
  readonly shardId: ShardId;
}

/**
 * Validates and narrows the identifiers a run was dispatched with.
 *
 * Guarantees every returned id carries the prefix its type promises, so no downstream statement
 * needs a cast; and that an out-of-range shard id is rejected here rather than by `shardById()`
 * three steps later, when a paid call has already been made.
 */
export function runIds(params: SiteGenerationParams): RunIds {
  const shardId = params.shardId;
  if (!Number.isInteger(shardId) || shardId < 0 || shardId > 999) {
    throw new RangeError(`Dispatched with an impossible shard id: ${String(shardId)}`);
  }
  return {
    jobId: assertId('generationJob', params.jobId),
    orgId: assertId('organisation', params.orgId),
    siteId: assertId('site', params.siteId),
    draftId: assertId('onboardingDraft', params.draftId),
    shardId,
  };
}
