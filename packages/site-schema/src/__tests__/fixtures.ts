import type { LocaleBundleGen } from '../gen/locale-bundle';
import type { SectionGen, SectionOf } from '../gen/section';
import type { PageGen, PageRole, SiteStructureGen } from '../gen/site-structure';
import type { NormalizeContext } from '../normalize';
import { deriveSlotInventory } from '../slots';

/**
 * Fixtures shared by the contract's unit tests.
 *
 * Kept deliberately small: every test asserts on an exact slot id or an exact array
 * length, so a fixture that grows quietly would turn a regression into a passing test.
 */

/** Two media assets and one allowlisted external link, mirroring a real generation. */
export const testContext: NormalizeContext = {
  knownMediaRefIds: new Set(['m1', 'm2']),
  knownExternalRefIds: new Set(['x1']),
  primaryLocale: 'nl',
  allowedLocales: ['nl', 'de'],
};

/** A hero with one media ref, one tel CTA and a trustline. */
export function heroSection(id: string): SectionOf<'hero'> {
  return {
    id,
    type: 'hero',
    variant: 'image_split',
    media: { refId: 'm1', focalPoint: 'center' },
    ctas: [{ target: { kind: 'tel', _: null }, style: 'primary' }],
    showTrustline: true,
  };
}

/** A USP row with `itemCount` items -- the array length IS the count. */
export function uspSection(id: string, itemCount = 3): SectionOf<'usp_trio'> {
  return {
    id,
    type: 'usp_trio',
    variant: 'icons_row',
    items: Array.from({ length: itemCount }, () => ({ iconId: 'star' as const })),
  };
}

export function makePage(pageId: string, role: PageRole, sections: readonly SectionGen[]): PageGen {
  return { pageId, role, noindex: false, showInNav: true, ogMedia: null, sections: [...sections] };
}

export function makeStructure(pages: readonly PageGen[]): SiteStructureGen {
  return {
    schemaVersion: '1',
    theme: {
      dnaId: 'clinical_trust',
      paletteVariant: 'default',
      accentHueShift: '0',
      typeScaleId: 'regular',
      radiusId: 'soft',
      densityId: 'regular',
      motionId: 'subtle',
      colorMode: 'light',
      rationale: 'Rustig en betrouwbaar.',
    },
    primaryLocale: 'nl',
    pages: [...pages],
    jsonLd: {
      schemaOrgType: 'LocalBusiness',
      priceRange: null,
      servesCuisine: null,
      acceptsReservations: null,
      paymentAccepted: [],
      amenities: [],
    },
    navStyle: 'logo_left_links_right',
    footerStyle: 'compact_2col',
    whatsappEnabled: false,
    stockQueryHint: 'kapsalon amsterdam',
    inputSafety: { containsInstructions: false, note: '' },
  };
}

/** A bundle that fills every derived slot with short, in-budget Dutch copy. */
export function fullBundle(
  structure: SiteStructureGen,
  locale: LocaleBundleGen['locale'] = 'nl',
): LocaleBundleGen {
  return {
    schemaVersion: '1',
    locale,
    entries: deriveSlotInventory(structure).slots.map((slot) => ({ id: slot.id, text: 'Tekst' })),
  };
}
