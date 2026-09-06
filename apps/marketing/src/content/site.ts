/**
 * Site-wide identity, origins and navigation for the marketing surface.
 *
 * `src/content/` here holds plain, typed data modules rather than an Astro content collection:
 * Phase 1 marketing copy is authored in code so it is typechecked and greppable, and there is no
 * markdown parser anywhere in this repo (architecture §S1, "deliberately absent"). The content
 * layer arrives with the blog in Phase 3.
 */

/**
 * Reads a `PUBLIC_*` build variable, falling back when it is unset or blank.
 *
 * Access is written out literally (never `import.meta.env[key]`) because Vite only substitutes
 * literal property access at build time. Values arrive as `unknown` and are narrowed rather than
 * asserted, so a variable set to a non-string by a misconfigured CI never reaches a page.
 */
function envOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

/**
 * Origin of the dashboard and editor (architecture §1.1: `app.` on the control-plane domain).
 * Phase 2 surface; the marketing nav links to its sign-in route.
 */
export const appOrigin: string = envOr(
  import.meta.env.PUBLIC_APP_ORIGIN,
  'https://app.aibuilder.app',
);

/** Origin of the public API the onboarding island talks to (architecture §S4). */
export const apiOrigin: string = envOr(
  import.meta.env.PUBLIC_API_ORIGIN,
  'https://api.aibuilder.app',
);

/**
 * The tenant registrable domain. Generated sites are served at `<slug>.${sitesRootDomain}`.
 * It is a different registrable domain from the marketing host, permanently (architecture §1.1),
 * and it is quoted in marketing copy — so it is a variable, never a literal in a sentence.
 */
export const sitesRootDomain: string = envOr(
  import.meta.env.PUBLIC_SITES_ROOT_DOMAIN,
  'mijnsaas.com',
);

/** Example tenant host used in copy, so the reader sees the real shape of their future address. */
export const exampleTenantHost = `bakkerij-jansen.${sitesRootDomain}`;

export interface Brand {
  /** Product name as written in running copy and in the wordmark. */
  readonly name: string;
  /** One sentence, used as the `Organization.description` and the OG fallback description. */
  readonly description: string;
}

export const brand: Brand = {
  name: 'aibuilder',
  description:
    'aibuilder maakt in enkele minuten een complete, snelle en vindbare website voor kleine ondernemers in Europa.',
};

export interface LegalEntity {
  readonly legalName: string;
  readonly streetAddress: string;
  readonly postalCode: string;
  readonly city: string;
  /** ISO 3166-1 alpha-2. */
  readonly country: string;
  readonly chamberOfCommerce: string;
  readonly vatId: string;
  readonly privacyEmail: string;
  readonly supportEmail: string;
}

/**
 * Marker for a legal identity field that the operator has not supplied yet. It is rendered
 * verbatim, in brackets, so an incomplete privacy policy is impossible to publish by accident —
 * and so nothing is ever invented. Fabricating a KvK number or a controller address on a published
 * privacy statement is a GDPR Art. 13 failure, not a cosmetic gap.
 */
const UNSET = '[nog in te vullen]';

export const legalEntity: LegalEntity = {
  legalName: envOr(import.meta.env.PUBLIC_LEGAL_NAME, UNSET),
  streetAddress: envOr(import.meta.env.PUBLIC_LEGAL_STREET, UNSET),
  postalCode: envOr(import.meta.env.PUBLIC_LEGAL_POSTAL_CODE, UNSET),
  city: envOr(import.meta.env.PUBLIC_LEGAL_CITY, UNSET),
  country: envOr(import.meta.env.PUBLIC_LEGAL_COUNTRY, 'NL'),
  chamberOfCommerce: envOr(import.meta.env.PUBLIC_LEGAL_KVK, UNSET),
  vatId: envOr(import.meta.env.PUBLIC_LEGAL_VAT_ID, UNSET),
  privacyEmail: envOr(import.meta.env.PUBLIC_LEGAL_PRIVACY_EMAIL, UNSET),
  supportEmail: envOr(import.meta.env.PUBLIC_LEGAL_SUPPORT_EMAIL, UNSET),
};

/**
 * True when every legal identity field is supplied. Structured data and `mailto:` links are
 * emitted only when this holds — a `mailto:[nog in te vullen]` is worse than no link, and a
 * `PostalAddress` node full of placeholders is worse than no address node.
 */
export const legalEntityIsConfigured: boolean = Object.values(legalEntity).every(
  (value) => value !== UNSET,
);

if (!legalEntityIsConfigured) {
  const missing = Object.entries(legalEntity)
    .filter(([, value]) => value === UNSET)
    .map(([key]) => key);
  // Evaluated once per build (ES module singleton), not once per page.
  console.warn(
    `[marketing] Legal identity incomplete: ${missing.join(', ')}. ` +
      'Set the matching PUBLIC_LEGAL_* build variables before deploying to a public host — ' +
      'the privacy statement and terms will render bracketed placeholders until you do.',
  );
}

/**
 * Date the legal texts were last substantively revised, ISO 8601. Bumped by hand when the wording
 * changes — never derived from the build time, because "laatst bijgewerkt: vandaag" on every deploy
 * destroys the only signal a reader has that a policy actually changed.
 */
export const legalRevisedOn = '2026-09-06';

export interface NavLink {
  readonly label: string;
  readonly href: string;
}

/** Primary navigation, left cell of the three-cell nav grid. In-page anchors on the home page. */
export const primaryNav: readonly NavLink[] = [
  { label: 'Functies', href: '/#functies' },
  { label: 'Prijzen', href: '/prijzen/' },
  { label: 'Vragen', href: '/#vragen' },
];

/** Footer link groups. Every legal document the site is required to publish is reachable here. */
export const footerNav: readonly { readonly title: string; readonly links: readonly NavLink[] }[] =
  [
    {
      title: 'Product',
      links: [
        { label: 'Functies', href: '/#functies' },
        { label: 'Prijzen', href: '/prijzen/' },
        { label: 'Veelgestelde vragen', href: '/#vragen' },
        { label: 'Beginnen', href: '/start/' },
      ],
    },
    {
      title: 'Juridisch',
      links: [
        { label: 'Privacyverklaring', href: '/privacy/' },
        { label: 'Algemene voorwaarden', href: '/voorwaarden/' },
        { label: 'Cookieverklaring', href: '/cookies/' },
      ],
    },
  ];

/** Sign-in destination on the Phase 2 dashboard. */
export const signInUrl = `${appOrigin}/inloggen`;

/** The onboarding entry point. A real page, so the CTA works with JavaScript disabled. */
export const startPath = '/start/';

/**
 * The Open Graph / Twitter card image. Like the hero media, the binary is produced once by the
 * media pipeline and dropped into `public/media/og/` under exactly this name; 1200x630 is the size
 * every major platform crops from without letterboxing.
 */
export const openGraphImage = {
  url: '/media/og/og-default-1200x630.jpg',
  width: 1200,
  height: 630,
  alt: 'Een gegenereerde bedrijfswebsite op een telefoon en een laptop.',
} as const;
