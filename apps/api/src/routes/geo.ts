import { Hono } from 'hono';
import { z } from 'zod';

import { readSecret } from '../env';
import type { AppEnv, Env } from '../env';
import { errorResponse, jsonResponse, validationErrorFromIssues } from '../lib/responses';
import { sha256Hex } from '../lib/subjects';
import { requireAnonSession } from '../middleware/draft-cookie';

/**
 * `POST /v1/geo/nl-be` — postcode plus house number to a street and a city.
 *
 * **A failure here must never block Continue.** That is the load-bearing sentence of architecture
 * §S4 for this route and it is why every path below is bounded: a 2.5-second timeout, a defensive
 * parse, and three honest answers — the address (200), "we don't know it" (404), or "the provider
 * is down" (503). The modal falls through to manual entry on the last two, and step 3 completes
 * either way. Nothing here is allowed to be the reason someone abandons onboarding.
 *
 * KV, 24 hours, keyed on `sha256(country|postcode|number)`. Both hits and misses are cached: a
 * miss that is not cached is an invitation to hammer a metered upstream with the same unknown
 * postcode, and the shorter negative TTL is there because new-build addresses do get added.
 *
 * The route requires the draft cookie. Lookups cost money per call and every real caller has a
 * draft by the time they reach step 3 — the modal creates one on the first keystroke of step 1.
 *
 * PROVIDER. One function (`lookupUpstream`) speaks to the geocoder; everything else is ours. The
 * response is read through a tolerant parse because the NL and BE endpoints of the same provider
 * spell their fields differently and a rigid schema would turn a working lookup into a permanent
 * 503. Anything that does not yield a street and a city is reported as `not_found`.
 */

/** NL/BE postcode autocomplete. Swapping providers is a change to `lookupUpstream` and nowhere else. */
const GEOCODER_BASE_URL = 'https://api.pro6pp.nl/v2/autocomplete';

/** A lookup may not hold a user's Continue button. */
const UPSTREAM_TIMEOUT_MS = 2_500;

/** Successful lookups are stable for a day. */
const CACHE_TTL_SECONDS = 86_400;

/** Unknown addresses are re-checked sooner: new builds are added to the registry over time. */
const NEGATIVE_CACHE_TTL_SECONDS = 3_600;

/** The request body. */
const GeoRequestSchema = z.object({
  country: z.enum(['NL', 'BE']),
  postalCode: z.string().min(4).max(12),
  houseNumber: z.string().min(1).max(12),
});

/** A resolved address, exactly as architecture §S4 specifies it. */
export interface GeoResult {
  readonly addressLine1: string;
  readonly city: string;
  readonly postalCode: string;
  readonly country: 'NL' | 'BE';
  readonly latitude: number | null;
  readonly longitude: number | null;
  /** Always `geocoded` here. §7.15 forbids emitting JSON-LD `geo` for any other source. */
  readonly source: 'geocoded';
}

/** What the KV cache holds: a hit or a recorded miss. */
type CachedLookup = { readonly ok: true; readonly result: GeoResult } | { readonly ok: false };

/** Normalises a postcode for the cache key and the upstream call: no spaces, uppercase. */
function normalizePostcode(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

/** Normalises a house number: no spaces, uppercase suffix letters. */
function normalizeHouseNumber(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

/** The cache key. Hashed so that a KV listing is not a list of everyone's addresses. */
async function cacheKey(country: string, postcode: string, houseNumber: string): Promise<string> {
  return `geo:${await sha256Hex(`${country}|${postcode}|${houseNumber}`)}`;
}

/** Reads one string field, accepting any of the aliases the two country endpoints use. */
function readString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

/** Reads one numeric field, accepting the same aliasing. */
function readNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

/** Unwraps the provider's envelope: a bare object, `{results:[…]}` or `{data:[…]}`. */
function firstRecord(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ['results', 'data'] as const) {
    const list = record[key];
    if (Array.isArray(list)) {
      const first: unknown = list[0];
      return typeof first === 'object' && first !== null
        ? (first as Record<string, unknown>)
        : null;
    }
  }
  return record;
}

/** Calls the provider. Returns `undefined` for "provider unavailable", `null` for "not found". */
async function lookupUpstream(
  env: Env,
  country: 'NL' | 'BE',
  postcode: string,
  houseNumber: string,
): Promise<GeoResult | null | undefined> {
  const key = await readSecret(env.GEOCODER_KEY, 'GEOCODER_KEY');
  const url = new URL(`${GEOCODER_BASE_URL}/${country.toLowerCase()}`);
  url.searchParams.set('authKey', key);
  url.searchParams.set('postalCode', postcode);
  url.searchParams.set('streetNumberAndPremise', houseNumber);

  let payload: unknown;
  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      return undefined;
    }
    payload = await response.json();
  } catch {
    return undefined;
  }

  const record = firstRecord(payload);
  if (record === null) {
    return undefined;
  }

  const street = readString(record, ['street', 'streetName', 'straat']);
  const city = readString(record, ['city', 'settlement', 'municipality', 'plaats']);
  if (street === null || city === null) {
    // A well-formed answer that names no street is the provider saying "no such address".
    return null;
  }

  return {
    addressLine1: `${street} ${houseNumber}`,
    city,
    postalCode: readString(record, ['postalCode', 'postcode']) ?? postcode,
    country,
    latitude: readNumber(record, ['lat', 'latitude']),
    longitude: readNumber(record, ['lng', 'lon', 'longitude']),
    source: 'geocoded',
  };
}

/** 404: the address is not in the registry. The modal falls through to manual entry. */
function notFound(): Response {
  return errorResponse(
    404,
    'not_found',
    'We konden dit adres niet vinden. Vul het hieronder zelf in.',
    'We could not find this address. Enter it manually below.',
  );
}

/** 503: the provider did not answer. Identical consequence for the user, different cause for us. */
function providerUnavailable(): Response {
  return errorResponse(
    503,
    'provider_unavailable',
    'De adrescontrole is even niet bereikbaar. Vul het adres hieronder zelf in.',
    'The address lookup is unavailable right now. Enter the address manually below.',
  );
}

export const geoRoutes = new Hono<AppEnv>();

geoRoutes.post('/nl-be', requireAnonSession, async (c) => {
  const body: unknown = await c.req.json<unknown>().catch(() => null);
  const parsed = GeoRequestSchema.safeParse(body);
  if (!parsed.success) {
    return validationErrorFromIssues(parsed.error.issues);
  }

  const postcode = normalizePostcode(parsed.data.postalCode);
  const houseNumber = normalizeHouseNumber(parsed.data.houseNumber);
  const key = await cacheKey(parsed.data.country, postcode, houseNumber);

  const cached = await c.env.GEO.get<CachedLookup>(key, 'json');
  if (cached !== null) {
    return cached.ok ? jsonResponse(cached.result, 200) : notFound();
  }

  const result = await lookupUpstream(c.env, parsed.data.country, postcode, houseNumber);

  // A provider outage is never cached: caching it would extend a five-minute incident into a
  // day of manual address entry for everyone who happened to look up the same postcode.
  if (result === undefined) {
    return providerUnavailable();
  }

  const entry: CachedLookup = result === null ? { ok: false } : { ok: true, result };
  c.executionCtx.waitUntil(
    c.env.GEO.put(key, JSON.stringify(entry), {
      expirationTtl: result === null ? NEGATIVE_CACHE_TTL_SECONDS : CACHE_TTL_SECONDS,
    }),
  );

  return result === null ? notFound() : jsonResponse(result, 200);
});
