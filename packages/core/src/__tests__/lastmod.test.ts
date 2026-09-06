import { describe, expect, it } from 'vitest';

import {
  SHA256_BYTES,
  decideLastmod,
  digestToBytes,
  digestToHex,
  formatLastmod,
  isHexDigest,
  newestChangedAt,
} from '../lastmod';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = `${'a'.repeat(63)}b`;
const PUBLISHED_AT = 1_700_000_000_000;
const NOW = 1_757_000_000_000;

describe('decideLastmod', () => {
  it('does NOT move when the semantic projection is unchanged', () => {
    // The whole point of §7.8. A republish, a template change, a redeploy and an identical
    // regeneration all land here, and every one of them must leave lastmod alone.
    const decision = decideLastmod({
      previous: { renderSha256: DIGEST_A, contentChangedAt: PUBLISHED_AT },
      renderSha256: DIGEST_A,
      now: NOW,
    });
    expect(decision).toEqual({ contentChangedAt: PUBLISHED_AT, changed: false });
  });

  it('moves when the projection differs', () => {
    expect(
      decideLastmod({
        previous: { renderSha256: DIGEST_A, contentChangedAt: PUBLISHED_AT },
        renderSha256: DIGEST_B,
        now: NOW,
      }),
    ).toEqual({ contentChangedAt: NOW, changed: true });
  });

  it('moves on a first publish', () => {
    expect(decideLastmod({ previous: null, renderSha256: DIGEST_A, now: NOW })).toEqual({
      contentChangedAt: NOW,
      changed: true,
    });
  });

  it('moves when the previous version recorded no digest', () => {
    // Erring towards a false "changed" costs one unnecessary crawl; erring the other way suppresses
    // a real update, which is the expensive mistake.
    expect(
      decideLastmod({
        previous: { renderSha256: null, contentChangedAt: PUBLISHED_AT },
        renderSha256: DIGEST_A,
        now: NOW,
      }),
    ).toEqual({ contentChangedAt: NOW, changed: true });
  });

  it('is stable across repeated republishes of identical content', () => {
    let state = { renderSha256: DIGEST_A, contentChangedAt: PUBLISHED_AT };
    for (let publish = 0; publish < 10; publish += 1) {
      const decision = decideLastmod({
        previous: state,
        renderSha256: DIGEST_A,
        now: NOW + publish * 86_400_000,
      });
      expect(decision.contentChangedAt).toBe(PUBLISHED_AT);
      state = { renderSha256: DIGEST_A, contentChangedAt: decision.contentChangedAt };
    }
  });
});

describe('digest conversion', () => {
  it('round-trips hex through the 32 bytes D1 stores', () => {
    const bytes = digestToBytes(DIGEST_B);
    expect(bytes.byteLength).toBe(SHA256_BYTES);
    expect(digestToHex(bytes)).toBe(DIGEST_B);
  });

  it('refuses anything that is not a lowercase hex digest', () => {
    for (const value of ['', 'zz', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      expect(isHexDigest(value)).toBe(false);
      expect(() => digestToBytes(value)).toThrow(RangeError);
    }
  });

  it('reads an empty column as null rather than as a digest', () => {
    expect(digestToHex(null)).toBeNull();
    expect(digestToHex(new Uint8Array(16))).toBeNull();
  });
});

describe('formatLastmod', () => {
  it('emits W3C Datetime truncated to whole seconds', () => {
    expect(formatLastmod(1_757_000_000_123)).toBe('2025-09-04T15:33:20Z');
  });

  it('is a pure function of the timestamp, with no Intl anywhere', () => {
    // Intl output depends on the ICU data bundled with the runtime, so a workerd upgrade would
    // silently change every tenant's sitemap (PHASE2-SITE-KIT §9.3 rule 3).
    expect(formatLastmod(0)).toBe('1970-01-01T00:00:00Z');
  });

  it('throws rather than writing "Invalid Date" into an XML document', () => {
    expect(() => formatLastmod(Number.NaN)).toThrow(RangeError);
  });
});

describe('newestChangedAt', () => {
  it('picks the newest entry for a sitemap index lastmod', () => {
    expect(
      newestChangedAt([{ contentChangedAt: 1 }, { contentChangedAt: 9 }, { contentChangedAt: 5 }]),
    ).toBe(9);
  });

  it('returns null for an empty sitemap so the element is omitted', () => {
    expect(newestChangedAt([])).toBeNull();
  });
});
