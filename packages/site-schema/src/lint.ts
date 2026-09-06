import type { LinkRef, MediaRef } from './gen/common';
import type { SectionGen, SectionType } from './gen/section';
import type { PageRole } from './gen/site-structure';
import type { SiteDoc } from './doc';
import { copyFor } from './doc';
import { normalizeHexColor } from './normalize';
import { deriveSlotInventoryForPages } from './slots';

/**
 * Semantic lint over an assembled `SiteDoc`.
 *
 * The schema proves the document is *well-formed*; this pass asks whether it is
 * *publishable*: does the text meet contrast against the theme it was themed with,
 * does every ref still resolve, is each section on a page where it makes sense, does
 * every required slot actually have copy, and does the document respect the legal
 * constraints (review markup, consent field) that a generated site can otherwise walk
 * straight into.
 *
 * It is pure and total: it reads a document and returns findings. The `assemble` step
 * fails on `error`, logs `warning`.
 */

/* -- Findings ------------------------------------------------------------ */

export type LintSeverity = 'error' | 'warning';

export type LintCode =
  | 'contrast_below_minimum'
  | 'token_missing'
  | 'token_unparseable'
  | 'dangling_media_ref'
  | 'dangling_external_ref'
  | 'dangling_page_ref'
  | 'dangling_anchor_ref'
  | 'section_not_allowed_on_page'
  | 'section_requires_fact'
  | 'blog_teaser_without_posts'
  | 'review_markup_not_permitted'
  | 'contact_form_without_consent'
  | 'contact_form_without_reply_channel'
  | 'faq_schema_without_items'
  | 'missing_copy'
  | 'missing_meta'
  | 'meta_title_too_long'
  | 'meta_description_too_long'
  | 'duplicate_path'
  | 'no_home_page'
  | 'home_noindex'
  | 'whatsapp_without_number'
  | 'route_without_address'
  | 'geo_source_conflict'
  | 'locale_without_copy';

export interface LintFinding {
  readonly code: LintCode;
  readonly severity: LintSeverity;
  /** Dotted path into the `SiteDoc`, e.g. `pages.2.sections.0`. */
  readonly path: string;
  readonly message: string;
  /** What a human should do about it. Surfaced in the dashboard, so keep it concrete. */
  readonly remediation: string;
}

/** True when at least one finding must block a publish. */
export function hasBlockingFindings(findings: readonly LintFinding[]): boolean {
  return findings.some((finding) => finding.severity === 'error');
}

/* -- Colour --------------------------------------------------------------- */

/** A colour in linear-light sRGB, components in `[0, 1]`. */
export interface LinearRgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Converts OKLCH to linear-light sRGB.
 *
 * The design tokens are OKLCH by construction (that is how `site-kit` can promise
 * perceptually even palettes), so contrast cannot be checked without this conversion.
 * Matrices are Bjorn Ottosson's published OKLab <-> linear sRGB pair.
 */
function oklchToLinearRgb(lightness: number, chroma: number, hueDegrees: number): LinearRgb {
  const hue = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);

  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return {
    r: clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

/** One numeric component of a CSS colour function, remembering percentage syntax. */
interface ColourComponent {
  readonly value: number;
  readonly isPercent: boolean;
}

function parseNumericComponents(inside: string): readonly ColourComponent[] {
  return inside
    .replace(/\//gu, ' ')
    .split(/[\s,]+/u)
    .filter((part) => part.length > 0)
    .map((part) =>
      part.endsWith('%')
        ? { value: Number.parseFloat(part) / 100, isPercent: true }
        : { value: Number.parseFloat(part), isPercent: false },
    );
}

/**
 * Parses `#rgb` / `#rrggbb` / `#rrggbbaa`, `rgb(...)` and `oklch(...)` into
 * linear-light sRGB.
 *
 * Returns `null` for anything else -- including `var(--x)` indirection, which the
 * linter deliberately refuses to follow: a token defined in terms of another token is
 * a token `site-kit` should have resolved before the document was stored.
 */
export function parseColor(value: string): LinearRgb | null {
  const trimmed = value.trim().toLowerCase();

  const hex = normalizeHexColor(trimmed);
  if (hex !== null) {
    const channel = (offset: number): number =>
      srgbToLinear(Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
    return { r: channel(1), g: channel(3), b: channel(5) };
  }

  const call = /^(rgb|rgba|oklch)\(([^)]*)\)$/u.exec(trimmed);
  const fn = call?.[1];
  const inside = call?.[2];
  if (fn === undefined || inside === undefined) return null;

  const [first, second, third] = parseNumericComponents(inside);
  if (first === undefined || second === undefined || third === undefined) return null;
  if (![first, second, third].every((part) => Number.isFinite(part.value))) return null;

  if (fn === 'oklch') return oklchToLinearRgb(first.value, second.value, third.value);
  // `rgb(50% 0% 0%)` and `rgb(128 0 0)` are the same colour written two ways.
  const channel = (part: ColourComponent): number =>
    srgbToLinear(clamp01(part.isPercent ? part.value : part.value / 255));
  return { r: channel(first), g: channel(second), b: channel(third) };
}

function relativeLuminance(colour: LinearRgb): number {
  return 0.2126 * colour.r + 0.7152 * colour.g + 0.0722 * colour.b;
}

/**
 * WCAG 2.x contrast ratio between two CSS colour strings, or `null` when either is
 * not a colour this linter can read.
 */
export function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (fg === null || bg === null) return null;
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/** One contrast obligation over the resolved theme tokens. */
export interface ContrastRequirement {
  readonly foreground: string;
  readonly background: string;
  readonly minRatio: number;
  readonly label: string;
}

/**
 * The token contract between `site-kit` and this linter.
 *
 * `site-kit`'s `tokens/resolve.ts` must emit these custom properties; a pair whose
 * tokens are absent produces a `token_missing` warning naming the token, rather than
 * silently passing a site whose contrast was never checked.
 */
export const CONTRAST_PAIRS: readonly ContrastRequirement[] = [
  { foreground: '--color-fg', background: '--color-bg', minRatio: 4.5, label: 'body text' },
  {
    foreground: '--color-fg-muted',
    background: '--color-bg',
    minRatio: 4.5,
    label: 'secondary text',
  },
  {
    foreground: '--color-fg-on-accent',
    background: '--color-accent',
    minRatio: 4.5,
    label: 'primary buttons',
  },
  {
    foreground: '--color-fg-on-surface',
    background: '--color-surface',
    minRatio: 4.5,
    label: 'card text',
  },
  {
    foreground: '--color-border-strong',
    background: '--color-bg',
    minRatio: 3,
    label: 'control borders',
  },
];

/* -- Section placement rules --------------------------------------------- */

/**
 * Page roles each section type is allowed on.
 *
 * Only the types where placement is genuinely wrong are listed; everything else may
 * appear anywhere. A menu on the privacy policy is not a style disagreement, it is a
 * generation defect worth a regeneration.
 */
const SECTION_PAGE_ROLES: Partial<Record<SectionType, readonly PageRole[]>> = {
  menu: ['home', 'menu', 'services'],
  booking: ['home', 'booking', 'services', 'contact'],
  map_hours: ['home', 'contact', 'about'],
  blog_teaser: ['home', 'blog_index'],
  contact_form: ['home', 'contact', 'booking', 'services'],
};

/* -- The pass ------------------------------------------------------------- */

interface Sink {
  (
    code: LintCode,
    severity: LintSeverity,
    path: string,
    message: string,
    remediation: string,
  ): void;
}

function lintTheme(doc: SiteDoc, emit: Sink): void {
  for (const pair of CONTRAST_PAIRS) {
    const foreground = doc.theme.tokens[pair.foreground];
    const background = doc.theme.tokens[pair.background];
    if (foreground === undefined || background === undefined) {
      emit(
        'token_missing',
        'warning',
        'theme.tokens',
        `${pair.label}: ${pair.foreground} / ${pair.background} not both resolved`,
        "Emit both custom properties from site-kit's tokens/resolve.ts.",
      );
      continue;
    }
    const ratio = contrastRatio(foreground, background);
    if (ratio === null) {
      emit(
        'token_unparseable',
        'warning',
        'theme.tokens',
        `${pair.label}: cannot read "${foreground}" or "${background}"`,
        'Store fully resolved hex/rgb()/oklch() values, not var() indirection.',
      );
      continue;
    }
    if (ratio < pair.minRatio) {
      emit(
        'contrast_below_minimum',
        'error',
        'theme.tokens',
        `${pair.label}: ${ratio.toFixed(2)}:1 is below ${pair.minRatio}:1`,
        `Pick another paletteVariant or colorMode for DNA "${doc.theme.dnaId}".`,
      );
    }
  }
}

function lintReferences(doc: SiteDoc, emit: Sink): void {
  const pageIds = new Set(doc.pages.map((page) => page.pageId));
  const sectionIds = new Set(doc.pages.flatMap((page) => page.sections.map((s) => s.id)));

  const checkMedia = (ref: MediaRef, path: string): void => {
    if (doc.media[ref.refId] !== undefined) return;
    emit(
      'dangling_media_ref',
      'error',
      path,
      `media "${ref.refId}" is not in the document manifest`,
      'Re-run resolve-media, or drop the section that points at it.',
    );
  };

  const checkLink = (ref: LinkRef, path: string): void => {
    switch (ref.kind) {
      case 'page':
        if (!pageIds.has(ref.pageId)) {
          emit(
            'dangling_page_ref',
            'error',
            path,
            `link targets unknown page "${ref.pageId}"`,
            'Point the link at a page that exists, or remove the call to action.',
          );
        }
        break;
      case 'anchor':
        if (!sectionIds.has(ref.sectionId)) {
          emit(
            'dangling_anchor_ref',
            'error',
            path,
            `link targets unknown section "${ref.sectionId}"`,
            'Point the anchor at a section that exists, or remove it.',
          );
        }
        break;
      case 'external':
        if (doc.links[ref.refId] === undefined) {
          emit(
            'dangling_external_ref',
            'error',
            path,
            `external link "${ref.refId}" is not in the allowlist`,
            'Add the URL to the allowlist, or remove the link.',
          );
        }
        break;
      case 'whatsapp':
        if (doc.facts.whatsappE164 === null) {
          emit(
            'whatsapp_without_number',
            'error',
            path,
            'a WhatsApp link exists but the business has no WhatsApp number',
            'Collect a WhatsApp number, or remove the link.',
          );
        }
        break;
      case 'route':
        if (doc.facts.address === null) {
          emit(
            'route_without_address',
            'error',
            path,
            'a route link exists but the business has no address',
            'Add an address, or use a service-area section instead.',
          );
        }
        break;
      default:
        break;
    }
  };

  for (const [pageIndex, page] of doc.pages.entries()) {
    for (const [sectionIndex, section] of page.sections.entries()) {
      const at = `pages.${pageIndex}.sections.${sectionIndex}`;
      for (const ref of collectMediaRefs(section)) checkMedia(ref, at);
      for (const ref of collectLinkRefs(section)) checkLink(ref, at);
    }
  }
  for (const [postIndex, post] of doc.blog.entries()) {
    for (const [blockIndex, block] of post.blocks.entries()) {
      const at = `blog.${postIndex}.blocks.${blockIndex}`;
      if (block.type === 'image') checkMedia(block.media, at);
      if (block.type === 'cta') checkLink(block.target, at);
    }
  }
}

function collectMediaRefs(section: SectionGen): readonly MediaRef[] {
  switch (section.type) {
    case 'hero':
    case 'cta_band':
    case 'about':
      return section.media === null ? [] : [section.media];
    case 'gallery':
      return section.media;
    case 'services_grid':
    case 'team':
      return section.items
        .map((item) => item.media)
        .filter((media): media is MediaRef => media !== null);
    default:
      return [];
  }
}

function collectLinkRefs(section: SectionGen): readonly LinkRef[] {
  switch (section.type) {
    case 'hero':
    case 'cta_band':
      return section.ctas.map((cta) => cta.target);
    case 'about':
      return section.cta === null ? [] : [section.cta.target];
    case 'services_grid':
      return section.items
        .map((item) => item.target)
        .filter((target): target is LinkRef => target !== null);
    case 'booking':
      return section.providerLink === null ? [] : [section.providerLink];
    default:
      return [];
  }
}

function lintSections(doc: SiteDoc, emit: Sink): void {
  for (const [pageIndex, page] of doc.pages.entries()) {
    for (const [sectionIndex, section] of page.sections.entries()) {
      const at = `pages.${pageIndex}.sections.${sectionIndex}`;
      const allowed = SECTION_PAGE_ROLES[section.type];
      if (allowed !== undefined && !allowed.includes(page.role)) {
        emit(
          'section_not_allowed_on_page',
          'error',
          at,
          `a "${section.type}" section does not belong on a "${page.role}" page`,
          `Move it to one of: ${allowed.join(', ')}.`,
        );
      }

      switch (section.type) {
        case 'reviews':
          if (section.source !== 'manual' && doc.facts.reviewsSource !== 'verified_platform') {
            emit(
              'review_markup_not_permitted',
              'error',
              at,
              `reviews source "${section.source}" requires verified-platform reviews`,
              'Set the section to manual testimonials, which render without markup ' +
                'and carry the Omnibus disclosure.',
            );
          }
          break;
        case 'blog_teaser':
          if (doc.blog.length === 0) {
            emit(
              'blog_teaser_without_posts',
              'error',
              at,
              'a blog teaser is on the page but no posts were generated',
              'Generate at least one post, or drop the section.',
            );
          }
          break;
        case 'contact_form': {
          const names = new Set(section.fields.map((field) => field.name));
          if (!names.has('consent')) {
            emit(
              'contact_form_without_consent',
              'error',
              at,
              'the lead form has no consent field',
              'Add a required consent checkbox; it is not optional under the GDPR.',
            );
          }
          if (!names.has('email') && !names.has('phone')) {
            emit(
              'contact_form_without_reply_channel',
              'error',
              at,
              'the lead form collects no way to reply',
              'Add an e-mail or phone field.',
            );
          }
          break;
        }
        case 'map_hours':
          if (doc.facts.address === null && section.variant !== 'hours_only') {
            emit(
              'section_requires_fact',
              'error',
              at,
              'a map is shown but the business has no address',
              'Use the "hours_only" variant for service-area businesses.',
            );
          }
          if (section.showRouteCta && doc.facts.address === null) {
            emit(
              'route_without_address',
              'error',
              at,
              'a route button is shown but the business has no address',
              'Turn off the route button, or add an address.',
            );
          }
          break;
        case 'faq':
          if (section.emitFaqSchema && section.items.length === 0) {
            emit(
              'faq_schema_without_items',
              'error',
              at,
              'FAQ structured data was requested but the section has no questions',
              'Add questions, or turn off emitFaqSchema.',
            );
          }
          break;
        case 'menu':
          if (doc.jsonLdInputs.servesCuisine === null) {
            emit(
              'section_requires_fact',
              'warning',
              at,
              'a menu is shown but no cuisine was declared for structured data',
              'Set servesCuisine so the Restaurant graph is complete.',
            );
          }
          break;
        default:
          break;
      }
    }
  }
}

function lintCopy(doc: SiteDoc, emit: Sink): void {
  const inventory = deriveSlotInventoryForPages(doc.pages);
  for (const locale of doc.locales.enabled) {
    const copy = copyFor(doc, locale);
    if (Object.keys(copy).length === 0) {
      emit(
        'locale_without_copy',
        'error',
        `copy.${locale}`,
        `locale "${locale}" is enabled but has no copy at all`,
        'Drop the locale from the publish, or run its copy step.',
      );
      continue;
    }
    for (const slot of inventory.slots) {
      const text = copy[slot.id];
      if (text === undefined || text.trim().length === 0) {
        emit(
          'missing_copy',
          'error',
          `copy.${locale}.${slot.id}`,
          `slot "${slot.id}" has no text in ${locale}`,
          'Run a copy repair turn for this slot.',
        );
      }
    }
  }

  for (const [pageIndex, page] of doc.pages.entries()) {
    for (const [locale, routing] of Object.entries(page.perLocale)) {
      const at = `pages.${pageIndex}.perLocale.${locale}`;
      if (routing.title.trim().length === 0) {
        emit('missing_meta', 'error', at, 'the page has no title', 'Generate a page title.');
      } else if ([...routing.title].length > 60) {
        emit(
          'meta_title_too_long',
          'warning',
          at,
          `title is ${[...routing.title].length} characters; Google truncates near 60`,
          'Shorten the title.',
        );
      }
      if (routing.description.trim().length === 0) {
        emit(
          'missing_meta',
          'error',
          at,
          'the page has no meta description',
          'Generate a meta description.',
        );
      } else if ([...routing.description].length > 155) {
        emit(
          'meta_description_too_long',
          'warning',
          at,
          `description is ${[...routing.description].length} characters`,
          'Shorten it to about 155 characters.',
        );
      }
    }
  }
}

function lintRouting(doc: SiteDoc, emit: Sink): void {
  const homePages = doc.pages.filter((page) => page.role === 'home');
  if (homePages.length === 0) {
    emit(
      'no_home_page',
      'error',
      'pages',
      'the site has no page with the home role',
      'Regenerate the structure; every site needs an entry point.',
    );
  }
  for (const home of homePages) {
    if (home.noindex) {
      emit(
        'home_noindex',
        'warning',
        `pages.${doc.pages.indexOf(home)}`,
        'the home page is marked noindex',
        'Expected before the indexing gate opens; check it flips on publish.',
      );
    }
  }

  const seen = new Map<string, string>();
  for (const [pageIndex, page] of doc.pages.entries()) {
    for (const [locale, routing] of Object.entries(page.perLocale)) {
      const key = `${locale}${routing.path}`;
      const owner = seen.get(key);
      if (owner !== undefined) {
        emit(
          'duplicate_path',
          'error',
          `pages.${pageIndex}.perLocale.${locale}`,
          `path "${routing.path}" is already used by page "${owner}"`,
          'Give one of the pages a different slug.',
        );
        continue;
      }
      seen.set(key, page.pageKey);
    }
  }
  for (const [postIndex, post] of doc.blog.entries()) {
    const key = `${post.locale}${post.path}`;
    const owner = seen.get(key);
    if (owner !== undefined) {
      emit(
        'duplicate_path',
        'error',
        `blog.${postIndex}`,
        `path "${post.path}" is already used by "${owner}"`,
        'Give the post a different slug.',
      );
      continue;
    }
    seen.set(key, post.postId);
  }
}

function lintFacts(doc: SiteDoc, emit: Sink): void {
  const { address } = doc.facts;
  if (
    address !== null &&
    address.geoSource === 'none' &&
    (address.latitude !== null || address.longitude !== null)
  ) {
    emit(
      'geo_source_conflict',
      'warning',
      'facts.address',
      'coordinates are present but geoSource is none, so they will not be emitted',
      'Geocode the address or drop the coordinates.',
    );
  }
  if (doc.chrome.whatsappEnabled && doc.facts.whatsappE164 === null) {
    emit(
      'whatsapp_without_number',
      'error',
      'chrome.whatsappEnabled',
      'the floating WhatsApp button is on but no number is known',
      'Collect a WhatsApp number, or turn the button off.',
    );
  }
}

/**
 * Runs every semantic check over an assembled document.
 *
 * Guarantees: pure, total, and never throws. Findings are returned in a stable order
 * (theme, refs, sections, copy, routing, facts) so a diff between two generations is
 * readable.
 */
export function lintSiteDoc(doc: SiteDoc): readonly LintFinding[] {
  const findings: LintFinding[] = [];
  const emit: Sink = (code, severity, path, message, remediation) => {
    findings.push({ code, severity, path, message, remediation });
  };

  lintTheme(doc, emit);
  lintReferences(doc, emit);
  lintSections(doc, emit);
  lintCopy(doc, emit);
  lintRouting(doc, emit);
  lintFacts(doc, emit);

  return findings;
}
