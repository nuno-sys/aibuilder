import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { INDUSTRY_GROUPS } from '../industries';
import { LUMINANCE_BOUNDARY } from '../luminance';
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
      expect(video.poster.widths.length).toBeGreaterThan(0);
      expect([...video.poster.widths].sort((a, b) => a - b)).toEqual([...video.poster.widths]);
      expect(video.poster.widths).toContain(video.poster.width);
      expect(video.poster.avifKeyTemplate).toContain('{width}');
      expect(video.poster.webpKeyTemplate).toContain('{width}');
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
