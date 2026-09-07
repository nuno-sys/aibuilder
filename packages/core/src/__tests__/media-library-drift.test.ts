import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { INDUSTRY_GROUPS } from '../industries';
import { LUMINANCE_BOUNDARY } from '../luminance';
import { LIBRARY_PREFIX, assetContentType, assetPath, parseAssetPath } from '../routing';
import { MEDIA_LIBRARY } from '../media-library';
import type { MediaGroupKey } from '../media-library';

/**
 * The ingest script is a standalone `.mjs` — it runs under plain node with no build step, because
 * it drives ffmpeg and has to work on a maintainer's laptop. That puts two constants outside the
 * type system: the group list it organises footage by, and the luminance boundary it measures with.
 *
 * Both are copies. Copies drift, and both failure modes are quiet: a group the ingest does not know
 * about is simply never filled, and a boundary that disagrees classifies footage one way at ingest
 * and the opposite way at render — which is unreadable copy, arrived at by two files that each look
 * correct on their own.
 */
const INGEST = readFileSync(
  fileURLToPath(new URL('../../../../scripts/media-library/ingest.mjs', import.meta.url)),
  'utf8',
);

const UPLOAD = readFileSync(
  fileURLToPath(new URL('../../../../scripts/media-library/upload.mjs', import.meta.url)),
  'utf8',
);

describe('the ingest script agrees with the code that consumes it', () => {
  it('organises footage by exactly the groups the taxonomy defines', () => {
    const block = /const GROUPS = \[([\s\S]*?)\];/u.exec(INGEST);
    expect(block, 'GROUPS not found in ingest.mjs').not.toBeNull();
    const declared = [...(block?.[1] ?? '').matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]);
    expect(declared.sort()).toEqual(INDUSTRY_GROUPS.map((g) => g.key).sort());
  });

  it('measures luminance against the same boundary the renderer classifies with', () => {
    const match = /const LUMINANCE_BOUNDARY = ([0-9.]+);/u.exec(INGEST);
    expect(match, 'LUMINANCE_BOUNDARY not found in ingest.mjs').not.toBeNull();
    expect(Number(match?.[1])).toBe(LUMINANCE_BOUNDARY);
  });

  it('uploads to the prefix the renderer reads from', () => {
    // The upload script writes `library/<key>` and `assetR2Key` reads `library/<key>`. They are two
    // programs in two languages; a mismatch is a 404 on every hero video and nothing else.
    const match = /const LIBRARY_PREFIX = '([^']+)';/u.exec(UPLOAD);
    expect(match, 'LIBRARY_PREFIX not found in upload.mjs').not.toBeNull();
    expect(match?.[1]).toBe(LIBRARY_PREFIX);
  });
});

describe('the shipped catalogue', () => {
  it('names only groups that exist', () => {
    const known = new Set<string>(INDUSTRY_GROUPS.map((g) => g.key));
    for (const video of MEDIA_LIBRARY.videos) expect(known.has(video.group)).toBe(true);
    for (const image of MEDIA_LIBRARY.images) expect(known.has(image.group)).toBe(true);
  });

  it('gives every clip both encodes, because a phone must never get the landscape file', () => {
    for (const video of MEDIA_LIBRARY.videos) {
      expect(video.landscape.width).toBeGreaterThan(video.landscape.height);
      expect(video.portrait.height).toBeGreaterThan(video.portrait.width);
      // The reason the portrait encode exists at all.
      expect(video.portrait.maxBytes).toBeLessThan(video.landscape.maxBytes);
    }
  });

  it('offers only widths that were actually encoded', () => {
    for (const video of MEDIA_LIBRARY.videos) {
      for (const ladder of [video.poster, video.posterPortrait]) {
        expect(ladder.widths.length).toBeGreaterThan(0);
        expect([...ladder.widths].sort((a, b) => a - b)).toEqual([...ladder.widths]);
        expect(ladder.widths).toContain(ladder.width);
        expect(ladder.avifKeyTemplate).toContain('{width}');
        expect(ladder.webpKeyTemplate).toContain('{width}');
      }
    }
  });

  it('keeps the phone poster at least as large as the box it is displayed in', () => {
    // THE LCP ARGUMENT, stated where it can fail the build.
    //
    // An image is scored at `min(visible area, intrinsic area)`, so a poster rung keeps the LCP
    // entry only while its intrinsic area is at least the area it is displayed at. A rung of width
    // `w` is selected when `viewport width x DPR` is about `w`; at DPR 1 that is a viewport `w` CSS
    // px wide and as tall as the device — up to 19.5/9 of its width on the tallest phones
    // shipping. So every rung has to be at least that box, which is exactly the claim that the
    // ladder is cut at 9:19.5 rather than 9:16. At 9:16 the rung is smaller than the box, the
    // video is clamped to the same box, and the video takes the LCP entry.
    const TALLEST_PHONE = 19.5 / 9;
    for (const video of MEDIA_LIBRARY.videos) {
      const ladder = video.posterPortrait;
      const rungHeight = (width: number): number =>
        Math.round((width * ladder.height) / ladder.width);
      for (const width of ladder.widths) {
        expect(width * rungHeight(width), `${video.id} @${String(width)}w`).toBeGreaterThanOrEqual(
          Math.round(width * width * TALLEST_PHONE) - width,
        );
      }
      // And the poster and the clip are the same shape, so nothing reframes when the video fades
      // in. Compared as a ratio, because the two are cut at different widths.
      expect(ladder.height / ladder.width, video.id).toBeCloseTo(
        video.portrait.height / video.portrait.width,
        1,
      );
    }
  });

  it('keeps every poster ladder dominating the clip it sits in front of', () => {
    // §7.17 as originally written: the top rung's intrinsic area is at least the video's, so at the
    // viewport sizes where the hero is the largest thing on screen the poster is never the smaller
    // candidate. The two structural guards — `opacity:0` until a decoded frame, and mounting only
    // after LCP has been attributed — carry the cases in between.
    for (const video of MEDIA_LIBRARY.videos) {
      expect(video.poster.width * video.poster.height, video.id).toBeGreaterThanOrEqual(
        video.landscape.width * video.landscape.height,
      );
      expect(
        video.posterPortrait.width * video.posterPortrait.height,
        video.id,
      ).toBeGreaterThanOrEqual(video.portrait.width * video.portrait.height);
    }
  });

  it('names keys the asset router will actually serve', () => {
    // Every key in the catalogue has to survive `parseAssetPath` — a key the grammar rejects is a
    // 404 that no test of the selector would ever surface.
    for (const video of MEDIA_LIBRARY.videos) {
      const keys = [
        video.landscape.av1Key,
        video.landscape.h264Key,
        video.portrait.av1Key,
        video.portrait.h264Key,
        ...[video.poster, video.posterPortrait].flatMap((ladder) =>
          ladder.widths.flatMap((width) => [
            ladder.avifKeyTemplate.replace('{width}', String(width)),
            ladder.webpKeyTemplate.replace('{width}', String(width)),
          ]),
        ),
      ];
      for (const key of keys) {
        const parsed = parseAssetPath(assetPath({ kind: 'library', key }));
        expect(parsed, key).toEqual({ kind: 'library', key });
        expect(assetContentType({ kind: 'library', key }), key).not.toBe(
          'application/octet-stream',
        );
      }
    }
  });

  it('is internally consistent even while empty', () => {
    // An empty catalogue is a valid shipped state — the header falls back to a full-screen poster.
    expect(MEDIA_LIBRARY.version).toBe(1);
    expect(Array.isArray(MEDIA_LIBRARY.videos)).toBe(true);
    expect(new Set(MEDIA_LIBRARY.videos.map((v) => v.id)).size).toBe(MEDIA_LIBRARY.videos.length);
    expect(new Set(MEDIA_LIBRARY.images.map((i) => i.id)).size).toBe(MEDIA_LIBRARY.images.length);
  });
});

/** Compile-time proof that the two group unions cannot drift apart silently. */
const _groupsAreExhaustive: Record<MediaGroupKey, true> = {
  food_drink: true,
  beauty: true,
  health: true,
  sport: true,
  trades: true,
  automotive: true,
  retail: true,
  professional: true,
  events: true,
  education: true,
  real_estate: true,
  travel: true,
  pets: true,
  crafts: true,
};
void _groupsAreExhaustive;
