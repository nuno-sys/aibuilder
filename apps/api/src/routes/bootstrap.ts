import { DEFAULT_LOCALE, INDUSTRIES, INDUSTRY_GROUPS, LOCALES, isLocale } from '@aibuilder/core';
import type { Locale } from '@aibuilder/core';
import { Hono } from 'hono';

import type { AppEnv } from '../env';
import { clientCountry, sha256Hex } from '../lib/subjects';

/**
 * `GET /v1/bootstrap` — everything the onboarding modal needs before it can render step 1.
 *
 * THIS ROUTE NEVER RETURNS THE CALLER'S DRAFT, and that is the whole reason it is a separate route
 * (architecture §S4). The response is `public, max-age=3600`: a body containing a business name,
 * address, phone number and e-mail served under that header is one visitor's personal data handed
 * to the next from any shared cache. The draft lives behind `GET /v1/drafts/me`, which is
 * cookie-authenticated and `private, no-store`.
 *
 * Everything here is a build-time constant plus two request-scoped values (the UI locale and the
 * visitor's country), so the body is deterministic per `(locale, country)` and is cached per
 * isolate as well as at the edge. The industry taxonomy is the bulk of it — around 14 KB — and it
 * ships once so that the combobox in step 2 costs zero network per keystroke.
 */

/** One locale, as the language switcher and the URL builder need it. */
interface BootstrapLocale {
  readonly code: string;
  /** Endonym: the language's name in itself. */
  readonly label: string;
  readonly urlSegment: string;
}

/** One industry group, localised. */
interface BootstrapGroup {
  readonly key: string;
  readonly label: string;
  readonly icon: string;
}

/** One leaf industry, localised, with the alias terms the combobox scores against. */
interface BootstrapIndustry {
  readonly key: string;
  readonly groupKey: string;
  readonly label: string;
  readonly searchTerms: readonly string[];
  readonly icon: string;
}

/** The full response body. */
interface BootstrapBody {
  readonly locales: readonly BootstrapLocale[];
  readonly groups: readonly BootstrapGroup[];
  readonly industries: readonly BootstrapIndustry[];
  /** Public Turnstile widget key. Public by definition — it is rendered into the page. */
  readonly turnstileSiteKey: string;
  /** The visitor's country, when the edge resolved one. Used to preselect the phone prefix. */
  readonly country: string | null;
}

/** A rendered body and its validator. */
interface CachedBootstrap {
  readonly body: string;
  readonly etag: string;
}

/**
 * Per-isolate render cache, keyed by `locale|country`.
 *
 * Bounded because the key space includes the country: an isolate that serves the whole of Europe
 * would otherwise accumulate one 14 KB string per country. At the cap the cache is cleared rather
 * than evicted one entry at a time — the entries are cheap to rebuild and an LRU here would be more
 * machinery than the problem deserves.
 */
const renderCache = new Map<string, CachedBootstrap>();

/** Above this many entries the cache resets. */
const RENDER_CACHE_LIMIT = 64;

/** How long a shared cache may serve this body. */
const MAX_AGE_SECONDS = 3600;

/** Builds the body for one locale and country. */
function buildBody(
  locale: Locale,
  country: string | null,
  turnstileSiteKey: string,
): BootstrapBody {
  return {
    locales: LOCALES.map((definition) => ({
      code: definition.code,
      label: definition.label,
      urlSegment: definition.urlSegment,
    })),
    groups: INDUSTRY_GROUPS.map((group) => ({
      key: group.key,
      label: group.labels[locale],
      icon: group.icon,
    })),
    industries: INDUSTRIES.map((industry) => ({
      key: industry.key,
      groupKey: industry.groupKey,
      label: industry.labels[locale],
      searchTerms: industry.searchTerms,
      icon: industry.icon,
    })),
    turnstileSiteKey,
    country,
  };
}

/** Renders and caches the body for one `(locale, country)` pair. */
async function render(
  locale: Locale,
  country: string | null,
  turnstileSiteKey: string,
): Promise<CachedBootstrap> {
  const cacheKey = `${locale}|${country ?? '-'}`;
  const cached = renderCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const body = JSON.stringify(buildBody(locale, country, turnstileSiteKey));
  // A weak validator: the body is semantically stable for the pair, and byte-for-byte equality is
  // not something a JSON serialisation should be asked to promise across deploys.
  const etag = `W/"${(await sha256Hex(body)).slice(0, 16)}"`;
  const entry: CachedBootstrap = { body, etag };

  if (renderCache.size >= RENDER_CACHE_LIMIT) {
    renderCache.clear();
  }
  renderCache.set(cacheKey, entry);
  return entry;
}

export const bootstrapRoutes = new Hono<AppEnv>();

bootstrapRoutes.get('/', async (c) => {
  const requested = c.req.query('locale');
  const locale: Locale = isLocale(requested) ? requested : DEFAULT_LOCALE;

  const requestedCountry = c.req.query('country');
  const country =
    requestedCountry !== undefined && /^[A-Z]{2}$/.test(requestedCountry)
      ? requestedCountry
      : clientCountry(c.req.raw);

  const { body, etag } = await render(locale, country, c.env.TURNSTILE_SITE_KEY);

  // `Vary: Accept-Language` is what architecture §S4 asks for; the CORS middleware appends
  // `Origin`, which a cacheable public response needs so that one caller's allowed origin is never
  // replayed to another's.
  const headers: Record<string, string> = {
    'cache-control': `public, max-age=${String(MAX_AGE_SECONDS)}`,
    vary: 'Accept-Language',
    etag,
  };

  if (c.req.header('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers });
  }

  headers['content-type'] = 'application/json; charset=utf-8';
  return new Response(body, { status: 200, headers });
});
