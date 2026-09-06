import { cp } from '@aibuilder/db';
import { describe, expect, it } from 'vitest';

import app from '../index';
import { DRAFT_COOKIE_NAME, mintDraftCookie } from '../middleware/draft-cookie';
import { TEST_APP_ORIGIN, anonSessionRow, draftRow, fakeD1, testEnv } from './doubles';
import type { Env } from '../env';

/**
 * `POST /v1/onboarding/submit`, at the one boundary a test can assert without spending money: the
 * 422.
 *
 * The shape matters more than the status. The modal renders one Dutch message per field and anchors
 * its error summary at the field that failed, so `fields` is keyed by DOTTED PATH and carries issue
 * CODES — never messages, which could echo what the user typed back into a response body.
 *
 * Everything before validation is exercised on the way here: the security headers, the CORS and
 * Origin guards, the JSON content-type guard, the rate-limit binding, the signed cookie and the
 * draft lookup. Nothing after it is: validation fails before Turnstile is called, before a quota is
 * consumed and long before a Durable Object is asked to reserve a budget — which is the order
 * architecture §8 requires and which this test would notice being changed, because `testEnv()`
 * throws on any binding a case did not stub.
 */

/** The 422 body from architecture §S4. */
interface ValidationBody {
  readonly error: string;
  readonly message: string;
  readonly messageEn: string;
  readonly fields: Record<string, readonly string[]>;
}

/** An env whose control plane answers the session and draft reads, and nothing else. */
async function envWithSession(): Promise<{ env: Env; cookie: string }> {
  const base = testEnv();
  const minted = await mintDraftCookie(base);
  const env = testEnv({
    CP: fakeD1({
      [cp.drafts.SQL_GET_ANON_SESSION]: () => anonSessionRow(),
      [cp.drafts.SQL_GET_LATEST_DRAFT_FOR_SESSION]: () => draftRow(),
    }),
  });
  return { env, cookie: `${DRAFT_COOKIE_NAME}=${minted.value}` };
}

/** Posts a body to the submit route with everything the guards require. */
async function submit(body: unknown): Promise<Response> {
  const { env, cookie } = await envWithSession();
  return app.request(
    '/v1/onboarding/submit',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: TEST_APP_ORIGIN,
        Cookie: cookie,
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

/** A complete, valid intake, so that a single removed field is the only thing under test. */
function validIntake(): Record<string, unknown> {
  return {
    turnstileToken: 'test-token',
    businessName: 'Kapsalon Anna',
    slug: 'kapsalon-anna',
    industryKey: 'hairdresser',
    defaultLocale: 'nl',
    extraLocales: [],
    serviceArea: null,
    address: {
      line1: 'Hoofdstraat 1',
      line2: null,
      postalCode: '1011 AB',
      city: 'Amsterdam',
      country: 'NL',
      latitude: null,
      longitude: null,
      geoSource: 'none',
    },
    openingHours: null,
    phoneE164: '+31612345678',
    whatsappE164: null,
    gbpUrl: null,
    shortDescription: 'Kleine kapsalon in de Jordaan.',
    contactEmail: 'anna@example.test',
    marketingOptIn: false,
    mediaIds: [],
  };
}

describe('submit validation', () => {
  it('answers 422 with a field-keyed error map', async () => {
    const response = await submit({});

    expect(response.status).toBe(422);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('private, no-store');

    const body = (await response.json()) as ValidationBody;
    expect(body.error).toBe('validation_failed');
    expect(body.message.length).toBeGreaterThan(0);
    expect(body.messageEn.length).toBeGreaterThan(0);

    // Every missing required field is named, and the Turnstile token is one of them: it travels
    // alongside the intake and is validated in the same pass.
    for (const field of ['turnstileToken', 'businessName', 'slug', 'phoneE164', 'contactEmail']) {
      expect(Object.keys(body.fields)).toContain(field);
      expect(body.fields[field]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('keys nested failures by dotted path', async () => {
    const intake = validIntake();
    intake['address'] = { ...(intake['address'] as Record<string, unknown>), country: 'nederland' };

    const body = (await submit(intake).then((response) => response.json())) as ValidationBody;

    expect(Object.keys(body.fields)).toContain('address.country');
  });

  it('reports the cross-field rule under the form key, not under a field', async () => {
    const intake = validIntake();
    intake['address'] = null;
    intake['serviceArea'] = null;

    const response = await submit(intake);
    expect(response.status).toBe(422);

    const body = (await response.json()) as ValidationBody;
    // `LocalBusiness` needs one of the two, and the JSON-LD emitter branches on which; the rule is
    // a refine rather than two optional fields, so it has no field to attach to.
    expect(body.fields['_']).toContain('address_or_service_area_required');
  });

  it('never echoes the submitted value back', async () => {
    const intake = validIntake();
    intake['contactEmail'] = 'not-an-address-<script>';

    const raw = await submit(intake).then((response) => response.text());

    expect(raw).not.toContain('<script>');
    expect(raw).not.toContain('not-an-address');
  });

  it('refuses the request outright when the draft cookie is missing', async () => {
    const { env } = await envWithSession();
    const response = await app.request(
      '/v1/onboarding/submit',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: TEST_APP_ORIGIN },
        body: JSON.stringify(validIntake()),
      },
      env,
    );

    expect(response.status).toBe(401);
  });
});
