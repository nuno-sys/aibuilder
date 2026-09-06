import type { Locale, PageDoc, SectionGen, SiteDoc } from '@aibuilder/site-schema';
import { deriveSectionSlots, mediaFor, textFor } from '@aibuilder/site-schema';
import type { RenderContext } from './context';
import { resolveLink } from './links';
import type { GraphNode, JsonValue } from './seo/jsonld';
import { translatedLocales } from './seo/hreflang';

/**
 * The canonical semantic projection, and the hash computed over it.
 *
 * `render_sha256` drives `lastmod`, and a sitemap that always says "now" gets ignored. It must not
 * move on a deploy, a template change, a footer year rollover, or a republish with identical
 * content — which rules out hashing the HTML, because the HTML contains asset hashes, the CSS
 * bundle and the markup of whatever the template happens to be this week.
 *
 * So the hash is taken over a projection of what the page *says*, not what it looks like.
 *
 * **In** (it changed ⇒ the page changed ⇒ `lastmod` moves): the projection-format version, the
 * routing identity, the SERP metadata, every section's type/variant/structural enum, its slots as
 * an ordered `[slotId, text]` array, media identity as the asset **content hash**, link targets in
 * resolved symbolic form, the subset of `facts` this page renders, the JSON-LD graph with dates and
 * hosts stripped, and the set of locales this page is translated into.
 *
 * **Out** (it changed ⇒ nothing about the content changed): the theme and every token, `versionId`,
 * `siteId`, the CSS bundle, asset URL prefixes and the origin, `publishedAt`, the renderer's own
 * markup, the footer's year, the `indexState`, the inline script — and `dateModified` /
 * `datePublished`. That last exclusion is the one that is easy to get wrong and it is **circular**:
 * `dateModified` derives from `content_changed_at`, which moves when `render_sha256` moves, so
 * including it would make the hash depend on itself and move `lastmod` on every single publish.
 * Excluding it is the whole reason this projection exists.
 */

/** A projection is JSON, and only JSON. */
export type Projection = JsonValue;

/** The stable shape hashed for one page. */
export interface PageProjection {
  /**
   * Projection-format version.
   *
   * Bumping it is a deliberate, explained, one-time `lastmod` move across the whole estate rather
   * than an unexplained one. Never bump it for a rendering change.
   */
  readonly v: 1;
  readonly locale: string;
  readonly pageKey: string;
  readonly path: string;
  readonly role: string;
  readonly noindex: boolean;
  readonly title: string;
  readonly description: string;
  readonly locales: readonly string[];
  readonly sections: readonly Projection[];
  readonly facts: Projection;
  readonly graph: readonly Projection[];
}

/**
 * Deterministic JSON: keys sorted, no whitespace, and a **throw** on anything that cannot be
 * canonicalised.
 *
 * `undefined`, `NaN` and the infinities are bugs in the projection, not values to coerce: a
 * projection that silently drops a key produces two different pages with the same hash, which is
 * the one failure mode a content hash exists to prevent.
 */
export function stableStringify(value: Projection): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`projection contains a non-finite number: ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const keys = Object.keys(value).sort();
  const parts = keys.map((key) => {
    const entry = value[key];
    if (entry === undefined) {
      throw new TypeError(`projection contains undefined at key "${key}"`);
    }
    return `${JSON.stringify(key)}:${stableStringify(entry)}`;
  });
  return `{${parts.join(',')}}`;
}

/** Structural fields of one section, per type. Booleans and enums only — never copy. */
function sectionStructure(section: SectionGen): Projection {
  switch (section.type) {
    case 'hero':
      return {
        showTrustline: section.showTrustline,
        ctaStyles: section.ctas.map((cta) => cta.style),
      };
    case 'usp_trio':
      return { icons: section.items.map((item) => item.iconId) };
    case 'about':
      return { emphasis: section.paragraphs.map((paragraph) => paragraph.emphasis) };
    case 'services_grid':
      return { showPrice: section.items.map((item) => item.showPrice) };
    case 'menu':
      return {
        groups: section.groups.map((group) => ({
          items: group.items.map((item) => ({
            showDescription: item.showDescription,
            tags: [...item.tags],
          })),
        })),
      };
    case 'gallery':
      return { showCaptions: section.showCaptions };
    case 'reviews':
      return { source: section.source };
    case 'team':
      return { showBio: section.items.map((item) => item.showBio) };
    case 'process_steps':
      return { icons: section.items.map((item) => item.iconId) };
    case 'stats_band':
      return { icons: section.items.map((item) => item.iconId) };
    case 'faq':
      return {
        emitFaqSchema: section.emitFaqSchema,
        expanded: section.items.map((item) => item.expandedByDefault),
      };
    case 'booking':
      return { provider: section.provider };
    case 'contact_form':
      return {
        fields: section.fields.map((field) => ({ name: field.name, required: field.required })),
      };
    case 'map_hours':
      return { showRouteCta: section.showRouteCta };
    case 'cta_band':
      return { ctaStyles: section.ctas.map((cta) => cta.style) };
    case 'blog_teaser':
      return { showExcerpts: section.showExcerpts };
    case 'rich_text':
      return { styles: section.paragraphs.map((paragraph) => paragraph.style) };
    default: {
      const unreachable: never = section;
      throw new Error(`Unhandled section type: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Media identity: the asset's **content hash**, its focal point and its alt text.
 *
 * The content hash is the leading component of every `r2Key` (`img/<sha>/1200.avif`), so
 * re-uploading the same bytes does not move `lastmod` while cropping does. The URL prefix is out
 * on purpose: a CDN path change is not a content change.
 */
function mediaIdentity(doc: SiteDoc, section: SectionGen): Projection {
  const refs =
    section.type === 'gallery'
      ? section.media
      : section.type === 'services_grid' || section.type === 'team'
        ? section.items.map((item) => item.media)
        : 'media' in section
          ? [section.media]
          : [];

  return refs.map((ref) => {
    const asset = mediaFor(doc, ref ?? null);
    if (asset === null) return null;
    // `orig/<sha>` / `img/<sha>/…` / `poster/<sha>.avif` — the hash is always the component after
    // the first slash, which is the one thing every key shape in `core/keys.ts` has in common.
    const contentHash = asset.r2Key.split('/')[1] ?? asset.r2Key;
    return {
      hash: contentHash,
      focal: ref?.focalPoint ?? null,
      alt: asset.altText ?? '',
    };
  });
}

/** Link targets, resolved to symbolic form rather than to an href. */
function linkIdentity(doc: SiteDoc, section: SectionGen, locale: Locale): Projection {
  const refs = [
    ...('ctas' in section ? section.ctas.map((cta) => cta.target) : []),
    ...('cta' in section && section.cta !== null ? [section.cta.target] : []),
    ...(section.type === 'services_grid' ? section.items.map((item) => item.target) : []),
    ...(section.type === 'booking' && section.providerLink !== null ? [section.providerLink] : []),
  ];

  return refs.map((ref) => {
    if (ref === null || ref === undefined) return null;
    switch (ref.kind) {
      case 'page': {
        // `pageKey`, not `pageId`: the id is regenerated on every run, the key is the stable
        // identity that slug stability is joined on.
        const target = doc.pages.find((page) => page.pageId === ref.pageId);
        return `page:${target?.pageKey ?? ref.pageId}`;
      }
      case 'anchor':
        return `anchor:${ref.sectionId}`;
      case 'external': {
        const resolved = resolveLink(doc, ref, locale);
        return `external:${resolved?.href ?? ''}`;
      }
      default:
        return ref.kind;
    }
  });
}

/**
 * The JSON-LD graph with everything volatile removed.
 *
 * Dates go because they are circular (see the module comment). Hosts go because the same content
 * served from a preview origin and a custom hostname is the same content.
 */
function projectGraph(graph: readonly GraphNode[], origin: string): Projection[] {
  const strip = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(strip);
    if (value === null || typeof value !== 'object') {
      return typeof value === 'string' && value.startsWith(origin)
        ? value.slice(origin.length)
        : value;
    }
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      if (key === 'dateModified' || key === 'datePublished') continue;
      const entry = value[key];
      if (entry === undefined) continue;
      out[key] = strip(entry);
    }
    return out;
  };
  return graph.map((node) => strip(node));
}

/** Everything `projectPage` needs beyond the document. */
export interface ProjectionInputs {
  readonly doc: SiteDoc;
  readonly page: PageDoc;
  readonly locale: Locale;
  readonly ctx: RenderContext;
  readonly graph: readonly GraphNode[];
}

/** Builds the projection for one page. Pure, and dependent on no clock and no environment. */
export function projectPage(inputs: ProjectionInputs): PageProjection {
  const { doc, page, locale, ctx, graph } = inputs;
  const routing = page.perLocale[locale];
  const facts = doc.facts;

  const sections = page.sections.map((section) => ({
    type: section.type,
    variant: section.variant,
    structure: sectionStructure(section),
    // The ORDERED slot inventory, never `Object.entries(copy)` — that order is a JS-engine detail
    // and that map also contains slots belonging to other pages.
    slots: deriveSectionSlots(section, page.pageId).map((descriptor) => [
      descriptor.id,
      textFor(doc, locale, descriptor.id),
    ]),
    media: mediaIdentity(doc, section),
    links: linkIdentity(doc, section, locale),
  }));

  return {
    v: 1,
    locale,
    pageKey: page.pageKey,
    path: routing?.path ?? '',
    role: page.role,
    noindex: page.noindex,
    title: routing?.title ?? '',
    description: routing?.description ?? '',
    // Adding a locale changes this page's head, which is a real content change.
    locales: translatedLocales(doc, page),
    sections,
    facts: {
      businessName: facts.businessName,
      legalName: facts.legalName,
      phone: facts.phoneE164,
      whatsapp: facts.whatsappE164,
      email: facts.contactEmail,
      address:
        facts.address === null
          ? null
          : {
              line1: facts.address.line1,
              line2: facts.address.line2,
              postalCode: facts.address.postalCode,
              city: facts.address.city,
              country: facts.address.country,
            },
      serviceArea:
        facts.serviceArea === null
          ? null
          : { city: facts.serviceArea.city, radiusKm: facts.serviceArea.radiusKm },
      hours: ctx.hoursDisplay.lines.map((line) => ({
        days: [...line.days],
        intervals: line.intervals.map((interval) => [interval.opens, interval.closes]),
        closed: line.closed,
      })),
      vatId: facts.vatId,
      registrationId: facts.companyRegistrationId,
    },
    graph: projectGraph(graph, ctx.origin),
  };
}

const encoder = new TextEncoder();

/** Lowercase hex SHA-256 of the canonicalised projection. */
export async function renderSha256(projection: PageProjection): Promise<string> {
  const bytes = encoder.encode(stableStringify(projection as unknown as Projection));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
