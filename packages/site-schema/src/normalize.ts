import type { Cta, LinkRef, Locale, MediaRef } from './gen/common';
import {
  COLOR_MODES,
  CTA_STYLES,
  DENSITY_IDS,
  DNA_IDS,
  FOCAL_POINTS,
  HUE_SHIFTS,
  ICON_IDS,
  MOTION_IDS,
  PALETTE_VARIANTS,
  RADIUS_IDS,
  TYPE_SCALE_IDS,
} from './gen/common';
import {
  ABOUT_VARIANTS,
  BLOG_TEASER_VARIANTS,
  BOOKING_PROVIDERS,
  BOOKING_VARIANTS,
  CONTACT_FIELD_NAMES,
  CONTACT_FORM_VARIANTS,
  CTA_BAND_VARIANTS,
  FAQ_VARIANTS,
  GALLERY_VARIANTS,
  HERO_VARIANTS,
  MAP_HOURS_VARIANTS,
  MENU_ITEM_TAGS,
  MENU_VARIANTS,
  PARAGRAPH_EMPHASIS,
  PROCESS_STEPS_VARIANTS,
  PROSE_STYLES,
  REVIEWS_VARIANTS,
  REVIEW_SOURCES,
  RICH_TEXT_VARIANTS,
  SECTION_TYPES,
  SERVICES_GRID_VARIANTS,
  STATS_BAND_VARIANTS,
  TEAM_VARIANTS,
  USP_TRIO_VARIANTS,
} from './gen/section';
import type { SectionGen } from './gen/section';
import { BLOG_BLOCK_TYPES, BlogPostGen } from './gen/blog-post';
import type { BlogBlockGen } from './gen/blog-post';
import { LocaleBundleGen } from './gen/locale-bundle';
import {
  AMENITIES,
  FOOTER_STYLES,
  NAV_STYLES,
  PAGE_ROLES,
  PAYMENT_METHODS,
  PRICE_RANGES,
  SCHEMA_ORG_TYPES,
  SiteStructureGen,
} from './gen/site-structure';
import type { JsonLdInputsGen, PageGen, ThemeGen } from './gen/site-structure';
import type { SlotInventory } from './slots';

/**
 * Deterministic repair of model output.
 *
 * THIS MODULE REPAIRS AND NEVER THROWS. Every entry point takes `unknown` and
 * returns a result object, because it runs on the far side of a paid 30K-token
 * generation: throwing there turns a recoverable defect into a lost step, a lost
 * spend, and a user watching a spinner.
 *
 * It is also where every constraint `gen/` is forbidden to express actually lives:
 * string ceilings, array bounds, hex casing, id charsets, and referential integrity
 * against the media manifest and the external-link allowlist. `gen/` carries what a
 * grammar can enforce; this file carries everything else.
 *
 * The one defect class it cannot repair is *missing copy*. That surfaces through
 * `validateBundle()` and escalates to at most two model repair turns.
 */

/* -- Limits -------------------------------------------------------------- */

/** An inclusive array-length range. */
export interface LengthRange {
  readonly min: number;
  readonly max: number;
}

/**
 * Every numeric bound the model is not allowed to be told about.
 *
 * Arrays are clamped by truncation above `max` and by padding with a neutral default
 * element below `min`, never by rejecting the document. Per-slot character ceilings
 * live in `SLOT_MAX_LENGTH`; the ones here cover strings that are not copy slots.
 */
export const LIMITS = {
  pagesPerSite: { min: 1, max: 12 },
  sectionsPerPage: { min: 1, max: 12 },
  ctasPerSection: { min: 0, max: 2 },
  uspItems: { min: 2, max: 6 },
  aboutParagraphs: { min: 1, max: 6 },
  serviceItems: { min: 1, max: 12 },
  menuGroups: { min: 1, max: 8 },
  menuItemsPerGroup: { min: 1, max: 24 },
  menuItemTags: { min: 0, max: 5 },
  galleryMedia: { min: 1, max: 24 },
  teamItems: { min: 1, max: 12 },
  processSteps: { min: 2, max: 6 },
  statsItems: { min: 2, max: 6 },
  faqItems: { min: 1, max: 12 },
  contactFields: { min: 1, max: 7 },
  richTextParagraphs: { min: 1, max: 24 },
  paymentMethods: { min: 0, max: 10 },
  amenities: { min: 0, max: 10 },
  servesCuisine: { min: 0, max: 8 },
  blogBlocks: { min: 1, max: 40 },
  blogListItems: { min: 1, max: 12 },
  identifierChars: 48,
  stockQueryHintChars: 60,
  rationaleChars: 400,
  safetyNoteChars: 400,
  cuisineChars: 40,
  blogTitleChars: 80,
  blogSlugSeedChars: 80,
  blogExcerptChars: 300,
  blogMetaDescriptionChars: 155,
  blogHeadingChars: 120,
  blogParagraphChars: 1200,
  blogListItemChars: 200,
  blogQuoteChars: 400,
  blogAttributionChars: 80,
  blogCaptionChars: 140,
  blogCtaLabelChars: 40,
} as const satisfies Record<string, LengthRange | number>;

/* -- Repair log ---------------------------------------------------------- */

/** Machine-readable classification of a single repair. */
export type RepairCode =
  | 'unsalvageable'
  | 'post_normalize_parse_failed'
  | 'missing_field_defaulted'
  | 'enum_fallback'
  | 'text_truncated'
  | 'array_truncated'
  | 'array_padded'
  | 'identifier_rewritten'
  | 'duplicate_id_renamed'
  | 'duplicate_role_demoted'
  | 'duplicate_entry_dropped'
  | 'unknown_slot_dropped'
  | 'blank_slot_dropped'
  | 'dangling_media_ref_dropped'
  | 'dangling_link_ref_dropped'
  | 'section_dropped'
  | 'page_dropped'
  | 'block_dropped';

/** One repair applied to (or refused on) model output. */
export interface Repair {
  readonly code: RepairCode;
  /** Dotted path into the generation document, e.g. `pages.0.sections.2.items`. */
  readonly path: string;
  readonly detail: string;
}

/**
 * Result of a normalisation.
 *
 * `value === null` means the input could not be repaired into a publishable document
 * (no pages at all, a blog post with no body). The caller fails the Workflow step; it
 * never means an exception was thrown.
 */
export interface NormalizeResult<T> {
  readonly value: T | null;
  readonly repairs: readonly Repair[];
}

type RepairLog = Repair[];

function note(log: RepairLog, code: RepairCode, path: string, detail: string): void {
  log.push({ code, path, detail });
}

/**
 * Describes an untrusted value for a repair message.
 *
 * Not `JSON.stringify`: this module must never throw, and `JSON.stringify` throws on
 * a circular object and on a BigInt -- both of which can appear in a decoded payload.
 */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return Array.isArray(value) ? 'array' : typeof value;
}

/* -- Context ------------------------------------------------------------- */

/**
 * Everything normalisation needs from the server, which is everything the model must
 * not be trusted for: which media actually exist, which external URLs are allowed,
 * and which locales this site bought.
 */
export interface NormalizeContext {
  /** Ref ids present in the media manifest built by the `resolve-media` step. */
  readonly knownMediaRefIds: ReadonlySet<string>;
  /** Ref ids present in the server-built, https-only external link allowlist. */
  readonly knownExternalRefIds: ReadonlySet<string>;
  /** Fallback when the model emits a locale this site has not enabled. */
  readonly primaryLocale: Locale;
  readonly allowedLocales: readonly Locale[];
}

/** `NormalizeContext` plus the ids an already-normalised structure has fixed. */
export interface DocumentNormalizeContext extends NormalizeContext {
  readonly knownPageIds: ReadonlySet<string>;
  readonly knownSectionIds: ReadonlySet<string>;
}

/**
 * Builds the context for bundle and blog normalisation from a normalised structure,
 * so link refs in later documents resolve against final, post-repair ids.
 */
export function contextFromStructure(
  base: NormalizeContext,
  structure: SiteStructureGen,
): DocumentNormalizeContext {
  const knownPageIds = new Set<string>();
  const knownSectionIds = new Set<string>();
  for (const page of structure.pages) {
    knownPageIds.add(page.pageId);
    for (const section of page.sections) knownSectionIds.add(section.id);
  }
  return { ...base, knownPageIds, knownSectionIds };
}

/* -- Primitive helpers --------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function isMember<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function pickEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  log: RepairLog,
  path: string,
): T {
  if (isMember(value, allowed)) return value;
  note(log, 'enum_fallback', path, `not one of [${allowed.join('|')}]; using "${fallback}"`);
  return fallback;
}

function pickBoolean(value: unknown, fallback: boolean, log: RepairLog, path: string): boolean {
  if (typeof value === 'boolean') return value;
  note(log, 'missing_field_defaulted', path, `expected boolean; using ${String(fallback)}`);
  return fallback;
}

/* -- Text hygiene -------------------------------------------------------- */

type CodePointRange = readonly [number, number];

/** C0 and C1 control characters, minus the whitespace the collapser handles. */
const CONTROL_RANGES: readonly CodePointRange[] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
];

/**
 * Zero-width and bidirectional-formatting characters.
 *
 * Stripped rather than escaped: they pass through `escapeHtml()` untouched and can
 * visually reverse or hide rendered text on a page published under our own brand.
 * That is the "trojan source" trick pointed at the visitor instead of a compiler.
 */
const INVISIBLE_RANGES: readonly CodePointRange[] = [
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

/**
 * Compiles code-point ranges into a character-class regex.
 *
 * Ranges are declared numerically instead of as escapes in a literal so that each one
 * can be named in a comment and reviewed as data.
 */
function rangesToRegExp(ranges: readonly CodePointRange[]): RegExp {
  const escape = (codePoint: number): string => '\\u' + codePoint.toString(16).padStart(4, '0');
  const body = ranges
    .map(([low, high]) => (low === high ? escape(low) : `${escape(low)}-${escape(high)}`))
    .join('');
  return new RegExp(`[${body}]`, 'gu');
}

const CONTROL_CHARS = rangesToRegExp(CONTROL_RANGES);
const INVISIBLE_CHARS = rangesToRegExp(INVISIBLE_RANGES);

/**
 * Collapses whitespace, removes characters that can lie about what the text says, and
 * truncates at a word boundary.
 *
 * Returns `""` for any non-string input, so callers can treat "absent" and "empty"
 * identically: both mean the copy is missing and only the model can supply it.
 */
export function normalizeText(value: unknown, max: number, log?: RepairLog, path?: string): string {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .normalize('NFC')
    .replace(CONTROL_CHARS, ' ')
    .replace(INVISIBLE_CHARS, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const truncated = truncateAtWordBoundary(cleaned, max);
  if (log !== undefined && path !== undefined && truncated.length < cleaned.length) {
    note(log, 'text_truncated', path, `${[...cleaned].length} code points > ${max}`);
  }
  return truncated;
}

/**
 * Truncates to at most `max` code points, cutting at the last word boundary that fits.
 *
 * No ellipsis is appended: a visible "..." in a headline reads as a broken site rather
 * than a shortened one. Falls back to a hard cut when backing off to a space would
 * discard more than 40% of the budget (long compounds, CJK, URLs pasted as text).
 */
export function truncateAtWordBoundary(text: string, max: number): string {
  if (max <= 0) return '';
  const chars = [...text];
  if (chars.length <= max) return text;

  const hard = chars.slice(0, max).join('');
  const boundary = chars[max];
  if (boundary !== undefined && /\s/u.test(boundary)) return trimEdgePunctuation(hard);

  const lastSpace = hard.lastIndexOf(' ');
  const keep = lastSpace >= Math.floor(max * 0.6) ? hard.slice(0, lastSpace) : hard;
  return trimEdgePunctuation(keep);
}

function trimEdgePunctuation(text: string): string {
  return text.replace(/[\s,;:.–—-]+$/u, '');
}

/**
 * Normalises a colour to lowercase `#rrggbb` / `#rrggbbaa`, expanding shorthand.
 *
 * Returns `null` for anything that is not a hex colour. Applied to the media
 * pipeline's `dominantColor` and to resolved design tokens; the model itself can
 * never author a colour (invariant 3).
 */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();
  const body = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/u.exec(raw)?.[1];
  if (body === undefined) return null;
  const full = body.length <= 4 ? [...body].map((char) => `${char}${char}`).join('') : body;
  return `#${full}`;
}

/** Ids that would collide with the page-slot namespace (`page.<pageId>.meta.title`). */
const RESERVED_IDS: ReadonlySet<string> = new Set(['page', 'site', 'doc']);

/**
 * Coerces a model-authored id into a safe DOM/CSS identifier.
 *
 * Section ids become `id=` attribute values and anchor-link fragments, so the charset
 * is closed to `[a-z0-9-]` and a leading digit is prefixed: `id="3col"` is legal
 * HTML5 but `#3col` is not a valid CSS selector, and the archetype CSS targets these.
 */
export function normalizeIdentifier(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, LIMITS.identifierChars);
  if (slug.length === 0 || RESERVED_IDS.has(slug)) return fallback;
  return /^[0-9]/u.test(slug) ? `id-${slug}` : slug;
}

function uniqueId(candidate: string, taken: ReadonlySet<string>): string {
  if (!taken.has(candidate)) return candidate;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const next = `${candidate}-${suffix}`;
    if (!taken.has(next)) return next;
  }
  // 1000 collisions on one id cannot survive array clamping; a time-based suffix
  // keeps the function total rather than adding a throw to a repair-only module.
  return `${candidate}-${Date.now().toString(36)}`;
}

function clampArray<T>(
  items: readonly T[],
  range: LengthRange,
  pad: (index: number) => T,
  log: RepairLog,
  path: string,
): T[] {
  const out = items.slice(0, range.max);
  if (items.length > range.max) {
    note(log, 'array_truncated', path, `${items.length} -> ${range.max}`);
  }
  while (out.length < range.min) {
    out.push(pad(out.length));
    note(log, 'array_padded', path, `padded up to minimum ${range.min}`);
  }
  return out;
}

function normalizeMediaRef(
  value: unknown,
  ctx: NormalizeContext,
  log: RepairLog,
  path: string,
): MediaRef | null {
  if (value === null || value === undefined) return null;
  const record = asRecord(value);
  if (record === null) {
    note(log, 'dangling_media_ref_dropped', path, 'not an object');
    return null;
  }
  const rawRefId: unknown = record.refId;
  const refId = typeof rawRefId === 'string' ? rawRefId.trim() : '';
  if (refId === '' || !ctx.knownMediaRefIds.has(refId)) {
    note(log, 'dangling_media_ref_dropped', path, `refId "${refId}" is not in the manifest`);
    return null;
  }
  return {
    refId,
    focalPoint: isMember(record.focalPoint, FOCAL_POINTS) ? record.focalPoint : 'center',
  };
}

/* -- Link refs ----------------------------------------------------------- */

/**
 * Shape-checks a model-emitted link without resolving it.
 *
 * Resolution happens in a second pass because page and section ids are still being
 * de-duplicated while sections are built, so a link cannot be checked against the
 * final id sets until every section exists.
 */
function parseLinkShape(value: unknown): LinkRef | null {
  const record = asRecord(value);
  if (record === null) return null;
  const rawKind: unknown = record.kind;
  const kind = typeof rawKind === 'string' ? rawKind : '';
  switch (kind) {
    case 'page': {
      const pageId: unknown = record.pageId;
      return typeof pageId === 'string' ? { kind: 'page', pageId } : null;
    }
    case 'anchor': {
      const sectionId: unknown = record.sectionId;
      return typeof sectionId === 'string' ? { kind: 'anchor', sectionId } : null;
    }
    case 'external': {
      const refId: unknown = record.refId;
      return typeof refId === 'string' ? { kind: 'external', refId } : null;
    }
    case 'tel':
    case 'whatsapp':
    case 'email':
    case 'route':
      return { kind, _: null };
    default:
      return null;
  }
}

/** Resolves one raw id against a rename map and the final id set. */
function resolveId(
  raw: string,
  remap: ReadonlyMap<string, string>,
  known: ReadonlySet<string>,
): string | null {
  const mapped = remap.get(raw);
  if (mapped !== undefined && known.has(mapped)) return mapped;
  if (known.has(raw)) return raw;
  const sanitised = normalizeIdentifier(raw, '');
  return sanitised !== '' && known.has(sanitised) ? sanitised : null;
}

/** Resolves a link against final ids, or returns `null` when it dangles. */
type LinkResolver = (link: LinkRef, path: string) => LinkRef | null;

function makeLinkResolver(
  pageIds: ReadonlySet<string>,
  sectionIds: ReadonlySet<string>,
  pageRemap: ReadonlyMap<string, string>,
  sectionRemap: ReadonlyMap<string, string>,
  externalRefIds: ReadonlySet<string>,
  log: RepairLog,
): LinkResolver {
  return (link, path) => {
    switch (link.kind) {
      case 'page': {
        const pageId = resolveId(link.pageId, pageRemap, pageIds);
        if (pageId === null) {
          note(log, 'dangling_link_ref_dropped', path, `no page "${link.pageId}"`);
          return null;
        }
        return { kind: 'page', pageId };
      }
      case 'anchor': {
        const sectionId = resolveId(link.sectionId, sectionRemap, sectionIds);
        if (sectionId === null) {
          note(log, 'dangling_link_ref_dropped', path, `no section "${link.sectionId}"`);
          return null;
        }
        return { kind: 'anchor', sectionId };
      }
      case 'external': {
        if (!externalRefIds.has(link.refId)) {
          note(log, 'dangling_link_ref_dropped', path, `"${link.refId}" is not allowlisted`);
          return null;
        }
        return link;
      }
      default:
        // tel / whatsapp / email / route are built by code from D1 facts. Whether the
        // fact exists is a lint concern, not a normalisation one.
        return link;
    }
  };
}

function parseCtas(value: unknown, log: RepairLog, path: string): Cta[] {
  const raw = asArray(value);
  const parsed: Cta[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const record = asRecord(raw[i]);
    if (record === null) continue;
    const target = parseLinkShape(record.target);
    if (target === null) {
      note(log, 'dangling_link_ref_dropped', `${path}.${i}`, 'unusable link target');
      continue;
    }
    parsed.push({
      target,
      style: pickEnum(record.style, CTA_STYLES, 'primary', log, `${path}.${i}.style`),
    });
  }
  return truncateArray(parsed, LIMITS.ctasPerSection.max, log, path);
}

function truncateArray<T>(items: readonly T[], max: number, log: RepairLog, path: string): T[] {
  if (items.length <= max) return items.slice();
  note(log, 'array_truncated', path, `${items.length} -> ${max}`);
  return items.slice(0, max);
}

/* -- Sections ------------------------------------------------------------ */

/**
 * Repairs one section, or returns `null` when the section cannot be rendered at all
 * (unknown type, or a gallery with no surviving media).
 *
 * Ids are sanitised and made site-wide unique here; `sectionRemap` records the
 * rename so link refs emitted against the original id still resolve.
 */
function normalizeSection(
  value: unknown,
  index: number,
  ctx: NormalizeContext,
  takenSectionIds: Set<string>,
  sectionRemap: Map<string, string>,
  log: RepairLog,
  path: string,
): SectionGen | null {
  const record = asRecord(value);
  if (record === null) {
    note(log, 'section_dropped', path, 'not an object');
    return null;
  }

  const rawType: unknown = record.type;
  if (!isMember(rawType, SECTION_TYPES)) {
    note(log, 'section_dropped', path, `unknown section type ${describeValue(rawType)}`);
    return null;
  }

  const rawSectionId: unknown = record.id;
  const rawId = typeof rawSectionId === 'string' ? rawSectionId : '';
  const base = normalizeIdentifier(rawId, `${rawType}-${index}`);
  const id = uniqueId(base, takenSectionIds);
  takenSectionIds.add(id);
  if (rawId !== '' && !sectionRemap.has(rawId)) sectionRemap.set(rawId, id);
  if (id !== rawId) {
    note(
      log,
      rawId !== '' && base !== id ? 'duplicate_id_renamed' : 'identifier_rewritten',
      `${path}.id`,
      `"${rawId}" -> "${id}"`,
    );
  }

  const media = (): MediaRef | null => normalizeMediaRef(record.media, ctx, log, `${path}.media`);

  switch (rawType) {
    case 'hero':
      return {
        id,
        type: 'hero',
        variant: pickEnum(record.variant, HERO_VARIANTS, 'image_split', log, `${path}.variant`),
        media: media(),
        ctas: parseCtas(record.ctas, log, `${path}.ctas`),
        showTrustline: pickBoolean(record.showTrustline, false, log, `${path}.showTrustline`),
      };

    case 'usp_trio':
      return {
        id,
        type: 'usp_trio',
        variant: pickEnum(record.variant, USP_TRIO_VARIANTS, 'icons_row', log, `${path}.variant`),
        items: clampArray(
          asArray(record.items).map((item, i) => ({
            iconId: pickEnum(
              asRecord(item)?.iconId,
              ICON_IDS,
              'star',
              log,
              `${path}.items.${i}.iconId`,
            ),
          })),
          LIMITS.uspItems,
          () => ({ iconId: 'star' }),
          log,
          `${path}.items`,
        ),
      };

    case 'about':
      return {
        id,
        type: 'about',
        variant: pickEnum(record.variant, ABOUT_VARIANTS, 'text_image', log, `${path}.variant`),
        media: media(),
        paragraphs: clampArray(
          asArray(record.paragraphs).map((item, i) => ({
            emphasis: pickEnum(
              asRecord(item)?.emphasis,
              PARAGRAPH_EMPHASIS,
              'normal',
              log,
              `${path}.paragraphs.${i}.emphasis`,
            ),
          })),
          LIMITS.aboutParagraphs,
          () => ({ emphasis: 'normal' }),
          log,
          `${path}.paragraphs`,
        ),
        cta: ((): Cta | null => {
          const parsed = parseCtas([record.cta], log, `${path}.cta`);
          return parsed[0] ?? null;
        })(),
      };

    case 'services_grid':
      return {
        id,
        type: 'services_grid',
        variant: pickEnum(
          record.variant,
          SERVICES_GRID_VARIANTS,
          'cards_3col',
          log,
          `${path}.variant`,
        ),
        items: clampArray(
          asArray(record.items).map((item, i) => {
            const entry = asRecord(item);
            return {
              media: normalizeMediaRef(entry?.media, ctx, log, `${path}.items.${i}.media`),
              target: parseLinkShape(entry?.target),
              showPrice: pickBoolean(entry?.showPrice, false, log, `${path}.items.${i}.showPrice`),
            };
          }),
          LIMITS.serviceItems,
          () => ({ media: null, target: null, showPrice: false }),
          log,
          `${path}.items`,
        ),
      };

    case 'menu':
      return {
        id,
        type: 'menu',
        variant: pickEnum(record.variant, MENU_VARIANTS, 'two_column', log, `${path}.variant`),
        groups: clampArray(
          asArray(record.groups).map((group, g) => ({
            items: clampArray(
              asArray(asRecord(group)?.items).map((item, i) => {
                const entry = asRecord(item);
                return {
                  showDescription: pickBoolean(
                    entry?.showDescription,
                    true,
                    log,
                    `${path}.groups.${g}.items.${i}.showDescription`,
                  ),
                  tags: truncateArray(
                    asArray(entry?.tags).filter((tag): tag is (typeof MENU_ITEM_TAGS)[number] =>
                      isMember(tag, MENU_ITEM_TAGS),
                    ),
                    LIMITS.menuItemTags.max,
                    log,
                    `${path}.groups.${g}.items.${i}.tags`,
                  ),
                };
              }),
              LIMITS.menuItemsPerGroup,
              () => ({ showDescription: false, tags: [] }),
              log,
              `${path}.groups.${g}.items`,
            ),
          })),
          LIMITS.menuGroups,
          () => ({ items: [{ showDescription: false, tags: [] }] }),
          log,
          `${path}.groups`,
        ),
      };

    case 'gallery': {
      const refs: MediaRef[] = [];
      const rawMedia = asArray(record.media);
      for (let i = 0; i < rawMedia.length; i += 1) {
        const ref = normalizeMediaRef(rawMedia[i], ctx, log, `${path}.media.${i}`);
        if (ref !== null) refs.push(ref);
      }
      if (refs.length === 0) {
        const [fallback] = [...ctx.knownMediaRefIds];
        if (fallback === undefined) {
          note(log, 'section_dropped', path, 'gallery has no resolvable media');
          return null;
        }
        refs.push({ refId: fallback, focalPoint: 'center' });
        note(log, 'array_padded', `${path}.media`, 'substituted the first manifest asset');
      }
      return {
        id,
        type: 'gallery',
        variant: pickEnum(record.variant, GALLERY_VARIANTS, 'grid_square', log, `${path}.variant`),
        media: truncateArray(refs, LIMITS.galleryMedia.max, log, `${path}.media`),
        showCaptions: pickBoolean(record.showCaptions, false, log, `${path}.showCaptions`),
      };
    }

    case 'reviews':
      return {
        id,
        type: 'reviews',
        variant: pickEnum(record.variant, REVIEWS_VARIANTS, 'cards_3col', log, `${path}.variant`),
        source: pickEnum(record.source, REVIEW_SOURCES, 'manual', log, `${path}.source`),
      };

    case 'team':
      return {
        id,
        type: 'team',
        variant: pickEnum(record.variant, TEAM_VARIANTS, 'portraits_grid', log, `${path}.variant`),
        items: clampArray(
          asArray(record.items).map((item, i) => {
            const entry = asRecord(item);
            return {
              media: normalizeMediaRef(entry?.media, ctx, log, `${path}.items.${i}.media`),
              showBio: pickBoolean(entry?.showBio, false, log, `${path}.items.${i}.showBio`),
            };
          }),
          LIMITS.teamItems,
          () => ({ media: null, showBio: false }),
          log,
          `${path}.items`,
        ),
      };

    case 'process_steps':
      return {
        id,
        type: 'process_steps',
        variant: pickEnum(
          record.variant,
          PROCESS_STEPS_VARIANTS,
          'numbered_horizontal',
          log,
          `${path}.variant`,
        ),
        items: clampArray(
          asArray(record.items).map((item) => {
            const iconId: unknown = asRecord(item)?.iconId;
            return { iconId: isMember(iconId, ICON_IDS) ? iconId : null };
          }),
          LIMITS.processSteps,
          () => ({ iconId: null }),
          log,
          `${path}.items`,
        ),
      };

    case 'stats_band':
      return {
        id,
        type: 'stats_band',
        variant: pickEnum(record.variant, STATS_BAND_VARIANTS, 'plain', log, `${path}.variant`),
        items: clampArray(
          asArray(record.items).map((item) => {
            const iconId: unknown = asRecord(item)?.iconId;
            return { iconId: isMember(iconId, ICON_IDS) ? iconId : null };
          }),
          LIMITS.statsItems,
          () => ({ iconId: null }),
          log,
          `${path}.items`,
        ),
      };

    case 'faq':
      return {
        id,
        type: 'faq',
        variant: pickEnum(record.variant, FAQ_VARIANTS, 'accordion', log, `${path}.variant`),
        emitFaqSchema: pickBoolean(record.emitFaqSchema, false, log, `${path}.emitFaqSchema`),
        items: clampArray(
          asArray(record.items).map((item, i) => ({
            expandedByDefault: pickBoolean(
              asRecord(item)?.expandedByDefault,
              false,
              log,
              `${path}.items.${i}.expandedByDefault`,
            ),
          })),
          LIMITS.faqItems,
          () => ({ expandedByDefault: false }),
          log,
          `${path}.items`,
        ),
      };

    case 'booking':
      return {
        id,
        type: 'booking',
        variant: pickEnum(
          record.variant,
          BOOKING_VARIANTS,
          'cta_to_provider',
          log,
          `${path}.variant`,
        ),
        provider: pickEnum(record.provider, BOOKING_PROVIDERS, 'native', log, `${path}.provider`),
        providerLink: parseLinkShape(record.providerLink),
      };

    case 'contact_form': {
      const seen = new Set<string>();
      const fields: { name: (typeof CONTACT_FIELD_NAMES)[number]; required: boolean }[] = [];
      const rawFields = asArray(record.fields);
      for (let i = 0; i < rawFields.length; i += 1) {
        const entry = asRecord(rawFields[i]);
        const name: unknown = entry?.name;
        if (!isMember(name, CONTACT_FIELD_NAMES)) continue;
        if (seen.has(name)) {
          note(log, 'duplicate_entry_dropped', `${path}.fields.${i}`, `duplicate field "${name}"`);
          continue;
        }
        seen.add(name);
        fields.push({
          name,
          // A consent checkbox that is not required is not consent.
          required:
            name === 'consent'
              ? true
              : pickBoolean(entry?.required, false, log, `${path}.fields.${i}.required`),
        });
      }
      return {
        id,
        type: 'contact_form',
        variant: pickEnum(record.variant, CONTACT_FORM_VARIANTS, 'stacked', log, `${path}.variant`),
        fields: clampArray(
          fields,
          LIMITS.contactFields,
          (i) => DEFAULT_CONTACT_FIELDS[i] ?? { name: 'message', required: true },
          log,
          `${path}.fields`,
        ),
      };
    }

    case 'map_hours':
      return {
        id,
        type: 'map_hours',
        variant: pickEnum(record.variant, MAP_HOURS_VARIANTS, 'map_left', log, `${path}.variant`),
        showRouteCta: pickBoolean(record.showRouteCta, true, log, `${path}.showRouteCta`),
      };

    case 'cta_band':
      return {
        id,
        type: 'cta_band',
        variant: pickEnum(record.variant, CTA_BAND_VARIANTS, 'accent_full', log, `${path}.variant`),
        media: media(),
        ctas: parseCtas(record.ctas, log, `${path}.ctas`),
      };

    case 'blog_teaser':
      return {
        id,
        type: 'blog_teaser',
        variant: pickEnum(
          record.variant,
          BLOG_TEASER_VARIANTS,
          'cards_2col',
          log,
          `${path}.variant`,
        ),
        showExcerpts: pickBoolean(record.showExcerpts, true, log, `${path}.showExcerpts`),
      };

    case 'rich_text':
      return {
        id,
        type: 'rich_text',
        variant: pickEnum(
          record.variant,
          RICH_TEXT_VARIANTS,
          'prose_narrow',
          log,
          `${path}.variant`,
        ),
        paragraphs: clampArray(
          asArray(record.paragraphs).map((item, i) => ({
            style: pickEnum(
              asRecord(item)?.style,
              PROSE_STYLES,
              'paragraph',
              log,
              `${path}.paragraphs.${i}.style`,
            ),
          })),
          LIMITS.richTextParagraphs,
          () => ({ style: 'paragraph' }),
          log,
          `${path}.paragraphs`,
        ),
      };

    default: {
      // `rawType` is narrowed to `never` here; a new section type that is not handled
      // above is a compile error rather than a silently dropped section.
      const unreachable: never = rawType;
      note(log, 'section_dropped', path, `unhandled type ${String(unreachable)}`);
      return null;
    }
  }
}

/**
 * The lead form a repaired `contact_form` falls back to.
 *
 * Name, message and consent are the minimum that produces a usable lead and a lawful
 * one; e-mail is the reply channel.
 */
const DEFAULT_CONTACT_FIELDS: readonly {
  name: (typeof CONTACT_FIELD_NAMES)[number];
  required: boolean;
}[] = [
  { name: 'name', required: true },
  { name: 'email', required: true },
  { name: 'message', required: true },
  { name: 'consent', required: true },
];

/** Rewrites every link a section owns through `resolve`, dropping the unresolvable. */
function resolveSectionLinks(
  section: SectionGen,
  resolve: LinkResolver,
  log: RepairLog,
  path: string,
): SectionGen {
  const resolveCtas = (ctas: readonly Cta[], base: string): Cta[] => {
    const out: Cta[] = [];
    for (let i = 0; i < ctas.length; i += 1) {
      const cta = ctas[i];
      if (cta === undefined) continue;
      const target = resolve(cta.target, `${base}.${i}.target`);
      if (target === null) continue;
      out.push({ target, style: cta.style });
    }
    return out;
  };

  switch (section.type) {
    case 'hero':
      return { ...section, ctas: resolveCtas(section.ctas, `${path}.ctas`) };
    case 'cta_band':
      return { ...section, ctas: resolveCtas(section.ctas, `${path}.ctas`) };
    case 'about': {
      if (section.cta === null) return section;
      const [cta] = resolveCtas([section.cta], `${path}.cta`);
      return { ...section, cta: cta ?? null };
    }
    case 'services_grid':
      return {
        ...section,
        items: section.items.map((item, i) => ({
          ...item,
          target: item.target === null ? null : resolve(item.target, `${path}.items.${i}.target`),
        })),
      };
    case 'booking': {
      const providerLink =
        section.providerLink === null
          ? null
          : resolve(section.providerLink, `${path}.providerLink`);
      if (providerLink === null && section.provider === 'external_link') {
        // A provider CTA with nowhere to go is a dead end; fall back to the native
        // form, which always works.
        note(log, 'enum_fallback', `${path}.provider`, 'external_link without a link');
        return { ...section, providerLink, provider: 'native' };
      }
      return { ...section, providerLink };
    }
    default:
      return section;
  }
}

/* -- Theme and JSON-LD inputs -------------------------------------------- */

function normalizeTheme(value: unknown, log: RepairLog): ThemeGen {
  const record = asRecord(value) ?? {};
  return {
    dnaId: pickEnum(record.dnaId, DNA_IDS, 'clinical_trust', log, 'theme.dnaId'),
    paletteVariant: pickEnum(
      record.paletteVariant,
      PALETTE_VARIANTS,
      'default',
      log,
      'theme.paletteVariant',
    ),
    accentHueShift: pickEnum(record.accentHueShift, HUE_SHIFTS, '0', log, 'theme.accentHueShift'),
    typeScaleId: pickEnum(record.typeScaleId, TYPE_SCALE_IDS, 'regular', log, 'theme.typeScaleId'),
    radiusId: pickEnum(record.radiusId, RADIUS_IDS, 'soft', log, 'theme.radiusId'),
    densityId: pickEnum(record.densityId, DENSITY_IDS, 'regular', log, 'theme.densityId'),
    motionId: pickEnum(record.motionId, MOTION_IDS, 'subtle', log, 'theme.motionId'),
    colorMode: pickEnum(record.colorMode, COLOR_MODES, 'light', log, 'theme.colorMode'),
    rationale: normalizeText(record.rationale, LIMITS.rationaleChars),
  };
}

function dedupeEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  max: number,
  log: RepairLog,
  path: string,
): T[] {
  const seen = new Set<T>();
  for (const entry of asArray(value)) {
    if (isMember(entry, allowed)) seen.add(entry);
  }
  return truncateArray([...seen], max, log, path);
}

function normalizeJsonLdInputs(value: unknown, log: RepairLog): JsonLdInputsGen {
  const record = asRecord(value) ?? {};
  const rawCuisine = record.servesCuisine;
  const servesCuisine = Array.isArray(rawCuisine)
    ? truncateArray(
        rawCuisine
          .map((entry) => normalizeText(entry, LIMITS.cuisineChars))
          .filter((entry) => entry.length > 0),
        LIMITS.servesCuisine.max,
        log,
        'jsonLd.servesCuisine',
      )
    : null;

  return {
    schemaOrgType: pickEnum(
      record.schemaOrgType,
      SCHEMA_ORG_TYPES,
      'LocalBusiness',
      log,
      'jsonLd.schemaOrgType',
    ),
    priceRange: isMember(record.priceRange, PRICE_RANGES) ? record.priceRange : null,
    servesCuisine,
    acceptsReservations: ((): boolean | null => {
      const value: unknown = record.acceptsReservations;
      return typeof value === 'boolean' ? value : null;
    })(),
    paymentAccepted: dedupeEnumArray(
      record.paymentAccepted,
      PAYMENT_METHODS,
      LIMITS.paymentMethods.max,
      log,
      'jsonLd.paymentAccepted',
    ),
    amenities: dedupeEnumArray(
      record.amenities,
      AMENITIES,
      LIMITS.amenities.max,
      log,
      'jsonLd.amenities',
    ),
  };
}

/* -- Pages --------------------------------------------------------------- */

function normalizePage(
  value: unknown,
  index: number,
  ctx: NormalizeContext,
  takenPageIds: Set<string>,
  pageRemap: Map<string, string>,
  takenSectionIds: Set<string>,
  sectionRemap: Map<string, string>,
  log: RepairLog,
  path: string,
): PageGen | null {
  const record = asRecord(value);
  if (record === null) {
    note(log, 'page_dropped', path, 'not an object');
    return null;
  }

  const rawPageId: unknown = record.pageId;
  const rawId = typeof rawPageId === 'string' ? rawPageId : '';
  const base = normalizeIdentifier(rawId, `page-${index}`);
  const pageId = uniqueId(base, takenPageIds);
  takenPageIds.add(pageId);
  if (rawId !== '' && !pageRemap.has(rawId)) pageRemap.set(rawId, pageId);
  if (pageId !== rawId) {
    note(log, 'identifier_rewritten', `${path}.pageId`, `"${rawId}" -> "${pageId}"`);
  }

  const sections: SectionGen[] = [];
  const rawSections = asArray(record.sections);
  for (let i = 0; i < rawSections.length && sections.length < LIMITS.sectionsPerPage.max; i += 1) {
    const section = normalizeSection(
      rawSections[i],
      i,
      ctx,
      takenSectionIds,
      sectionRemap,
      log,
      `${path}.sections.${i}`,
    );
    if (section !== null) sections.push(section);
  }
  if (rawSections.length > LIMITS.sectionsPerPage.max) {
    note(
      log,
      'array_truncated',
      `${path}.sections`,
      `${rawSections.length} -> ${LIMITS.sectionsPerPage.max}`,
    );
  }
  if (sections.length === 0) {
    // A page with nothing on it cannot be published, and inventing sections would
    // invent copy slots the model was never asked to fill.
    note(log, 'page_dropped', path, 'no renderable sections survived normalisation');
    return null;
  }

  return {
    pageId,
    role: pickEnum(record.role, PAGE_ROLES, index === 0 ? 'home' : 'services', log, `${path}.role`),
    noindex: pickBoolean(record.noindex, false, log, `${path}.noindex`),
    showInNav: pickBoolean(record.showInNav, true, log, `${path}.showInNav`),
    ogMedia: normalizeMediaRef(record.ogMedia, ctx, log, `${path}.ogMedia`),
    sections,
  };
}

/**
 * Forces exactly one page to hold the `home` role.
 *
 * Two home pages both claim `/{locale}/`, and zero means the site has no entry
 * point; either breaks routing before anything reaches the renderer.
 */
function enforceSingleHome(pages: readonly PageGen[], log: RepairLog): PageGen[] {
  let homeSeen = false;
  const out = pages.map((page, index) => {
    if (page.role !== 'home') return page;
    if (!homeSeen) {
      homeSeen = true;
      return page;
    }
    note(log, 'duplicate_role_demoted', `pages.${index}.role`, 'second home page -> services');
    return { ...page, role: 'services' as const };
  });

  const first = out[0];
  if (!homeSeen && first !== undefined) {
    note(
      log,
      'missing_field_defaulted',
      'pages.0.role',
      `no home page; promoted "${first.pageId}"`,
    );
    out[0] = { ...first, role: 'home' };
  }
  return out;
}

/* -- Entry points -------------------------------------------------------- */

/**
 * Repairs a raw `SiteStructureGen` from the model into a schema-valid,
 * referentially-consistent structure.
 *
 * Guarantees: never throws; section ids are unique site-wide and safe as DOM ids;
 * every media ref exists in the manifest; every link resolves or is gone; exactly one
 * page holds the `home` role; every array is inside `LIMITS`. Returns
 * `value: null` only when no page survived.
 */
export function normalizeStructure(
  input: unknown,
  ctx: NormalizeContext,
): NormalizeResult<SiteStructureGen> {
  const log: RepairLog = [];
  const root = asRecord(input);
  if (root === null) {
    note(log, 'unsalvageable', '', 'structure is not an object');
    return { value: null, repairs: log };
  }

  const takenPageIds = new Set<string>();
  const takenSectionIds = new Set<string>();
  const pageRemap = new Map<string, string>();
  const sectionRemap = new Map<string, string>();

  const rawPages = asArray(root.pages);
  const pages: PageGen[] = [];
  for (let i = 0; i < rawPages.length && pages.length < LIMITS.pagesPerSite.max; i += 1) {
    const page = normalizePage(
      rawPages[i],
      i,
      ctx,
      takenPageIds,
      pageRemap,
      takenSectionIds,
      sectionRemap,
      log,
      `pages.${i}`,
    );
    if (page !== null) pages.push(page);
  }
  if (rawPages.length > LIMITS.pagesPerSite.max) {
    note(log, 'array_truncated', 'pages', `${rawPages.length} -> ${LIMITS.pagesPerSite.max}`);
  }
  if (pages.length === 0) {
    note(log, 'unsalvageable', 'pages', 'no page survived normalisation');
    return { value: null, repairs: log };
  }

  const withHome = enforceSingleHome(pages, log);
  const pageIds = new Set(withHome.map((page) => page.pageId));
  const sectionIds = new Set(withHome.flatMap((page) => page.sections.map((s) => s.id)));
  const resolve = makeLinkResolver(
    pageIds,
    sectionIds,
    pageRemap,
    sectionRemap,
    ctx.knownExternalRefIds,
    log,
  );
  const linked = withHome.map((page, pageIndex) => ({
    ...page,
    sections: page.sections.map((section, sectionIndex) =>
      resolveSectionLinks(section, resolve, log, `pages.${pageIndex}.sections.${sectionIndex}`),
    ),
  }));

  const safety = asRecord(root.inputSafety) ?? {};
  const rawContainsInstructions: unknown = safety.containsInstructions;
  const containsInstructionsFlag =
    typeof rawContainsInstructions === 'boolean' ? rawContainsInstructions : true;
  const candidate: SiteStructureGen = {
    schemaVersion: '1',
    theme: normalizeTheme(root.theme, log),
    primaryLocale: pickEnum(
      root.primaryLocale,
      ctx.allowedLocales,
      ctx.primaryLocale,
      log,
      'primaryLocale',
    ),
    pages: linked,
    jsonLd: normalizeJsonLdInputs(root.jsonLd, log),
    navStyle: pickEnum(root.navStyle, NAV_STYLES, 'logo_left_links_right', log, 'navStyle'),
    footerStyle: pickEnum(root.footerStyle, FOOTER_STYLES, 'compact_2col', log, 'footerStyle'),
    whatsappEnabled: pickBoolean(root.whatsappEnabled, false, log, 'whatsappEnabled'),
    stockQueryHint: normalizeText(root.stockQueryHint, LIMITS.stockQueryHintChars),
    inputSafety: {
      // Defaults to `true`: an intake we could not read is treated as suspicious, not
      // as clean, because this flag only ever raises moderation scrutiny.
      containsInstructions: containsInstructionsFlag,
      note: normalizeText(safety.note, LIMITS.safetyNoteChars),
    },
  };

  // Belt and braces: the object above is built to be valid by construction, so a
  // failure here means the normaliser and the schema have drifted apart.
  const parsed = SiteStructureGen.safeParse(candidate);
  if (!parsed.success) {
    note(log, 'post_normalize_parse_failed', '', parsed.error.issues.map(formatIssue).join('; '));
    return { value: null, repairs: log };
  }
  return { value: parsed.data, repairs: log };
}

function formatIssue(issue: { path: readonly PropertyKey[]; message: string }): string {
  return `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`;
}

/**
 * Repairs a locale bundle against the slot inventory derived from its structure.
 *
 * Drops entries the model invented, drops duplicates (first wins), drops entries that
 * are blank after cleaning so they surface as *missing* rather than as empty strings
 * on a live page, and truncates the rest at their slot's ceiling. Output entries are
 * emitted in inventory order, so two runs over the same input are byte-identical.
 *
 * It never invents copy: filling `missing` is the only thing worth another model call.
 */
export function normalizeLocaleBundle(
  input: unknown,
  inventory: SlotInventory,
  ctx: NormalizeContext,
): NormalizeResult<LocaleBundleGen> {
  const log: RepairLog = [];
  const root = asRecord(input);
  if (root === null) {
    note(log, 'unsalvageable', '', 'bundle is not an object');
    return { value: null, repairs: log };
  }

  const texts = new Map<string, string>();
  const rawEntries = asArray(root.entries);
  for (let i = 0; i < rawEntries.length; i += 1) {
    const entry = asRecord(rawEntries[i]);
    const rawEntryId: unknown = entry === null ? undefined : entry.id;
    const id = typeof rawEntryId === 'string' ? rawEntryId.trim() : '';
    const descriptor = inventory.byId.get(id);
    if (descriptor === undefined) {
      note(log, 'unknown_slot_dropped', `entries.${i}`, `slot "${id}" is not in the inventory`);
      continue;
    }
    if (texts.has(id)) {
      note(log, 'duplicate_entry_dropped', `entries.${i}`, `slot "${id}" seen twice`);
      continue;
    }
    const text = normalizeText(entry?.text, descriptor.maxLength, log, `entries.${i}`);
    if (text.length === 0) {
      note(log, 'blank_slot_dropped', `entries.${i}`, `slot "${id}" is blank`);
      continue;
    }
    texts.set(id, text);
  }

  const entries: { id: string; text: string }[] = [];
  for (const descriptor of inventory.slots) {
    const text = texts.get(descriptor.id);
    if (text !== undefined) entries.push({ id: descriptor.id, text });
  }

  const candidate: LocaleBundleGen = {
    schemaVersion: '1',
    locale: pickEnum(root.locale, ctx.allowedLocales, ctx.primaryLocale, log, 'locale'),
    entries,
  };
  const parsed = LocaleBundleGen.safeParse(candidate);
  if (!parsed.success) {
    note(log, 'post_normalize_parse_failed', '', parsed.error.issues.map(formatIssue).join('; '));
    return { value: null, repairs: log };
  }
  return { value: parsed.data, repairs: log };
}

function normalizeBlogBlock(
  value: unknown,
  ctx: DocumentNormalizeContext,
  resolve: LinkResolver,
  log: RepairLog,
  path: string,
): BlogBlockGen | null {
  const record = asRecord(value);
  if (record === null) return null;
  const type: unknown = record.type;
  if (!isMember(type, BLOG_BLOCK_TYPES)) {
    note(log, 'block_dropped', path, `unknown block type ${describeValue(type)}`);
    return null;
  }

  switch (type) {
    case 'h2':
    case 'h3': {
      const text = normalizeText(record.text, LIMITS.blogHeadingChars, log, `${path}.text`);
      if (text.length === 0) {
        note(log, 'block_dropped', path, 'heading has no text');
        return null;
      }
      return type === 'h2' ? { type: 'h2', text } : { type: 'h3', text };
    }
    case 'p': {
      const text = normalizeText(record.text, LIMITS.blogParagraphChars, log, `${path}.text`);
      if (text.length === 0) {
        note(log, 'block_dropped', path, 'paragraph has no text');
        return null;
      }
      return { type: 'p', text };
    }
    case 'ul':
    case 'ol': {
      const items = truncateArray(
        asArray(record.items)
          .map((item, i) =>
            normalizeText(item, LIMITS.blogListItemChars, log, `${path}.items.${i}`),
          )
          .filter((item) => item.length > 0),
        LIMITS.blogListItems.max,
        log,
        `${path}.items`,
      );
      if (items.length === 0) {
        note(log, 'block_dropped', path, 'list has no items');
        return null;
      }
      return type === 'ul' ? { type: 'ul', items } : { type: 'ol', items };
    }
    case 'quote': {
      const text = normalizeText(record.text, LIMITS.blogQuoteChars, log, `${path}.text`);
      if (text.length === 0) {
        note(log, 'block_dropped', path, 'quote has no text');
        return null;
      }
      const attribution = normalizeText(
        record.attributionText,
        LIMITS.blogAttributionChars,
        log,
        `${path}.attributionText`,
      );
      const attributionText = attribution.length === 0 ? null : attribution;
      return { type: 'quote', text, attributionText };
    }
    case 'image': {
      const media = normalizeMediaRef(record.media, ctx, log, `${path}.media`);
      if (media === null) {
        note(log, 'block_dropped', path, 'image has no resolvable media ref');
        return null;
      }
      const caption = normalizeText(
        record.captionText,
        LIMITS.blogCaptionChars,
        log,
        `${path}.captionText`,
      );
      return { type: 'image', media, captionText: caption.length === 0 ? null : caption };
    }
    case 'cta': {
      const shape = parseLinkShape(record.target);
      const target = shape === null ? null : resolve(shape, `${path}.target`);
      const labelText = normalizeText(
        record.labelText,
        LIMITS.blogCtaLabelChars,
        log,
        `${path}.labelText`,
      );
      if (target === null || labelText.length === 0) {
        note(log, 'block_dropped', path, 'cta has no usable target or label');
        return null;
      }
      return { type: 'cta', labelText, target };
    }
    default: {
      const unreachable: never = type;
      note(log, 'block_dropped', path, `unhandled block ${String(unreachable)}`);
      return null;
    }
  }
}

/**
 * Repairs one generated blog post.
 *
 * Returns `value: null` when the post has no title or no surviving block: an empty
 * post is a thin-content page that would drag the whole site's quality score down,
 * and re-running one blog step is cheap compared with publishing it.
 */
export function normalizeBlogPost(
  input: unknown,
  ctx: DocumentNormalizeContext,
): NormalizeResult<BlogPostGen> {
  const log: RepairLog = [];
  const root = asRecord(input);
  if (root === null) {
    note(log, 'unsalvageable', '', 'blog post is not an object');
    return { value: null, repairs: log };
  }

  const resolve = makeLinkResolver(
    ctx.knownPageIds,
    ctx.knownSectionIds,
    new Map(),
    new Map(),
    ctx.knownExternalRefIds,
    log,
  );

  const blocks: BlogBlockGen[] = [];
  const rawBlocks = asArray(root.blocks);
  for (let i = 0; i < rawBlocks.length && blocks.length < LIMITS.blogBlocks.max; i += 1) {
    const block = normalizeBlogBlock(rawBlocks[i], ctx, resolve, log, `blocks.${i}`);
    if (block !== null) blocks.push(block);
  }

  const titleText = normalizeText(root.titleText, LIMITS.blogTitleChars, log, 'titleText');
  if (titleText.length === 0 || blocks.length === 0) {
    note(log, 'unsalvageable', '', 'blog post has no title or no body');
    return { value: null, repairs: log };
  }

  const candidate: BlogPostGen = {
    schemaVersion: '1',
    locale: pickEnum(root.locale, ctx.allowedLocales, ctx.primaryLocale, log, 'locale'),
    titleText,
    slugSeed: normalizeText(root.slugSeed, LIMITS.blogSlugSeedChars, log, 'slugSeed') || titleText,
    excerptText: normalizeText(root.excerptText, LIMITS.blogExcerptChars, log, 'excerptText'),
    metaDescriptionText: normalizeText(
      root.metaDescriptionText,
      LIMITS.blogMetaDescriptionChars,
      log,
      'metaDescriptionText',
    ),
    heroMedia: normalizeMediaRef(root.heroMedia, ctx, log, 'heroMedia'),
    blocks,
  };

  const parsed = BlogPostGen.safeParse(candidate);
  if (!parsed.success) {
    note(log, 'post_normalize_parse_failed', '', parsed.error.issues.map(formatIssue).join('; '));
    return { value: null, repairs: log };
  }
  return { value: parsed.data, repairs: log };
}
