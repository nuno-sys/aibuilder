import { describe, expect, it } from 'vitest';
import type { ExternalLink, MediaAsset, SiteFacts } from '../doc';
import { SiteDocSchema } from '../doc';
import type { LocaleBundleGen } from '../gen/locale-bundle';
import type { SectionOf } from '../gen/section';
import type { SiteStructureGen } from '../gen/site-structure';
import type { GenToDocInput, Slugify } from '../gen-to-doc';
import { genToDoc } from '../gen-to-doc';
import { hasBlockingFindings, lintSiteDoc } from '../lint';
import { upgradeToLatest } from '../migrations';
import { deriveSlotInventory } from '../slots';
import { heroSection, makePage, makeStructure } from './fixtures';

/**
 * End-to-end over the assemble step: structure + bundle + D1 facts + manifests ->
 * `SiteDoc` -> lint -> upgrade-on-read.
 */

const contactForm: SectionOf<'contact_form'> = {
  id: 'cf1',
  type: 'contact_form',
  variant: 'stacked',
  fields: [
    { name: 'name', required: true },
    { name: 'email', required: true },
    { name: 'message', required: true },
    { name: 'consent', required: true },
  ],
};

const structure: SiteStructureGen = makeStructure([
  makePage('home', 'home', [heroSection('h1')]),
  makePage('contact', 'contact', [contactForm]),
]);

/** Copy for every slot, with readable slugs so the asserted paths are meaningful. */
function bundleFor(source: SiteStructureGen): LocaleBundleGen {
  return {
    schemaVersion: '1',
    locale: 'nl',
    entries: deriveSlotInventory(source).slots.map((slot) => ({
      id: slot.id,
      text: slot.kind === 'slug_seed' ? (slot.pageId === 'home' ? 'start' : 'contact') : 'Tekst',
    })),
  };
}

const facts: SiteFacts = {
  businessName: 'Kapsalon De Schaar',
  legalName: 'De Schaar B.V.',
  industryKey: 'hairdresser',
  shortDescription: 'Kapsalon in Amsterdam-West.',
  contactEmail: 'hallo@deschaar.nl',
  phoneE164: '+31201234567',
  whatsappE164: '+31612345678',
  gbpUrl: null,
  address: {
    line1: 'Kinkerstraat 1',
    line2: null,
    postalCode: '1053ED',
    city: 'Amsterdam',
    country: 'NL',
    latitude: 52.366,
    longitude: 4.868,
    geoSource: 'geocoded',
  },
  serviceArea: null,
  openingHours: null,
  reviewsSource: 'manual',
  vatId: null,
  companyRegistrationId: '12345678',
};

const media: Record<string, MediaAsset> = {
  m1: {
    refId: 'm1',
    r2Key: 'sites/s1/media/m1.webp',
    mimeType: 'image/webp',
    width: 2400,
    height: 1350,
    blurhash: 'LEHV6nWB2yk8',
    dominantColor: '#3a3a3a',
    altText: 'De salon van binnen',
    credit: null,
  },
};

const externalLinks: Record<string, ExternalLink> = {
  x1: { href: 'https://www.treatwell.nl/salon/de-schaar/', rel: null },
};

/** Contrast-safe tokens; `site-kit` resolves the real ones from the design DNA. */
const themeTokens: Record<string, string> = {
  '--color-fg': '#111111',
  '--color-bg': '#ffffff',
  '--color-fg-muted': '#565656',
  '--color-fg-on-accent': '#ffffff',
  '--color-accent': '#1e4620',
  '--color-fg-on-surface': '#111111',
  '--color-surface': '#f4f4f4',
  '--color-border-strong': '#767676',
};

const slugify: Slugify = ({ seed, key }) => (seed.trim().length > 0 ? seed : key);

function makeInput(overrides: Partial<GenToDocInput> = {}): GenToDocInput {
  return {
    siteId: 'site_01',
    versionId: 'ver_01',
    structure,
    bundles: [bundleFor(structure)],
    blog: [],
    facts,
    media,
    externalLinks,
    themeTokens,
    enabledLocales: ['nl'],
    slugify,
    ...overrides,
  };
}

describe('genToDoc', () => {
  it('produces a document that validates against SiteDocSchema', () => {
    const { doc, issues } = genToDoc(makeInput());

    expect(issues).toEqual([]);
    expect(SiteDocSchema.safeParse(doc).success).toBe(true);
    expect(doc.schemaVersion).toBe(1);
  });

  it('routes the home page to /{locale}/ and other pages to a localised slug', () => {
    const { doc } = genToDoc(makeInput());

    expect(doc.pages[0]?.perLocale.nl?.path).toBe('/nl/');
    expect(doc.pages[0]?.perLocale.nl?.slug).toBe('');
    expect(doc.pages[1]?.perLocale.nl?.path).toBe('/nl/contact/');
  });

  it("derives a page key from the role, not from the model's page id", () => {
    const { doc } = genToDoc(makeInput());

    expect(doc.pages.map((page) => page.pageKey)).toEqual(['home', 'contact']);
  });

  it('merges the D1 facts and drops the theme rationale', () => {
    const { doc } = genToDoc(makeInput());

    expect(doc.facts.businessName).toBe('Kapsalon De Schaar');
    expect('rationale' in doc.theme).toBe(false);
    expect(doc.theme.tokens['--color-fg']).toBe('#111111');
  });

  it('carries only the media the document actually references', () => {
    const { doc } = genToDoc(makeInput());

    expect(Object.keys(doc.media)).toEqual(['m1']);
    expect(Object.keys(doc.links)).toEqual([]);
  });

  it('reports a media ref that is missing from the manifest instead of throwing', () => {
    const { doc, issues } = genToDoc(makeInput({ media: {} }));

    expect(issues.map((issue) => issue.code)).toContain('unknown_media_ref');
    expect(doc.media).toEqual({});
  });

  it('reports missing copy and a missing bundle rather than inventing text', () => {
    const { doc, issues } = genToDoc(makeInput({ bundles: [] }));

    expect(issues.map((issue) => issue.code)).toContain('missing_bundle');
    expect(issues.map((issue) => issue.code)).toContain('missing_copy');
    expect(doc.copy.nl).toEqual({});
  });

  it('omits a locale that has no bundle rather than substituting another', () => {
    const { doc } = genToDoc(makeInput({ enabledLocales: ['nl', 'de'] }));

    expect(doc.locales.enabled).toEqual(['nl']);
    expect(doc.copy.de).toBeUndefined();
  });

  it('turns the WhatsApp button off when there is no number to send people to', () => {
    const withWhatsapp = { ...structure, whatsappEnabled: true };
    const { doc } = genToDoc(
      makeInput({
        structure: withWhatsapp,
        bundles: [bundleFor(withWhatsapp)],
        facts: { ...facts, whatsappE164: null },
      }),
    );

    expect(doc.chrome.whatsappEnabled).toBe(false);
  });
});

describe('lintSiteDoc', () => {
  it('passes a well-formed document', () => {
    const { doc } = genToDoc(makeInput());
    const findings = lintSiteDoc(doc);

    expect(findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    expect(hasBlockingFindings(findings)).toBe(false);
  });

  it('fails a theme whose body text does not meet 4.5:1', () => {
    const { doc } = genToDoc(
      makeInput({ themeTokens: { ...themeTokens, '--color-fg': '#cccccc' } }),
    );
    const findings = lintSiteDoc(doc);

    expect(findings.map((finding) => finding.code)).toContain('contrast_below_minimum');
    expect(hasBlockingFindings(findings)).toBe(true);
  });

  it('warns rather than fails when a token pair is missing', () => {
    const { doc } = genToDoc(makeInput({ themeTokens: {} }));
    const findings = lintSiteDoc(doc).filter((finding) => finding.code === 'token_missing');

    expect(findings).toHaveLength(5);
    expect(findings.every((finding) => finding.severity === 'warning')).toBe(true);
  });

  it('reads oklch() tokens, not just hex', () => {
    const { doc } = genToDoc(
      makeInput({
        themeTokens: {
          ...themeTokens,
          '--color-fg': 'oklch(0.22 0.02 250)',
          '--color-bg': 'oklch(0.99 0 0)',
        },
      }),
    );
    const findings = lintSiteDoc(doc);

    expect(findings.map((finding) => finding.code)).not.toContain('contrast_below_minimum');
    expect(findings.map((finding) => finding.code)).not.toContain('token_unparseable');
  });

  it('blocks a lead form with no consent field', () => {
    const withoutConsent: SectionOf<'contact_form'> = {
      ...contactForm,
      fields: contactForm.fields.filter((field) => field.name !== 'consent'),
    };
    const broken = makeStructure([
      makePage('home', 'home', [heroSection('h1')]),
      makePage('contact', 'contact', [withoutConsent]),
    ]);
    const { doc } = genToDoc(makeInput({ structure: broken, bundles: [bundleFor(broken)] }));

    expect(lintSiteDoc(doc).map((finding) => finding.code)).toContain(
      'contact_form_without_consent',
    );
  });

  it('blocks a section that claims Google reviews without a verified platform', () => {
    const withReviews = makeStructure([
      makePage('home', 'home', [
        heroSection('h1'),
        { id: 'rv1', type: 'reviews', variant: 'google_badge', source: 'google' },
      ]),
    ]);
    const { doc } = genToDoc(
      makeInput({ structure: withReviews, bundles: [bundleFor(withReviews)] }),
    );

    expect(lintSiteDoc(doc).map((finding) => finding.code)).toContain(
      'review_markup_not_permitted',
    );
  });

  it('blocks a menu on a page where a menu does not belong', () => {
    const misplaced = makeStructure([
      makePage('home', 'home', [heroSection('h1')]),
      makePage('privacy', 'privacy', [
        { id: 'mn1', type: 'menu', variant: 'two_column', groups: [{ items: [] }] },
      ]),
    ]);
    const { doc } = genToDoc(makeInput({ structure: misplaced, bundles: [bundleFor(misplaced)] }));

    expect(lintSiteDoc(doc).map((finding) => finding.code)).toContain(
      'section_not_allowed_on_page',
    );
  });
});

describe('upgradeToLatest', () => {
  it('passes a current document straight through', () => {
    const { doc } = genToDoc(makeInput());
    const result = upgradeToLatest(JSON.parse(JSON.stringify(doc)) as unknown);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.issues.join('; '));
    expect(result.changed).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.doc.siteId).toBe('site_01');
  });

  it('refuses a document written by a newer build instead of guessing', () => {
    const { doc } = genToDoc(makeInput());
    const future = { ...JSON.parse(JSON.stringify(doc)), schemaVersion: 99 } as unknown;
    const result = upgradeToLatest(future);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the upgrade to be refused');
    expect(result.reason).toBe('unsupported_version');
    expect(result.foundVersion).toBe(99);
  });

  it('reports garbage without throwing', () => {
    for (const input of [null, 7, 'doc', [], {}, { schemaVersion: '1' }]) {
      expect(() => upgradeToLatest(input)).not.toThrow();
      expect(upgradeToLatest(input).ok).toBe(false);
    }
  });
});
