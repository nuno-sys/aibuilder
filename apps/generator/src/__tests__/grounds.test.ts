import type { SiteStructureGen } from '@aibuilder/site-schema';
import { describe, expect, it } from 'vitest';

import { assignSectionBackgrounds, keepIfLuminanceMatches } from '../steps/assemble';
import type { MediaManifest } from '../steps/media';

/**
 * Which bands get a photograph, and which photographs are allowed to be there.
 *
 * The rule that matters is not "is a background assigned" but "is it assigned only where the copy
 * over it stays readable". Luminance is measured at ingest and is a HARD constraint: a dark ground
 * under a light theme's ink is not a duller page, it is a page whose text cannot be read. The two
 * choices are also made in different steps — the footer's before a theme exists, the sections'
 * after — so this suite pins the order they resolve in as much as the picks themselves.
 */

function asset(refId: string, luminance: 'light' | 'dark', landscape = true) {
  return {
    refId,
    width: landscape ? 1600 : 900,
    height: landscape ? 900 : 1600,
    luminance,
  };
}

function manifest(
  assets: readonly ReturnType<typeof asset>[],
  footerMediaRefId: string | null = null,
): MediaManifest {
  return {
    candidates: [],
    assets: Object.fromEntries(assets.map((a) => [a.refId, a])),
    heroVideo: null,
    footerMediaRefId,
    sectionBackgrounds: {},
  } as unknown as MediaManifest;
}

function structure(pages: readonly { id: string; types: readonly string[] }[]): SiteStructureGen {
  return {
    pages: pages.map((page, index) => ({
      pageId: `p${String(index)}`,
      sections: page.types.map((type, i) => ({ id: `${page.id}-${String(i)}`, type })),
    })),
  } as unknown as SiteStructureGen;
}

describe('section grounds', () => {
  it('dresses at most one band per page, on the first that wants one', () => {
    // The hero already carries full-bleed motion. A page whose every band is a photograph reads as
    // a slideshow rather than as a business.
    const grounds = assignSectionBackgrounds(
      structure([{ id: 'a', types: ['hero', 'services_grid', 'cta_band', 'contact_form'] }]),
      manifest([asset('one', 'light'), asset('two', 'light'), asset('three', 'light')]),
      'light',
    );
    expect(Object.keys(grounds)).toEqual(['a-1']);
  });

  it('never uses the same photograph twice', () => {
    const grounds = assignSectionBackgrounds(
      structure([
        { id: 'a', types: ['services_grid'] },
        { id: 'b', types: ['contact_form'] },
      ]),
      manifest([asset('one', 'light'), asset('two', 'light')]),
      'light',
    );
    expect(new Set(Object.values(grounds)).size).toBe(2);
  });

  it('leaves the footer photograph out of the bands', () => {
    // The two picks are made in different steps and cannot negotiate; the later one avoids the
    // earlier. The same photograph in a services band and again in the footer reads as a site that
    // ran out of pictures.
    const grounds = assignSectionBackgrounds(
      structure([{ id: 'a', types: ['services_grid'] }]),
      manifest([asset('one', 'light'), asset('two', 'light')], 'one'),
      'light',
    );
    expect(Object.values(grounds)).toEqual(['two']);
  });

  it('refuses a ground whose luminance fights the mode the copy is set in', () => {
    expect(
      assignSectionBackgrounds(
        structure([{ id: 'a', types: ['services_grid'] }]),
        manifest([asset('dark-one', 'dark')]),
        'light',
      ),
    ).toEqual({});
  });

  it('refuses a portrait asset for a full-bleed band', () => {
    expect(
      assignSectionBackgrounds(
        structure([{ id: 'a', types: ['services_grid'] }]),
        manifest([asset('tall', 'light', false)]),
        'light',
      ),
    ).toEqual({});
  });

  it('dresses nothing when no band wants a ground', () => {
    expect(
      assignSectionBackgrounds(
        structure([{ id: 'a', types: ['hero', 'about', 'gallery'] }]),
        manifest([asset('one', 'light')]),
        'light',
      ),
    ).toEqual({});
  });
});

describe('the footer ground, re-checked against the resolved theme', () => {
  const assets = manifest([asset('light-one', 'light'), asset('dark-one', 'dark')]);

  it('keeps a ground that matches the mode the model actually chose', () => {
    expect(keepIfLuminanceMatches(assets, 'light-one', 'light')).toBe('light-one');
  });

  it('drops one that does not', () => {
    // The media step picked this before a theme existed, from the industry's design DNA. If the
    // model then chose the other mode, an unmatched ground is not a duller footer — it is a footer
    // whose legal identity block cannot be read.
    expect(keepIfLuminanceMatches(assets, 'dark-one', 'light')).toBeNull();
  });

  it('drops one whose asset is not in the manifest at all', () => {
    expect(keepIfLuminanceMatches(assets, 'ghost', 'light')).toBeNull();
  });

  it('passes through the absence of a ground', () => {
    expect(keepIfLuminanceMatches(assets, null, 'dark')).toBeNull();
  });
});
