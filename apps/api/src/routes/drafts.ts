import {
  Locale,
  OpeningHours,
  SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  SLUG_PATTERN,
  industryByKey,
  mintId,
} from '@aibuilder/core';
import { FIRST_SHARD, cp } from '@aibuilder/db';
import type { AnonSessionRow, OnboardingDraftRow } from '@aibuilder/db';
import { Hono } from 'hono';
import { z } from 'zod';

import type { AppEnv, Env } from '../env';
import { randomToken } from '../lib/encoding';
import {
  errorResponse,
  jsonResponse,
  malformedBodyResponse,
  notFoundResponse,
  validationErrorFromIssues,
} from '../lib/responses';
import { clientCountry, clientIp, hashIp } from '../lib/subjects';
import {
  DRAFT_SESSION_TTL_SECONDS,
  draftCookieHeader,
  loadAnonSession,
  mintDraftCookie,
  requireAnonSession,
} from '../middleware/draft-cookie';
import { rateLimitByIp } from '../middleware/ratelimit';
import { TURNSTILE_ACTION_DRAFT, verifyTurnstile } from '../middleware/turnstile';

/**
 * The draft lifecycle: create, read, autosave.
 *
 * WHAT THE CLIENT NEVER SEES. `idempotency_key` is minted here with a CSPRNG, stored on the row and
 * never returned — architecture §S4 and §5.4: a client-supplied idempotency key was simultaneously
 * a cross-tenant denial of service and an existence oracle for other tenants' job ids.
 *
 * WHAT AUTOSAVE DOES WITH A HALF-TYPED VALUE. A draft is partial by definition and the intake
 * columns carry real CHECK constraints (`phone_e164` is anchored on both ends because it ends up in
 * a `wa.me` href and a JSON-LD `telephone` field). Two kinds of field are therefore treated
 * differently, and deliberately:
 *
 *   - **Closed-list fields** — locale, industry key, radius, opening hours — come from a fixed UI
 *     control. A value outside the list is a client bug and answers 422.
 *   - **Free-text fields** — name, postcode, phone, e-mail — are typed one character at a time. A
 *     value the column cannot hold is stored as NULL rather than rejected: the modal keeps its own
 *     local copy until the field is complete, and a 422 on the third character of a postcode is a
 *     worse product than a field that saves once it is real.
 */

/** Milliseconds in the draft/session/cookie window. One constant, three uses. */
const SESSION_TTL_MS = DRAFT_SESSION_TTL_SECONDS * 1000;

/** Bytes of entropy in the server-minted idempotency key. */
const IDEMPOTENCY_KEY_BYTES = 24;

/** `user_agent` columns cap at 512 characters. */
const USER_AGENT_MAX = 512;

/** The steps the modal has. Mirrors `CHECK (step BETWEEN 1 AND 12)`. */
const STEP_MIN = 1;
const STEP_MAX = 12;

export const draftRoutes = new Hono<AppEnv>();

// ------------------------------------------------------------------------------------------------
// Shapes
// ------------------------------------------------------------------------------------------------

/** The intake as the modal holds it. Every field is nullable: a draft is partial by definition. */
export interface DraftValues {
  readonly businessName: string | null;
  readonly slug: string | null;
  readonly industryKey: string | null;
  readonly defaultLocale: string | null;
  readonly extraLocales: readonly string[];
  readonly serviceArea: { readonly city: string; readonly radiusKm: number } | null;
  readonly address: {
    readonly line1: string | null;
    readonly line2: string | null;
    readonly postalCode: string | null;
    readonly city: string | null;
    readonly country: string | null;
    readonly latitude: number | null;
    readonly longitude: number | null;
    readonly geoSource: 'none' | 'geocoded' | 'user_pin';
  };
  readonly openingHours: z.infer<typeof OpeningHours> | null;
  readonly phoneE164: string | null;
  readonly whatsappE164: string | null;
  readonly gbpUrl: string | null;
  readonly shortDescription: string | null;
  readonly contactEmail: string | null;
  readonly marketingOptIn: boolean;
  readonly mediaIds: readonly string[];
}

/** What `GET /v1/drafts/me` returns, and what a 409 carries as the server's copy. */
export interface DraftView {
  readonly draftId: string;
  readonly status: string;
  readonly uiLocale: string;
  readonly step: number;
  readonly furthestStep: number;
  readonly updatedAt: number;
  readonly values: DraftValues;
}

/** Parses a JSON column, returning `null` for absent or malformed content rather than throwing. */
function parseJsonColumn(value: string | null): unknown {
  if (value === null) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/** Reads a JSON array column as strings, dropping anything that is not one. */
function parseStringArrayColumn(value: string | null): readonly string[] {
  const parsed = parseJsonColumn(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * Projects a row into the client's view.
 *
 * `idempotency_key`, `ip_hash`, `ip_country` and the policy-screen verdict are absent by
 * construction rather than by filtering: this function names every field that may leave the
 * server, so adding a column to the table cannot accidentally publish it.
 */
export function toDraftView(row: OnboardingDraftRow): DraftView {
  const hours = OpeningHours.safeParse(parseJsonColumn(row.opening_hours));
  return {
    draftId: row.id,
    status: row.status,
    uiLocale: row.ui_locale,
    step: row.step,
    furthestStep: row.furthest_step,
    updatedAt: row.updated_at,
    values: {
      businessName: row.business_name,
      slug: row.slug,
      industryKey: row.industry_key,
      defaultLocale: row.default_locale,
      extraLocales: parseStringArrayColumn(row.extra_locales),
      serviceArea:
        row.service_area_city === null || row.service_area_radius_km === null
          ? null
          : { city: row.service_area_city, radiusKm: row.service_area_radius_km },
      address: {
        line1: row.address_line1,
        line2: row.address_line2,
        postalCode: row.postal_code,
        city: row.city,
        country: row.country,
        latitude: row.latitude,
        longitude: row.longitude,
        geoSource: row.geo_source,
      },
      openingHours: hours.success ? hours.data : null,
      phoneE164: row.phone_e164,
      whatsappE164: row.whatsapp_e164,
      gbpUrl: row.gbp_url,
      shortDescription: row.short_description,
      contactEmail: row.contact_email,
      marketingOptIn: row.marketing_opt_in === 1,
      mediaIds: parseStringArrayColumn(row.media_ids),
    },
  };
}

// ------------------------------------------------------------------------------------------------
// POST /v1/drafts
// ------------------------------------------------------------------------------------------------

const CreateDraftSchema = z.object({
  turnstileToken: z.string().min(1).max(4096),
  locale: Locale,
});

/** A URL-safe, CSPRNG idempotency key inside the column's `16..64` and `[0-9A-Za-z_-]` CHECK. */
function mintIdempotencyKey(): string {
  return randomToken(IDEMPOTENCY_KEY_BYTES);
}

draftRoutes.post('/', rateLimitByIp('RL_DRAFT'), async (c) => {
  const body: unknown = await c.req.json<unknown>().catch(() => null);
  if (body === null) {
    return malformedBodyResponse();
  }
  const parsed = CreateDraftSchema.safeParse(body);
  if (!parsed.success) {
    return validationErrorFromIssues(parsed.error.issues);
  }

  const ip = clientIp(c.req.raw);
  const verification = await verifyTurnstile(c.env, {
    token: parsed.data.turnstileToken,
    action: TURNSTILE_ACTION_DRAFT,
    // There is no draft to bind to yet; the binding starts existing at submit, where the token is
    // additionally checked against the draft id in `cdata`.
    cdata: null,
    remoteIp: ip,
  });
  if (!verification.ok) {
    return errorResponse(
      403,
      'turnstile_failed',
      'We konden niet vaststellen dat je een mens bent. Ververs de pagina en probeer het opnieuw.',
      'We could not verify that you are human. Refresh the page and try again.',
      { reason: verification.error },
    );
  }

  const now = Date.now();

  // A live cookie is reused rather than replaced. Minting a second session per visitor would leave
  // the first draft unreachable and would make "resume where you left off" depend on which tab won.
  const existingSession = await loadAnonSession(c.env, c.req.header('Cookie'));
  if (existingSession !== null) {
    const open = await cp.drafts.getLatestDraftForSession(c.env.CP, existingSession.id);
    if (open !== null && open.status === 'open') {
      return jsonResponse({ draftId: open.id, expiresAt: open.purge_after }, 200);
    }
  }

  const ipHash = ip === null ? null : await hashIp(c.env, ip);
  const userAgent = (c.req.header('User-Agent') ?? '').slice(0, USER_AGENT_MAX) || null;

  let sessionId = existingSession?.id ?? null;
  let cookieValue: string | null = null;

  if (sessionId === null) {
    const cookie = await mintDraftCookie(c.env);
    const minted = mintId('anonSession');
    await cp.drafts.insertAnonSession(c.env.CP, {
      tokenHash: cookie.tokenHash,
      id: minted,
      ipHash,
      ipCountry: clientCountry(c.req.raw),
      userAgent,
      now,
      expiresAt: now + SESSION_TTL_MS,
    });
    sessionId = minted;
    cookieValue = cookie.value;
  }

  const draftId = mintId('onboardingDraft');
  await cp.drafts.insertDraft(c.env.CP, {
    id: draftId,
    anonSessionId: sessionId,
    // No organisation exists yet, so the draft carries the placement decision that the organisation
    // will inherit at submit. With one shard this is always shard 0; the indirection is what makes
    // shard 001 a configuration change (`@aibuilder/db`'s shard router).
    shardId: FIRST_SHARD,
    uiLocale: parsed.data.locale,
    idempotencyKey: mintIdempotencyKey(),
    turnstileVerifiedAt: now,
    ipHash,
    ipCountry: clientCountry(c.req.raw),
    now,
    purgeAfter: now + SESSION_TTL_MS,
  });

  const headers: Record<string, string> =
    cookieValue === null ? {} : { 'set-cookie': draftCookieHeader(cookieValue) };
  return jsonResponse({ draftId, expiresAt: now + SESSION_TTL_MS }, 201, headers);
});

// ------------------------------------------------------------------------------------------------
// GET /v1/drafts/me
// ------------------------------------------------------------------------------------------------

/**
 * Resolves the session's current draft.
 *
 * The cookie carries the session, not the draft, so "which draft" is a database question with a
 * single answer: the most recently touched one. That is also what makes resume work after the tab
 * has been closed for a week.
 */
export async function currentDraft(
  env: Env,
  session: AnonSessionRow,
): Promise<OnboardingDraftRow | null> {
  return cp.drafts.getLatestDraftForSession(env.CP, session.id);
}

draftRoutes.get('/me', requireAnonSession, async (c) => {
  const draft = await currentDraft(c.env, c.get('anonSession'));
  if (draft === null) {
    return notFoundResponse('no_draft');
  }
  return jsonResponse({ draft: toDraftView(draft) }, 200);
});

// ------------------------------------------------------------------------------------------------
// PUT /v1/drafts/me
// ------------------------------------------------------------------------------------------------

/**
 * The autosave patch.
 *
 * Only maximum lengths and closed lists are enforced here; minimum lengths are applied by the
 * `storable*` helpers below, which NULL a value the column cannot hold instead of failing the save.
 */
const DraftPatchSchema = z.object({
  step: z.number().int().min(STEP_MIN).max(STEP_MAX),
  furthestStep: z.number().int().min(STEP_MIN).max(STEP_MAX),
  updatedAt: z.number().int().nonnegative(),
  values: z
    .object({
      businessName: z.string().max(120).nullable().optional(),
      slug: z.string().max(SLUG_MAX_LENGTH).nullable().optional(),
      industryKey: z.string().max(40).nullable().optional(),
      defaultLocale: Locale.nullable().optional(),
      extraLocales: z.array(Locale).max(1).optional(),
      serviceArea: z
        .object({
          city: z.string().max(80),
          radiusKm: z.union([z.literal(5), z.literal(10), z.literal(25), z.literal(50)]),
        })
        .nullable()
        .optional(),
      address: z
        .object({
          line1: z.string().max(120).nullable(),
          line2: z.string().max(120).nullable(),
          postalCode: z.string().max(16).nullable(),
          city: z.string().max(80).nullable(),
          country: z.string().max(2).nullable(),
          latitude: z.number().min(-90).max(90).nullable(),
          longitude: z.number().min(-180).max(180).nullable(),
          geoSource: z.enum(['none', 'geocoded', 'user_pin']),
        })
        .nullable()
        .optional(),
      openingHours: OpeningHours.nullable().optional(),
      phoneE164: z.string().max(16).nullable().optional(),
      whatsappE164: z.string().max(16).nullable().optional(),
      gbpUrl: z.string().max(500).nullable().optional(),
      shortDescription: z.string().max(600).nullable().optional(),
      contactEmail: z.string().max(254).nullable().optional(),
      marketingOptIn: z.boolean().optional(),
      mediaIds: z.array(z.string().max(30)).max(12).optional(),
    })
    .strict(),
});

/** Chooses between a present patch value (which may clear a field) and the stored one. */
function pick<T>(present: boolean, next: T | null | undefined, current: T | null): T | null {
  return present ? (next ?? null) : current;
}

/** Trims, then keeps only what the column's length CHECK accepts. */
function storableText(value: string | null, min: number, max: number): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length >= min && trimmed.length <= max ? trimmed : null;
}

/** Keeps a slug only if it is one: the `sites.slug` and draft CHECKs, applied before the write. */
function storableSlug(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const candidate = value.trim().toLowerCase();
  const ok =
    candidate.length >= SLUG_MIN_LENGTH &&
    candidate.length <= SLUG_MAX_LENGTH &&
    SLUG_PATTERN.test(candidate) &&
    !candidate.includes('--');
  return ok ? candidate : null;
}

/** Keeps a phone number only in E.164. Half-typed numbers are not storable and are not stored. */
function storableE164(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const candidate = value.replace(/[\s-]/g, '');
  return /^\+[1-9]\d{6,14}$/.test(candidate) ? candidate : null;
}

/** Keeps an address only in the `contact_email` CHECK's shape. */
function storableEmail(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const candidate = value.trim();
  const ok =
    candidate.length >= 6 &&
    candidate.length <= 254 &&
    /^[^\s<>"@]+@[^\s<>"@]+\.[^\s<>"@]+$/.test(candidate);
  return ok ? candidate : null;
}

/**
 * Keeps a Google Business Profile URL only when it parses as `https:`.
 *
 * Architecture §4 invariant 2: the scheme allowlist for anything that becomes a link is `https:`
 * and nothing else. The column's CHECK is deliberately a length bound rather than a scheme GLOB —
 * a prefix test is not URL parsing, and `https://evil@real.example` passes one and fails the other.
 * This is where the real parse happens.
 */
function storableHttpsUrl(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const candidate = value.trim();
  if (candidate.length < 12 || candidate.length > 500) {
    return null;
  }
  try {
    return new URL(candidate).protocol === 'https:' ? candidate : null;
  } catch {
    return null;
  }
}

/** Keeps a two-letter uppercase country code. */
function storableCountry(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const candidate = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(candidate) ? candidate : null;
}

/** Keeps only well-formed media ids, capped at the column's twelve. */
function storableMediaIds(values: readonly string[]): string | null {
  const ids = values.filter((id) => /^med_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id)).slice(0, 12);
  return ids.length === 0 ? null : JSON.stringify(ids);
}

draftRoutes.put('/me', requireAnonSession, async (c) => {
  const session = c.get('anonSession');
  const body: unknown = await c.req.json<unknown>().catch(() => null);
  if (body === null) {
    return malformedBodyResponse();
  }
  const parsed = DraftPatchSchema.safeParse(body);
  if (!parsed.success) {
    return validationErrorFromIssues(parsed.error.issues);
  }

  const row = await currentDraft(c.env, session);
  if (row === null) {
    return notFoundResponse('no_draft');
  }

  const { values } = parsed.data;

  // A closed-list field with an unknown value is a client bug, not a partially-typed field: the
  // combobox only ever emits keys that exist, and the column carries a foreign key to `industries`
  // that would otherwise abort the write with a constraint error.
  if ('industryKey' in values && typeof values.industryKey === 'string') {
    if (industryByKey(values.industryKey) === null) {
      return validationErrorFromIssues([
        { path: ['values', 'industryKey'], code: 'unknown_industry', message: 'unknown_industry' },
      ]);
    }
  }

  const extraLocales =
    'extraLocales' in values && values.extraLocales !== undefined
      ? JSON.stringify(values.extraLocales)
      : row.extra_locales;

  // `'x' in values` distinguishes "the client cleared this" from "the client did not send it",
  // which is the whole reason the autosave statement writes the entire intake rather than a
  // COALESCE-style partial update: a partial update can only ever set values, so deleting a second
  // address line would silently not save.
  const hasServiceArea = 'serviceArea' in values;
  const hasAddress = 'address' in values;
  const serviceArea = values.serviceArea ?? null;
  const address = values.address ?? null;

  const openingHours =
    'openingHours' in values
      ? values.openingHours === null || values.openingHours === undefined
        ? null
        : JSON.stringify(values.openingHours)
      : row.opening_hours;

  const mediaIds =
    'mediaIds' in values && values.mediaIds !== undefined
      ? storableMediaIds(values.mediaIds)
      : row.media_ids;

  const now = Date.now();
  const saved = await cp.drafts.updateDraftIntake(c.env.CP, {
    draftId: row.id,
    anonSessionId: session.id,
    now,
    ifUnmodifiedSince: parsed.data.updatedAt,
    patch: {
      step: parsed.data.step,
      furthestStep: Math.max(parsed.data.furthestStep, parsed.data.step),
      businessName: storableText(
        pick('businessName' in values, values.businessName, row.business_name),
        2,
        120,
      ),
      slug: storableSlug(pick('slug' in values, values.slug, row.slug)),
      industryKey: pick('industryKey' in values, values.industryKey, row.industry_key),
      defaultLocale: pick('defaultLocale' in values, values.defaultLocale, row.default_locale),
      extraLocales,
      serviceAreaCity: hasServiceArea
        ? storableText(serviceArea?.city ?? null, 1, 80)
        : row.service_area_city,
      serviceAreaRadiusKm: hasServiceArea
        ? (serviceArea?.radiusKm ?? null)
        : row.service_area_radius_km,
      addressLine1: hasAddress ? storableText(address?.line1 ?? null, 1, 120) : row.address_line1,
      addressLine2: hasAddress ? storableText(address?.line2 ?? null, 1, 120) : row.address_line2,
      postalCode: hasAddress ? storableText(address?.postalCode ?? null, 2, 16) : row.postal_code,
      city: hasAddress ? storableText(address?.city ?? null, 1, 80) : row.city,
      country: hasAddress ? storableCountry(address?.country ?? null) : row.country,
      latitude: hasAddress ? (address?.latitude ?? null) : row.latitude,
      longitude: hasAddress ? (address?.longitude ?? null) : row.longitude,
      geoSource: hasAddress ? (address?.geoSource ?? 'none') : row.geo_source,
      openingHours,
      phoneE164: storableE164(pick('phoneE164' in values, values.phoneE164, row.phone_e164)),
      whatsappE164: storableE164(
        pick('whatsappE164' in values, values.whatsappE164, row.whatsapp_e164),
      ),
      gbpUrl: storableHttpsUrl(pick('gbpUrl' in values, values.gbpUrl, row.gbp_url)),
      shortDescription: storableText(
        pick('shortDescription' in values, values.shortDescription, row.short_description),
        1,
        600,
      ),
      contactEmail: storableEmail(
        pick('contactEmail' in values, values.contactEmail, row.contact_email),
      ),
      marketingOptIn:
        'marketingOptIn' in values && values.marketingOptIn !== undefined
          ? values.marketingOptIn
            ? 1
            : 0
          : row.marketing_opt_in,
      mediaIds,
    },
  });

  if (!saved) {
    // Zero rows changed means one of three things, and only the caller's own copy can tell them
    // apart: the server's copy is strictly newer, the draft has already been submitted, or the
    // cookie no longer owns it. Re-reading and returning the server's copy answers all three
    // without the client having to guess (architecture §S4).
    const server = await currentDraft(c.env, session);
    if (server === null) {
      return notFoundResponse('no_draft');
    }
    return errorResponse(
      409,
      'draft_conflict',
      'Er is elders een nieuwere versie van dit formulier opgeslagen.',
      'A newer version of this form was saved elsewhere.',
      { server: toDraftView(server) },
    );
  }

  return jsonResponse({ updatedAt: now }, 200);
});
