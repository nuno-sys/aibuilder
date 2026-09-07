import { ASSET_PREFIX, parseAssetPath } from '@aibuilder/core';
import type { HeroVideo, PageDoc } from '@aibuilder/site-schema';
import type { ResolvedImage } from '@aibuilder/site-kit';
import { describe, expect, it } from 'vitest';

import { heroFor } from '../steps/render';

/**
 * The hero's motion layer, from the document to the markup.
 *
 * WHY THIS SUITE EXISTS. Every piece of the video path was built and none of it reached a page:
 * the library was ingested, the catalogue was bundled, the selector ran, `SiteDoc.heroVideo` was
 * populated and `site-kit` had the `<video>` markup ready — and the composition root returned
 * `video: null` behind a comment saying videos were out of scope. Nothing failed. No test broke.
 * The site simply had a still header, and the only way to notice was to look at one.
 *
 * That is the class of defect this file is for: not "does the mapping compute the right string",
 * but "does the document's video reach the renderer at all". Hence the first assertion, which is
 * about presence rather than value.
 */

const POSTER: ResolvedImage = {
  src: '/_a/i/'.concat('a'.repeat(64), '/1600.jpg'),
  sources: [],
  width: 2560,
  height: 1440,
  alt: '',
  focal: '50% 50%',
  dominantColor: '#101010',
};

const HERO_VIDEO: HeroVideo = {
  landscape: {
    av1R2Key: 'video/food_drink/dark-1-landscape.av1.webm',
    h264R2Key: 'video/food_drink/dark-1-landscape.h264.mp4',
    width: 1920,
    height: 1080,
    maxBytes: 380_000,
  },
  portrait: {
    av1R2Key: 'video/food_drink/dark-1-portrait.av1.webm',
    h264R2Key: 'video/food_drink/dark-1-portrait.h264.mp4',
    width: 720,
    height: 1280,
    maxBytes: 110_000,
  },
  durationSeconds: 8,
  luminance: 'dark',
  credit: null,
  portraitPoster: {
    avifKeyTemplate: 'poster/food_drink/dark-1-p-{width}.avif',
    webpKeyTemplate: 'poster/food_drink/dark-1-p-{width}.webp',
    widths: [540, 720, 1080, 1440],
    width: 1440,
    height: 2560,
  },
};

/** The minimum page shape `heroFor` reads: one hero section carrying one media ref. */
function pageWithHero(refId: string | null): PageDoc {
  return {
    sections: [
      refId === null
        ? { type: 'about', id: 's1' }
        : { type: 'hero', id: 's1', media: { refId, focalPoint: 'center' } },
    ],
  } as unknown as PageDoc;
}

describe('the hero video reaches the renderer', () => {
  it('hands site-kit a video whenever the document has one', () => {
    const hero = heroFor(pageWithHero('m1'), { m1: POSTER }, HERO_VIDEO);
    expect(hero).not.toBeNull();
    expect(hero?.video).not.toBeNull();
    expect(hero?.portraitSources).toHaveLength(2);
  });

  it('sends the phone its own encode, never the landscape file', () => {
    const video = heroFor(pageWithHero('m1'), { m1: POSTER }, HERO_VIDEO)?.video;
    expect(video?.mobileAv1).not.toBe(video?.desktopAv1);
    expect(video?.mobileH264).not.toBe(video?.desktopH264);
    // The element's width/height only establish an aspect-ratio box, and it is the landscape shape
    // the CSS lays out at; the mobile file is swapped in by the mount script.
    expect(video?.width).toBe(1920);
    expect(video?.height).toBe(1080);
  });

  it('addresses every rendition through the asset router, same-origin', () => {
    const hero = heroFor(pageWithHero('m1'), { m1: POSTER }, HERO_VIDEO);
    const urls = [
      hero?.video?.desktopAv1,
      hero?.video?.desktopH264,
      hero?.video?.mobileAv1,
      hero?.video?.mobileH264,
      ...(hero?.portraitSources ?? []).flatMap((source) =>
        source.srcset.split(', ').map((candidate) => candidate.split(' ')[0]),
      ),
    ];
    expect(urls.length).toBeGreaterThan(4);
    for (const url of urls) {
      expect(url, 'a hero URL must be same-origin: img-src/media-src are both self').toMatch(
        new RegExp(`^${ASSET_PREFIX}`, 'u'),
      );
      // A URL the router will not parse is a 404 nobody sees until a customer opens their site.
      expect(parseAssetPath(url ?? ''), url).not.toBeNull();
    }
  });

  it('offers only widths the ingest actually encoded', () => {
    const hero = heroFor(pageWithHero('m1'), { m1: POSTER }, HERO_VIDEO);
    for (const source of hero?.portraitSources ?? []) {
      const widths = source.srcset
        .split(', ')
        .map((candidate) => Number(candidate.split(' ')[1]?.replace('w', '')));
      expect(widths).toEqual([...HERO_VIDEO.portraitPoster.widths]);
    }
  });

  it('falls back to a full-screen poster when the library cannot dress the site', () => {
    // A complete answer, not a failure: `selectHeroVideo` returns null rather than serving footage
    // whose luminance fights the theme, and the header is then a still. It must not be a hole.
    const hero = heroFor(pageWithHero('m1'), { m1: POSTER }, null);
    expect(hero?.poster).toEqual(POSTER);
    expect(hero?.video).toBeNull();
    expect(hero?.portraitSources).toEqual([]);
  });

  it('is null when the page has no hero section at all', () => {
    expect(heroFor(pageWithHero(null), { m1: POSTER }, HERO_VIDEO)).toBeNull();
  });

  it('is null when the hero names an asset the media manifest does not hold', () => {
    expect(heroFor(pageWithHero('missing'), { m1: POSTER }, HERO_VIDEO)).toBeNull();
  });
});
