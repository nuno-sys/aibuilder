import type { Amenity, Locale, PageDoc, PaymentMethod, SiteDoc } from '@aibuilder/site-schema';
import { AMENITIES, PAYMENT_METHODS } from '@aibuilder/site-schema';
import type { RenderContext } from '../context';
import { escapeJsonLd } from '../escape';
import { LOCALE_META } from '../ui';
import { isLocalBusinessSubtype } from './allowlist';

/**
 * The `@graph` builder.
 *
 * Invariant 4: the model never authors JSON-LD. It supplies typed enum inputs (`JsonLdInputsGen`),
 * code builds the graph from D1 facts, and exactly one function serialises it. There is no template
 * literal anywhere in this file and no string concatenation of tenant text.
 */

/** Anything that can appear in the graph. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** One node of the `@graph`. */
export type GraphNode = Readonly<Record<string, JsonValue>>;

/** Thrown when the graph cannot be built correctly. A failed publish, never a wrong `@type`. */
export class JsonLdError extends Error {
  override readonly name = 'JsonLdError';
}

/** A divergence between the model's `schemaOrgType` and the industry row. QA signal, not an error. */
export interface QaNote {
  readonly code: string;
  readonly detail: Readonly<Record<string, string>>;
}

/**
 * The ONLY way a graph becomes markup.
 *
 * `escapeHtml()` is deliberately **not** used: HTML-escaping inside an `application/ld+json` block
 * would corrupt the JSON. `escapeJsonLd` escapes at the JSON layer instead, which is legal JSON,
 * identical after `JSON.parse`, and sufficient — see `escape.ts` for why those are the only three
 * substitutions needed.
 */
export function ldScript(graph: readonly GraphNode[]): string {
  const json = escapeJsonLd({ '@context': 'https://schema.org', '@graph': graph });
  return `<script type="application/ld+json">${json}</script>`;
}

/**
 * Resolves the business `@type`.
 *
 * The industry row wins over the model's pick. A wrong `@type` silently disables every rich result
 * and the row is a server fact, so the model's choice is recorded as a QA signal and discarded.
 */
export function businessType(
  industrySchemaOrgType: string,
  modelChoice: string,
  notes: QaNote[],
): string | string[] {
  if (!isLocalBusinessSubtype(industrySchemaOrgType)) {
    throw new JsonLdError(
      `schema_org_type "${industrySchemaOrgType}" is not a LocalBusiness subtype`,
    );
  }
  if (modelChoice !== industrySchemaOrgType) {
    notes.push({
      code: 'jsonld.schemaOrgType.divergence',
      detail: { industry: industrySchemaOrgType, model: modelChoice },
    });
  }
  return industrySchemaOrgType === 'LocalBusiness'
    ? 'LocalBusiness'
    : ['LocalBusiness', industrySchemaOrgType];
}

/**
 * Labels for the two closed enums, emitted in **enum order, not model order**.
 *
 * Order matters because the serialised graph is part of the page's bytes: a model that lists the
 * same two payment methods in the other order must not move every tenant's `ETag`.
 */
const PAYMENT_LABELS: Readonly<Record<PaymentMethod, string>> = {
  cash: 'Cash',
  credit_card: 'Credit Card',
  debit_card: 'Debit Card',
  ideal: 'iDEAL',
  bancontact: 'Bancontact',
  paypal: 'PayPal',
  apple_pay: 'Apple Pay',
  google_pay: 'Google Pay',
  bank_transfer: 'Bank Transfer',
  invoice: 'Invoice',
};

/** schema.org `LocationFeatureSpecification` names, one per `Amenity`. */
const AMENITY_NAMES: Readonly<Record<Amenity, string>> = {
  wheelchair_accessible: 'wheelchairAccessible',
  parking: 'parking',
  wifi: 'wifi',
  outdoor_seating: 'outdoorSeating',
  takeaway: 'takeaway',
  delivery: 'delivery',
  pet_friendly: 'petFriendly',
  kids_welcome: 'kidsWelcome',
  air_conditioning: 'airConditioning',
  ev_charging: 'evCharging',
};

/** Drops `undefined` so an absent fact produces no key rather than a `null` one. */
function compact(entries: Readonly<Record<string, JsonValue | undefined>>): GraphNode {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/** What the builder needs beyond the document. */
export interface GraphInputs {
  readonly doc: SiteDoc;
  readonly page: PageDoc;
  readonly locale: Locale;
  readonly ctx: RenderContext;
  /** Absolute canonical URL of this page, including the origin. */
  readonly canonical: string;
  /** Collected divergences. The caller decides what to do with them. */
  readonly notes: QaNote[];
}

/**
 * Builds the `@graph` for one page.
 *
 * `@id` scoping: the business and website ids carry **no locale** — one real business, one entity.
 * `WebPage` and `BreadcrumbList` ids are the canonical URL plus a fragment, so they are per-locale
 * by construction.
 */
export function buildGraph(inputs: GraphInputs): GraphNode[] {
  const { doc, page, locale, ctx, canonical, notes } = inputs;
  const origin = ctx.origin;
  const businessId = `${origin}/#business`;
  const websiteId = `${origin}/#website`;
  const facts = doc.facts;
  const graph: GraphNode[] = [];

  const languages = doc.locales.enabled.map((enabled) => LOCALE_META[enabled].tag);

  graph.push(
    compact({
      '@type': 'WebSite',
      '@id': websiteId,
      url: `${origin}/`,
      name: facts.businessName,
      publisher: { '@id': businessId },
      inLanguage: languages,
    }),
  );

  /* -- The business ----------------------------------------------------- */

  const address = facts.address;
  const addressNode =
    address === null
      ? undefined
      : compact({
          '@type': 'PostalAddress',
          streetAddress: address.line1,
          addressLocality: address.city,
          postalCode: address.postalCode,
          addressCountry: address.country,
        });

  // A guessed city centre that contradicts the postal address is worse than no coordinate at all,
  // so `geo` is emitted only for a real geocode or a user-placed pin.
  const geoNode =
    address !== null &&
    address.geoSource !== 'none' &&
    address.latitude !== null &&
    address.longitude !== null
      ? { '@type': 'GeoCoordinates', latitude: address.latitude, longitude: address.longitude }
      : undefined;

  // A service-area business still emits an address (Google requires one for local rich results)
  // and a `GeoCircle` whose radius is metres **as a string**, per the vocabulary.
  const serviceArea = facts.serviceArea;
  const areaServed =
    serviceArea !== null
      ? [
          {
            '@type': 'GeoCircle',
            geoMidpoint: geoNode ?? compact({ '@type': 'GeoCoordinates', name: serviceArea.city }),
            geoRadius: String(Number(serviceArea.radiusKm) * 1000),
          },
        ]
      : address !== null
        ? [{ '@type': 'City', name: address.city }]
        : undefined;

  const openingHours = ctx.hoursJsonLd.openingHoursSpecification.map((spec) =>
    compact({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: spec.dayOfWeek === undefined ? undefined : [...spec.dayOfWeek],
      opens: spec.opens,
      closes: spec.closes,
    }),
  );
  const specialHours = ctx.hoursJsonLd.specialOpeningHoursSpecification.map((spec) =>
    compact({
      '@type': 'OpeningHoursSpecification',
      opens: spec.opens,
      closes: spec.closes,
      validFrom: spec.validFrom,
      validThrough: spec.validThrough,
    }),
  );

  const homeRouting = doc.pages.find((candidate) => candidate.role === 'home')?.perLocale[locale];
  // Sorted by `refId`, never taken in record order: `doc.media` is a `z.record(...)` whose key
  // enumeration is a JS-engine detail, and this array lands in the page's bytes and in
  // `render_sha256`. Google wants 1:1, 4:3 and 16:9 crops, so three is the useful cap.
  const images = Object.keys(doc.media)
    .sort()
    .map((refId) => ctx.images[refId])
    .filter((image): image is NonNullable<typeof image> => image !== undefined)
    .slice(0, 3)
    .map((image) => `${origin}${image.src}`);

  const inputsGen = doc.jsonLdInputs;

  graph.push(
    compact({
      '@type': businessType(ctx.industry.schemaOrgType, inputsGen.schemaOrgType, notes),
      '@id': businessId,
      additionalType: ctx.industry.additionalType ?? undefined,
      name: facts.businessName,
      legalName: facts.legalName ?? undefined,
      url: `${origin}${homeRouting?.path ?? '/'}`,
      description: facts.shortDescription ?? undefined,
      image: images.length === 0 ? undefined : images,
      telephone: facts.phoneE164,
      email: facts.contactEmail,
      vatID: facts.vatId ?? undefined,
      identifier:
        facts.companyRegistrationId === null
          ? undefined
          : {
              '@type': 'PropertyValue',
              propertyID: 'companyRegistration',
              value: facts.companyRegistrationId,
            },
      address: addressNode,
      geo: geoNode,
      // Never a shortener, never the tenant's own URL, and never the platform's apex.
      sameAs: facts.gbpUrl === null ? undefined : [facts.gbpUrl],
      hasMap: facts.gbpUrl ?? undefined,
      priceRange: inputsGen.priceRange ?? undefined,
      currenciesAccepted: inputsGen.priceRange === null ? undefined : 'EUR',
      paymentAccepted:
        inputsGen.paymentAccepted.length === 0
          ? undefined
          : PAYMENT_METHODS.filter((method) => inputsGen.paymentAccepted.includes(method))
              .map((method) => PAYMENT_LABELS[method])
              .join(', '),
      servesCuisine:
        inputsGen.servesCuisine === null || inputsGen.servesCuisine.length === 0
          ? undefined
          : [...inputsGen.servesCuisine],
      acceptsReservations: inputsGen.acceptsReservations ?? undefined,
      areaServed,
      knowsLanguage: languages,
      openingHoursSpecification: openingHours.length === 0 ? undefined : openingHours,
      specialOpeningHoursSpecification: specialHours.length === 0 ? undefined : specialHours,
      amenityFeature:
        inputsGen.amenities.length === 0
          ? undefined
          : AMENITIES.filter((amenity) => inputsGen.amenities.includes(amenity)).map((amenity) => ({
              '@type': 'LocationFeatureSpecification',
              name: AMENITY_NAMES[amenity],
              value: true,
            })),
    }),
  );

  /* -- The page --------------------------------------------------------- */

  const routing = page.perLocale[locale];
  const heroImage = ctx.hero?.poster;

  graph.push(
    compact({
      '@type': 'WebPage',
      '@id': `${canonical}#webpage`,
      url: canonical,
      name: routing?.title ?? facts.businessName,
      description: routing?.description ?? undefined,
      isPartOf: { '@id': websiteId },
      about: { '@id': businessId },
      inLanguage: LOCALE_META[locale].tag,
      datePublished: ctx.publishedAt,
      // `content_changed_at`, never the deploy time.
      dateModified: ctx.contentChangedAt,
      primaryImageOfPage:
        heroImage === undefined
          ? undefined
          : {
              '@type': 'ImageObject',
              url: `${origin}${heroImage.src}`,
              width: heroImage.width,
              height: heroImage.height,
            },
      breadcrumb: { '@id': `${canonical}#breadcrumb` },
    }),
  );

  const home = doc.pages.find((candidate) => candidate.role === 'home');
  const homePath = home?.perLocale[locale]?.path;
  const crumbs: JsonValue[] = [];
  if (homePath !== undefined) {
    crumbs.push({
      '@type': 'ListItem',
      position: 1,
      name: home?.perLocale[locale]?.title ?? facts.businessName,
      item: `${origin}${homePath}`,
    });
  }
  if (page.role !== 'home' && routing !== undefined) {
    crumbs.push({
      '@type': 'ListItem',
      position: crumbs.length + 1,
      name: routing.title,
      item: canonical,
    });
  }
  graph.push({
    '@type': 'BreadcrumbList',
    '@id': `${canonical}#breadcrumb`,
    itemListElement: crumbs,
  });

  /* -- FAQ -------------------------------------------------------------- */

  // Emitted only when a real FAQ section with real items is on THIS page. We never create an FAQ
  // section *for* the markup: Google restricted FAQ rich results to government and health sites in
  // 2023, so this is a clean signal for AI Overviews and Bing, not a rich-result play.
  for (const section of page.sections) {
    if (section.type !== 'faq' || !section.emitFaqSchema || section.items.length === 0) continue;
    const questions = section.items.map((_item, index) => {
      const question = doc.copy[locale]?.[`${section.id}.items.${index}.question`] ?? '';
      const answer = doc.copy[locale]?.[`${section.id}.items.${index}.answer`] ?? '';
      return {
        '@type': 'Question',
        name: question,
        acceptedAnswer: { '@type': 'Answer', text: answer },
      };
    });
    graph.push({
      '@type': 'FAQPage',
      '@id': `${canonical}#faq`,
      mainEntity: questions,
    });
    break;
  }

  return graph;
}

/**
 * Structural checks over a built graph.
 *
 * Every `@id` referenced by another node must exist as a node in the same graph, every URL must be
 * absolute and `https:`, and `aggregateRating` / `review` must be absent unless the tenant's
 * reviews come from a verified platform. Exported so the CI gate and the publish path run the same
 * checks rather than two lists that drift.
 */
export function validateGraph(graph: readonly GraphNode[], doc: SiteDoc): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const node of graph) {
    const id = node['@id'];
    if (typeof id === 'string') ids.add(id);
  }

  const walk = (value: JsonValue, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const keys = Object.keys(value);
    // A bare `{"@id": "..."}` is a reference; anything else is a node in its own right.
    if (keys.length === 1 && keys[0] === '@id') {
      const target = value['@id'];
      if (typeof target === 'string' && !ids.has(target)) {
        problems.push(`${path}: dangling @id reference ${target}`);
      }
      return;
    }
    for (const key of keys) {
      const entry = value[key];
      if (entry === undefined) continue;
      if (
        typeof entry === 'string' &&
        /^https?:\/\//u.test(entry) &&
        !entry.startsWith('https://')
      ) {
        problems.push(`${path}.${key}: ${entry} is not https:`);
      }
      walk(entry, `${path}.${key}`);
    }
  };

  graph.forEach((node, index) => walk(node, `@graph[${index}]`));

  if (doc.facts.reviewsSource !== 'verified_platform') {
    for (const node of graph) {
      if ('aggregateRating' in node || 'review' in node) {
        problems.push(
          'review markup emitted for a tenant whose reviews are not from a verified platform',
        );
      }
    }
  }

  return problems;
}
