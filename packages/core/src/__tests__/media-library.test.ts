import { describe, expect, it } from 'vitest';

import {
  coverageGaps,
  hueAffinity,
  hueDistance,
  selectGrounds,
  selectHeroVideo,
} from '../media-library';
import type { LibraryImage, LibraryVideo, MediaGroupKey, MediaLibrary } from '../media-library';

function video(
  id: string,
  group: MediaGroupKey,
  luminance: 'light' | 'dark',
  hue: number | null,
): LibraryVideo {
  const rendition = {
    av1Key: `${id}.webm`,
    h264Key: `${id}.mp4`,
    width: 1920,
    height: 1080,
    maxBytes: 1,
  };
  return {
    id,
    group,
    luminance,
    hue,
    landscape: rendition,
    portrait: { ...rendition, width: 720, height: 1280 },
    poster: {
      avifKeyTemplate: `${id}-{width}.avif`,
      webpKeyTemplate: `${id}-{width}.webp`,
      widths: [960, 1920],
      width: 1920,
      height: 1080,
    },
    durationSeconds: 8,
    description: id,
    credit: null,
  };
}

function ground(
  id: string,
  group: MediaGroupKey,
  luminance: 'light' | 'dark',
  hue: number | null,
): LibraryImage {
  return {
    id,
    group,
    luminance,
    hue,
    role: 'ground',
    orientation: 'landscape',
    rendition: {
      avifKeyTemplate: `${id}-{width}.avif`,
      webpKeyTemplate: `${id}-{width}.webp`,
      widths: [960, 1920],
      width: 1920,
      height: 1080,
    },
    description: id,
    credit: null,
  };
}

const library: MediaLibrary = {
  version: 1,
  builtAt: '2026-09-07T00:00:00Z',
  videos: [
    video('food-dark-a', 'food_drink', 'dark', 20),
    video('food-dark-b', 'food_drink', 'dark', 25),
    video('food-light-a', 'food_drink', 'light', 30),
    video('food-light-b', 'food_drink', 'light', 200),
    video('events-dark-a', 'events', 'dark', 280),
  ],
  images: [
    ground('food-ground-1', 'food_drink', 'light', 30),
    ground('food-ground-2', 'food_drink', 'light', 40),
    ground('food-ground-3', 'food_drink', 'light', 50),
    ground('other-ground', 'trades', 'light', 210),
  ],
};

describe('hue maths', () => {
  it('wraps around the wheel', () => {
    expect(hueDistance(10, 350)).toBe(20);
    expect(hueDistance(350, 10)).toBe(20);
    expect(hueDistance(0, 180)).toBe(180);
  });

  it('scores complementary footage LOW, because that is a deliberate choice and this is a default', () => {
    expect(hueAffinity(0, 0)).toBe(1);
    expect(hueAffinity(0, 180)).toBe(0);
    // Achromatic footage sits in the middle: it goes with anything, which is neither a reason to
    // prefer it nor to avoid it.
    expect(hueAffinity(null, 120)).toBe(0.5);
    expect(hueAffinity(120, null)).toBe(0.5);
  });
});

describe('selectHeroVideo', () => {
  it('never returns footage in the wrong luminance', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const dark = selectHeroVideo(library, {
        group: 'food_drink',
        colorMode: 'dark',
        accentHue: 20,
        seed,
      });
      expect(dark?.luminance).toBe('dark');
      const light = selectHeroVideo(library, {
        group: 'food_drink',
        colorMode: 'light',
        accentHue: 20,
        seed,
      });
      expect(light?.luminance).toBe('light');
    }
  });

  it('prefers footage near the accent hue', () => {
    // 30 degrees away vs 180 away: the near one must win outright.
    const chosen = selectHeroVideo(library, {
      group: 'food_drink',
      colorMode: 'light',
      accentHue: 30,
      seed: 'seed-1',
    });
    expect(chosen?.id).toBe('food-light-a');
  });

  it('is deterministic for one site and varies across sites', () => {
    const pick = (seed: string) =>
      selectHeroVideo(library, { group: 'food_drink', colorMode: 'dark', accentHue: 22, seed })?.id;
    expect(pick('site-1')).toBe(pick('site-1'));
    const spread = new Set(Array.from({ length: 40 }, (_unused, i) => pick(`site-${String(i)}`)));
    // Both close-scoring dark clips must actually get used; one clip for every bakery in the
    // country is the outcome this whole library exists to prevent.
    expect(spread.size).toBeGreaterThan(1);
  });

  it('widens beyond the trade rather than serving an unreadable header', () => {
    // `events` has no light footage at all. Legibility outranks relevance.
    const chosen = selectHeroVideo(library, {
      group: 'events',
      colorMode: 'light',
      accentHue: 280,
      seed: 's',
    });
    expect(chosen).not.toBeNull();
    expect(chosen?.luminance).toBe('light');
  });

  it('returns null rather than the wrong luminance when nothing matches at all', () => {
    const empty: MediaLibrary = { ...library, videos: [] };
    expect(
      selectHeroVideo(empty, { group: 'food_drink', colorMode: 'dark', accentHue: 0, seed: 's' }),
    ).toBeNull();
  });
});

describe('selectGrounds', () => {
  it('returns distinct stills, best fit first', () => {
    const grounds = selectGrounds(
      library,
      { group: 'food_drink', colorMode: 'light', accentHue: 30, seed: 's' },
      3,
    );
    expect(grounds).toHaveLength(3);
    expect(new Set(grounds.map((g) => g.id)).size).toBe(3);
    expect(grounds[0]?.id).toBe('food-ground-1');
  });

  it('asks for none and gets none', () => {
    expect(
      selectGrounds(
        library,
        { group: 'food_drink', colorMode: 'light', accentHue: 0, seed: 's' },
        0,
      ),
    ).toEqual([]);
  });

  it('never returns a ground in the wrong luminance', () => {
    const grounds = selectGrounds(
      library,
      { group: 'food_drink', colorMode: 'dark', accentHue: 30, seed: 's' },
      2,
    );
    for (const g of grounds) expect(g.luminance).toBe('dark');
  });
});

describe('coverageGaps', () => {
  it('names every group that cannot dress both a light and a dark site', () => {
    const gaps = coverageGaps(library, ['food_drink', 'events']);
    expect(gaps.find((g) => g.group === 'food_drink')).toBeUndefined();
    expect(gaps.find((g) => g.group === 'events' && g.luminance === 'light')?.have).toBe(0);
    expect(gaps.find((g) => g.group === 'events' && g.luminance === 'dark')?.have).toBe(1);
  });
});
