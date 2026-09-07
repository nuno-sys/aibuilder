import type {
  ExternalLink,
  LocaleCopy,
  MediaAsset,
  PageDoc,
  SectionGen,
  SiteDoc,
} from '@aibuilder/site-schema';
import { deriveSlotInventoryForPages, pageMetaSlotId, pageNavSlotId } from '@aibuilder/site-schema';
import type { RenderContext, RenderOptions } from '../index';

/**
 * The hostile fixture.
 *
 * Every model-authored string in this document is the same payload (below), and one allowlist entry
 * carries a `javascript:` scheme. The point is not that any one of them is likely — it is that a
 * renderer which escapes 16 of 17 sections has a hole, and only feeding every slot of every section
 * the same string finds it.
 *
 * `businessName` carries the payload too. It is a D1 fact rather than model output, but it is still
 * *user* input, and the header, footer, WhatsApp `aria-label` and JSON-LD all interpolate it.
 */

/**
 * The payload: a `<script>` element, all three quote characters, an ampersand, and U+2028.
 *
 * U+2028 is the interesting one. It is legal inside a JSON string but is a literal line terminator
 * in JavaScript source, so it is the single character that can break out of a
 * `<script type="application/ld+json">` block without a `<` appearing anywhere. It is written as an
 * escape rather than as a literal so this source file stays free of irregular whitespace.
 */
export const HOSTILE = '<script>alert(1)</script>"\'&\u2028';

/** An allowlist entry that should never be emitted. The renderer must drop it, not escape it. */
export const HOSTILE_HREF = 'javascript:alert(1)';

const SECTIONS: SectionGen[] = [
  {
    id: 's1',
    type: 'hero',
    variant: 'video_fullbleed',
    media: { refId: 'm1', focalPoint: 'center' },
    ctas: [
      { target: { kind: 'page', pageId: 'p1' }, style: 'primary' },
      { target: { kind: 'tel', _: null }, style: 'secondary' },
    ],
    showTrustline: true,
  },
  {
    id: 's2',
    type: 'usp_trio',
    variant: 'icons_row',
    items: [{ iconId: 'clock' }, { iconId: 'shield' }, { iconId: 'star' }],
  },
  {
    id: 's3',
    type: 'about',
    variant: 'wide_quote',
    media: { refId: 'm1', focalPoint: 'top' },
    paragraphs: [{ emphasis: 'lead' }, { emphasis: 'normal' }],
    cta: { target: { kind: 'external', refId: 'l1' }, style: 'ghost' },
  },
  {
    id: 's4',
    type: 'services_grid',
    variant: 'cards_3col',
    items: [
      {
        media: { refId: 'm1', focalPoint: 'center' },
        target: { kind: 'anchor', sectionId: 's6' },
        showPrice: true,
      },
      { media: null, target: { kind: 'external', refId: 'lbad' }, showPrice: false },
    ],
  },
  {
    id: 's5',
    type: 'menu',
    variant: 'two_column',
    groups: [
      {
        items: [
          { showDescription: true, tags: ['vegan', 'spicy'] },
          { showDescription: false, tags: [] },
        ],
      },
    ],
  },
  {
    id: 's6',
    type: 'gallery',
    variant: 'grid_square',
    media: [
      { refId: 'm1', focalPoint: 'center' },
      { refId: 'm2', focalPoint: 'left' },
    ],
    showCaptions: true,
  },
  { id: 's7', type: 'reviews', variant: 'cards_3col', source: 'manual' },
  {
    id: 's8',
    type: 'team',
    variant: 'portraits_grid',
    items: [
      { media: { refId: 'm1', focalPoint: 'center' }, showBio: true },
      { media: null, showBio: false },
    ],
  },
  {
    id: 's9',
    type: 'process_steps',
    variant: 'numbered_horizontal',
    items: [{ iconId: 'wrench' }, { iconId: null }],
  },
  {
    id: 's10',
    type: 'stats_band',
    variant: 'accent_bg',
    items: [{ iconId: 'euro' }, { iconId: null }],
  },
  {
    id: 's11',
    type: 'faq',
    variant: 'accordion',
    emitFaqSchema: true,
    items: [{ expandedByDefault: true }, { expandedByDefault: false }],
  },
  {
    id: 's12',
    type: 'booking',
    variant: 'cta_to_provider',
    provider: 'external_link',
    providerLink: { kind: 'external', refId: 'l1' },
  },
  {
    id: 's13',
    type: 'contact_form',
    variant: 'stacked',
    fields: [
      { name: 'name', required: true },
      { name: 'email', required: true },
      { name: 'message', required: false },
      { name: 'consent', required: true },
    ],
  },
  { id: 's14', type: 'map_hours', variant: 'map_right', showRouteCta: true },
  {
    id: 's15',
    type: 'cta_band',
    variant: 'accent_full',
    media: null,
    ctas: [{ target: { kind: 'whatsapp', _: null }, style: 'primary' }],
  },
  { id: 's16', type: 'blog_teaser', variant: 'cards_2col', showExcerpts: true },
  {
    id: 's17',
    type: 'rich_text',
    variant: 'prose_narrow',
    paragraphs: [{ style: 'lead' }, { style: 'paragraph' }, { style: 'note' }],
  },
];

function media(refId: string, hash: string): MediaAsset {
  return {
    refId,
    r2Key: `img/${hash}/1200.avif`,
    mimeType: 'image/avif',
    width: 1200,
    height: 800,
    blurhash: null,
    dominantColor: '#3a2a1c',
    luminance: 'dark',
    renditions: null,
    altText: HOSTILE,
    credit: null,
  };
}

const LINKS: Readonly<Record<string, ExternalLink>> = {
  l1: { href: 'https://example.com/book?a=1&b=2', rel: 'nofollow' },
  // Never emitted: `resolveLink` drops it. A schema regression must not become an XSS.
  lbad: { href: HOSTILE_HREF, rel: null },
};

/** Fills every derived slot of every page with the hostile payload. */
function hostileCopy(pages: readonly PageDoc[], reverse: boolean): LocaleCopy {
  const inventory = deriveSlotInventoryForPages(pages);
  const ids = inventory.slots.map((descriptor) => descriptor.id);
  const ordered = reverse ? [...ids].reverse() : ids;
  const copy: Record<string, string> = {};
  for (const id of ordered) copy[id] = `${HOSTILE} ${id}`;
  for (const page of pages) {
    copy[pageMetaSlotId(page.pageId, 'title')] = `${HOSTILE} title`;
    copy[pageMetaSlotId(page.pageId, 'description')] = `${HOSTILE} description`;
    copy[pageNavSlotId(page.pageId)] = `${HOSTILE} nav`;
  }
  return copy;
}

/** Options for shaping the fixture. Defaults produce the pathological all-17-sections page. */
export interface FixtureOptions {
  /** Enumerate the copy record in reverse. Proves the renderer never iterates a record (§9.3). */
  readonly reverseCopyOrder?: boolean;
  /** Enumerate the media record in reverse, for the same reason. */
  readonly reverseMediaOrder?: boolean;
  readonly reviewsSource?: SiteDoc['facts']['reviewsSource'];
  readonly theme?: Partial<SiteDoc['theme']>;
  readonly sections?: readonly SectionGen[];
  /** Ref id of the footer's photographic ground. `undefined` leaves the footer flat. */
  readonly footerMediaRefId?: string;
}

/** A `SiteDoc` carrying all 17 sections and the hostile payload in every slot. */
export function hostileDoc(options: FixtureOptions = {}): SiteDoc {
  const sections = options.sections ?? SECTIONS;
  const pages: PageDoc[] = [
    {
      pageId: 'p1',
      pageKey: 'home',
      role: 'home',
      noindex: false,
      showInNav: true,
      sortOrder: 0,
      sections: [...sections],
      perLocale: {
        nl: {
          path: '/nl/',
          slug: '',
          title: `${HOSTILE} title`,
          description: `${HOSTILE} description`,
          ogMediaRefId: null,
        },
        de: {
          path: '/de/',
          slug: '',
          title: 'Titel',
          description: 'Beschreibung',
          ogMediaRefId: null,
        },
      },
    },
    {
      pageId: 'p2',
      pageKey: 'privacy',
      role: 'privacy',
      noindex: false,
      showInNav: false,
      sortOrder: 1,
      sections: [
        {
          id: 's18',
          type: 'rich_text',
          variant: 'prose_wide',
          paragraphs: [{ style: 'paragraph' }],
        },
      ],
      // Deliberately has no `de` translation: the hreflang cluster must OMIT it, never substitute.
      perLocale: {
        nl: {
          path: '/nl/privacy/',
          slug: 'privacy',
          title: 'Privacy',
          description: 'Privacy',
          ogMediaRefId: null,
        },
      },
    },
  ];

  const mediaEntries: [string, MediaAsset][] = [
    ['m1', media('m1', 'aaaa1111')],
    ['m2', media('m2', 'bbbb2222')],
  ];
  if (options.reverseMediaOrder === true) mediaEntries.reverse();

  return {
    schemaVersion: 1,
    siteId: 'site_01',
    versionId: 'ver_01',
    theme: {
      dnaId: 'warm_trattoria',
      paletteVariant: 'default',
      accentHueShift: '0',
      typeScaleId: 'editorial',
      radiusId: 'soft',
      densityId: 'airy',
      motionId: 'subtle',
      colorMode: 'light',
      tokens: {},
      ...options.theme,
    },
    locales: { default: 'nl', enabled: ['nl', 'de'] },
    chrome: {
      navStyle: 'logo_left_links_right',
      footerStyle: 'rich_4col',
      whatsappEnabled: true,
      footerMediaRefId: options.footerMediaRefId ?? null,
    },
    pages,
    copy: {
      nl: hostileCopy(pages, options.reverseCopyOrder === true),
      de: hostileCopy(pages, false),
    },
    media: Object.fromEntries(mediaEntries),
    heroVideo: null,
    sectionBackgrounds: {},
    links: LINKS,
    jsonLdInputs: {
      schemaOrgType: 'Restaurant',
      priceRange: '€€',
      servesCuisine: [HOSTILE],
      acceptsReservations: true,
      paymentAccepted: ['ideal', 'cash'],
      amenities: ['parking', 'wheelchair_accessible'],
    },
    facts: {
      businessName: `Bakkerij ${HOSTILE}`,
      legalName: `Bakkerij ${HOSTILE} B.V.`,
      industryKey: 'bakery',
      shortDescription: HOSTILE,
      contactEmail: 'info@example.com',
      phoneE164: '+31205551234',
      whatsappE164: '+31612345678',
      gbpUrl: 'https://www.google.com/maps/place/?q=place_id:ChIJtest',
      address: {
        line1: 'Javastraat 118',
        line2: null,
        postalCode: '1094 HP',
        city: 'Amsterdam',
        country: 'NL',
        latitude: 52.3625,
        longitude: 4.9384,
        geoSource: 'geocoded',
      },
      serviceArea: null,
      openingHours: null,
      reviewsSource: options.reviewsSource ?? 'manual',
      vatId: 'NL812345678B01',
      companyRegistrationId: '30123456',
    },
    blog: [
      {
        postId: 'b1',
        locale: 'nl',
        slug: 'test',
        path: '/nl/blog/test/',
        title: `${HOSTILE} post`,
        excerpt: `${HOSTILE} excerpt`,
        metaDescription: 'x',
        heroMediaRefId: null,
        blocks: [],
        publishedAt: '2026-05-14T09:00:00+02:00',
        updatedAt: '2026-09-02T11:41:07+02:00',
      },
    ],
  };
}

const IMAGE = {
  src: '/_a/img-1200.aaaa1111.avif',
  sources: [
    {
      type: 'image/avif',
      srcset: '/_a/img-800.aaaa1111.avif 800w,/_a/img-1200.aaaa1111.avif 1200w',
    },
  ],
  width: 1200,
  height: 800,
  alt: HOSTILE,
  focal: '50% 50%',
  dominantColor: '#3a2a1c',
  luminance: 'dark',
  renditions: null,
} as const;

/** A `RenderContext` with every injected capability present. */
export function renderContext(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    origin: 'https://bakkerij.mijnsaas.com',
    assetBase: '/_a',
    indexState: 'index',
    publishedAt: '2026-05-14T09:00:00+02:00',
    contentChangedAt: '2026-09-02T11:41:07+02:00',
    industry: {
      key: 'bakery',
      schemaOrgType: 'Bakery',
      additionalType: 'https://www.wikidata.org/wiki/Q274393',
    },
    hoursJsonLd: {
      openingHoursSpecification: [
        {
          '@type': 'OpeningHoursSpecification',
          dayOfWeek: ['Tuesday', 'Wednesday', 'Thursday'],
          opens: '08:30',
          closes: '18:00',
        },
      ],
      specialOpeningHoursSpecification: [],
      byAppointmentOnly: false,
    },
    hoursDisplay: {
      lines: [
        {
          days: ['Tuesday', 'Wednesday', 'Thursday'],
          daysLabel: 'Di t/m do',
          hoursLabel: '08:30–18:00',
          intervals: [{ opens: '08:30', closes: '18:00' }],
          closed: false,
          allDay: false,
          crossesMidnight: false,
        },
        {
          days: ['Monday'],
          daysLabel: 'Ma',
          hoursLabel: 'Gesloten',
          intervals: [],
          closed: true,
          allDay: false,
          crossesMidnight: false,
        },
      ],
      exceptions: [],
      byAppointmentOnly: false,
      byAppointmentLabel: null,
      timeZone: 'Europe/Amsterdam',
    },
    reviews: [
      { id: 'r1', authorName: HOSTILE, rating: 5, body: HOSTILE, publishedOn: '2026-04-02' },
      { id: 'r2', authorName: 'Jan', rating: 4, body: 'Prima brood', publishedOn: '2026-03-11' },
    ],
    images: { m1: IMAGE, m2: { ...IMAGE, src: '/_a/img-1200.bbbb2222.avif' } },
    hero: {
      poster: { ...IMAGE, width: 2400, height: 1350 },
      portraitSources: [
        { type: 'image/avif', srcset: '/_a/hero-p-780.avif 780w,/_a/hero-p-1170.avif 1170w' },
      ],
      video: {
        desktopAv1: '/_a/hero-1920.av1.webm',
        desktopH264: '/_a/hero-1920.h264.mp4',
        mobileAv1: '/_a/hero-720x1280.av1.webm',
        mobileH264: '/_a/hero-720x1280.h264.mp4',
        width: 1920,
        height: 1080,
      },
    },
    map: { ...IMAGE, src: '/_a/map.aaaa1111.png', width: 640, height: 400, alt: '' },
    sectionHeights: Object.fromEntries(
      Array.from({ length: 18 }, (_value, index) => [`s${index + 1}`, 480 + index]),
    ),
    icons: {
      png32: '/_a/icon-32.png',
      svg: '/_a/icon.svg',
      appleTouch: '/_a/icon-180.png',
      og: { url: 'https://bakkerij.mijnsaas.com/_a/og.jpg', width: 1200, height: 630 },
    },
    usesNonEssential: false,
    ...overrides,
  };
}

/** Deployment facts the renderer needs but the document does not carry. */
export function renderOptions(): RenderOptions {
  return {
    fontHashes: { byAsset: { inter: '7c1e9a', 'playfair-display': '9a13c4' } },
    madeWith: 'Gemaakt met aibuilder',
  };
}
