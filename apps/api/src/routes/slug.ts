import {
  DEFAULT_LOCALE,
  SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  evaluateSlug,
  industryByKey,
  isLocale,
  resolveAvailableSlug,
  slugSeed,
} from '@aibuilder/core';
import type { Locale, SlugRejectionReason } from '@aibuilder/core';
import { cp } from '@aibuilder/db';
import { Hono } from 'hono';

import type { AppEnv, Env } from '../env';
import { jsonResponse, validationErrorFromIssues } from '../lib/responses';

/**
 * `GET /v1/slug-check` — is this going to be a working hostname, and if not, what is?
 *
 * The route validates the **final** slug: post-transliteration, post-collision-suffix, at most 63
 * characters (architecture §S4, §7.5). That is the whole point of it existing as a separate call.
 * A Greek or Cyrillic business name transliterates to the empty string under a naive NFD strip and
 * would otherwise fail the `slug` CHECK inside the submit `batch()` — after eighty-two seconds of
 * the customer's effort, on the one screen where a failure is unrecoverable.
 *
 * Policy lives in `@aibuilder/core`'s slug module (transliteration, reserved labels, homoglyph and
 * trademark distance, the collision ladder) because it needs Unicode tables and an edit distance,
 * neither of which belongs in a SQL statement. Availability lives in D1 because it is a fact about
 * other tenants. This route is the join, and it is the only place the two meet.
 */

/** Longest query value accepted. A business name that does not fit is not a business name. */
const MAX_QUERY_LENGTH = 200;

/** The answer, exactly as architecture §S4 specifies it. */
interface SlugCheckBody {
  readonly available: boolean;
  /** The candidate after transliteration and normalisation. This is what would be stored. */
  readonly normalized: string;
  /** A free alternative, when the candidate is unavailable and one could be found. */
  readonly suggestion?: string;
  readonly reason?: SlugRejectionReason;
}

/**
 * Availability against the control plane.
 *
 * Deliberately reads `sites` and not `live_sites`: a soft-deleted tenant's slug is NOT available.
 * Its 301s and its printed flyers outlive the row, which is why the schema carries a total unique
 * index alongside the partial live one.
 */
function takenPredicate(env: Env): (candidate: string) => Promise<boolean> {
  return async (candidate: string): Promise<boolean> => {
    const unavailable = await cp.slugs.filterUnavailableSlugs(env.CP, [candidate]);
    return unavailable.has(candidate);
  };
}

/**
 * Finds a free slug near the candidate, or `null`.
 *
 * The ladder is the one in `@aibuilder/core`: the seed, then the city (`kapsalon-jansen-amsterdam`
 * reads like a business, `kapsalon-jansen-2` reads like a bug), then a numeric suffix, then
 * randomness. A seed the ladder cannot rescue returns `null` rather than a 63-character random
 * string that no customer would ever accept.
 */
async function suggest(
  env: Env,
  seed: string,
  locale: Locale,
  city: string | null,
): Promise<string | null> {
  if (seed.length < SLUG_MIN_LENGTH) {
    return null;
  }
  try {
    const resolved = await resolveAvailableSlug({
      seed,
      locale,
      city,
      isTaken: takenPredicate(env),
    });
    return resolved.slug;
  } catch {
    // `SlugSpaceExhaustedError` means the seed is pathological or the predicate is broken. Both
    // need a human; neither should turn a type-ahead check into a 500.
    return null;
  }
}

export const slugRoutes = new Hono<AppEnv>();

slugRoutes.get('/', async (c) => {
  const raw = c.req.query('slug') ?? '';
  if (raw.length === 0 || raw.length > MAX_QUERY_LENGTH) {
    return validationErrorFromIssues([
      { path: ['slug'], code: raw.length === 0 ? 'required' : 'too_big', message: 'invalid_slug' },
    ]);
  }

  const requestedLocale = c.req.query('locale');
  const locale: Locale = isLocale(requestedLocale) ? requestedLocale : DEFAULT_LOCALE;

  const cityQuery = c.req.query('city');
  const city = cityQuery !== undefined && cityQuery.length <= MAX_QUERY_LENGTH ? cityQuery : null;

  const evaluation = evaluateSlug(raw, locale);

  // A candidate that transliterates to nothing usable is where `slugSeed()` earns its place: the
  // fallback is `{industry}-{city}` in the site's OWN locale (`kapsalon-amsterdam`, never
  // `hairdresser-amsterdam`), which needs the two extra query parameters the modal already has.
  const businessName = c.req.query('businessName') ?? null;
  const industryKey = c.req.query('industryKey') ?? null;
  const fallbackSeed =
    businessName !== null &&
    businessName.length > 0 &&
    businessName.length <= MAX_QUERY_LENGTH &&
    industryKey !== null &&
    industryByKey(industryKey) !== null
      ? slugSeed({ businessName, industryKey, city, locale }).slug
      : evaluation.normalized;

  if (!evaluation.ok) {
    const reason = evaluation.reason ?? 'invalid';
    // A brand or reserved-label collision gets NO suggestion, and that is a product decision as
    // much as a performance one. `google-2` is not a fix for `g00gle`, and walking the ladder for
    // one would spend a D1 round trip per rejected candidate on a seed whose whole family is
    // rejected. The modal asks for a different name instead.
    const suggestion =
      reason === 'reserved' || reason === 'homoglyph'
        ? null
        : await suggest(c.env, fallbackSeed, locale, city);
    const body: SlugCheckBody = {
      available: false,
      normalized: evaluation.normalized.slice(0, SLUG_MAX_LENGTH),
      reason,
      ...(suggestion === null ? {} : { suggestion }),
    };
    return jsonResponse(body, 200);
  }

  const { normalized } = evaluation;

  // Two reads rather than one combined statement, because the two answers are not interchangeable
  // to the person reading them: "reserved" reads very differently to a customer whose own trading
  // name collided with a brand entry than it does for `www`, and support needs to tell them apart.
  const reserved = await cp.slugs.getReservedSlug(c.env.CP, normalized);
  const taken = reserved === null ? await cp.slugs.isSlugTaken(c.env.CP, normalized) : false;

  if (reserved === null && !taken) {
    return jsonResponse({ available: true, normalized } satisfies SlugCheckBody, 200);
  }

  const suggestion = await suggest(c.env, normalized, locale, city);
  const body: SlugCheckBody = {
    available: false,
    normalized,
    reason: reserved === null ? 'taken' : 'reserved',
    ...(suggestion === null ? {} : { suggestion }),
  };
  return jsonResponse(body, 200);
});
