import { cp } from '@aibuilder/db';
import { describe, expect, it } from 'vitest';

import app from '../index';
import { fakeD1, testEnv } from './doubles';

/**
 * `GET /v1/slug-check`, one case per reason the answer can be "no".
 *
 * The two that never touch D1 are the point of the design: a reserved label and a brand lookalike
 * are decided in `@aibuilder/core` from tables that ship with the code, so they cost nothing and
 * cannot be affected by a database outage. `testEnv()` throws on any unstubbed binding, which is
 * what turns "no database call happens here" from a comment into an assertion.
 */

/** The answer shape from architecture §S4. */
interface SlugCheckBody {
  readonly available: boolean;
  readonly normalized: string;
  readonly suggestion?: string;
  readonly reason?: string;
}

/** Reads the JSON body as the documented shape. */
async function bodyOf(response: Response): Promise<SlugCheckBody> {
  return (await response.json()) as SlugCheckBody;
}

describe('slug-check', () => {
  it('refuses a reserved label without asking the database', async () => {
    const response = await app.request('/v1/slug-check?slug=www', undefined, testEnv());

    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body.available).toBe(false);
    expect(body.reason).toBe('reserved');
    // No suggestion: `www-2` is not a fix for `www`, and the modal asks for another name instead.
    expect(body.suggestion).toBeUndefined();
  });

  it('refuses a trademark lookalike written with digits', async () => {
    const response = await app.request('/v1/slug-check?slug=g00gle', undefined, testEnv());

    const body = await bodyOf(response);
    expect(body.available).toBe(false);
    expect(body.reason).toBe('homoglyph');
  });

  it('refuses a name that transliterates to nothing usable', async () => {
    const env = testEnv({
      CP: fakeD1({
        [cp.slugs.SQL_FILTER_TAKEN_SLUGS]: () => [],
      }),
    });

    // Greek does not survive transliteration, which is exactly the case a generic NFD strip gets
    // wrong: it yields the empty string and fails the `slug` CHECK inside the submit batch.
    const response = await app.request(
      `/v1/slug-check?slug=${encodeURIComponent('Καφενείο')}&businessName=${encodeURIComponent('Καφενείο')}&industryKey=hairdresser&city=Amsterdam&locale=nl`,
      undefined,
      env,
    );

    const body = await bodyOf(response);
    expect(body.available).toBe(false);
    expect(body.reason).toBe('invalid');
    // The fallback seed is `{industry}-{city}` in the site's own locale.
    expect(body.suggestion).toBeDefined();
    expect(body.suggestion).toContain('amsterdam');
  });

  it('reports a slug another tenant holds, and suggests a free one', async () => {
    const taken = new Set(['kapsalon-anna']);
    const env = testEnv({
      CP: fakeD1({
        [cp.slugs.SQL_GET_RESERVED_SLUG]: () => null,
        [cp.slugs.SQL_IS_SLUG_TAKEN]: (params) =>
          taken.has(String(params[0])) ? { id: 'ste_01J0000000000000000000000C' } : null,
        [cp.slugs.SQL_FILTER_TAKEN_SLUGS]: (params) => {
          const candidates: unknown = JSON.parse(String(params[0]));
          return (Array.isArray(candidates) ? candidates : [])
            .filter((slug): slug is string => typeof slug === 'string' && taken.has(slug))
            .map((slug) => ({ slug }));
        },
      }),
    });

    const response = await app.request('/v1/slug-check?slug=kapsalon-anna', undefined, env);

    const body = await bodyOf(response);
    expect(body.available).toBe(false);
    expect(body.reason).toBe('taken');
    expect(body.suggestion).toBeDefined();
    expect(body.suggestion).not.toBe('kapsalon-anna');
  });

  it('accepts a free, policy-clean slug', async () => {
    const env = testEnv({
      CP: fakeD1({
        [cp.slugs.SQL_GET_RESERVED_SLUG]: () => null,
        [cp.slugs.SQL_IS_SLUG_TAKEN]: () => null,
      }),
    });

    const response = await app.request('/v1/slug-check?slug=kapsalon-anna', undefined, env);

    const body = await bodyOf(response);
    expect(body).toEqual({ available: true, normalized: 'kapsalon-anna' });
  });

  it('normalises before judging, so the answer describes what would be stored', async () => {
    const env = testEnv({
      CP: fakeD1({
        [cp.slugs.SQL_GET_RESERVED_SLUG]: () => null,
        [cp.slugs.SQL_IS_SLUG_TAKEN]: () => null,
      }),
    });

    const response = await app.request(
      `/v1/slug-check?slug=${encodeURIComponent('Bäckerei Müller')}&locale=de`,
      undefined,
      env,
    );

    // German umlauts expand rather than dropping their diacritic: `ue`, not `u`.
    expect((await bodyOf(response)).normalized).toBe('baeckerei-mueller');
  });

  it('carries the security headers on every answer', async () => {
    const response = await app.request('/v1/slug-check?slug=www', undefined, testEnv());

    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('strict-transport-security')).toContain('includeSubDomains');
  });
});
