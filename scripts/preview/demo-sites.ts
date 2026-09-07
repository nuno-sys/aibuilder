import type {
  DnaId,
  LocaleCopy,
  MediaAsset,
  PageDoc,
  PageRole,
  SectionGen,
  SiteDoc,
} from '@aibuilder/site-schema';
import { parseSiteDocOrThrow } from '@aibuilder/site-schema';
import type { RenderedReview } from '@aibuilder/site-kit';
import { resolveTheme } from '@aibuilder/site-kit';

/**
 * Four demo tenant sites, one per Phase 1 design DNA.
 *
 * WHY THIS FILE EXISTS. The only `SiteDoc` in the repository is `hostileDoc()`, whose every string
 * is `<script>alert(1)</script>` because it exists to prove the escaping. That fixture is exactly
 * right for its job and useless for looking at: you cannot judge a colour ramp, a type scale or a
 * component library through it. These four documents are the other half — real Dutch copy, real
 * section mixes, real routing — so the design can be seen.
 *
 * EVERYTHING HERE IS FICTIONAL. The businesses, the addresses, the postcodes, the phone numbers,
 * the VAT and KvK numbers, the e-mail hosts (`.example`, which is reserved by RFC 2606 and can
 * never be registered) and the reviews are all invented for this harness. The reviews in
 * particular are written as visibly illustrative placeholder text rather than as testimony, because
 * a fabricated testimonial is a per-se unfair commercial practice under UCPD Annex I 23b/23c —
 * the same rule `lint.ts` and the reviews component already enforce for tenants.
 *
 * WHAT IS REAL. The `industryKey` of each site is a genuine key from
 * `packages/core/src/industries.ts`, and each one is a key whose row carries the `dnaId` this demo
 * claims — `nightclub → midnight_neon`, `restaurant → warm_trattoria`, `dentist →
 * clinical_trust`, `car_repair → garage_steel`. `assertIndustry()` in `render.ts` reads the row
 * back, so a typo here fails the run rather than producing a plausible-looking lie.
 *
 * HOW COPY IS KEYED. Slot ids are derived from `(sectionId, field, index)` by
 * `deriveSectionSlots()`, never authored; `slotsOf()` below prefixes a section id onto the short
 * field paths so the literal keys in this file stay readable, and `render.ts` runs
 * `lintSiteDoc()` — whose `missing_copy` check is the same derivation — over every document
 * before rendering it. A mistyped path here therefore fails loudly.
 */

/* ── Shapes the rest of the harness reads ───────────────────────────────── */

/** What kind of placeholder `media.ts` should synthesise for one asset. */
export type PlaceholderKind =
  'hero_landscape' | 'hero_portrait' | 'wide' | 'square' | 'portrait' | 'map' | 'og';

/** One synthesised asset: what it is, how big it is, and what it is called. */
export interface DemoMedia {
  /** `refId` in `doc.media`, and the basename under `/_m/<siteKey>/`. */
  readonly refId: string;
  readonly kind: PlaceholderKind;
  readonly width: number;
  readonly height: number;
  /** Written by the media pipeline in production, so it is a fact here, not model copy. */
  readonly alt: string;
}

/** One demo tenant site, plus everything the composition root needs that is not in the document. */
export interface DemoSite {
  /** Directory and hostname slug: `.preview/<key>/…`. */
  readonly key: string;
  readonly label: string;
  readonly archetype: DnaId;
  /** One line for the index page. Describes the archetype, not the fictional business. */
  readonly blurb: string;
  /** Canonical origin the pages claim. `.example` is reserved, so it can never resolve. */
  readonly origin: string;
  readonly doc: SiteDoc;
  readonly media: readonly DemoMedia[];
  /** `refId` of the hero poster, and of its portrait crop. */
  readonly heroRefId: string;
  readonly heroPortraitRefId: string;
  /** `refId` of the static map image, or `null` for a site that renders no map. */
  readonly mapRefId: string | null;
  readonly ogRefId: string;
  /** Injected through `RenderContext`; never model copy, and never a real person's testimony. */
  readonly reviews: readonly RenderedReview[];
}

/* ── Small builders ─────────────────────────────────────────────────────── */

/** The one locale these demos are written in. Dutch is the primary market. */
const NL = 'nl';

/**
 * Prefixes a section id onto short field paths.
 *
 * `slotsOf('nk-hero', { subhead: '…' })` produces `{ 'nk-hero.subhead': '…' }`, which is the id
 * `deriveSectionSlots()` derives for that field. Writing the prefix once per section is what keeps
 * a 300-slot file readable.
 */
function slotsOf(sectionId: string, entries: Readonly<Record<string, string>>): LocaleCopy {
  const out: Record<string, string> = {};
  for (const [path, text] of Object.entries(entries)) out[`${sectionId}.${path}`] = text;
  return out;
}

/** The four page-level slots: SERP title, SERP description, slug seed and nav label. */
function pageSlots(
  pageId: string,
  meta: {
    readonly title: string;
    readonly description: string;
    readonly slugSeed: string;
    readonly nav: string | null;
  },
): LocaleCopy {
  const out: Record<string, string> = {
    [`page.${pageId}.meta.title`]: meta.title,
    [`page.${pageId}.meta.description`]: meta.description,
    [`page.${pageId}.meta.slug`]: meta.slugSeed,
  };
  if (meta.nav !== null) out[`page.${pageId}.nav.label`] = meta.nav;
  return out;
}

/** One page, with its `nl` routing. `slug: ''` is the home page, whose path is `/nl/`. */
function page(input: {
  readonly pageId: string;
  readonly pageKey: string;
  readonly role: PageRole;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly showInNav: boolean;
  readonly sortOrder: number;
  readonly sections: readonly SectionGen[];
}): PageDoc {
  return {
    pageId: input.pageId,
    pageKey: input.pageKey,
    role: input.role,
    noindex: false,
    showInNav: input.showInNav,
    sortOrder: input.sortOrder,
    sections: [...input.sections],
    perLocale: {
      [NL]: {
        path: input.slug === '' ? `/${NL}/` : `/${NL}/${input.slug}/`,
        slug: input.slug,
        title: input.title,
        description: input.description,
        ogMediaRefId: null,
      },
    },
  };
}

/**
 * A deterministic 64-hex digest for a media key.
 *
 * Production keys are content-addressed (`img/{sha256}/1600.avif`) and several consumers read the
 * digest back out of the key, so a placeholder key has to have the right *shape*. FNV-1a over the
 * refId gives that shape without pulling in a hash implementation or making the documents
 * non-deterministic.
 */
function digestOf(seed: string): string {
  let out = '';
  let hash = 0x811c9dc5;
  for (let round = 0; out.length < 64; round += 1) {
    for (const character of `${seed}#${String(round)}`) {
      hash ^= character.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    out += hash.toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
}

/** The document's media manifest, derived from the harness's own asset plan. */
function mediaManifest(
  assets: readonly DemoMedia[],
  dominantColor: string,
): Record<string, MediaAsset> {
  const out: Record<string, MediaAsset> = {};
  for (const asset of assets) {
    out[asset.refId] = {
      refId: asset.refId,
      r2Key: `img/${digestOf(asset.refId)}/${String(asset.width)}.svg`,
      mimeType: 'image/svg+xml',
      width: asset.width,
      height: asset.height,
      blurhash: null,
      dominantColor,
      altText: asset.alt,
      credit: null,
    };
  }
  return out;
}

/** Fills `theme.tokens` the way `genToDoc()` does, so `lintSiteDoc()`'s contrast pass has data. */
function themeOf(theme: Omit<SiteDoc['theme'], 'tokens'>): SiteDoc['theme'] {
  return { ...theme, tokens: resolveTheme(theme) };
}

/**
 * Illustrative review cards.
 *
 * Deliberately not written as testimony: no invented person's name, no invented experience, and
 * the body says what it is. `facts.reviewsSource` is `manual` on every demo, so the component
 * renders the Omnibus disclosure underneath and the JSON-LD builder emits no review markup.
 */
function placeholderReviews(subject: string): readonly RenderedReview[] {
  return [
    {
      id: 'demo-1',
      authorName: 'Voorbeeldreview 1',
      rating: 5,
      body: `Voorbeeldtekst. Hier komt een echte, geverifieerde review over ${subject} te staan; deze kaart toont alleen de opmaak.`,
      publishedOn: '2026-02-18',
    },
    {
      id: 'demo-2',
      authorName: 'Voorbeeldreview 2',
      rating: 4,
      body: 'Voorbeeldtekst met een iets langere regel, zodat zichtbaar is hoe een review van twee of drie zinnen in deze kaart uitlijnt en waar hij afbreekt.',
      publishedOn: '2026-01-30',
    },
    {
      id: 'demo-3',
      authorName: 'Voorbeeldreview 3',
      rating: 5,
      body: 'Voorbeeldtekst. Korte review, één zin.',
      publishedOn: '2025-12-09',
    },
  ];
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1 · midnight_neon — Club Neonkaai, a nightclub
 * ══════════════════════════════════════════════════════════════════════════ */

const NEONKAAI_MEDIA: readonly DemoMedia[] = [
  {
    refId: 'hero',
    kind: 'hero_landscape',
    width: 2400,
    height: 1350,
    alt: 'De grote zaal bij nacht, gezien vanaf het balkon',
  },
  {
    refId: 'hero-portrait',
    kind: 'hero_portrait',
    width: 1170,
    height: 2080,
    alt: 'De grote zaal bij nacht, staand uitsnede',
  },
  { refId: 'zaal-1', kind: 'square', width: 1200, height: 1200, alt: 'Dansvloer tijdens een set' },
  { refId: 'zaal-2', kind: 'wide', width: 1600, height: 1067, alt: 'Lichtbrug boven de vloer' },
  { refId: 'zaal-3', kind: 'square', width: 1200, height: 1200, alt: 'De kleine zaal' },
  { refId: 'zaal-4', kind: 'portrait', width: 1000, height: 1400, alt: 'Zicht op de dj-booth' },
  {
    refId: 'avond-1',
    kind: 'wide',
    width: 1200,
    height: 800,
    alt: 'Vrijdagavond in de grote zaal',
  },
  {
    refId: 'avond-2',
    kind: 'wide',
    width: 1200,
    height: 800,
    alt: 'Zaterdagavond, hoofdprogramma',
  },
  { refId: 'avond-3', kind: 'wide', width: 1200, height: 800, alt: 'Donderdagavond, studiosessie' },
  { refId: 'avond-4', kind: 'wide', width: 1200, height: 800, alt: 'Zondagmiddagprogramma' },
  { refId: 'entree', kind: 'wide', width: 1600, height: 1067, alt: 'De entree aan de kade' },
  { refId: 'kaart', kind: 'map', width: 640, height: 400, alt: '' },
  { refId: 'og', kind: 'og', width: 1200, height: 630, alt: '' },
];

const NEONKAAI_SECTIONS: Readonly<Record<string, readonly SectionGen[]>> = {
  home: [
    {
      id: 'nk-hero',
      type: 'hero',
      variant: 'video_fullbleed',
      media: { refId: 'hero', focalPoint: 'center' },
      ctas: [
        { target: { kind: 'page', pageId: 'nk-p-agenda' }, style: 'primary' },
        { target: { kind: 'external', refId: 'tickets' }, style: 'secondary' },
      ],
      showTrustline: true,
    },
    {
      id: 'nk-usp',
      type: 'usp_trio',
      variant: 'icons_row',
      items: [{ iconId: 'sparkle' }, { iconId: 'clock' }, { iconId: 'star' }],
    },
    {
      id: 'nk-stats',
      type: 'stats_band',
      variant: 'accent_bg',
      items: [{ iconId: null }, { iconId: 'star' }, { iconId: 'clock' }],
    },
    {
      id: 'nk-gallery',
      type: 'gallery',
      variant: 'masonry',
      media: [
        { refId: 'zaal-1', focalPoint: 'center' },
        { refId: 'zaal-2', focalPoint: 'center' },
        { refId: 'zaal-3', focalPoint: 'center' },
        { refId: 'zaal-4', focalPoint: 'top' },
      ],
      showCaptions: true,
    },
    { id: 'nk-reviews', type: 'reviews', variant: 'marquee', source: 'manual' },
    { id: 'nk-blog', type: 'blog_teaser', variant: 'cards_2col', showExcerpts: true },
    {
      id: 'nk-cta',
      type: 'cta_band',
      variant: 'accent_full',
      media: null,
      ctas: [
        { target: { kind: 'whatsapp', _: null }, style: 'primary' },
        { target: { kind: 'tel', _: null }, style: 'ghost' },
      ],
    },
  ],
  agenda: [
    {
      id: 'nk-agenda-hero',
      type: 'hero',
      variant: 'type_centered',
      media: null,
      ctas: [{ target: { kind: 'external', refId: 'tickets' }, style: 'primary' }],
      showTrustline: false,
    },
    {
      id: 'nk-avonden',
      type: 'services_grid',
      variant: 'image_tiles',
      items: [
        {
          media: { refId: 'avond-1', focalPoint: 'center' },
          target: { kind: 'external', refId: 'tickets' },
          showPrice: true,
        },
        {
          media: { refId: 'avond-2', focalPoint: 'center' },
          target: { kind: 'external', refId: 'tickets' },
          showPrice: true,
        },
        {
          media: { refId: 'avond-3', focalPoint: 'center' },
          target: { kind: 'external', refId: 'tickets' },
          showPrice: true,
        },
        {
          media: { refId: 'avond-4', focalPoint: 'center' },
          target: null,
          showPrice: true,
        },
      ],
    },
    {
      id: 'nk-faq',
      type: 'faq',
      variant: 'accordion',
      emitFaqSchema: true,
      items: [
        { expandedByDefault: true },
        { expandedByDefault: false },
        { expandedByDefault: false },
        { expandedByDefault: false },
      ],
    },
  ],
  contact: [
    {
      id: 'nk-contact-hero',
      type: 'hero',
      variant: 'image_split',
      media: { refId: 'entree', focalPoint: 'center' },
      ctas: [{ target: { kind: 'tel', _: null }, style: 'primary' }],
      showTrustline: false,
    },
    {
      id: 'nk-form',
      type: 'contact_form',
      variant: 'boxed_accent',
      fields: [
        { name: 'name', required: true },
        { name: 'email', required: true },
        { name: 'phone', required: false },
        { name: 'date', required: false },
        { name: 'message', required: true },
        { name: 'consent', required: true },
      ],
    },
    { id: 'nk-hours', type: 'map_hours', variant: 'map_right', showRouteCta: true },
  ],
  privacy: [
    {
      id: 'nk-privacy',
      type: 'rich_text',
      variant: 'prose_wide',
      paragraphs: [
        { style: 'lead' },
        { style: 'paragraph' },
        { style: 'paragraph' },
        { style: 'note' },
      ],
    },
  ],
};

const NEONKAAI_PAGES: readonly PageDoc[] = [
  page({
    pageId: 'nk-p-home',
    pageKey: 'home',
    role: 'home',
    slug: '',
    title: 'Club Neonkaai — clubnachten aan de Maashaven',
    description:
      'Vier nachten per week clubprogramma aan de Maashaven in Rotterdam: residents, gastdj’s, Funktion-One geluid en open tot 05:00.',
    showInNav: true,
    sortOrder: 0,
    sections: NEONKAAI_SECTIONS.home ?? [],
  }),
  page({
    pageId: 'nk-p-agenda',
    pageKey: 'agenda',
    role: 'services',
    slug: 'agenda',
    title: 'Agenda en vaste avonden — Club Neonkaai',
    description:
      'Wat er wanneer draait: Kaaisessies op vrijdag, Neon op zaterdag, Studio op donderdag en de matinee op zondag. Met entreeprijzen en tijden.',
    showInNav: true,
    sortOrder: 1,
    sections: NEONKAAI_SECTIONS.agenda ?? [],
  }),
  page({
    pageId: 'nk-p-contact',
    pageKey: 'contact',
    role: 'contact',
    slug: 'contact',
    title: 'Contact, route en zaalhuur — Club Neonkaai',
    description:
      'Openingstijden, route naar de Maashaven en het aanvraagformulier voor zaalhuur, presentaties en besloten avonden.',
    showInNav: true,
    sortOrder: 2,
    sections: NEONKAAI_SECTIONS.contact ?? [],
  }),
  page({
    pageId: 'nk-p-privacy',
    pageKey: 'privacy',
    role: 'privacy',
    slug: 'privacy',
    title: 'Privacyverklaring — Club Neonkaai',
    description:
      'Welke gegevens Club Neonkaai verwerkt bij ticketverkoop, zaalhuur en cameratoezicht, hoe lang ze bewaard blijven en hoe je ze opvraagt.',
    showInNav: false,
    sortOrder: 3,
    sections: NEONKAAI_SECTIONS.privacy ?? [],
  }),
];

const NEONKAAI_COPY: LocaleCopy = {
  ...pageSlots('nk-p-home', {
    title: 'Club Neonkaai — clubnachten aan de Maashaven',
    description:
      'Vier nachten per week clubprogramma aan de Maashaven in Rotterdam: residents, gastdj’s, Funktion-One geluid en open tot 05:00.',
    slugSeed: 'home',
    nav: 'Home',
  }),
  ...pageSlots('nk-p-agenda', {
    title: 'Agenda en vaste avonden — Club Neonkaai',
    description:
      'Wat er wanneer draait: Kaaisessies op vrijdag, Neon op zaterdag, Studio op donderdag en de matinee op zondag. Met entreeprijzen en tijden.',
    slugSeed: 'agenda',
    nav: 'Agenda',
  }),
  ...pageSlots('nk-p-contact', {
    title: 'Contact, route en zaalhuur — Club Neonkaai',
    description:
      'Openingstijden, route naar de Maashaven en het aanvraagformulier voor zaalhuur, presentaties en besloten avonden.',
    slugSeed: 'contact',
    nav: 'Contact',
  }),
  ...pageSlots('nk-p-privacy', {
    title: 'Privacyverklaring — Club Neonkaai',
    description:
      'Welke gegevens Club Neonkaai verwerkt bij ticketverkoop, zaalhuur en cameratoezicht, hoe lang ze bewaard blijven en hoe je ze opvraagt.',
    slugSeed: 'privacy',
    nav: null,
  }),

  ...slotsOf('nk-hero', {
    headline: 'Vier nachten per week, één geluid',
    subhead:
      'Clubprogramma aan de Maashaven. Residents die de avond opbouwen, gastdj’s die hem afmaken, en een zaal die op vrijdag en zaterdag doorgaat tot vijf uur.',
    trustline: 'Sinds 2014 · ruim 400 nachten geprogrammeerd · 18+',
    'ctas.0.label': 'Bekijk de agenda',
    'ctas.1.label': 'Tickets',
  }),
  ...slotsOf('nk-usp', {
    headline: 'Waarom Neonkaai',
    'items.0.title': 'Geluid dat schoon blijft',
    'items.0.body':
      'Een systeem dat is afgestemd op déze zaal, niet op een decibelmeter. Op elk volume blijft de bas droog en versta je elkaar aan de bar.',
    'items.1.title': 'Open tot 05:00',
    'items.1.body':
      'Vrijdag en zaterdag draaien we door tot vijf uur. De nachtbus stopt op tweehonderd meter, de fietsenstalling is van ons.',
    'items.2.title': 'Vier residents',
    'items.2.body':
      'Onze residents bouwen elke avond zelf op. Daardoor is een nacht een verhaal met een begin en een eind, en geen willekeurige reeks losse sets.',
  }),
  ...slotsOf('nk-stats', {
    headline: 'Neonkaai in cijfers',
    'items.0.value': '1.100',
    'items.0.label': 'Bezoekers in de grote zaal',
    'items.1.value': '4',
    'items.1.label': 'Residents op de vloer',
    'items.2.value': '05:00',
    'items.2.label': 'Sluitingstijd op vrijdag en zaterdag',
  }),
  ...slotsOf('nk-gallery', {
    headline: 'De zaal',
    'media.0.caption': 'De grote zaal, halverwege een residentsnacht',
    'media.1.caption': 'De lichtbrug boven de vloer, opgebouwd voor het weekend',
    'media.2.caption': 'De kleine zaal, ingericht voor live sets',
    'media.3.caption': 'Het balkon met zicht op de booth',
  }),
  ...slotsOf('nk-reviews', { headline: 'Wat bezoekers zeggen' }),
  ...slotsOf('nk-blog', { headline: 'Uit het logboek', linkLabel: 'Alle berichten' }),
  ...slotsOf('nk-cta', {
    headline: 'Zaal huren of op de gastenlijst?',
    body: 'App ons overdag en je hebt dezelfde dag antwoord. Voor besloten avonden, bedrijfsfeesten en releases maken we een programma op maat.',
    'ctas.0.label': 'Stuur een appje',
    'ctas.1.label': 'Bel de kassa',
  }),

  ...slotsOf('nk-agenda-hero', {
    headline: 'Agenda',
    subhead:
      'Vier vaste avonden, elk met een eigen opbouw en een eigen publiek. De line-up per week staat uiterlijk maandag online.',
    'ctas.0.label': 'Tickets',
  }),
  ...slotsOf('nk-avonden', {
    headline: 'Vaste avonden',
    'items.0.title': 'Vrijdag · Kaaisessies',
    'items.0.body':
      'House en disco, opgebouwd door de residents. Deuren om 23:00, laatste plaat om 05:00. Rustig begin, vol na één uur.',
    'items.0.price': '€ 12,50',
    'items.1.title': 'Zaterdag · Neon',
    'items.1.body':
      'Het hoofdprogramma, met elke week een gast in de grote zaal en een resident in de kleine. Deuren om 23:00.',
    'items.1.price': '€ 15,00',
    'items.2.title': 'Donderdag · Studio',
    'items.2.body':
      'Live sets en presentaties van werk dat nog niet af is. Kleine zaal, zittend en staand, tot 03:00.',
    'items.2.price': '€ 7,50',
    'items.3.title': 'Zondag · Matinee',
    'items.3.body':
      'Van 15:00 tot 21:00, deuren open en entree vrij. Bedoeld voor wie de nacht liever overslaat.',
    'items.3.price': 'Gratis',
  }),
  ...slotsOf('nk-faq', {
    headline: 'Praktisch',
    'items.0.question': 'Vanaf welke leeftijd kom ik binnen?',
    'items.0.answer':
      'Alle avonden zijn 18+. Neem een geldig identiteitsbewijs mee; zonder legitimatie kunnen we je aan de deur niet toelaten, ook niet met een ticket op naam.',
    'items.1.question': 'Kan ik met contant geld betalen?',
    'items.1.answer':
      'Nee, aan de deur en aan de bar betaal je met pin of met een telefoon. Dat is sneller aan de bar en veiliger voor het personeel aan het eind van de nacht.',
    'items.2.question': 'Is er een garderobe?',
    'items.2.answer':
      'Ja, de garderobe is verplicht voor jassen en tassen en kost € 3,00 per stuk. Grote tassen en koffers kunnen we helaas niet aannemen.',
    'items.3.question': 'Mag ik filmen op de dansvloer?',
    'items.3.answer':
      'Een foto voor jezelf mag. Filmen op de dansvloer liever niet: het is druk, het licht is fel en niet iedereen wil in beeld. Vraag het aan de fotograaf als je iets nodig hebt.',
  }),

  ...slotsOf('nk-contact-hero', {
    headline: 'Contact en route',
    subhead:
      'De club ligt aan de Maashaven, aan de kadezijde. Bellen kan tijdens kantooruren; op clubavonden staat de telefoon aan vanaf 21:00.',
    'ctas.0.label': 'Bel de kassa',
  }),
  ...slotsOf('nk-form', {
    headline: 'Zaal huren',
    body: 'Vertel kort wat je van plan bent, met welke datum en hoeveel mensen je verwacht. Je krijgt binnen twee werkdagen een voorstel met prijzen en tijden.',
    submitLabel: 'Aanvraag versturen',
    'fields.0.label': 'Naam',
    'fields.1.label': 'E-mailadres',
    'fields.2.label': 'Telefoonnummer',
    'fields.3.label': 'Gewenste datum',
    'fields.4.label': 'Waar gaat het over?',
    'fields.5.label':
      'Ik ga ermee akkoord dat mijn gegevens worden gebruikt om deze aanvraag te beantwoorden.',
  }),
  ...slotsOf('nk-hours', {
    headline: 'Openingstijden en route',
    body: 'Overdag zijn we telefonisch bereikbaar voor zaalhuur en pers. De kassa opent een half uur voor de eerste set.',
    routeCtaLabel: 'Route in Google Maps',
  }),

  ...slotsOf('nk-privacy', {
    headline: 'Privacyverklaring',
    'paragraphs.0.text':
      'Deze verklaring beschrijft welke persoonsgegevens Club Neonkaai verwerkt, waarom dat gebeurt en hoe lang we ze bewaren. Dit is voorbeeldtekst in een demonstratiesite; laat een echte verklaring altijd door een jurist controleren.',
    'paragraphs.1.text':
      'Bij ticketverkoop verwerken we je naam, je e-mailadres en het bestelnummer. Die gegevens komen van de ticketpartner, worden alleen gebruikt om je toegang te verlenen en worden na dertien maanden verwijderd.',
    'paragraphs.2.text':
      'In de zaal en bij de entree hangen camera’s. De beelden worden na zeven dagen automatisch overschreven, tenzij er een incident is vastgelegd waarvan aangifte is gedaan. Toegang tot de beelden heeft alleen de bedrijfsleiding.',
    'paragraphs.3.text':
      'Vragen over je gegevens, of een verzoek tot inzage of verwijdering, stuur je naar het e-mailadres onderaan deze pagina. Je krijgt binnen een maand antwoord.',
  }),
};

const NEONKAAI: DemoSite = {
  key: 'club-neonkaai',
  label: 'Club Neonkaai',
  archetype: 'midnight_neon',
  blurb:
    'Nachtclub · donkere grond, één elektrische accentkleur, Space Grotesk als display-letter, video-hero met scrim.',
  origin: 'https://club-neonkaai.example',
  heroRefId: 'hero',
  heroPortraitRefId: 'hero-portrait',
  mapRefId: 'kaart',
  ogRefId: 'og',
  media: NEONKAAI_MEDIA,
  reviews: placeholderReviews('een clubnacht'),
  doc: parseSiteDocOrThrow({
    schemaVersion: 1,
    siteId: 'site_demo_neonkaai',
    versionId: 'ver_demo_0001',
    theme: themeOf({
      dnaId: 'midnight_neon',
      paletteVariant: 'default',
      accentHueShift: '0',
      typeScaleId: 'display',
      radiusId: 'sharp',
      densityId: 'compact',
      motionId: 'expressive',
      colorMode: 'dark',
    }),
    locales: { default: NL, enabled: [NL] },
    chrome: {
      navStyle: 'centered_logo_slim',
      footerStyle: 'compact_2col',
      whatsappEnabled: true,
    },
    pages: NEONKAAI_PAGES,
    copy: { [NL]: NEONKAAI_COPY },
    media: mediaManifest(NEONKAAI_MEDIA, '#160f22'),
    links: {
      tickets: { href: 'https://tickets.example.com/club-neonkaai', rel: 'nofollow noopener' },
    },
    jsonLdInputs: {
      schemaOrgType: 'NightClub',
      priceRange: '€€',
      servesCuisine: null,
      acceptsReservations: false,
      paymentAccepted: ['ideal', 'debit_card', 'apple_pay'],
      amenities: ['wheelchair_accessible', 'air_conditioning'],
    },
    facts: {
      businessName: 'Club Neonkaai',
      legalName: 'Neonkaai Exploitatie B.V.',
      industryKey: 'nightclub',
      shortDescription:
        'Clubprogramma aan de Maashaven in Rotterdam, vier nachten per week, met eigen residents en gastdj’s.',
      contactEmail: 'hallo@neonkaai.example',
      phoneE164: '+31105550142',
      whatsappE164: '+31612000142',
      gbpUrl: null,
      address: {
        line1: 'Kraanbaanweg 4',
        line2: null,
        postalCode: '3089 AB',
        city: 'Rotterdam',
        country: 'NL',
        latitude: 51.8971,
        longitude: 4.4726,
        geoSource: 'geocoded',
      },
      serviceArea: null,
      openingHours: {
        tz: 'Europe/Amsterdam',
        byAppointmentOnly: false,
        spec: [
          { dayOfWeek: ['Thursday'], opens: '22:00', closes: '03:00' },
          { dayOfWeek: ['Friday', 'Saturday'], opens: '23:00', closes: '05:00' },
          { dayOfWeek: ['Sunday'], opens: '15:00', closes: '21:00' },
        ],
        closed: ['Monday', 'Tuesday', 'Wednesday'],
        exceptions: [{ from: '2026-12-25', to: '2026-12-25', closed: true }],
      },
      reviewsSource: 'manual',
      vatId: 'NL001234567B01',
      companyRegistrationId: '24123456',
    },
    blog: [
      {
        postId: 'nk-post-1',
        locale: NL,
        slug: 'zo-stemmen-we-de-zaal-af',
        path: '/nl/blog/zo-stemmen-we-de-zaal-af/',
        title: 'Zo stemmen we de zaal af voor het weekend',
        excerpt:
          'Elke donderdag hangt er een meetmicrofoon midden op de vloer. Wat we meten, waarom het elke week opnieuw moet, en wat je er als bezoeker van hoort.',
        metaDescription:
          'Hoe de geluidsinstallatie van Club Neonkaai wekelijks wordt ingemeten en afgestemd, en waarom dat op de dansvloer hoorbaar is.',
        heroMediaRefId: 'zaal-2',
        blocks: [],
        publishedAt: '2026-02-26T16:00:00+01:00',
        updatedAt: '2026-02-26T16:00:00+01:00',
      },
      {
        postId: 'nk-post-2',
        locale: NL,
        slug: 'vier-jaar-kaaisessies',
        path: '/nl/blog/vier-jaar-kaaisessies/',
        title: 'Vier jaar Kaaisessies: wat er veranderde',
        excerpt:
          'De vrijdagavond begon als een experiment met twee residents en een geleend mengpaneel. Een terugblik op wat bleef en wat we onderweg hebben afgeschaft.',
        metaDescription:
          'Vier jaar Kaaisessies op vrijdagavond: hoe de avond ontstond, wat er veranderde en wat er bewust hetzelfde bleef.',
        heroMediaRefId: 'avond-1',
        blocks: [],
        publishedAt: '2026-01-15T12:00:00+01:00',
        updatedAt: '2026-01-19T09:30:00+01:00',
      },
    ],
  }),
};

/* ══════════════════════════════════════════════════════════════════════════
 * 2 · warm_trattoria — Trattoria Nuvola Rossa, an Italian restaurant
 * ══════════════════════════════════════════════════════════════════════════ */

const NUVOLA_MEDIA: readonly DemoMedia[] = [
  {
    refId: 'hero',
    kind: 'hero_landscape',
    width: 2400,
    height: 1350,
    alt: 'De eetzaal aan het begin van de avond',
  },
  {
    refId: 'hero-portrait',
    kind: 'hero_portrait',
    width: 1170,
    height: 2080,
    alt: 'De eetzaal aan het begin van de avond, staande uitsnede',
  },
  {
    refId: 'keuken',
    kind: 'wide',
    width: 1600,
    height: 1067,
    alt: 'De open keuken met de houtoven',
  },
  { refId: 'terras', kind: 'wide', width: 1600, height: 1067, alt: 'Het terras aan de gracht' },
  { refId: 'tafel', kind: 'square', width: 1200, height: 1200, alt: 'Gedekte tafel bij het raam' },
  { refId: 'kaart', kind: 'map', width: 640, height: 400, alt: '' },
  { refId: 'og', kind: 'og', width: 1200, height: 630, alt: '' },
];

const NUVOLA_SECTIONS: Readonly<Record<string, readonly SectionGen[]>> = {
  home: [
    {
      id: 'nr-hero',
      type: 'hero',
      variant: 'image_split',
      media: { refId: 'hero', focalPoint: 'center' },
      ctas: [
        { target: { kind: 'page', pageId: 'nr-p-reserveren' }, style: 'primary' },
        { target: { kind: 'page', pageId: 'nr-p-menu' }, style: 'secondary' },
      ],
      showTrustline: true,
    },
    {
      id: 'nr-about',
      type: 'about',
      variant: 'text_image',
      media: { refId: 'keuken', focalPoint: 'center' },
      paragraphs: [{ emphasis: 'lead' }, { emphasis: 'normal' }, { emphasis: 'normal' }],
      cta: { target: { kind: 'page', pageId: 'nr-p-menu' }, style: 'ghost' },
    },
    {
      id: 'nr-proeverij',
      type: 'menu',
      variant: 'two_column',
      groups: [
        {
          items: [
            { showDescription: true, tags: ['vegetarian'] },
            { showDescription: true, tags: [] },
            { showDescription: true, tags: ['vegan'] },
          ],
        },
      ],
    },
    { id: 'nr-reviews', type: 'reviews', variant: 'cards_3col', source: 'manual' },
    { id: 'nr-hours', type: 'map_hours', variant: 'map_left', showRouteCta: true },
    {
      id: 'nr-cta',
      type: 'cta_band',
      variant: 'minimal_rule',
      media: null,
      ctas: [
        { target: { kind: 'tel', _: null }, style: 'primary' },
        { target: { kind: 'whatsapp', _: null }, style: 'ghost' },
      ],
    },
  ],
  menu: [
    {
      id: 'nr-menu-hero',
      type: 'hero',
      variant: 'type_centered',
      media: null,
      ctas: [{ target: { kind: 'page', pageId: 'nr-p-reserveren' }, style: 'primary' }],
      showTrustline: false,
    },
    {
      id: 'nr-menu',
      type: 'menu',
      variant: 'cards',
      groups: [
        {
          items: [
            { showDescription: true, tags: ['vegetarian'] },
            { showDescription: true, tags: [] },
            { showDescription: true, tags: ['vegan', 'gluten_free'] },
          ],
        },
        {
          items: [
            { showDescription: true, tags: [] },
            { showDescription: true, tags: ['spicy'] },
            { showDescription: true, tags: ['vegetarian'] },
            { showDescription: false, tags: [] },
          ],
        },
        {
          items: [
            { showDescription: true, tags: [] },
            { showDescription: false, tags: ['new'] },
          ],
        },
      ],
    },
    {
      id: 'nr-allergenen',
      type: 'rich_text',
      variant: 'prose_narrow',
      paragraphs: [{ style: 'lead' }, { style: 'paragraph' }, { style: 'note' }],
    },
  ],
  reserveren: [
    {
      id: 'nr-res-hero',
      type: 'hero',
      variant: 'image_offset_grid',
      media: { refId: 'terras', focalPoint: 'center' },
      ctas: [{ target: { kind: 'tel', _: null }, style: 'secondary' }],
      showTrustline: false,
    },
    {
      id: 'nr-booking',
      type: 'booking',
      variant: 'cta_to_provider',
      provider: 'external_link',
      providerLink: { kind: 'external', refId: 'reserveren' },
    },
    {
      id: 'nr-form',
      type: 'contact_form',
      variant: 'split_map',
      fields: [
        { name: 'name', required: true },
        { name: 'email', required: true },
        { name: 'phone', required: true },
        { name: 'service', required: false },
        { name: 'message', required: false },
        { name: 'consent', required: true },
      ],
    },
  ],
};

const NUVOLA_PAGES: readonly PageDoc[] = [
  page({
    pageId: 'nr-p-home',
    pageKey: 'home',
    role: 'home',
    slug: '',
    title: 'Trattoria Nuvola Rossa — Utrecht',
    description:
      'Napolitaanse keuken in het centrum van Utrecht. Verse pasta uit eigen keuken, een houtoven en een terras aan de gracht. Open van dinsdag tot en met zondag.',
    showInNav: true,
    sortOrder: 0,
    sections: NUVOLA_SECTIONS.home ?? [],
  }),
  page({
    pageId: 'nr-p-menu',
    pageKey: 'menu',
    role: 'menu',
    slug: 'menukaart',
    title: 'Menukaart — Trattoria Nuvola Rossa',
    description:
      'De hele kaart: antipasti, pasta uit eigen keuken, pizza uit de houtoven en dolci. Met prijzen, allergenen en de wisselende suggesties van de week.',
    showInNav: true,
    sortOrder: 1,
    sections: NUVOLA_SECTIONS.menu ?? [],
  }),
  page({
    pageId: 'nr-p-reserveren',
    pageKey: 'reserveren',
    role: 'booking',
    slug: 'reserveren',
    title: 'Reserveren — Trattoria Nuvola Rossa',
    description:
      'Reserveer online een tafel, bel ons tijdens openingstijden, of vraag een groepsdiner aan voor acht personen of meer.',
    showInNav: true,
    sortOrder: 2,
    sections: NUVOLA_SECTIONS.reserveren ?? [],
  }),
];

const NUVOLA_COPY: LocaleCopy = {
  ...pageSlots('nr-p-home', {
    title: 'Trattoria Nuvola Rossa — Utrecht',
    description:
      'Napolitaanse keuken in het centrum van Utrecht. Verse pasta uit eigen keuken, een houtoven en een terras aan de gracht. Open van dinsdag tot en met zondag.',
    slugSeed: 'home',
    nav: 'Home',
  }),
  ...pageSlots('nr-p-menu', {
    title: 'Menukaart — Trattoria Nuvola Rossa',
    description:
      'De hele kaart: antipasti, pasta uit eigen keuken, pizza uit de houtoven en dolci. Met prijzen, allergenen en de wisselende suggesties van de week.',
    slugSeed: 'menukaart',
    nav: 'Menukaart',
  }),
  ...pageSlots('nr-p-reserveren', {
    title: 'Reserveren — Trattoria Nuvola Rossa',
    description:
      'Reserveer online een tafel, bel ons tijdens openingstijden, of vraag een groepsdiner aan voor acht personen of meer.',
    slugSeed: 'reserveren',
    nav: 'Reserveren',
  }),

  ...slotsOf('nr-hero', {
    headline: 'Napolitaans koken in een Utrechtse gracht',
    subhead:
      'Elke ochtend deeg, elke middag saus, elke avond vuur. Een kleine kaart die met het seizoen meebeweegt, en een terras dat het water raakt.',
    trustline: 'Sinds 2011 · eigen pastamakerij · terras aan de gracht',
    'ctas.0.label': 'Tafel reserveren',
    'ctas.1.label': 'Bekijk de kaart',
  }),
  ...slotsOf('nr-about', {
    headline: 'Over de trattoria',
    'paragraphs.0.text':
      'We begonnen in 2011 met acht tafels, één oven en het plan om precies te koken zoals we het thuis zouden doen. Dat plan is niet veranderd; de kaart wel, elke maand een beetje.',
    'paragraphs.1.text':
      'De pasta maken we ’s ochtends zelf, met harde tarwegriesmeel en eieren van een boerderij die we kennen. De pizza gaat in een houtoven die op 430 graden staat; dat scheelt in tijd, maar vooral in smaak. Wat we niet zelf maken, kopen we bij drie leveranciers die we al jaren houden.',
    'paragraphs.2.text':
      'De bediening is klein en vast. Vertel bij het reserveren gerust wat je niet eet — dan bedenken we iets in plaats van iets weg te laten.',
    'cta.label': 'Naar de menukaart',
  }),
  ...slotsOf('nr-proeverij', {
    headline: 'Een greep uit de kaart',
    'groups.0.title': 'Deze week',
    'groups.0.items.0.name': 'Gnocchi met pompoen en salie',
    'groups.0.items.0.price': '€ 19,50',
    'groups.0.items.0.description':
      'Gnocchi van de dag, gebrande pompoen, salieboter en oude pecorino.',
    'groups.0.items.1.name': 'Pizza margherita van de houtoven',
    'groups.0.items.1.price': '€ 14,00',
    'groups.0.items.1.description':
      'San-marzanotomaat, fior di latte, basilicum en olijfolie. Deeg van 48 uur.',
    'groups.0.items.2.name': 'Caponata met geroosterd brood',
    'groups.0.items.2.price': '€ 11,50',
    'groups.0.items.2.description':
      'Aubergine, selderij, kappertjes en tomaat, koud geserveerd met brood uit de oven.',
  }),
  ...slotsOf('nr-reviews', { headline: 'Wat gasten zeggen' }),
  ...slotsOf('nr-hours', {
    headline: 'Openingstijden en route',
    body: 'We zitten aan de werf, twaalf minuten lopen vanaf Utrecht Centraal. De keuken sluit een uur voor sluitingstijd.',
    routeCtaLabel: 'Route in Google Maps',
  }),
  ...slotsOf('nr-cta', {
    headline: 'Liever even bellen?',
    body: 'Voor vanavond, voor een groep of voor een vraag over allergenen: tussen 15:00 en 17:00 staat de telefoon aan en krijg je meteen de bediening aan de lijn.',
    'ctas.0.label': 'Bel de trattoria',
    'ctas.1.label': 'App ons',
  }),

  ...slotsOf('nr-menu-hero', {
    headline: 'Menukaart',
    subhead:
      'De kaart wisselt met het seizoen. Wat hieronder staat, staat er deze maand; de suggesties van de week horen bij de tafel.',
    'ctas.0.label': 'Tafel reserveren',
  }),
  ...slotsOf('nr-menu', {
    headline: 'De hele kaart',
    'groups.0.title': 'Antipasti',
    'groups.0.items.0.name': 'Caponata met geroosterd brood',
    'groups.0.items.0.price': '€ 11,50',
    'groups.0.items.0.description':
      'Aubergine, selderij, kappertjes en tomaat, koud geserveerd met brood uit de oven.',
    'groups.0.items.1.name': 'Vitello tonnato',
    'groups.0.items.1.price': '€ 13,50',
    'groups.0.items.1.description':
      'Dun gesneden kalfsmuis, tonijnmayonaise, kappertjes en citroen.',
    'groups.0.items.2.name': 'Insalata di finocchio',
    'groups.0.items.2.price': '€ 9,50',
    'groups.0.items.2.description': 'Venkel, sinaasappel, olijven en olijfolie. Zonder gluten.',
    'groups.1.title': 'Primi en pizza',
    'groups.1.items.0.name': 'Tagliatelle al ragù',
    'groups.1.items.0.price': '€ 21,00',
    'groups.1.items.0.description':
      'Ragù van vier uur, verse tagliatelle, parmezaan van 24 maanden.',
    'groups.1.items.1.name': 'Rigatoni all’arrabbiata',
    'groups.1.items.1.price': '€ 18,00',
    'groups.1.items.1.description':
      'Tomaat, knoflook, peperoncino en peterselie. Behoorlijk pittig.',
    'groups.1.items.2.name': 'Gnocchi met pompoen en salie',
    'groups.1.items.2.price': '€ 19,50',
    'groups.1.items.2.description':
      'Gnocchi van de dag, gebrande pompoen, salieboter en oude pecorino.',
    'groups.1.items.3.name': 'Pizza margherita',
    'groups.1.items.3.price': '€ 14,00',
    'groups.2.title': 'Dolci',
    'groups.2.items.0.name': 'Tiramisù van het huis',
    'groups.2.items.0.price': '€ 8,50',
    'groups.2.items.0.description':
      'Mascarpone, espresso van onze eigen branding, cacao. Per twee personen.',
    'groups.2.items.1.name': 'Affogato',
    'groups.2.items.1.price': '€ 6,00',
  }),
  ...slotsOf('nr-allergenen', {
    headline: 'Allergenen en dieetwensen',
    'paragraphs.0.text':
      'We koken in één keuken, met bloem in de lucht. Volledig glutenvrij werken kunnen we daarom niet garanderen, hoe zorgvuldig we ook zijn.',
    'paragraphs.1.text':
      'Wat we wel doen: bij elke reservering noteren we allergieën en dieetwensen, de kok krijgt dat briefje in handen, en de bediening loopt het bij het serveren nog één keer met je na. Vegetarisch en veganistisch koken we elke dag; noten en schaaldieren houden we op aparte werkbladen.',
    'paragraphs.2.text':
      'Twijfel je over een gerecht? Vraag het aan tafel. Liever een keer te veel gevraagd dan een avond met een vervelende afloop.',
  }),

  ...slotsOf('nr-res-hero', {
    headline: 'Reserveren',
    subhead:
      'Online kan tot een uur van tevoren. Voor groepen vanaf acht personen maken we een aparte afspraak, zodat de keuken kan meedenken.',
    'ctas.0.label': 'Bel de trattoria',
  }),
  ...slotsOf('nr-booking', {
    headline: 'Direct een tafel boeken',
    body: 'De agenda loopt via ons reserveringssysteem. Je ziet meteen welke tijden vrij zijn en krijgt een bevestiging per e-mail.',
    ctaLabel: 'Naar de reserveringen',
  }),
  ...slotsOf('nr-form', {
    headline: 'Groepen en gelegenheden',
    body: 'Voor acht personen of meer stellen we een kaart op maat samen. Laat weten met hoeveel jullie komen en wat de gelegenheid is; we reageren binnen twee werkdagen.',
    submitLabel: 'Aanvraag versturen',
    'fields.0.label': 'Naam',
    'fields.1.label': 'E-mailadres',
    'fields.2.label': 'Telefoonnummer',
    'fields.3.label': 'Gelegenheid',
    'fields.4.label': 'Aantal personen en dieetwensen',
    'fields.5.label':
      'Ik ga ermee akkoord dat mijn gegevens worden gebruikt om deze aanvraag te beantwoorden.',
  }),
};

const NUVOLA: DemoSite = {
  key: 'trattoria-nuvola-rossa',
  label: 'Trattoria Nuvola Rossa',
  archetype: 'warm_trattoria',
  blurb:
    'Italiaans restaurant · crème grond, terracotta accent, Playfair Display in de koppen, haarlijnen en veel witruimte.',
  origin: 'https://nuvola-rossa.example',
  heroRefId: 'hero',
  heroPortraitRefId: 'hero-portrait',
  mapRefId: 'kaart',
  ogRefId: 'og',
  media: NUVOLA_MEDIA,
  reviews: placeholderReviews('een avond in de trattoria'),
  doc: parseSiteDocOrThrow({
    schemaVersion: 1,
    siteId: 'site_demo_nuvola',
    versionId: 'ver_demo_0002',
    theme: themeOf({
      dnaId: 'warm_trattoria',
      paletteVariant: 'default',
      accentHueShift: '0',
      typeScaleId: 'editorial',
      radiusId: 'soft',
      densityId: 'airy',
      motionId: 'subtle',
      colorMode: 'light',
    }),
    locales: { default: NL, enabled: [NL] },
    chrome: {
      navStyle: 'logo_left_links_right',
      footerStyle: 'rich_4col',
      whatsappEnabled: true,
    },
    pages: NUVOLA_PAGES,
    copy: { [NL]: NUVOLA_COPY },
    media: mediaManifest(NUVOLA_MEDIA, '#efe6d8'),
    links: {
      reserveren: {
        href: 'https://reserveren.example.com/nuvola-rossa',
        rel: 'nofollow noopener',
      },
    },
    jsonLdInputs: {
      schemaOrgType: 'Restaurant',
      priceRange: '€€',
      servesCuisine: ['Italiaans', 'Napolitaans'],
      acceptsReservations: true,
      paymentAccepted: ['ideal', 'debit_card', 'cash'],
      amenities: ['outdoor_seating', 'kids_welcome', 'wheelchair_accessible'],
    },
    facts: {
      businessName: 'Trattoria Nuvola Rossa',
      legalName: 'Nuvola Rossa Horeca B.V.',
      industryKey: 'restaurant',
      shortDescription:
        'Napolitaanse trattoria in het centrum van Utrecht, met een eigen pastamakerij en een houtoven.',
      contactEmail: 'ciao@nuvola-rossa.example',
      phoneE164: '+31305550118',
      whatsappE164: '+31612000218',
      gbpUrl: null,
      address: {
        line1: 'Rozenbrugwerf 9',
        line2: null,
        postalCode: '3512 KL',
        city: 'Utrecht',
        country: 'NL',
        latitude: 52.0908,
        longitude: 5.1214,
        geoSource: 'geocoded',
      },
      serviceArea: null,
      openingHours: {
        tz: 'Europe/Amsterdam',
        byAppointmentOnly: false,
        spec: [
          { dayOfWeek: ['Tuesday', 'Wednesday', 'Thursday'], opens: '17:00', closes: '22:00' },
          { dayOfWeek: ['Friday', 'Saturday'], opens: '17:00', closes: '23:00' },
          { dayOfWeek: ['Sunday'], opens: '16:00', closes: '21:00' },
        ],
        closed: ['Monday'],
        exceptions: [{ from: '2026-07-20', to: '2026-08-03', closed: true }],
      },
      reviewsSource: 'manual',
      vatId: 'NL002345678B01',
      companyRegistrationId: '30234567',
    },
    blog: [],
  }),
};

/* ══════════════════════════════════════════════════════════════════════════
 * 3 · clinical_trust — Tandartspraktijk Zilverberk, a dental practice
 * ══════════════════════════════════════════════════════════════════════════ */

const ZILVERBERK_MEDIA: readonly DemoMedia[] = [
  {
    refId: 'hero',
    kind: 'hero_landscape',
    width: 2400,
    height: 1350,
    alt: 'De wachtkamer met zicht op de tuin',
  },
  {
    refId: 'hero-portrait',
    kind: 'hero_portrait',
    width: 1170,
    height: 2080,
    alt: 'De wachtkamer, staande uitsnede',
  },
  { refId: 'balie', kind: 'wide', width: 1600, height: 1067, alt: 'De balie bij binnenkomst' },
  { refId: 'team-1', kind: 'portrait', width: 900, height: 1125, alt: 'Portret van een tandarts' },
  {
    refId: 'team-2',
    kind: 'portrait',
    width: 900,
    height: 1125,
    alt: 'Portret van een mondhygiënist',
  },
  {
    refId: 'team-3',
    kind: 'portrait',
    width: 900,
    height: 1125,
    alt: 'Portret van een tandartsassistent',
  },
  { refId: 'kaart', kind: 'map', width: 640, height: 400, alt: '' },
  { refId: 'og', kind: 'og', width: 1200, height: 630, alt: '' },
];

const ZILVERBERK_SECTIONS: Readonly<Record<string, readonly SectionGen[]>> = {
  home: [
    {
      id: 'zb-hero',
      type: 'hero',
      variant: 'type_centered',
      media: { refId: 'hero', focalPoint: 'center' },
      ctas: [
        { target: { kind: 'page', pageId: 'zb-p-afspraak' }, style: 'primary' },
        { target: { kind: 'tel', _: null }, style: 'secondary' },
      ],
      showTrustline: true,
    },
    {
      id: 'zb-usp',
      type: 'usp_trio',
      variant: 'bordered_grid',
      items: [{ iconId: 'shield' }, { iconId: 'clock' }, { iconId: 'heart' }],
    },
    {
      id: 'zb-behandelingen',
      type: 'services_grid',
      variant: 'cards_3col',
      // `media: null` on every item, and that is not an omission: `services_grid.tsx` renders an
      // item image for the `image_tiles` variant only, so a `cards_3col` card carrying a MediaRef
      // would reference an asset the component never draws. The nightclub's `image_tiles` grid is
      // where the item imagery is shown.
      items: [
        { media: null, target: { kind: 'anchor', sectionId: 'zb-faq' }, showPrice: true },
        { media: null, target: { kind: 'anchor', sectionId: 'zb-faq' }, showPrice: true },
        { media: null, target: { kind: 'page', pageId: 'zb-p-afspraak' }, showPrice: true },
      ],
    },
    {
      id: 'zb-stappen',
      type: 'process_steps',
      variant: 'numbered_horizontal',
      items: [{ iconId: 'phone' }, { iconId: 'clock' }, { iconId: 'shield' }, { iconId: 'heart' }],
    },
    {
      id: 'zb-team',
      type: 'team',
      variant: 'portraits_grid',
      items: [
        { media: { refId: 'team-1', focalPoint: 'top' }, showBio: true },
        { media: { refId: 'team-2', focalPoint: 'top' }, showBio: true },
        { media: { refId: 'team-3', focalPoint: 'top' }, showBio: true },
      ],
    },
    {
      id: 'zb-faq',
      type: 'faq',
      variant: 'two_column',
      emitFaqSchema: true,
      items: [
        { expandedByDefault: false },
        { expandedByDefault: false },
        { expandedByDefault: false },
        { expandedByDefault: false },
      ],
    },
    { id: 'zb-hours', type: 'map_hours', variant: 'hours_only', showRouteCta: false },
    {
      id: 'zb-cta',
      type: 'cta_band',
      variant: 'accent_full',
      media: null,
      ctas: [
        { target: { kind: 'page', pageId: 'zb-p-afspraak' }, style: 'primary' },
        { target: { kind: 'email', _: null }, style: 'ghost' },
      ],
    },
  ],
  afspraak: [
    {
      id: 'zb-afspraak-hero',
      type: 'hero',
      variant: 'image_split',
      media: { refId: 'balie', focalPoint: 'center' },
      ctas: [{ target: { kind: 'tel', _: null }, style: 'primary' }],
      showTrustline: false,
    },
    {
      id: 'zb-booking',
      type: 'booking',
      variant: 'inline_calendar',
      provider: 'native',
      providerLink: null,
    },
    {
      id: 'zb-form',
      type: 'contact_form',
      variant: 'stacked',
      fields: [
        { name: 'name', required: true },
        { name: 'email', required: true },
        { name: 'phone', required: true },
        { name: 'service', required: false },
        { name: 'message', required: false },
        { name: 'consent', required: true },
      ],
    },
  ],
  privacy: [
    {
      id: 'zb-privacy',
      type: 'rich_text',
      variant: 'prose_wide',
      paragraphs: [
        { style: 'lead' },
        { style: 'paragraph' },
        { style: 'paragraph' },
        { style: 'note' },
      ],
    },
  ],
};

const ZILVERBERK_PAGES: readonly PageDoc[] = [
  page({
    pageId: 'zb-p-home',
    pageKey: 'home',
    role: 'home',
    slug: '',
    title: 'Tandartspraktijk Zilverberk — Amersfoort',
    description:
      'Tandheelkunde in Amersfoort-Noord: controle, mondhygiëne en restauratieve zorg. Vaste behandelaars, avondspreekuur op dinsdag, nieuwe patiënten welkom.',
    showInNav: true,
    sortOrder: 0,
    sections: ZILVERBERK_SECTIONS.home ?? [],
  }),
  page({
    pageId: 'zb-p-afspraak',
    pageKey: 'afspraak',
    role: 'booking',
    slug: 'afspraak',
    title: 'Afspraak maken — Tandartspraktijk Zilverberk',
    description:
      'Maak online een afspraak voor een controle of een behandeling, of schrijf je in als nieuwe patiënt. Bij spoed bellen we dezelfde dag terug.',
    showInNav: true,
    sortOrder: 1,
    sections: ZILVERBERK_SECTIONS.afspraak ?? [],
  }),
  page({
    pageId: 'zb-p-privacy',
    pageKey: 'privacy',
    role: 'privacy',
    slug: 'privacy',
    title: 'Privacy en dossier — Tandartspraktijk Zilverberk',
    description:
      'Hoe wij met je medisch dossier omgaan: welke gegevens we vastleggen, wie ze mag inzien, hoe lang we ze bewaren en hoe je ze opvraagt.',
    showInNav: false,
    sortOrder: 2,
    sections: ZILVERBERK_SECTIONS.privacy ?? [],
  }),
];

const ZILVERBERK_COPY: LocaleCopy = {
  ...pageSlots('zb-p-home', {
    title: 'Tandartspraktijk Zilverberk — Amersfoort',
    description:
      'Tandheelkunde in Amersfoort-Noord: controle, mondhygiëne en restauratieve zorg. Vaste behandelaars, avondspreekuur op dinsdag, nieuwe patiënten welkom.',
    slugSeed: 'home',
    nav: 'Home',
  }),
  ...pageSlots('zb-p-afspraak', {
    title: 'Afspraak maken — Tandartspraktijk Zilverberk',
    description:
      'Maak online een afspraak voor een controle of een behandeling, of schrijf je in als nieuwe patiënt. Bij spoed bellen we dezelfde dag terug.',
    slugSeed: 'afspraak',
    nav: 'Afspraak maken',
  }),
  ...pageSlots('zb-p-privacy', {
    title: 'Privacy en dossier — Tandartspraktijk Zilverberk',
    description:
      'Hoe wij met je medisch dossier omgaan: welke gegevens we vastleggen, wie ze mag inzien, hoe lang we ze bewaren en hoe je ze opvraagt.',
    slugSeed: 'privacy',
    nav: null,
  }),

  ...slotsOf('zb-hero', {
    headline: 'Tandheelkunde zonder verrassingen',
    subhead:
      'Je ziet bij ons steeds dezelfde behandelaar, je hoort vooraf wat iets kost, en we plannen ruim genoeg zodat uitleg geen haastwerk wordt.',
    trustline: 'BIG-geregistreerd · aangesloten bij de KNMT · nieuwe patiënten welkom',
    'ctas.0.label': 'Afspraak maken',
    'ctas.1.label': 'Bel de balie',
  }),
  ...slotsOf('zb-usp', {
    headline: 'Wat je van ons mag verwachten',
    'items.0.title': 'Eerst uitleg, dan behandelen',
    'items.0.body':
      'We laten op het scherm zien wat we zien, vertellen welke opties er zijn en wat ze kosten. Pas daarna maak je een keuze — ook als dat betekent dat je nog even wilt nadenken.',
    'items.1.title': 'Ruim ingeplande afspraken',
    'items.1.body':
      'Een controle duurt bij ons twintig minuten in plaats van tien. Dat scheelt uitloop voor de patiënten na jou, en het scheelt haast bij ons.',
    'items.2.title': 'Vaste behandelaar',
    'items.2.body':
      'Je hebt één tandarts en één mondhygiënist die je dossier kennen. Bij vakantie of ziekte nemen collega’s waar en lees je dat vooraf in de bevestiging.',
  }),
  ...slotsOf('zb-behandelingen', {
    headline: 'Behandelingen',
    'items.0.title': 'Periodieke controle',
    'items.0.body':
      'Twee keer per jaar, inclusief een korte poetsinstructie en, als het nodig is, röntgenfoto’s. Je krijgt de bevindingen op papier mee.',
    'items.0.price': 'vanaf € 26,00',
    'items.1.title': 'Mondhygiëne',
    'items.1.body':
      'Gebitsreiniging door onze mondhygiënist, met aandacht voor tandvlees en de plekken die thuis lastig te halen zijn.',
    'items.1.price': 'vanaf € 55,00',
    'items.2.title': 'Vullingen en kronen',
    'items.2.body':
      'Restauratieve zorg in composiet of keramiek. Je krijgt vooraf een begroting die we met je doorlopen, inclusief wat je verzekering vergoedt.',
    'items.2.price': 'op begroting',
  }),
  ...slotsOf('zb-stappen', {
    headline: 'Zo verloopt een eerste afspraak',
    'items.0.title': 'Aanmelden',
    'items.0.body':
      'Je meldt je online of telefonisch aan. We vragen naar je vorige praktijk, zodat we je dossier kunnen opvragen.',
    'items.1.title': 'Intake van 30 minuten',
    'items.1.body':
      'We nemen je gezondheid en je gebit door, maken zo nodig foto’s en bespreken waar je zelf last van hebt.',
    'items.2.title': 'Plan en begroting',
    'items.2.body':
      'Je krijgt een behandelplan met kosten per onderdeel. Er zit geen tijdsdruk op; je beslist thuis of aan de balie.',
    'items.3.title': 'Vervolgafspraken',
    'items.3.body':
      'We plannen alles in één keer in en sturen een herinnering per e-mail, twee dagen van tevoren.',
  }),
  ...slotsOf('zb-team', {
    headline: 'Het team',
    'items.0.name': 'A. de Wit',
    'items.0.role': 'Tandarts, praktijkhouder',
    'items.0.bio':
      'Werkt sinds 2009 als tandarts en opende Zilverberk in 2016. Houdt zich vooral bezig met restauratieve zorg en met patiënten die tegen de stoel opzien.',
    'items.1.name': 'M. Jansen',
    'items.1.role': 'Mondhygiënist',
    'items.1.bio':
      'Behandelt tandvleesproblemen en begeleidt patiënten met een implantaat. Geeft de poetsinstructies waar je thuis daadwerkelijk iets aan hebt.',
    'items.2.name': 'S. Bakker',
    'items.2.role': 'Tandartsassistent',
    'items.2.bio':
      'Eerste aanspreekpunt aan de balie en aan de stoel, regelt de planning en de verzekeringsvragen. Namen in dit demo-team zijn fictief.',
  }),
  ...slotsOf('zb-faq', {
    headline: 'Veelgestelde vragen',
    'items.0.question': 'Kan ik me inschrijven als nieuwe patiënt?',
    'items.0.answer':
      'Ja. We nemen op dit moment nieuwe patiënten aan, ook uit omliggende gemeenten. Bij de aanmelding vragen we je vorige praktijk om je dossier, zodat we niet opnieuw hoeven te beginnen met foto’s.',
    'items.1.question': 'Wat kost een controle?',
    'items.1.answer':
      'De tarieven in de mondzorg worden jaarlijks vastgesteld door de Nederlandse Zorgautoriteit; wij rekenen die tarieven. Een periodieke controle valt onder code C11. Bij grotere behandelingen krijg je vooraf een begroting.',
    'items.2.question': 'Ik heb spoed. Wat nu?',
    'items.2.answer':
      'Bel de praktijk tijdens openingstijden; we houden elke ochtend ruimte vrij voor spoed. Buiten openingstijden neemt de regionale spoeddienst waar; het nummer staat op ons antwoordapparaat en onderaan deze pagina.',
    'items.3.question': 'Is de praktijk toegankelijk met een rolstoel?',
    'items.3.answer':
      'Ja. De ingang is gelijkvloers, er is een aangepast toilet en twee van de vier behandelkamers zijn ruim genoeg om met een rolstoel naast de stoel te komen. Laat het bij het maken van de afspraak even weten.',
  }),
  ...slotsOf('zb-hours', {
    headline: 'Openingstijden',
    body: 'Tussen de middag is de praktijk gesloten van 12:30 tot 13:15. Op dinsdag is er avondspreekuur tot 20:00.',
  }),
  ...slotsOf('zb-cta', {
    headline: 'Klaar om een afspraak te maken?',
    body: 'Online plannen kan dag en nacht. Liever even overleggen of het bij je past? Stuur een e-mail; de balie leest mee op werkdagen.',
    'ctas.0.label': 'Afspraak maken',
    'ctas.1.label': 'Mail de balie',
  }),

  ...slotsOf('zb-afspraak-hero', {
    headline: 'Afspraak maken',
    subhead:
      'Kies zelf een moment in de agenda, of bel ons als het om spoed gaat. Nieuwe patiënten plannen we in op een intake van een half uur.',
    'ctas.0.label': 'Bel de balie',
  }),
  ...slotsOf('zb-booking', {
    headline: 'Online in de agenda',
    body: 'Kies een datum en laat je e-mailadres achter. Je krijgt binnen één werkdag een bevestiging met het tijdstip en de naam van je behandelaar.',
    ctaLabel: 'Datum aanvragen',
  }),
  ...slotsOf('zb-form', {
    headline: 'Inschrijven als nieuwe patiënt',
    body: 'Vul je gegevens in, dan nemen we contact op voor een intake. Vermeld je vorige praktijk, dan vragen we daar je dossier op.',
    submitLabel: 'Inschrijving versturen',
    'fields.0.label': 'Naam',
    'fields.1.label': 'E-mailadres',
    'fields.2.label': 'Telefoonnummer',
    'fields.3.label': 'Vorige praktijk',
    'fields.4.label': 'Toelichting',
    'fields.5.label':
      'Ik ga ermee akkoord dat mijn gegevens worden gebruikt om mijn inschrijving te verwerken.',
  }),

  ...slotsOf('zb-privacy', {
    headline: 'Privacy en je dossier',
    'paragraphs.0.text':
      'Als zorgverlener leggen we een medisch dossier aan. Dat is niet vrijblijvend: de Wet op de geneeskundige behandelingsovereenkomst verplicht ons ertoe, en dezelfde wet bepaalt wat we ermee mogen doen. Dit is voorbeeldtekst in een demonstratiesite.',
    'paragraphs.1.text':
      'In je dossier staan je gegevens, je behandelgeschiedenis, gemaakte foto’s en de correspondentie over je behandeling. Alleen je behandelaars en de assistenten die betrokken zijn bij je afspraak kunnen erbij. Voor het delen met een verwijzer of een specialist vragen we je toestemming.',
    'paragraphs.2.text':
      'Het dossier bewaren we twintig jaar na de laatste behandeling, zoals de wet voorschrijft. Facturatiegegevens gaan naar onze factoringpartner en worden zeven jaar bewaard voor de Belastingdienst.',
    'paragraphs.3.text':
      'Je hebt recht op inzage, op een kopie en op correctie van feitelijke onjuistheden. Vraag het aan de balie of stuur een e-mail; we reageren binnen vier weken en vragen je om je te legitimeren voordat we iets meegeven.',
  }),
};

const ZILVERBERK: DemoSite = {
  key: 'tandartspraktijk-zilverberk',
  label: 'Tandartspraktijk Zilverberk',
  archetype: 'clinical_trust',
  blurb:
    'Tandartspraktijk · witte grond, één rustige teal, Inter in twee gewichten, ronde hoeken en veel regelafstand.',
  origin: 'https://zilverberk.example',
  heroRefId: 'hero',
  heroPortraitRefId: 'hero-portrait',
  mapRefId: 'kaart',
  ogRefId: 'og',
  media: ZILVERBERK_MEDIA,
  reviews: placeholderReviews('een bezoek aan de praktijk'),
  doc: parseSiteDocOrThrow({
    schemaVersion: 1,
    siteId: 'site_demo_zilverberk',
    versionId: 'ver_demo_0003',
    theme: themeOf({
      dnaId: 'clinical_trust',
      paletteVariant: 'default',
      accentHueShift: '0',
      typeScaleId: 'regular',
      radiusId: 'round',
      densityId: 'regular',
      motionId: 'none',
      colorMode: 'light',
    }),
    locales: { default: NL, enabled: [NL] },
    chrome: {
      navStyle: 'logo_left_links_right',
      footerStyle: 'rich_3col_map',
      // A dental practice does not take patient questions over WhatsApp, so the widget is off.
      // This is also the demo that proves the chrome renders without it.
      whatsappEnabled: false,
    },
    pages: ZILVERBERK_PAGES,
    copy: { [NL]: ZILVERBERK_COPY },
    media: mediaManifest(ZILVERBERK_MEDIA, '#e7eef2'),
    links: {},
    jsonLdInputs: {
      schemaOrgType: 'Dentist',
      priceRange: null,
      servesCuisine: null,
      acceptsReservations: null,
      paymentAccepted: ['debit_card', 'invoice'],
      amenities: ['wheelchair_accessible', 'parking'],
    },
    facts: {
      businessName: 'Tandartspraktijk Zilverberk',
      legalName: 'Zilverberk Mondzorg B.V.',
      industryKey: 'dentist',
      shortDescription:
        'Tandheelkundige praktijk in Amersfoort-Noord met vaste behandelaars en ruim ingeplande afspraken.',
      contactEmail: 'balie@zilverberk.example',
      phoneE164: '+31335550164',
      whatsappE164: null,
      gbpUrl: null,
      address: {
        line1: 'Zilverberklaan 3',
        line2: 'Gebouw B',
        postalCode: '3818 RM',
        city: 'Amersfoort',
        country: 'NL',
        latitude: 52.1704,
        longitude: 5.3908,
        geoSource: 'geocoded',
      },
      serviceArea: null,
      openingHours: {
        tz: 'Europe/Amsterdam',
        byAppointmentOnly: false,
        spec: [
          {
            dayOfWeek: ['Monday', 'Wednesday', 'Thursday'],
            opens: '08:00',
            closes: '12:30',
          },
          {
            dayOfWeek: ['Monday', 'Wednesday', 'Thursday'],
            opens: '13:15',
            closes: '17:00',
          },
          { dayOfWeek: ['Tuesday'], opens: '08:00', closes: '12:30' },
          { dayOfWeek: ['Tuesday'], opens: '13:15', closes: '20:00' },
          { dayOfWeek: ['Friday'], opens: '08:00', closes: '13:00' },
        ],
        closed: ['Saturday', 'Sunday'],
        exceptions: [{ from: '2026-05-05', to: '2026-05-05', closed: true }],
      },
      reviewsSource: 'manual',
      vatId: 'NL003456789B01',
      companyRegistrationId: '61345678',
    },
    blog: [],
  }),
};

/* ══════════════════════════════════════════════════════════════════════════
 * 4 · garage_steel — Autobedrijf Hamerslag, a car garage
 * ══════════════════════════════════════════════════════════════════════════ */

const HAMERSLAG_MEDIA: readonly DemoMedia[] = [
  {
    refId: 'hero',
    kind: 'hero_landscape',
    width: 2400,
    height: 1350,
    alt: 'De werkplaats met twee bruggen',
  },
  {
    refId: 'hero-portrait',
    kind: 'hero_portrait',
    width: 1170,
    height: 2080,
    alt: 'De werkplaats, staande uitsnede',
  },
  { refId: 'werkplaats', kind: 'wide', width: 1600, height: 1067, alt: 'De hefbrug in gebruik' },
  { refId: 'balie', kind: 'wide', width: 1600, height: 1067, alt: 'De receptie van de werkplaats' },
  {
    refId: 'monteur-1',
    kind: 'portrait',
    width: 900,
    height: 1125,
    alt: 'Portret van een monteur',
  },
  {
    refId: 'monteur-2',
    kind: 'portrait',
    width: 900,
    height: 1125,
    alt: 'Portret van een tweede monteur',
  },
  {
    refId: 'monteur-3',
    kind: 'portrait',
    width: 900,
    height: 1125,
    alt: 'Portret van de werkplaatschef',
  },
  { refId: 'gereedschap', kind: 'square', width: 1200, height: 1200, alt: 'Gereedschapswand' },
  { refId: 'diagnose', kind: 'square', width: 1200, height: 1200, alt: 'Diagnoseapparatuur' },
  { refId: 'banden', kind: 'square', width: 1200, height: 1200, alt: 'Bandenopslag' },
  { refId: 'apk', kind: 'square', width: 1200, height: 1200, alt: 'De APK-straat' },
  { refId: 'kaart', kind: 'map', width: 640, height: 400, alt: '' },
  { refId: 'og', kind: 'og', width: 1200, height: 630, alt: '' },
];

const HAMERSLAG_SECTIONS: Readonly<Record<string, readonly SectionGen[]>> = {
  home: [
    {
      id: 'hs-hero',
      type: 'hero',
      variant: 'image_offset_grid',
      media: { refId: 'hero', focalPoint: 'center' },
      ctas: [
        { target: { kind: 'tel', _: null }, style: 'primary' },
        { target: { kind: 'page', pageId: 'hs-p-contact' }, style: 'secondary' },
      ],
      showTrustline: true,
    },
    {
      id: 'hs-usp',
      type: 'usp_trio',
      variant: 'numbered_cards',
      items: [{ iconId: 'wrench' }, { iconId: 'euro' }, { iconId: 'truck' }],
    },
    {
      id: 'hs-diensten',
      type: 'services_grid',
      variant: 'list_split',
      items: [
        { media: null, target: { kind: 'tel', _: null }, showPrice: true },
        { media: null, target: { kind: 'tel', _: null }, showPrice: true },
        { media: null, target: { kind: 'page', pageId: 'hs-p-contact' }, showPrice: true },
        { media: null, target: null, showPrice: true },
      ],
    },
    {
      id: 'hs-stappen',
      type: 'process_steps',
      variant: 'arrow_flow',
      items: [{ iconId: 'phone' }, { iconId: 'wrench' }, { iconId: 'euro' }],
    },
    {
      id: 'hs-cijfers',
      type: 'stats_band',
      variant: 'boxed',
      items: [{ iconId: 'clock' }, { iconId: 'wrench' }, { iconId: 'star' }],
    },
    { id: 'hs-reviews', type: 'reviews', variant: 'single_large', source: 'manual' },
    {
      id: 'hs-cta',
      type: 'cta_band',
      variant: 'image_overlay',
      media: { refId: 'werkplaats', focalPoint: 'center' },
      ctas: [
        { target: { kind: 'tel', _: null }, style: 'primary' },
        { target: { kind: 'whatsapp', _: null }, style: 'secondary' },
      ],
    },
    { id: 'hs-hours', type: 'map_hours', variant: 'map_right', showRouteCta: true },
  ],
  werkplaats: [
    {
      id: 'hs-wp-hero',
      type: 'hero',
      variant: 'image_split',
      media: { refId: 'balie', focalPoint: 'center' },
      ctas: [{ target: { kind: 'tel', _: null }, style: 'primary' }],
      showTrustline: false,
    },
    {
      id: 'hs-over',
      type: 'about',
      variant: 'image_text',
      media: { refId: 'werkplaats', focalPoint: 'center' },
      paragraphs: [{ emphasis: 'lead' }, { emphasis: 'normal' }, { emphasis: 'normal' }],
      cta: null,
    },
    {
      id: 'hs-team',
      type: 'team',
      variant: 'list_compact',
      items: [
        { media: { refId: 'monteur-1', focalPoint: 'top' }, showBio: true },
        { media: { refId: 'monteur-2', focalPoint: 'top' }, showBio: true },
        { media: { refId: 'monteur-3', focalPoint: 'top' }, showBio: false },
      ],
    },
    {
      id: 'hs-gallery',
      type: 'gallery',
      variant: 'grid_square',
      media: [
        { refId: 'gereedschap', focalPoint: 'center' },
        { refId: 'diagnose', focalPoint: 'center' },
        { refId: 'banden', focalPoint: 'center' },
        { refId: 'apk', focalPoint: 'center' },
      ],
      showCaptions: false,
    },
  ],
  contact: [
    {
      id: 'hs-contact-hero',
      type: 'hero',
      variant: 'type_centered',
      media: null,
      ctas: [{ target: { kind: 'tel', _: null }, style: 'primary' }],
      showTrustline: false,
    },
    {
      id: 'hs-form',
      type: 'contact_form',
      variant: 'split_map',
      fields: [
        { name: 'name', required: true },
        { name: 'phone', required: true },
        { name: 'email', required: false },
        { name: 'service', required: true },
        { name: 'date', required: false },
        { name: 'message', required: false },
        { name: 'consent', required: true },
      ],
    },
  ],
};

const HAMERSLAG_PAGES: readonly PageDoc[] = [
  page({
    pageId: 'hs-p-home',
    pageKey: 'home',
    role: 'home',
    slug: '',
    title: 'Autobedrijf Hamerslag — onderhoud en APK in Eindhoven',
    description:
      'Onderhoud, APK en reparatie voor alle merken in Eindhoven-Noord. Vaste prijzen vooraf, vervangend vervoer, klaar terwijl u wacht bij kleine klussen.',
    showInNav: true,
    sortOrder: 0,
    sections: HAMERSLAG_SECTIONS.home ?? [],
  }),
  page({
    pageId: 'hs-p-werkplaats',
    pageKey: 'werkplaats',
    role: 'about',
    slug: 'werkplaats',
    title: 'De werkplaats en het team — Autobedrijf Hamerslag',
    description:
      'Vier bruggen, een APK-straat en drie vaste monteurs. Wie er aan uw auto werkt, met welke apparatuur, en waarom we merkonafhankelijk blijven.',
    showInNav: true,
    sortOrder: 1,
    sections: HAMERSLAG_SECTIONS.werkplaats ?? [],
  }),
  page({
    pageId: 'hs-p-contact',
    pageKey: 'contact',
    role: 'contact',
    slug: 'contact',
    title: 'Afspraak en contact — Autobedrijf Hamerslag',
    description:
      'Vraag een afspraak aan voor onderhoud, APK of een reparatie. Bellen kan tijdens werkplaatsuren; het formulier lezen we dezelfde dag.',
    showInNav: true,
    sortOrder: 2,
    sections: HAMERSLAG_SECTIONS.contact ?? [],
  }),
];

const HAMERSLAG_COPY: LocaleCopy = {
  ...pageSlots('hs-p-home', {
    title: 'Autobedrijf Hamerslag — onderhoud en APK in Eindhoven',
    description:
      'Onderhoud, APK en reparatie voor alle merken in Eindhoven-Noord. Vaste prijzen vooraf, vervangend vervoer, klaar terwijl u wacht bij kleine klussen.',
    slugSeed: 'home',
    nav: 'Home',
  }),
  ...pageSlots('hs-p-werkplaats', {
    title: 'De werkplaats en het team — Autobedrijf Hamerslag',
    description:
      'Vier bruggen, een APK-straat en drie vaste monteurs. Wie er aan uw auto werkt, met welke apparatuur, en waarom we merkonafhankelijk blijven.',
    slugSeed: 'werkplaats',
    nav: 'Werkplaats',
  }),
  ...pageSlots('hs-p-contact', {
    title: 'Afspraak en contact — Autobedrijf Hamerslag',
    description:
      'Vraag een afspraak aan voor onderhoud, APK of een reparatie. Bellen kan tijdens werkplaatsuren; het formulier lezen we dezelfde dag.',
    slugSeed: 'contact',
    nav: 'Contact',
  }),

  ...slotsOf('hs-hero', {
    headline: 'Onderhoud en APK, prijs vooraf bekend',
    subhead:
      'Alle merken, vier bruggen en drie vaste monteurs in Eindhoven-Noord. U hoort wat het kost voordat we beginnen, en u belt met de monteur zelf.',
    trustline: 'Sinds 1998 · APK-erkend · vervangend vervoer beschikbaar',
    'ctas.0.label': 'Bel de werkplaats',
    'ctas.1.label': 'Afspraak aanvragen',
  }),
  ...slotsOf('hs-usp', {
    headline: 'Waarom Hamerslag',
    'items.0.title': 'Alle merken, één werkplaats',
    'items.0.body':
      'We werken merkonafhankelijk met originele of gelijkwaardige onderdelen. Uw fabrieksgarantie blijft daarbij gewoon geldig; we noteren elke beurt in het digitale onderhoudsboekje.',
    'items.1.title': 'Prijs vooraf, geen meerwerk zonder belletje',
    'items.1.body':
      'U krijgt een prijsopgave voordat we beginnen. Komen we onderweg iets tegen, dan bellen we eerst. Zonder uw akkoord draaien we geen bout extra.',
    'items.2.title': 'Vervangend vervoer',
    'items.2.body':
      'Voor onderhoud dat langer duurt dan een halve dag staat er een leenauto klaar. Reserveer hem bij het maken van de afspraak; het zijn er drie.',
  }),
  ...slotsOf('hs-diensten', {
    headline: 'Werkzaamheden en tarieven',
    'items.0.title': 'APK-keuring',
    'items.0.body':
      'Inclusief afmelden bij de RDW. Kleine herstelpunten voeren we in overleg direct uit, zodat u niet twee keer hoeft te komen.',
    'items.0.price': '€ 49,00',
    'items.1.title': 'Grote beurt',
    'items.1.body':
      'Olie en filters, remmen, vloeistoffen, banden en een proefrit. Inclusief een schriftelijk rapport met wat nu moet en wat kan wachten.',
    'items.1.price': 'vanaf € 289,00',
    'items.2.title': 'Storingsdiagnose',
    'items.2.body':
      'Uitlezen van de foutcodes en meten aan het systeem zelf, want een code is een aanwijzing en geen diagnose. Eerste uur vast tarief.',
    'items.2.price': '€ 89,00 per uur',
    'items.3.title': 'Banden en wielen',
    'items.3.body':
      'Wisselen, balanceren en opslag van uw seizoensset in ons rek. Uitlijnen doen we op afspraak, op de bank achterin.',
    'items.3.price': 'vanaf € 25,00',
  }),
  ...slotsOf('hs-stappen', {
    headline: 'Zo werkt het',
    'items.0.title': '1 · Bellen of aanvragen',
    'items.0.body':
      'U geeft het kenteken en de klacht door. Wij kijken meteen wat de historie zegt en plannen de juiste tijd in.',
    'items.1.title': '2 · Wij kijken en bellen',
    'items.1.body':
      'De monteur inspecteert en belt u met de bevindingen en de prijs. U beslist wat er wel en niet gebeurt.',
    'items.2.title': '3 · Klaar en afgemeld',
    'items.2.body':
      'U krijgt de vervangen onderdelen te zien, de factuur is de prijsopgave, en de beurt staat in het onderhoudsboekje.',
  }),
  ...slotsOf('hs-cijfers', {
    headline: 'De werkplaats in cijfers',
    'items.0.value': '27',
    'items.0.label': 'Jaar aan de Ankerslagweg',
    'items.1.value': '4',
    'items.1.label': 'Bruggen, waarvan één APK-straat',
    'items.2.value': '3',
    'items.2.label': 'Vaste monteurs, geen uitzendkrachten',
  }),
  ...slotsOf('hs-reviews', { headline: 'Wat klanten zeggen' }),
  ...slotsOf('hs-cta', {
    headline: 'Auto nodig voor de APK?',
    body: 'Bel even, dan zeggen we meteen wanneer er plek is. Meestal kan het binnen drie werkdagen, en bij een lekke band of een startprobleem vaak dezelfde dag.',
    'ctas.0.label': 'Bel de werkplaats',
    'ctas.1.label': 'App het kenteken',
  }),
  ...slotsOf('hs-hours', {
    headline: 'Openingstijden en route',
    body: 'De werkplaats zit op het bedrijventerrein, tweede straat na de rotonde. Sleutelinlevering kan buiten openingstijden via de brievenbus naast de deur.',
    routeCtaLabel: 'Route in Google Maps',
  }),

  ...slotsOf('hs-wp-hero', {
    headline: 'De werkplaats',
    subhead:
      'Vier bruggen, een eigen APK-straat en gereedschap waarmee we ook aan hybride auto’s mogen werken. Kom gerust een keer kijken.',
    'ctas.0.label': 'Bel de werkplaats',
  }),
  ...slotsOf('hs-over', {
    headline: 'Over Hamerslag',
    'paragraphs.0.text':
      'Wij begonnen in 1998 met één brug en een aanhanger. Wat sindsdien hetzelfde bleef: u spreekt de monteur die aan uw auto werkt, en u hoort de prijs voordat de sleutel erin gaat.',
    'paragraphs.1.text':
      'De werkplaats is erkend voor APK en aangesloten bij de branchevereniging. We investeren elk jaar in apparatuur en in scholing, want een auto van nu is voor de helft software; zonder de juiste uitleesapparatuur en de juiste opleiding kom je er niet meer aan te pas.',
    'paragraphs.2.text':
      'Merkonafhankelijk blijven is een bewuste keuze. Het betekent dat we onderdelen kunnen kiezen op kwaliteit en prijs, en dat u niet vastzit aan één leverancier zodra de fabrieksgarantie afloopt.',
  }),
  ...slotsOf('hs-team', {
    headline: 'Wie er aan uw auto werkt',
    'items.0.name': 'R. Vermeulen',
    'items.0.role': 'Eerste monteur',
    'items.0.bio':
      'Vijftien jaar in het vak, gespecialiseerd in diagnose en elektronica. Als er een storing is die niemand vindt, is dit degene die hem vindt.',
    'items.1.name': 'K. Oomen',
    'items.1.role': 'Monteur en APK-keurmeester',
    'items.1.bio':
      'Voert de keuringen uit en meldt af bij de RDW. Legt bij het afhalen uit wat er is afgekeurd en waarom, met het onderdeel in de hand.',
    'items.2.name': 'J. Hamerslag',
    'items.2.role': 'Werkplaatschef',
  }),
  ...slotsOf('hs-gallery', { headline: 'In de werkplaats' }),

  ...slotsOf('hs-contact-hero', {
    headline: 'Afspraak maken',
    subhead:
      'Bellen gaat het snelst; het formulier hieronder lezen we dezelfde werkdag. Geef het kenteken door, dan zien we meteen wat er eerder is gedaan.',
    'ctas.0.label': 'Bel de werkplaats',
  }),
  ...slotsOf('hs-form', {
    headline: 'Afspraak aanvragen',
    body: 'Vul in wat er moet gebeuren en wanneer het u schikt. U krijgt dezelfde werkdag een voorstel met dag, tijd en een prijsindicatie.',
    submitLabel: 'Aanvraag versturen',
    'fields.0.label': 'Naam',
    'fields.1.label': 'Telefoonnummer',
    'fields.2.label': 'E-mailadres',
    'fields.3.label': 'Kenteken en soort klus',
    'fields.4.label': 'Voorkeursdatum',
    'fields.5.label': 'Toelichting',
    'fields.6.label':
      'Ik ga ermee akkoord dat mijn gegevens worden gebruikt om deze aanvraag te beantwoorden.',
  }),
};

const HAMERSLAG: DemoSite = {
  key: 'autobedrijf-hamerslag',
  label: 'Autobedrijf Hamerslag',
  archetype: 'garage_steel',
  blurb:
    'Autogarage · koele staalgrijze grond, veiligheidsamber accent, smalle Archivo-koppen, scherpe hoeken en grote knoppen.',
  origin: 'https://hamerslag.example',
  heroRefId: 'hero',
  heroPortraitRefId: 'hero-portrait',
  mapRefId: 'kaart',
  ogRefId: 'og',
  media: HAMERSLAG_MEDIA,
  reviews: placeholderReviews('een onderhoudsbeurt'),
  doc: parseSiteDocOrThrow({
    schemaVersion: 1,
    siteId: 'site_demo_hamerslag',
    versionId: 'ver_demo_0004',
    theme: themeOf({
      dnaId: 'garage_steel',
      paletteVariant: 'default',
      accentHueShift: '0',
      typeScaleId: 'compact',
      radiusId: 'sharp',
      densityId: 'compact',
      motionId: 'none',
      colorMode: 'light',
    }),
    locales: { default: NL, enabled: [NL] },
    chrome: {
      navStyle: 'minimal_burger',
      footerStyle: 'compact_2col',
      whatsappEnabled: true,
    },
    pages: HAMERSLAG_PAGES,
    copy: { [NL]: HAMERSLAG_COPY },
    media: mediaManifest(HAMERSLAG_MEDIA, '#2b2d31'),
    links: {},
    jsonLdInputs: {
      schemaOrgType: 'AutoRepair',
      priceRange: '€€',
      servesCuisine: null,
      acceptsReservations: true,
      paymentAccepted: ['ideal', 'debit_card', 'invoice', 'cash'],
      amenities: ['parking', 'ev_charging', 'wheelchair_accessible'],
    },
    facts: {
      businessName: 'Autobedrijf Hamerslag',
      legalName: 'Hamerslag Autotechniek V.O.F.',
      industryKey: 'car_repair',
      shortDescription:
        'Merkonafhankelijke werkplaats in Eindhoven voor onderhoud, APK en reparatie, met vaste prijzen vooraf.',
      contactEmail: 'werkplaats@hamerslag.example',
      phoneE164: '+31405550129',
      whatsappE164: '+31612000429',
      gbpUrl: null,
      address: {
        line1: 'Ankerslagweg 22',
        line2: null,
        postalCode: '5651 GX',
        city: 'Eindhoven',
        country: 'NL',
        latitude: 51.4512,
        longitude: 5.4381,
        geoSource: 'geocoded',
      },
      serviceArea: null,
      openingHours: {
        tz: 'Europe/Amsterdam',
        byAppointmentOnly: false,
        spec: [
          {
            dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
            opens: '07:30',
            closes: '17:30',
          },
          { dayOfWeek: ['Saturday'], opens: '09:00', closes: '13:00' },
        ],
        closed: ['Sunday'],
        exceptions: [{ from: '2026-12-24', to: '2027-01-02', closed: true }],
      },
      reviewsSource: 'manual',
      vatId: 'NL004567890B01',
      companyRegistrationId: '17456789',
    },
    blog: [],
  }),
};

/* ── The catalogue ──────────────────────────────────────────────────────── */

/** The four demo sites, one per Phase 1 design DNA, in archetype order. */
export const DEMO_SITES: readonly DemoSite[] = [NEONKAAI, NUVOLA, ZILVERBERK, HAMERSLAG];

/** One demo site by key, or `undefined`. */
export function demoSiteByKey(key: string): DemoSite | undefined {
  return DEMO_SITES.find((site) => site.key === key);
}
