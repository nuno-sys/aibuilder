import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

import { subtleCryptoProvider } from '../stripe';
import { verifyStripeRequest } from '../webhook/verify';
import { testEnv } from './doubles';

/**
 * Signature verification, against real signatures.
 *
 * NOTHING HERE IS STUBBED. The headers are produced by Stripe's own
 * `generateTestHeaderStringAsync`, and the verifier is the one the Worker ships — including the
 * SubtleCrypto provider, which is the whole reason this suite runs in workerd rather than in Node.
 * A test that stubbed the verifier would prove that a mock returns what it was told to.
 *
 * THE RAW-BODY RULE IS ASSERTED BY CONSTRUCTION. Each case builds the `Request` from the exact
 * string it signed; the tampered case changes one byte after signing. If the implementation ever
 * parsed the body before verifying, the "Body has already been used" failure would surface here
 * rather than in production.
 */

/** The secret both the fixture and the Worker use. */
const SECRET = 'whsec_test_secret_0123456789';

/** An env whose only relevant binding is the webhook secret. */
function env(): ReturnType<typeof testEnv> {
  return testEnv({ STRIPE_WEBHOOK_SECRET: SECRET });
}

/** Builds a signed request, optionally back-dating the signature. */
async function signedRequest(options: {
  readonly payload: string;
  readonly ageSeconds?: number;
  readonly bodyOverride?: string;
  readonly secret?: string;
}): Promise<Request> {
  const timestamp = Math.floor(Date.now() / 1000) - (options.ageSeconds ?? 0);
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
    payload: options.payload,
    secret: options.secret ?? SECRET,
    timestamp,
    cryptoProvider: subtleCryptoProvider,
  });
  return new Request('https://billing.aibuilder.app/v1/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
    body: options.bodyOverride ?? options.payload,
  });
}

/** A minimal but structurally real event payload. */
const PAYLOAD = JSON.stringify({
  id: 'evt_test0000000001',
  object: 'event',
  api_version: '2026-08-26.dahlia',
  created: Math.floor(Date.now() / 1000),
  livemode: false,
  type: 'checkout.session.completed',
  data: { object: { id: 'cs_test_0123456789abcdef', object: 'checkout.session' } },
});

describe('verifyStripeRequest', () => {
  it('accepts a correctly signed payload and returns the parsed event', async () => {
    const result = await verifyStripeRequest(await signedRequest({ payload: PAYLOAD }), env());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.id).toBe('evt_test0000000001');
      expect(result.event.type).toBe('checkout.session.completed');
      // The raw string is returned so the caller archives exactly the bytes the HMAC covered.
      expect(result.raw).toBe(PAYLOAD);
    }
  });

  it('rejects a tampered body with 400, not 500 (T-B12)', async () => {
    const tampered = PAYLOAD.replace('cs_test_0123456789abcdef', 'cs_test_attackerchosen01');
    const request = await signedRequest({ payload: PAYLOAD, bodyOverride: tampered });

    const result = await verifyStripeRequest(request, env());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 400 and never 5xx: a 5xx makes Stripe retry for three days and then disable the endpoint,
      // for a request that will never verify.
      expect(result.status).toBe(400);
      expect(result.reason).toBe('bad_signature');
    }
  });

  it('rejects a signature made with the wrong secret', async () => {
    const request = await signedRequest({ payload: PAYLOAD, secret: 'whsec_someone_elses_secret' });

    const result = await verifyStripeRequest(request, env());

    expect(result.ok).toBe(false);
  });

  it('accepts a four-minute-old signature and refuses a six-minute-old one (T-B12)', async () => {
    // `Webhook.DEFAULT_TOLERANCE` is 300 seconds, and passing `undefined` in the tolerance slot is
    // what keeps it. Supplying the crypto provider one argument early would silently pass it AS the
    // tolerance and disable this window entirely — which is exactly what these two cases catch.
    const fresh = await verifyStripeRequest(
      await signedRequest({ payload: PAYLOAD, ageSeconds: 240 }),
      env(),
    );
    expect(fresh.ok).toBe(true);

    const stale = await verifyStripeRequest(
      await signedRequest({ payload: PAYLOAD, ageSeconds: 360 }),
      env(),
    );
    expect(stale.ok).toBe(false);
  });

  it('rejects a request with no signature header at all', async () => {
    const request = new Request('https://billing.aibuilder.app/v1/stripe/webhook', {
      method: 'POST',
      body: PAYLOAD,
    });

    const result = await verifyStripeRequest(request, env());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_signature');
    }
  });
});
