import { parseSiteDocOrThrow, SCHEMA_VERSION } from '@aibuilder/site-schema';
import type { SiteDoc } from '@aibuilder/site-schema';
import { resolveTheme } from '@aibuilder/site-kit';

/**
 * A minimal, VALID `SiteDoc` for the editor's tests.
 *
 * `parseSiteDocOrThrow` is applied at the end on purpose. A fixture that has drifted from the schema
 * is a test suite that proves things about a document the product cannot store, and the failure mode
 * is subtle: patches apply, the document round-trips, and production rejects it. Throwing here makes
 * that a red test on the first run after a schema change rather than a support ticket.
 *
 * The theme's tokens come from `resolveTheme` rather than a hand-written map, for the same reason:
 * `ThemeDocSchema` accepts any string record, so a wrong one would pass validation and then fail
 * the first time something rendered it.
 */

/** The eight knobs the fixture starts from. */
export const FIXTURE_KNOBS = {
  dnaId: 'clinical_trust',
  paletteVariant: 'default',
  accentHueShift: '0',
  typeScaleId: 'regular',
  radiusId: 'soft',
  densityId: 'regular',
  motionId: 'subtle',
  colorMode: 'light',
} as const;

/** Builds a fresh document. A function, not a constant: tests must not share a mutable fixture. */
export function siteDocFixture(): SiteDoc {
  return parseSiteDocOrThrow({
    schemaVersion: SCHEMA_VERSION,
    siteId: 'ste_01J8Z9QWERTYUIOPASDFGHJKLZ',
    versionId: 'ver_01J8Z9QWERTYUIOPASDFGHJKLZ',
    theme: { ...FIXTURE_KNOBS, tokens: resolveTheme(FIXTURE_KNOBS) },
    locales: { default: 'nl', enabled: ['nl'] },
    chrome: {
      navStyle: 'logo_left_links_right',
      footerStyle: 'compact_2col',
      whatsappEnabled: false,
    },
    pages: [
      {
        pageId: 'p_home',
        pageKey: 'home',
        role: 'home',
        noindex: false,
        showInNav: true,
        sortOrder: 0,
        sections: [
          {
            id: 's_hero',
            type: 'hero',
            variant: 'type_centered',
            media: null,
            ctas: [],
            showTrustline: false,
          },
          {
            id: 's_gallery',
            type: 'gallery',
            variant: 'grid_square',
            media: [{ refId: 'm1', focalPoint: 'center' }],
            showCaptions: false,
          },
        ],
        perLocale: {
          nl: {
            path: '/nl/',
            slug: '',
            title: 'Kapsalon Anna',
            description: 'Knippen en kleuren in Utrecht.',
            ogMediaRefId: null,
          },
        },
      },
      {
        pageId: 'p_contact',
        pageKey: 'contact',
        role: 'contact',
        noindex: false,
        showInNav: true,
        sortOrder: 1,
        sections: [
          {
            id: 's_contact_hero',
            type: 'hero',
            variant: 'type_centered',
            media: null,
            ctas: [],
            showTrustline: false,
          },
        ],
        perLocale: {
          nl: {
            path: '/nl/contact/',
            slug: 'contact',
            title: 'Contact',
            description: 'Neem contact op met Kapsalon Anna.',
            ogMediaRefId: null,
          },
        },
      },
    ],
    copy: {
      nl: {
        's_hero.headline': 'Welkom bij Kapsalon Anna',
        's_hero.subhead': 'Knippen en kleuren in hartje Utrecht.',
        // `s_gallery.headline` is deliberately ABSENT. A derived slot with no copy is a real
        // state — the model may leave one empty and `normalize()` never invents text — and it is
        // the case the copy patch's inverse has to restore correctly.
        's_contact_hero.headline': 'Contact',
        's_contact_hero.subhead': 'Bel of mail ons.',
        'page.p_home.meta.title': 'Kapsalon Anna',
        'page.p_home.meta.description': 'Knippen en kleuren in Utrecht.',
        'page.p_home.meta.slug': 'home',
        'page.p_home.nav.label': 'Home',
        'page.p_contact.meta.title': 'Contact',
        'page.p_contact.meta.description': 'Neem contact op.',
        'page.p_contact.meta.slug': 'contact',
        'page.p_contact.nav.label': 'Contact',
      },
    },
    media: {
      m1: {
        refId: 'm1',
        r2Key: `img/${'a'.repeat(64)}/1200.jpg`,
        mimeType: 'image/jpeg',
        width: 1200,
        height: 800,
        blurhash: null,
        dominantColor: null,
        altText: null,
        credit: null,
      },
      m2: {
        refId: 'm2',
        r2Key: `img/${'b'.repeat(64)}/1200.jpg`,
        mimeType: 'image/jpeg',
        width: 1200,
        height: 800,
        blurhash: null,
        dominantColor: null,
        altText: null,
        credit: null,
      },
    },
    links: {},
    jsonLdInputs: {
      schemaOrgType: 'HairSalon',
      priceRange: '€€',
      servesCuisine: null,
      acceptsReservations: null,
      paymentAccepted: [],
      amenities: [],
    },
    facts: {
      businessName: 'Kapsalon Anna',
      legalName: null,
      industryKey: 'hair_salon',
      shortDescription: null,
      contactEmail: 'anna@example.test',
      phoneE164: '+31201234567',
      whatsappE164: null,
      gbpUrl: null,
      address: null,
      serviceArea: null,
      openingHours: null,
      reviewsSource: 'none',
      vatId: null,
      companyRegistrationId: null,
    },
    blog: [],
  });
}
