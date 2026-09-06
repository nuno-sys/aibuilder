import { z } from 'zod';
import { Cta, IconId, LinkRef, MediaRef } from './common';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FOUR INVARIANTS — the security boundary of the whole product.
 * Every type in this file is shaped to make them structurally true.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. NO MARKUP. The model cannot author HTML, markdown or rich-text runs. Sections
 *    carry ZERO prose: they carry structure, and copy arrives separately as plain
 *    text in a `LocaleBundleGen`, keyed by slot ids this file never mentions.
 *    The renderer only ever calls `escapeHtml()`. Emphasis comes from choosing a
 *    section type and variant, never from inline markup.
 *
 * 2. NO URLS. Every link is a symbolic `LinkRef`. There is no `href` field anywhere.
 *    `tel:` / `wa.me` / `mailto:` are built by code from CHECK-constrained D1
 *    columns; `{kind:"external"}` indexes a server-built, `https:`-only allowlist.
 *
 * 3. NO CSS. The model picks a `dnaId` from a closed enum plus a handful of bounded
 *    knobs (see `ThemeGen`). Code resolves those to OKLCH-derived custom properties.
 *    There is no colour, length, font or class name in this file.
 *
 * 4. NO JSON-LD. The model supplies typed enum inputs (`schemaOrgType`,
 *    `priceRange`, …); code builds the `@graph` from D1 facts and serialises it
 *    through one function that escapes every `<` as a JSON unicode escape, so no
 *    model string can ever close the `<script>` element it sits in.
 *
 * Consequences that are load-bearing and easy to break by "just adding one field":
 *
 *   - NO `*Slot` FIELDS. Slot ids are DERIVED from `(sectionId, field, index)` by
 *     `deriveSlotInventory()` — the single implementation used by the renderer, the
 *     editor and the translation validator. A model-authored slot id would make
 *     `validateBundle()` compare model output against model output.
 *   - NO `itemCount` FIELDS. The array length IS the count; `normalize()` clamps it.
 *   - NO `.regex()`, `.min()`, `.max()`, `.length()` — see `gen/common.ts`.
 *   - Every field is REQUIRED and `.nullable()` where absence is meaningful. An
 *     optional field lets the model silently skip a decision; a nullable one forces
 *     it to make one.
 *
 * A fully successful prompt injection against this schema yields bad copy, not code
 * execution. Bad copy is a real attack in its own right and is handled elsewhere
 * (intake policy screen, pre-publish moderation, nightly rescan) — not here.
 */

/** Every section carries a model-chosen id; `normalize()` sanitises and de-duplicates it. */
const Base = { id: z.string() };

/* ── Bounded vocabularies used inside sections ──────────────────────────── */

export const MENU_ITEM_TAGS = ['vegan', 'vegetarian', 'gluten_free', 'spicy', 'new'] as const;
export const MenuItemTag = z.enum(MENU_ITEM_TAGS);
export type MenuItemTag = z.infer<typeof MenuItemTag>;

export const CONTACT_FIELD_NAMES = [
  'name',
  'email',
  'phone',
  'date',
  'service',
  'message',
  'consent',
] as const;
export const ContactFieldName = z.enum(CONTACT_FIELD_NAMES);
export type ContactFieldName = z.infer<typeof ContactFieldName>;

export const PARAGRAPH_EMPHASIS = ['normal', 'lead'] as const;
export const ParagraphEmphasis = z.enum(PARAGRAPH_EMPHASIS);
export type ParagraphEmphasis = z.infer<typeof ParagraphEmphasis>;

export const PROSE_STYLES = ['paragraph', 'lead', 'note'] as const;
export const ProseStyle = z.enum(PROSE_STYLES);
export type ProseStyle = z.infer<typeof ProseStyle>;

export const REVIEW_SOURCES = ['google', 'manual', 'mixed'] as const;
export const ReviewSource = z.enum(REVIEW_SOURCES);
export type ReviewSource = z.infer<typeof ReviewSource>;

export const BOOKING_PROVIDERS = ['native', 'external_link'] as const;
export const BookingProvider = z.enum(BOOKING_PROVIDERS);
export type BookingProvider = z.infer<typeof BookingProvider>;

/**
 * Layout variants, one closed set per section type.
 *
 * Exported as `as const` arrays rather than inlined in the `z.enum(...)` calls so
 * that `normalize.ts` falls back to a real member of the same set instead of
 * carrying a second, drift-prone copy of every list.
 */
export const HERO_VARIANTS = [
  'video_fullbleed',
  'image_split',
  'type_centered',
  'image_offset_grid',
] as const;
export const USP_TRIO_VARIANTS = ['icons_row', 'numbered_cards', 'bordered_grid'] as const;
export const ABOUT_VARIANTS = ['text_image', 'image_text', 'wide_quote', 'timeline'] as const;
export const SERVICES_GRID_VARIANTS = [
  'cards_3col',
  'list_split',
  'image_tiles',
  'accordion',
] as const;
export const MENU_VARIANTS = ['two_column', 'cards', 'chalkboard'] as const;
export const GALLERY_VARIANTS = ['masonry', 'carousel', 'grid_square', 'before_after'] as const;
export const REVIEWS_VARIANTS = ['cards_3col', 'single_large', 'marquee', 'google_badge'] as const;
export const TEAM_VARIANTS = ['portraits_grid', 'list_compact'] as const;
export const PROCESS_STEPS_VARIANTS = [
  'numbered_horizontal',
  'vertical_timeline',
  'arrow_flow',
] as const;
export const STATS_BAND_VARIANTS = ['plain', 'boxed', 'accent_bg'] as const;
export const FAQ_VARIANTS = ['accordion', 'two_column'] as const;
export const BOOKING_VARIANTS = ['inline_calendar', 'cta_to_provider'] as const;
export const CONTACT_FORM_VARIANTS = ['split_map', 'stacked', 'boxed_accent'] as const;
export const MAP_HOURS_VARIANTS = ['map_left', 'map_right', 'hours_only'] as const;
export const CTA_BAND_VARIANTS = ['accent_full', 'image_overlay', 'minimal_rule'] as const;
export const BLOG_TEASER_VARIANTS = ['cards_2col', 'list'] as const;
export const RICH_TEXT_VARIANTS = ['prose_narrow', 'prose_wide'] as const;

/* ── The 17 section types ───────────────────────────────────────────────── */

/**
 * The complete section catalogue as a flat discriminated union.
 *
 * Flat and non-recursive is not a style choice: Structured Outputs' JSON-Schema
 * subset rejects recursive schemas outright, so a section that could contain a
 * section could not be sent at all.
 */
export const SectionGen = z.discriminatedUnion('type', [
  /** 1. Hero — always the first section of the home page; owns the LCP element. */
  z.object({
    ...Base,
    type: z.literal('hero'),
    variant: z.enum(HERO_VARIANTS),
    media: MediaRef.nullable(),
    ctas: z.array(Cta),
    showTrustline: z.boolean(),
  }),

  /** 2. Three (or so) differentiators, icon-led. */
  z.object({
    ...Base,
    type: z.literal('usp_trio'),
    variant: z.enum(USP_TRIO_VARIANTS),
    items: z.array(z.object({ iconId: IconId })),
  }),

  /** 3. The story block. `paragraphs` carries no text — only per-paragraph emphasis. */
  z.object({
    ...Base,
    type: z.literal('about'),
    variant: z.enum(ABOUT_VARIANTS),
    media: MediaRef.nullable(),
    paragraphs: z.array(z.object({ emphasis: ParagraphEmphasis })),
    cta: Cta.nullable(),
  }),

  /** 4. Services / treatments / packages. */
  z.object({
    ...Base,
    type: z.literal('services_grid'),
    variant: z.enum(SERVICES_GRID_VARIANTS),
    items: z.array(
      z.object({
        media: MediaRef.nullable(),
        target: LinkRef.nullable(),
        showPrice: z.boolean(),
      }),
    ),
  }),

  /** 5. Food verticals. Nested groups are containment, not recursion. */
  z.object({
    ...Base,
    type: z.literal('menu'),
    variant: z.enum(MENU_VARIANTS),
    groups: z.array(
      z.object({
        items: z.array(
          z.object({
            showDescription: z.boolean(),
            tags: z.array(MenuItemTag),
          }),
        ),
      }),
    ),
  }),

  /** 6. Photo wall. Captions are derived slots, one per media entry. */
  z.object({
    ...Base,
    type: z.literal('gallery'),
    variant: z.enum(GALLERY_VARIANTS),
    media: z.array(MediaRef),
    showCaptions: z.boolean(),
  }),

  /**
   * 7. Testimonials.
   *
   * The review bodies are NOT model copy — they come from the shard's `reviews`
   * table, and `source` decides whether markup may be emitted at all (self-serving
   * review markup has been rich-result-ineligible since 2019 and is a per-se unfair
   * commercial practice under UCPD Annex I 23b/23c).
   */
  z.object({
    ...Base,
    type: z.literal('reviews'),
    variant: z.enum(REVIEWS_VARIANTS),
    source: ReviewSource,
  }),

  /** 8. The people. */
  z.object({
    ...Base,
    type: z.literal('team'),
    variant: z.enum(TEAM_VARIANTS),
    items: z.array(
      z.object({
        media: MediaRef.nullable(),
        showBio: z.boolean(),
      }),
    ),
  }),

  /** 9. "How it works" in n steps. */
  z.object({
    ...Base,
    type: z.literal('process_steps'),
    variant: z.enum(PROCESS_STEPS_VARIANTS),
    items: z.array(z.object({ iconId: IconId.nullable() })),
  }),

  /** 10. Numbers band. Values are copy slots, so "12 jaar" localises correctly. */
  z.object({
    ...Base,
    type: z.literal('stats_band'),
    variant: z.enum(STATS_BAND_VARIANTS),
    items: z.array(z.object({ iconId: IconId.nullable() })),
  }),

  /** 11. FAQ. `emitFaqSchema` is an input to the JSON-LD builder, not markup. */
  z.object({
    ...Base,
    type: z.literal('faq'),
    variant: z.enum(FAQ_VARIANTS),
    emitFaqSchema: z.boolean(),
    items: z.array(z.object({ expandedByDefault: z.boolean() })),
  }),

  /** 12. Booking. `providerLink` must be an external allowlist ref when linking out. */
  z.object({
    ...Base,
    type: z.literal('booking'),
    variant: z.enum(BOOKING_VARIANTS),
    provider: BookingProvider,
    providerLink: LinkRef.nullable(),
  }),

  /** 13. Lead form. Field *labels* are derived slots so they localise. */
  z.object({
    ...Base,
    type: z.literal('contact_form'),
    variant: z.enum(CONTACT_FORM_VARIANTS),
    fields: z.array(
      z.object({
        name: ContactFieldName,
        required: z.boolean(),
      }),
    ),
  }),

  /** 14. Address, opening hours and a route link — all rendered from D1 facts. */
  z.object({
    ...Base,
    type: z.literal('map_hours'),
    variant: z.enum(MAP_HOURS_VARIANTS),
    showRouteCta: z.boolean(),
  }),

  /** 15. Conversion band. */
  z.object({
    ...Base,
    type: z.literal('cta_band'),
    variant: z.enum(CTA_BAND_VARIANTS),
    media: MediaRef.nullable(),
    ctas: z.array(Cta),
  }),

  /** 16. Teaser for the generated blog. Post content lives in `BlogPostGen`. */
  z.object({
    ...Base,
    type: z.literal('blog_teaser'),
    variant: z.enum(BLOG_TEASER_VARIANTS),
    showExcerpts: z.boolean(),
  }),

  /** 17. Long-form prose for legal and editorial pages. Still plain-text slots. */
  z.object({
    ...Base,
    type: z.literal('rich_text'),
    variant: z.enum(RICH_TEXT_VARIANTS),
    paragraphs: z.array(z.object({ style: ProseStyle })),
  }),
]);
export type SectionGen = z.infer<typeof SectionGen>;

/** Discriminator values of `SectionGen`, in catalogue order. */
export const SECTION_TYPES = [
  'hero',
  'usp_trio',
  'about',
  'services_grid',
  'menu',
  'gallery',
  'reviews',
  'team',
  'process_steps',
  'stats_band',
  'faq',
  'booking',
  'contact_form',
  'map_hours',
  'cta_band',
  'blog_teaser',
  'rich_text',
] as const;

export type SectionType = SectionGen['type'];

/** Narrow `SectionGen` to a single member, e.g. `SectionOf<"menu">`. */
export type SectionOf<T extends SectionType> = Extract<SectionGen, { type: T }>;

/** True when `value` is one of the 17 catalogue discriminators. */
export function isSectionType(value: unknown): value is SectionType {
  return typeof value === 'string' && (SECTION_TYPES as readonly string[]).includes(value);
}

/** Fails to compile unless `T` is `never`. */
type MustBeNever<T extends never> = T;

/**
 * Compile-time proof that `SECTION_TYPES` and the `SectionGen` union stay in sync.
 *
 * Adding a section to the union without adding it to the list (or the reverse) makes
 * the argument a non-`never` union, which does not satisfy the constraint, and
 * typecheck fails on this line rather than silently at a call site months later.
 * Exported so `noUnusedLocals` sees it as used; it carries no runtime weight.
 */
export type SectionTypesInSync = MustBeNever<
  | Exclude<SectionType, (typeof SECTION_TYPES)[number]>
  | Exclude<(typeof SECTION_TYPES)[number], SectionType>
>;
