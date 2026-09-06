import { z } from 'zod';
import { InvalidSiteDocError } from './errors';
import { Locale } from './gen/common';
import type { LinkRef, MediaRef } from './gen/common';
import { BlogBlockGen } from './gen/blog-post';
import { SectionGen } from './gen/section';
import { FooterStyle, JsonLdInputsGen, NavStyle, PageRole, ThemeGen } from './gen/site-structure';

/**
 * `SiteDoc` -- the renderer input, the editor's form model and the R2 storage shape.
 *
 * Its types are DERIVED from the `gen/` schemas (`ThemeGen.omit(...)`, `SectionGen`,
 * `BlogBlockGen`, `JsonLdInputsGen`) and never re-authored, so there is no second copy
 * of seventeen section definitions to keep in sync. What this layer adds is
 * everything the model is not allowed to produce:
 *
 *   - real constraints (lengths, regexes, https-only URLs) -- safe here, because a
 *     `SiteDoc` never goes to the model;
 *   - the resolution maps `media` and `links`, built by the server;
 *   - `facts`, which come from D1 and are the only source of the business's name,
 *     address, phone and hours;
 *   - `copy`, the flat `slotId -> text` map per locale;
 *   - routing data (`pageKey`, `sortOrder`, per-locale `path`).
 *
 * Sections keep their symbolic refs. A `MediaRef` is resolved through `media`, a
 * `LinkRef` through `links` (external) or through the document's own ids and the
 * facts (everything else) -- at render time, per locale. Baking hrefs in here would
 * make the document locale-specific and undo invariant 2.
 */

/** Version stamp of the stored document. Bump with a migration, never on its own. */
export const SCHEMA_VERSION = 1;

/* -- Small validators ---------------------------------------------------- */

/**
 * Absolute `https:` URL with a dotted host, an optional port, and a path/query that
 * contains no whitespace and none of the characters that would be dangerous if the
 * href ever reached an attribute.
 *
 * Deliberately stricter than `new URL()`, and deliberately not `new URL()` at all:
 * this package declares no ambient types (`"types": []`), so it must not depend on a
 * DOM or Node global to state what an allowlisted link may look like.
 */
const HTTPS_URL_PATTERN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?([/?#][^\s"'<>\\`]*)?$/iu;

/** True when `value` is an absolute `https:` URL this system is willing to emit. */
export function isHttpsUrl(value: string): boolean {
  return HTTPS_URL_PATTERN.test(value);
}

/** True when `value` is an ISO-8601 timestamp that `Date` accepts. */
export function isIsoTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

const HttpsUrl = z.string().max(2048).refine(isHttpsUrl, { message: 'must be an https: URL' });
const IsoTimestamp = z.string().refine(isIsoTimestamp, { message: 'must be an ISO-8601 instant' });
const E164 = z.string().regex(/^\+[1-9]\d{6,14}$/u, { message: 'must be E.164' });
const EmailAddress = z
  .string()
  .max(254)
  .regex(/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/u, { message: 'must be an e-mail address' });
const HexColor = z.string().regex(/^#[0-9a-f]{6}([0-9a-f]{2})?$/u, {
  message: 'must be lowercase #rrggbb or #rrggbbaa',
});
/** A rendered URL path: absolute, lowercase, with a trailing slash. */
const UrlPath = z.string().regex(/^\/[a-z0-9\-/]*\/$/u, {
  message: 'must be an absolute lowercase path with a trailing slash',
});

/* -- Facts (from D1, never from the model) ------------------------------- */

export const DAYS_OF_WEEK = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;
export const DayOfWeek = z.enum(DAYS_OF_WEEK);
export type DayOfWeek = z.infer<typeof DayOfWeek>;

const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u, { message: 'must be HH:MM' });

/**
 * Opening hours exactly as `packages/core/src/hours.ts` expects them: an IANA zone, a
 * spec of day/interval tuples (split shifts are two entries for the same day), an
 * explicit closed-days list, and dated exceptions.
 */
export const OpeningHoursSchema = z.object({
  tz: z.string().min(1).max(64),
  byAppointmentOnly: z.boolean(),
  spec: z
    .array(
      z.object({
        dayOfWeek: z.array(DayOfWeek).min(1),
        opens: ClockTime,
        closes: ClockTime,
      }),
    )
    .max(21),
  closed: z.array(DayOfWeek).max(7),
  exceptions: z.array(z.object({ from: z.string(), to: z.string(), closed: z.boolean() })).max(24),
});
export type OpeningHours = z.infer<typeof OpeningHoursSchema>;

export const GEO_SOURCES = ['none', 'geocoded', 'user_pin'] as const;
export const GeoSource = z.enum(GEO_SOURCES);
export type GeoSource = z.infer<typeof GeoSource>;

export const AddressSchema = z.object({
  line1: z.string().max(120),
  line2: z.string().max(120).nullable(),
  postalCode: z.string().max(16),
  city: z.string().max(80),
  country: z.string().regex(/^[A-Z]{2}$/u),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  /**
   * `geo` is emitted into JSON-LD only for `geocoded` / `user_pin`: a guessed
   * city-centre coordinate that contradicts the postal address is worse than none.
   */
  geoSource: GeoSource,
});
export type Address = z.infer<typeof AddressSchema>;

export const SERVICE_AREA_RADII = ['5', '10', '25', '50'] as const;
export const ServiceAreaSchema = z.object({
  city: z.string().max(80),
  radiusKm: z.enum(SERVICE_AREA_RADII),
});
export type ServiceArea = z.infer<typeof ServiceAreaSchema>;

/**
 * Where this tenant's reviews come from -- distinct from a `reviews` section's own
 * `source`, which only says what the section renders.
 */
export const REVIEW_PROVENANCES = ['none', 'manual', 'verified_platform'] as const;
export const ReviewProvenance = z.enum(REVIEW_PROVENANCES);
export type ReviewProvenance = z.infer<typeof ReviewProvenance>;

/**
 * The tenant's verified facts.
 *
 * Every one of these comes from the intake form and D1. The model never writes them,
 * `genToDoc()` cannot be called without them, and the JSON-LD builder reads them
 * rather than anything the model produced.
 */
export const SiteFactsSchema = z.object({
  businessName: z.string().min(1).max(120),
  legalName: z.string().max(160).nullable(),
  industryKey: z.string().min(1).max(40),
  shortDescription: z.string().max(600).nullable(),
  contactEmail: EmailAddress,
  phoneE164: E164,
  whatsappE164: E164.nullable(),
  /** Stored for `sameAs`. Never fetched: it is a user-supplied third-party URL. */
  gbpUrl: HttpsUrl.nullable(),
  address: AddressSchema.nullable(),
  serviceArea: ServiceAreaSchema.nullable(),
  openingHours: OpeningHoursSchema.nullable(),
  /**
   * Gates review markup. `aggregateRating` / `review` are emitted only for
   * `verified_platform`; self-serving review markup has been rich-result-ineligible
   * since 2019 and is a per-se unfair practice under UCPD Annex I 23b/23c.
   */
  reviewsSource: ReviewProvenance,
  vatId: z.string().max(20).nullable(),
  /** KvK / Handelsregister number, required in the footer across the EU. */
  companyRegistrationId: z.string().max(40).nullable(),
});
export type SiteFacts = z.infer<typeof SiteFactsSchema>;

/* -- Resolution maps ----------------------------------------------------- */

/** One image or video in the site's media manifest, after the pipeline has run. */
export const MediaAssetSchema = z.object({
  refId: z.string().min(1).max(64),
  r2Key: z.string().min(1).max(512),
  mimeType: z.string().min(3).max(80),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  blurhash: z.string().max(120).nullable(),
  dominantColor: HexColor.nullable(),
  /**
   * Written by the media pipeline, not by the model.
   * Phase 2: alt text becomes a per-locale slot once the editor can translate it.
   */
  altText: z.string().max(300).nullable(),
  credit: z.string().max(200).nullable(),
});
export type MediaAsset = z.infer<typeof MediaAssetSchema>;

/** One entry of the server-built external-link allowlist. */
export const ExternalLinkSchema = z.object({
  href: HttpsUrl,
  /** `rel` the renderer must apply; the badge link is `nofollow sponsored`. */
  rel: z.string().max(64).nullable(),
});
export type ExternalLink = z.infer<typeof ExternalLinkSchema>;

/* -- Theme --------------------------------------------------------------- */

/**
 * The generated theme minus `rationale` (QA-only), plus the resolved custom
 * properties `site-kit` computed from the DNA and knobs.
 */
export const ThemeDocSchema = ThemeGen.omit({ rationale: true }).extend({
  tokens: z.record(z.string(), z.string()),
});
export type ThemeDoc = z.infer<typeof ThemeDocSchema>;

/* -- Pages --------------------------------------------------------------- */

/** Sections are stored exactly as generated; refs stay symbolic. */
export type DocSection = z.infer<typeof SectionGen>;

export const PageLocaleDocSchema = z.object({
  /** `/{locale}/{slug}/`, or `/{locale}/` for the home page. */
  path: UrlPath,
  slug: z.string().max(63),
  title: z.string().max(120),
  description: z.string().max(320),
  ogMediaRefId: z.string().nullable(),
});
export type PageLocaleDoc = z.infer<typeof PageLocaleDocSchema>;

export const PageDocSchema = z.object({
  pageId: z.string().min(1).max(64),
  /**
   * Stable identity across regenerations. Slug stability is joined on
   * `(pageKey, locale)`, so this must not change when the model renames a page.
   */
  pageKey: z.string().min(1).max(64),
  role: PageRole,
  noindex: z.boolean(),
  showInNav: z.boolean(),
  sortOrder: z.number().int().nonnegative(),
  sections: z.array(SectionGen),
  /** Keyed by locale; a locale absent here has no translation of this page. */
  perLocale: z.record(z.string(), PageLocaleDocSchema),
});
export type PageDoc = z.infer<typeof PageDocSchema>;

/* -- Blog ---------------------------------------------------------------- */

export const BlogPostDocSchema = z.object({
  postId: z.string().min(1).max(64),
  locale: Locale,
  slug: z.string().min(1).max(96),
  path: UrlPath,
  title: z.string().min(1).max(160),
  excerpt: z.string().max(400),
  metaDescription: z.string().max(320),
  heroMediaRefId: z.string().nullable(),
  blocks: z.array(BlogBlockGen),
  publishedAt: IsoTimestamp,
  /** Feeds `dateModified`; equals `content_changed_at`, not the deploy time. */
  updatedAt: IsoTimestamp,
});
export type BlogPostDoc = z.infer<typeof BlogPostDocSchema>;

/* -- The document -------------------------------------------------------- */

/** Flat `slotId -> text` map for one locale. */
export const LocaleCopySchema = z.record(z.string(), z.string());
export type LocaleCopy = z.infer<typeof LocaleCopySchema>;

/**
 * The complete stored site document.
 *
 * `copy`, `perLocale`, `media` and `links` are `z.record(z.string(), ...)` rather than
 * enum-keyed records because a Zod v4 record with an enum key is *exhaustive*: it
 * would demand a copy map for all six locales on a site that enabled one. The
 * `superRefine` below enforces the real rule instead -- every locale key is enabled
 * on this site -- and `copyFor()` is the typed way to read one back.
 */
export const SiteDocSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    siteId: z.string().min(1).max(64),
    versionId: z.string().min(1).max(64),
    theme: ThemeDocSchema,
    locales: z.object({
      default: Locale,
      enabled: z.array(Locale).min(1).max(6),
    }),
    chrome: z.object({
      navStyle: NavStyle,
      footerStyle: FooterStyle,
      whatsappEnabled: z.boolean(),
    }),
    pages: z.array(PageDocSchema).min(1),
    copy: z.record(z.string(), LocaleCopySchema),
    media: z.record(z.string(), MediaAssetSchema),
    links: z.record(z.string(), ExternalLinkSchema),
    jsonLdInputs: JsonLdInputsGen,
    facts: SiteFactsSchema,
    blog: z.array(BlogPostDocSchema),
  })
  .superRefine((doc, ctx) => {
    const enabled = new Set<string>(doc.locales.enabled);
    if (!enabled.has(doc.locales.default)) {
      ctx.addIssue({
        code: 'custom',
        path: ['locales', 'default'],
        message: 'default locale must also be enabled',
      });
    }
    for (const locale of Object.keys(doc.copy)) {
      if (!enabled.has(locale)) {
        ctx.addIssue({
          code: 'custom',
          path: ['copy', locale],
          message: `copy for locale "${locale}", which is not enabled`,
        });
      }
    }
    for (const [index, page] of doc.pages.entries()) {
      for (const locale of Object.keys(page.perLocale)) {
        if (!enabled.has(locale)) {
          ctx.addIssue({
            code: 'custom',
            path: ['pages', index, 'perLocale', locale],
            message: `page routing for locale "${locale}", which is not enabled`,
          });
        }
      }
    }
  });

export type SiteDoc = z.infer<typeof SiteDocSchema>;

/* -- Accessors ----------------------------------------------------------- */

/**
 * Reads one locale's copy map, returning an empty map when the locale is absent.
 *
 * The typed way in: `doc.copy` is string-keyed for the schema reason above, and
 * `noUncheckedIndexedAccess` would otherwise force every call site to re-handle
 * `undefined`.
 */
export function copyFor(doc: SiteDoc, locale: string): LocaleCopy {
  return doc.copy[locale] ?? {};
}

/**
 * Reads one slot's text in one locale, falling back to the default locale and then to
 * the empty string.
 *
 * Rendering an empty string is deliberate: a missing slot must never surface as
 * `undefined`, the slot id, or the other language's text on a customer's page.
 */
export function textFor(doc: SiteDoc, locale: string, slotId: string): string {
  return copyFor(doc, locale)[slotId] ?? copyFor(doc, doc.locales.default)[slotId] ?? '';
}

/** Resolves a `MediaRef` against the document's manifest. */
export function mediaFor(doc: SiteDoc, ref: MediaRef | null): MediaAsset | null {
  if (ref === null) return null;
  return doc.media[ref.refId] ?? null;
}

/**
 * Resolves an `{kind:"external"}` link against the allowlist.
 *
 * Returns `null` for every other kind: those are built by code from the document's
 * own ids and from `facts`, which is what keeps invariant 2 true.
 */
export function externalLinkFor(doc: SiteDoc, ref: LinkRef): ExternalLink | null {
  if (ref.kind !== 'external') return null;
  return doc.links[ref.refId] ?? null;
}

/* -- Parsing ------------------------------------------------------------- */

/** Result of validating a stored document. */
export type SiteDocParseResult =
  | { readonly ok: true; readonly doc: SiteDoc }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * Validates a stored document without throwing.
 *
 * Use this on every read path; the renderer must degrade to the previously published
 * version rather than 500 on a document that failed to validate.
 */
export function parseSiteDoc(input: unknown): SiteDocParseResult {
  const parsed = SiteDocSchema.safeParse(input);
  if (parsed.success) return { ok: true, doc: parsed.data };
  const issues = parsed.error.issues.map(
    (issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`,
  );
  return { ok: false, issues };
}

/**
 * Validates a stored document, throwing `InvalidSiteDocError` on failure.
 *
 * For write paths (publish, migration output) where an invalid document must never be
 * persisted.
 */
export function parseSiteDocOrThrow(input: unknown): SiteDoc {
  const result = parseSiteDoc(input);
  if (!result.ok) throw new InvalidSiteDocError(result.issues);
  return result.doc;
}
