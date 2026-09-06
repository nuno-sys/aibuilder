import { describe, expect, it } from 'vitest';

import {
  DRAFT_COOKIE_NAME,
  clearDraftCookieHeader,
  draftCookieHeader,
  mintDraftCookie,
  readCookie,
  verifyDraftCookie,
} from '../middleware/draft-cookie';
import { toHex } from '../lib/subjects';
import { TEST_HMAC_KEY, TEST_HMAC_KEY_ROTATED, testEnv } from './doubles';

/**
 * The cookie is the only thing standing between one visitor's draft — their business name, address,
 * phone number and e-mail — and the next visitor's request. These cases are the properties that
 * must hold for that to be true, expressed one per assertion.
 */
describe('draft cookie', () => {
  it('round-trips: what it mints, it verifies, and the hash matches the one stored', async () => {
    const env = testEnv();
    const minted = await mintDraftCookie(env);

    const verified = await verifyDraftCookie(env, minted.value);

    expect(verified).not.toBeNull();
    expect(verified === null ? '' : toHex(verified)).toBe(toHex(minted.tokenHash));
    expect(minted.tokenHash.byteLength).toBe(32);
  });

  it('mints a distinct token every time', async () => {
    const env = testEnv();
    const first = await mintDraftCookie(env);
    const second = await mintDraftCookie(env);

    expect(first.value).not.toBe(second.value);
    expect(toHex(first.tokenHash)).not.toBe(toHex(second.tokenHash));
  });

  it('rejects a tampered signature', async () => {
    const env = testEnv();
    const minted = await mintDraftCookie(env);
    const [kid, token, signature] = minted.value.split('.');

    // Flip one character of the signature. Everything else about the cookie is untouched, which is
    // exactly the forgery an attacker with a stolen-but-expired cookie would attempt.
    const flipped = `${signature?.startsWith('A') === true ? 'B' : 'A'}${signature?.slice(1) ?? ''}`;

    expect(await verifyDraftCookie(env, `${kid ?? ''}.${token ?? ''}.${flipped}`)).toBeNull();
  });

  it('rejects a tampered token under a valid signature', async () => {
    const env = testEnv();
    const minted = await mintDraftCookie(env);
    const [kid, token, signature] = minted.value.split('.');
    const flipped = `${token?.startsWith('A') === true ? 'B' : 'A'}${token?.slice(1) ?? ''}`;

    expect(await verifyDraftCookie(env, `${kid ?? ''}.${flipped}.${signature ?? ''}`)).toBeNull();
  });

  it('rejects a cookie signed under a key that is no longer configured', async () => {
    const retired = await mintDraftCookie(testEnv({ DRAFT_HMAC_KEY: TEST_HMAC_KEY_ROTATED }));

    // `k2` is gone from the configuration; a cookie carrying it must not be accepted under `k1`.
    expect(
      await verifyDraftCookie(testEnv({ DRAFT_HMAC_KEY: TEST_HMAC_KEY }), retired.value),
    ).toBeNull();
  });

  it('accepts both keys during a rotation, and signs with the newest', async () => {
    const before = testEnv({ DRAFT_HMAC_KEY: TEST_HMAC_KEY });
    const during = testEnv({ DRAFT_HMAC_KEY: `${TEST_HMAC_KEY_ROTATED},${TEST_HMAC_KEY}` });

    const oldCookie = await mintDraftCookie(before);
    const newCookie = await mintDraftCookie(during);

    // Dual accept: nobody is signed out by a rotation.
    expect(await verifyDraftCookie(during, oldCookie.value)).not.toBeNull();
    expect(await verifyDraftCookie(during, newCookie.value)).not.toBeNull();
    // The newest key signs, so the cookie carries its id.
    expect(newCookie.value.startsWith('k2.')).toBe(true);
  });

  it('rejects malformed values without throwing', async () => {
    const env = testEnv();
    for (const value of ['', 'nonsense', 'k1.token', 'k1.token.sig.extra', 'k1..', '..']) {
      expect(await verifyDraftCookie(env, value)).toBeNull();
    }
  });

  it('serialises the attributes the __Host- prefix requires', async () => {
    const minted = await mintDraftCookie(testEnv());
    const header = draftCookieHeader(minted.value);

    expect(header.startsWith(`${DRAFT_COOKIE_NAME}=`)).toBe(true);
    expect(header).toContain('Secure');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Path=/');
    expect(header).toContain('SameSite=Lax');
    // A `Domain` attribute makes a browser ignore a `__Host-` cookie outright.
    expect(header).not.toContain('Domain=');
    expect(clearDraftCookieHeader()).toContain('Max-Age=0');
  });

  it('reads its own cookie out of a header that carries others', () => {
    const header = `other=1; ${DRAFT_COOKIE_NAME}=abc.def.ghi; another=2`;

    expect(readCookie(header, DRAFT_COOKIE_NAME)).toBe('abc.def.ghi');
    expect(readCookie(header, 'missing')).toBeNull();
    expect(readCookie(undefined, DRAFT_COOKIE_NAME)).toBeNull();
  });
});
