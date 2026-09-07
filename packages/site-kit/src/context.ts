import type { DayOfWeek, Locale } from '@aibuilder/site-schema';

/**
 * `RenderContext` — everything the renderer needs that is **not** in the `SiteDoc`.
 *
 * The boundary rules say site-kit depends on `@aibuilder/site-schema` and on nothing else, so the
 * three things it would otherwise reach into `@aibuilder/core` for — the opening-hours formatter,
 * the opening-hours JSON-LD builder and the industry row — are passed *in* rather than imported.
 * `apps/renderer` is the composition root: it calls `core`, and hands the results over. This is the
 * same shape as the injected-`Env` rule, and it is what keeps site-kit renderable in a plain Node
 * test with no bindings and no taxonomy table.
 *
 * Everything here is a **server fact**. Not one field is model output, and `renderPage` is pure with
 * respect to `(doc, locale, pageId, ctx)` — no `Date.now()`, no `Math.random()`, no environment read.
 */

/* ── Injected from `core/hours.ts` ──────────────────────────────────────── */

/** Structurally identical to `core/hours.ts`'s `OpeningHoursSpecification`. */
export interface OpeningHoursSpecification {
  readonly '@type': 'OpeningHoursSpecification';
  readonly dayOfWeek?: readonly DayOfWeek[];
  readonly opens: string;
  readonly closes: string;
  readonly validFrom?: string;
  readonly validThrough?: string;
}

/** Structurally identical to `core/hours.ts`'s `OpeningHoursJsonLd`. */
export interface OpeningHoursJsonLd {
  readonly openingHoursSpecification: readonly OpeningHoursSpecification[];
  readonly specialOpeningHoursSpecification: readonly OpeningHoursSpecification[];
  readonly byAppointmentOnly: boolean;
}

/** Structurally identical to `core/hours.ts`'s `OpeningInterval`. */
export interface OpeningInterval {
  readonly opens: string;
  readonly closes: string;
}

/** Structurally identical to `core/hours.ts`'s `FormattedHoursLine`. */
export interface FormattedHoursLine {
  readonly days: readonly DayOfWeek[];
  readonly daysLabel: string;
  readonly hoursLabel: string;
  readonly intervals: readonly OpeningInterval[];
  readonly closed: boolean;
  readonly allDay: boolean;
  readonly crossesMidnight: boolean;
}

/** Structurally identical to `core/hours.ts`'s `FormattedHoursException`. */
export interface FormattedHoursException {
  readonly from: string;
  readonly to: string;
  readonly closed: boolean;
  readonly label: string;
}

/** Structurally identical to `core/hours.ts`'s `FormattedHours`. */
export interface FormattedHours {
  readonly lines: readonly FormattedHoursLine[];
  readonly exceptions: readonly FormattedHoursException[];
  readonly byAppointmentOnly: boolean;
  readonly byAppointmentLabel: string | null;
  readonly timeZone: string;
}

/* ── Injected from `core/industries.ts` ─────────────────────────────────── */

/**
 * The industry row, as a D1 fact.
 *
 * `schemaOrgType` here beats the model's own `jsonLdInputs.schemaOrgType` (§8.2): a wrong `@type`
 * silently disables every rich result, and the row is a server fact while the model's pick is a QA
 * signal.
 */
export interface IndustryFacts {
  readonly key: string;
  readonly schemaOrgType: string;
  /** A Wikidata URI carrying the meaning the schema.org type drops. `null` for most industries. */
  readonly additionalType: string | null;
}

/* ── Reviews (from the shard, never from the model) ─────────────────────── */

/** One review row. Bodies are tenant data; `reviews` is the only section whose text is not copy. */
export interface RenderedReview {
  readonly id: string;
  readonly authorName: string;
  /** 1–5. Rendered as text plus a `.vh` "n out of 5" so it is not a bare glyph run. */
  readonly rating: number;
  readonly body: string;
  /** ISO-8601 date, `YYYY-MM-DD`. Formatted by the table-driven formatter, never by `Intl`. */
  readonly publishedOn: string;
}

/* ── Media resolved to a URL ────────────────────────────────────────────── */

/** A responsive image the pipeline produced, resolved to absolute paths by the composition root. */
export interface ResolvedImage {
  /** Fallback `src`. Always a same-origin `/_a/…` path. */
  readonly src: string;
  /** `srcset` candidates per format, widest last. Empty when only a fallback exists. */
  readonly sources: readonly { readonly type: string; readonly srcset: string }[];
  readonly width: number;
  readonly height: number;
  /** Written by the media pipeline, never by the model. `''` renders a decorative image. */
  readonly alt: string;
  /** `object-position`, derived from the `MediaRef`'s closed `FocalPoint` enum. */
  readonly focal: string;
  /** `media_assets.dominant_color`, for the hero's pre-paint wash. */
  readonly dominantColor: string | null;
}

/**
 * Photographic grounds behind ordinary sections, keyed by section id.
 *
 * Resolved by the composition root from `doc.sectionBackgrounds`, exactly as `images` and `hero`
 * are: `site-kit` renders in a runner with no bindings, so anything it would otherwise have to
 * fetch arrives already resolved. A section id with no entry has no ground, which is the normal
 * case — most bands are a flat tone, and a page whose every band is a photograph reads as a
 * slideshow rather than as a business.
 */
export type SectionGrounds = Readonly<Record<string, ResolvedImage>>;

/** The hero's art-directed poster/video set. Built by the media pipeline, never by the model. */
export interface HeroMedia {
  readonly poster: ResolvedImage;
  /** Portrait poster sources for `(max-width:767px)`. Empty when there is no portrait crop. */
  readonly portraitSources: readonly { readonly type: string; readonly srcset: string }[];
  /** Video sources by role. Absent when the site has no hero video. */
  readonly video: {
    readonly desktopAv1: string;
    readonly desktopH264: string;
    readonly mobileAv1: string;
    readonly mobileH264: string;
    readonly width: number;
    readonly height: number;
  } | null;
}

/* ── The context ────────────────────────────────────────────────────────── */

/** Whether the page may be indexed. Mirrors `sites.index_state`. */
export type IndexState = 'index' | 'noindex';

export interface RenderContext {
  /** Absolute origin of the tenant site, no trailing slash. From `vars`, never hardcoded. */
  readonly origin: string;
  /** Path prefix for content-hashed assets, no trailing slash. Conventionally `/_a`. */
  readonly assetBase: string;
  readonly indexState: IndexState;
  /** ISO-8601 instant with an offset. Feeds `datePublished`. */
  readonly publishedAt: string;
  /** ISO-8601 instant with an offset. Equals `content_changed_at`, never the deploy time. */
  readonly contentChangedAt: string;
  readonly industry: IndustryFacts;
  readonly hoursJsonLd: OpeningHoursJsonLd;
  /** The visible hours table, already localised for `locale`. */
  readonly hoursDisplay: FormattedHours;
  readonly reviews: readonly RenderedReview[];
  /** Resolved by `refId`, so a section's `MediaRef` never has to become a URL in this package. */
  readonly images: Readonly<Record<string, ResolvedImage>>;
  readonly hero: HeroMedia | null;
  readonly sectionGrounds: SectionGrounds;
  /** The static map image rendered to R2 at publish. Never a third-party iframe. */
  readonly map: ResolvedImage | null;
  /** `contain-intrinsic-size` estimate per section id, computed at publish (§9.4). */
  readonly sectionHeights: Readonly<Record<string, number>>;
  /** Icon set emitted into `<head>`. All content-hashed, all same-origin. */
  readonly icons: {
    readonly png32: string;
    readonly svg: string;
    readonly appleTouch: string;
    readonly og: { readonly url: string; readonly width: number; readonly height: number } | null;
  };
  /** True when the tenant enabled a non-essential cookie. Default is false (non-negotiable §25). */
  readonly usesNonEssential: boolean;
}

/** Locale plus the page being rendered — bundled so section components take one argument fewer. */
export interface RenderScope {
  readonly locale: Locale;
  readonly pageId: string;
}
