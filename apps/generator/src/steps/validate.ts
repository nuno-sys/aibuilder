import { IntakeSchema } from '@aibuilder/core';
import type { Intake } from '@aibuilder/core';
import type { OnboardingDraftRow } from '@aibuilder/db';

import { putArtifact, runArtifactKey } from '../artifacts';
import type { ArtifactRef } from '../artifacts';
import type { Env, SiteGenerationParams } from '../env';
import { DraftUnavailableError, GeneratorError } from '../errors';

/**
 * Step 1, `validate-intake` — the last cheap check before anything costs money.
 *
 * WHY THERE IS NO SECOND HAIKU CALL HERE. Architecture §6.1 lists this step as "Zod + Haiku 4.5
 * policy screen", and the screen genuinely runs — it runs at submit, through
 * `POST /v1/policy-screen` on this Worker's service binding, BEFORE the job row exists and before
 * any Opus spend, which is the entire economic argument for having it (§8: a refusal is not
 * refundable). Its verdict is durable on `onboarding_drafts.policy_screen`. Calling the classifier a
 * second time here would pay twice for the same answer and would open the door to a run proceeding
 * on a verdict that disagrees with the one the customer was already told about. So this step
 * *enforces* the stored verdict instead of re-deriving it, and a draft that is not `pass` fails the
 * run terminally as a policy failure, never as a retryable error.
 *
 * WHAT ZOD IS DOING HERE THAT IT DID NOT DO AT SUBMIT. The API validated a request BODY. This
 * validates the ROW — the projection of that body through eleven nullable columns, a JSON-encoded
 * opening-hours blob and an integer-coded radius. Those are two different documents, and the gap
 * between them is exactly where a NULL that the schema says is impossible would otherwise reach a
 * prompt builder.
 */

/**
 * Reads a draft by id, without a session predicate.
 *
 * Every other read of this table in the product is scoped by `anon_session_id`, because possession
 * of a draft id must never be sufficient to read someone's business name, address, phone and
 * e-mail (§S4). This one is not, and cannot be: the Workflow is dispatched with identifiers only
 * and has no session. What authorises it is upstream and structural — the only path into this
 * Worker is `apps/api`'s service binding, there is no public route, and the API has already proven
 * the draft cookie owns this draft before it dispatched. The statement therefore lives here rather
 * than in `@aibuilder/db`, so that "the unauthenticated read" is one greppable string in the one
 * Worker allowed to make it, instead of a general-purpose function anything could pick up.
 *
 * It is a primary-key lookup, so the `EXPLAIN QUERY PLAN` gate's `SCAN` prohibition is satisfied by
 * construction.
 */
export const SQL_GET_DRAFT_BY_ID = `
SELECT * FROM onboarding_drafts WHERE id = ?1
`;

/** What the validate step hands to the rest of the run. Keys and counts only. */
export interface ValidateResult {
  readonly intake: ArtifactRef;
  /** Denormalised so the media and structure steps do not have to read the artefact to branch. */
  readonly primaryLocale: Intake['defaultLocale'];
  readonly industryKey: string;
  readonly mediaIdCount: number;
  readonly hasDescription: boolean;
}

/** Parses a JSON column, returning `null` rather than throwing on malformed content. */
function readJsonColumn(value: string | null): unknown {
  if (value === null || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Projects a draft row onto the intake document the rest of the pipeline reads.
 *
 * Deliberately builds a plain object and hands it to `IntakeSchema` rather than casting: the row's
 * columns are all nullable and the schema's fields are mostly not, and the difference between those
 * two facts is a validation error rather than a cast.
 */
function intakeFromRow(row: OnboardingDraftRow): unknown {
  const radius = row.service_area_radius_km;
  return {
    businessName: row.business_name,
    slug: row.slug,
    industryKey: row.industry_key,
    defaultLocale: row.default_locale,
    extraLocales: readJsonColumn(row.extra_locales) ?? [],
    serviceArea:
      row.service_area_city === null || radius === null
        ? null
        : { city: row.service_area_city, radiusKm: String(radius) },
    address:
      row.address_line1 === null || row.postal_code === null || row.city === null
        ? null
        : {
            line1: row.address_line1,
            line2: row.address_line2,
            postalCode: row.postal_code,
            city: row.city,
            country: row.country,
            latitude: row.latitude,
            longitude: row.longitude,
            geoSource: row.geo_source,
          },
    openingHours: readJsonColumn(row.opening_hours),
    phoneE164: row.phone_e164,
    whatsappE164: row.whatsapp_e164,
    gbpUrl: row.gbp_url,
    shortDescription: row.short_description,
    contactEmail: row.contact_email,
    marketingOptIn: row.marketing_opt_in === 1,
    mediaIds: readJsonColumn(row.media_ids) ?? [],
  };
}

/**
 * Validates the run's inputs and stores the canonical intake document.
 *
 * Guarantees: the run stops here — terminally, and before a single token is spent — if the draft is
 * missing, is not in `submitted`, did not pass the policy screen, or does not satisfy
 * `IntakeSchema`; and that everything downstream reads ONE validated intake from R2 rather than
 * re-projecting eleven columns per step.
 *
 * Idempotent: it re-reads the same row and overwrites the same object.
 */
export async function runValidateStep(
  env: Env,
  params: SiteGenerationParams,
): Promise<ValidateResult> {
  const row = await env.CP.prepare(SQL_GET_DRAFT_BY_ID)
    .bind(params.draftId)
    .first<OnboardingDraftRow>();
  if (row === null) {
    throw new DraftUnavailableError('draft_missing', params.draftId);
  }

  // `claimed` is legal: a run can outlive the claim e-mail the customer clicked while it was still
  // building. `open` is not — it means the control-plane batch that creates the job never
  // committed, so this dispatch is addressing a draft that was never submitted.
  if (row.status !== 'submitted' && row.status !== 'claimed') {
    throw new DraftUnavailableError('draft_not_ready', `status=${row.status}`);
  }

  if (row.policy_screen !== 'pass') {
    // Not retryable and not a technical failure: it is the terminal `needs_review` state from §6.2,
    // and `classifyStepFailure` maps this code onto it.
    throw new GeneratorError('policy_not_passed', `policy_screen=${row.policy_screen}`, {
      retryable: false,
      detail: row.policy_screen,
    });
  }

  const parsed = IntakeSchema.safeParse(intakeFromRow(row));
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => issue.path.join('.'))
      .filter((path) => path.length > 0)
      .slice(0, 8);
    throw new GeneratorError('intake_invalid', 'Draft row does not satisfy IntakeSchema', {
      retryable: false,
      detail: fields.join(','),
    });
  }
  const intake: Intake = parsed.data;

  const ref = await putArtifact(env.BLOBS, runArtifactKey(params.jobId, 'intake'), intake);
  return {
    intake: ref,
    primaryLocale: intake.defaultLocale,
    industryKey: intake.industryKey,
    mediaIdCount: intake.mediaIds.length,
    hasDescription: intake.shortDescription !== null && intake.shortDescription.length > 0,
  };
}
