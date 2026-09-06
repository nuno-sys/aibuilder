import type { Locale, MediaRef } from './gen/common';
import type { BlogPostGen } from './gen/blog-post';
import type { LocaleBundleGen } from './gen/locale-bundle';
import type { SectionGen } from './gen/section';
import type { PageGen, PageRole, SiteStructureGen } from './gen/site-structure';
import type {
  BlogPostDoc,
  ExternalLink,
  MediaAsset,
  PageDoc,
  PageLocaleDoc,
  SiteDoc,
  SiteFacts,
} from './doc';
import { SCHEMA_VERSION, SiteDocSchema } from './doc';
import { deriveSlotInventory, pageMetaSlotId } from './slots';
import type { SlotInventory } from './slots';

/**
 * `genToDoc()` -- the one place where generated documents, server facts and the media
 * and link manifests become a single `SiteDoc`.
 *
 * It resolves nothing the model could have faked: media refs are looked up in the
 * manifest, external links in the allowlist, and every business fact comes from the
 * `facts` argument, which is sourced from D1. The signature makes that structural --
 * `facts`, `media`, `externalLinks`, `themeTokens` and `slugify` are all required, so
 * a caller cannot forget to merge them and quietly ship a site with no address.
 *
 * It is total: it reports problems as `issues` rather than throwing, because it runs
 * in the `assemble` Workflow step where the alternative is losing a paid generation.
 */

/* -- Inputs -------------------------------------------------------------- */

/** A generated post plus the identity and timestamps that only D1 knows. */
export interface BlogPostInput {
  readonly postId: string;
  /** ISO-8601 instant. Feeds `datePublished`. */
  readonly publishedAt: string;
  /** ISO-8601 instant. Feeds `dateModified`; equals `content_changed_at`. */
  readonly updatedAt: string;
  readonly post: BlogPostGen;
}

/** What the slug policy needs to turn a model-written phrase into a URL segment. */
export interface SlugifyRequest {
  readonly seed: string;
  readonly locale: Locale;
  /** `"blog_post"` for posts; otherwise the page's role. */
  readonly kind: PageRole | 'blog_post';
  /** `pageKey` or `postId` -- stable across regenerations, for the fallback slug. */
  readonly key: string;
}

/**
 * Locale-aware transliteration and reserved-word policy.
 *
 * Injected rather than implemented here: the real policy lives in
 * `packages/core/src/slug.ts` (transliteration tables, homoglyph and trademark
 * checks, collision suffixing against D1), and this package depends on nothing.
 */
export type Slugify = (request: SlugifyRequest) => string;

/** Everything `genToDoc()` needs. Every field is required by design. */
export interface GenToDocInput {
  readonly siteId: string;
  readonly versionId: string;
  readonly structure: SiteStructureGen;
  /** One per locale being published. A missing bundle is reported, not fatal. */
  readonly bundles: readonly LocaleBundleGen[];
  readonly blog: readonly BlogPostInput[];
  /** From D1. The model never authors any of this. */
  readonly facts: SiteFacts;
  /** The media manifest, keyed by `refId`. */
  readonly media: Readonly<Record<string, MediaAsset>>;
  /** The external-link allowlist, keyed by `refId`. https-only. */
  readonly externalLinks: Readonly<Record<string, ExternalLink>>;
  /** Resolved CSS custom properties from `site-kit`'s `tokens/resolve.ts`. */
  readonly themeTokens: Readonly<Record<string, string>>;
  /** Locales this site publishes. The structure's `primaryLocale` is always added. */
  readonly enabledLocales: readonly Locale[];
  readonly slugify: Slugify;
}

/* -- Issues -------------------------------------------------------------- */

export type GenToDocIssueCode =
  | 'missing_bundle'
  | 'missing_copy'
  | 'unknown_media_ref'
  | 'unknown_link_ref'
  | 'duplicate_path'
  | 'invalid_document';

/** A defect `genToDoc()` could not resolve. Never thrown; always reported. */
export interface GenToDocIssue {
  readonly code: GenToDocIssueCode;
  readonly path: string;
  readonly message: string;
}

export interface GenToDocResult {
  readonly doc: SiteDoc;
  readonly issues: readonly GenToDocIssue[];
}

/* -- Helpers ------------------------------------------------------------- */

const MAX_SLUG_LENGTH = 63;

/**
 * Final safety net over the injected slugifier's output.
 *
 * Not a second slug policy: it only guarantees the character class and length the
 * `SiteDoc` path regex requires, so a slugifier bug cannot produce a document that
 * fails validation after everything else succeeded.
 */
function sanitiseSlug(value: string, fallback: string): string {
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MAX_SLUG_LENGTH);
  return slug.length === 0 ? fallback : slug;
}

/** Suffixes a slug until it is unused within its locale, staying inside 63 chars. */
function uniqueSlug(slug: string, taken: ReadonlySet<string>): string {
  if (!taken.has(slug)) return slug;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${slug.slice(0, MAX_SLUG_LENGTH - tail.length)}${tail}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${slug.slice(0, MAX_SLUG_LENGTH - 14)}-${Date.now().toString(36)}`;
}

/** Every media ref a section points at, in document order. */
function sectionMediaRefs(section: SectionGen): readonly MediaRef[] {
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

/** Every external link ref a section points at. */
function sectionExternalRefs(section: SectionGen): readonly string[] {
  const out: string[] = [];
  switch (section.type) {
    case 'hero':
    case 'cta_band':
      for (const cta of section.ctas) {
        if (cta.target.kind === 'external') out.push(cta.target.refId);
      }
      break;
    case 'about':
      if (section.cta !== null && section.cta.target.kind === 'external') {
        out.push(section.cta.target.refId);
      }
      break;
    case 'services_grid':
      for (const item of section.items) {
        if (item.target !== null && item.target.kind === 'external') out.push(item.target.refId);
      }
      break;
    case 'booking':
      if (section.providerLink !== null && section.providerLink.kind === 'external') {
        out.push(section.providerLink.refId);
      }
      break;
    default:
      break;
  }
  return out;
}

/**
 * Stable identity for a page across regenerations.
 *
 * Keyed on role, not on the model's `pageId`, because slug stability is joined on
 * `(pageKey, locale)` and the model renames pages freely between runs.
 */
function derivePageKeys(pages: readonly PageGen[]): readonly string[] {
  const used = new Set<string>();
  return pages.map((page) => {
    let key: string = page.role;
    for (let suffix = 2; used.has(key); suffix += 1) key = `${page.role}-${suffix}`;
    used.add(key);
    return key;
  });
}

function copyOf(
  copy: Readonly<Record<string, Readonly<Record<string, string>>>>,
  locale: string,
  slotId: string,
): string {
  return copy[locale]?.[slotId] ?? '';
}

/* -- The conversion ------------------------------------------------------ */

/**
 * Builds a `SiteDoc` from the generation documents, the D1 facts and the server-built
 * manifests.
 *
 * Guarantees: never throws; every `refId` that survives into `doc.media` / `doc.links`
 * exists; every page has a unique path per locale; `pageKey` is stable across runs for
 * the same role ordering; the returned document is validated against `SiteDocSchema`
 * and any residual violation is reported as an `invalid_document` issue rather than
 * silently persisted.
 */
export function genToDoc(input: GenToDocInput): GenToDocResult {
  const issues: GenToDocIssue[] = [];
  const add = (code: GenToDocIssueCode, path: string, message: string): void => {
    issues.push({ code, path, message });
  };

  const { structure } = input;
  const inventory: SlotInventory = deriveSlotInventory(structure);

  /* Locales -------------------------------------------------------------- */
  const defaultLocale = structure.primaryLocale;
  const enabled: Locale[] = [defaultLocale];
  for (const locale of input.enabledLocales) {
    if (!enabled.includes(locale)) enabled.push(locale);
  }

  /* Copy ----------------------------------------------------------------- */
  const bundleByLocale = new Map<Locale, LocaleBundleGen>();
  for (const bundle of input.bundles) {
    if (!bundleByLocale.has(bundle.locale)) bundleByLocale.set(bundle.locale, bundle);
  }

  const copy: Record<string, Record<string, string>> = {};
  const publishedLocales: Locale[] = [];
  for (const locale of enabled) {
    const bundle = bundleByLocale.get(locale);
    if (bundle === undefined) {
      add('missing_bundle', `copy.${locale}`, `no locale bundle was generated for ${locale}`);
      if (locale !== defaultLocale) continue;
    }
    const entries: Record<string, string> = {};
    for (const entry of bundle?.entries ?? []) {
      if (inventory.ids.has(entry.id)) entries[entry.id] = entry.text;
    }
    copy[locale] = entries;
    publishedLocales.push(locale);
    const missing = inventory.slots.filter((slot) => entries[slot.id] === undefined);
    for (const slot of missing) {
      add('missing_copy', `copy.${locale}.${slot.id}`, `slot "${slot.id}" has no text`);
    }
  }

  /* Pages ---------------------------------------------------------------- */
  const pageKeys = derivePageKeys(structure.pages);
  const takenSlugs = new Map<Locale, Set<string>>();
  for (const locale of publishedLocales) takenSlugs.set(locale, new Set<string>());

  const pages: PageDoc[] = structure.pages.map((page, index) => {
    const pageKey = pageKeys[index] ?? page.role;
    const perLocale: Record<string, PageLocaleDoc> = {};

    for (const locale of publishedLocales) {
      const taken = takenSlugs.get(locale) ?? new Set<string>();
      const seed = copyOf(copy, locale, pageMetaSlotId(page.pageId, 'slug'));
      const title = copyOf(copy, locale, pageMetaSlotId(page.pageId, 'title'));
      const description = copyOf(copy, locale, pageMetaSlotId(page.pageId, 'description'));

      let slug = '';
      let path = `/${locale}/`;
      if (page.role !== 'home') {
        const requested = input.slugify({ seed, locale, kind: page.role, key: pageKey });
        const base = sanitiseSlug(requested, pageKey);
        slug = uniqueSlug(base, taken);
        if (slug !== base) {
          add('duplicate_path', `pages.${index}.perLocale.${locale}`, `"${base}" taken`);
        }
        taken.add(slug);
        path = `/${locale}/${slug}/`;
      }

      perLocale[locale] = {
        path,
        slug,
        title,
        description,
        ogMediaRefId: page.ogMedia === null ? null : page.ogMedia.refId,
      };
    }

    return {
      pageId: page.pageId,
      pageKey,
      role: page.role,
      noindex: page.noindex,
      showInNav: page.showInNav,
      sortOrder: index,
      sections: page.sections,
      perLocale,
    };
  });

  /* Blog ----------------------------------------------------------------- */
  const blogIndexSlugs = new Map<string, string>();
  for (const page of pages) {
    if (page.role !== 'blog_index') continue;
    for (const [locale, routing] of Object.entries(page.perLocale)) {
      blogIndexSlugs.set(locale, routing.slug);
    }
  }
  const takenPostSlugs = new Map<string, Set<string>>();

  const blog: BlogPostDoc[] = input.blog.map((entry, index) => {
    const { post } = entry;
    const locale = post.locale;
    const taken = takenPostSlugs.get(locale) ?? new Set<string>();
    takenPostSlugs.set(locale, taken);

    const requested = input.slugify({
      seed: post.slugSeed,
      locale,
      kind: 'blog_post',
      key: entry.postId,
    });
    const base = sanitiseSlug(requested, entry.postId);
    const slug = uniqueSlug(base, taken);
    if (slug !== base) add('duplicate_path', `blog.${index}`, `"${base}" taken`);
    taken.add(slug);

    const prefix = blogIndexSlugs.get(locale) ?? 'blog';
    return {
      postId: entry.postId,
      locale,
      slug,
      path: `/${locale}/${prefix}/${slug}/`,
      title: post.titleText,
      excerpt: post.excerptText,
      metaDescription: post.metaDescriptionText,
      heroMediaRefId: post.heroMedia === null ? null : post.heroMedia.refId,
      blocks: post.blocks,
      publishedAt: entry.publishedAt,
      updatedAt: entry.updatedAt,
    };
  });

  /* Media and link resolution -------------------------------------------- */
  const media: Record<string, MediaAsset> = {};
  const requireMedia = (refId: string, path: string): void => {
    if (media[refId] !== undefined) return;
    const asset = input.media[refId];
    if (asset === undefined) {
      add('unknown_media_ref', path, `media "${refId}" is not in the manifest`);
      return;
    }
    media[refId] = asset;
  };

  const links: Record<string, ExternalLink> = {};
  const requireLink = (refId: string, path: string): void => {
    if (links[refId] !== undefined) return;
    const link = input.externalLinks[refId];
    if (link === undefined) {
      add('unknown_link_ref', path, `external link "${refId}" is not allowlisted`);
      return;
    }
    links[refId] = link;
  };

  for (const [pageIndex, page] of pages.entries()) {
    const ogRefId = page.perLocale[defaultLocale]?.ogMediaRefId ?? null;
    if (ogRefId !== null) requireMedia(ogRefId, `pages.${pageIndex}.ogMedia`);
    for (const [sectionIndex, section] of page.sections.entries()) {
      const at = `pages.${pageIndex}.sections.${sectionIndex}`;
      for (const ref of sectionMediaRefs(section)) requireMedia(ref.refId, at);
      for (const refId of sectionExternalRefs(section)) requireLink(refId, at);
    }
  }
  for (const [postIndex, post] of blog.entries()) {
    if (post.heroMediaRefId !== null) requireMedia(post.heroMediaRefId, `blog.${postIndex}.hero`);
    for (const [blockIndex, block] of post.blocks.entries()) {
      const at = `blog.${postIndex}.blocks.${blockIndex}`;
      if (block.type === 'image') requireMedia(block.media.refId, at);
      if (block.type === 'cta' && block.target.kind === 'external') {
        requireLink(block.target.refId, at);
      }
    }
  }

  /* Assemble -------------------------------------------------------------- */
  const { rationale: _rationale, ...themeKnobs } = structure.theme;
  const doc: SiteDoc = {
    schemaVersion: SCHEMA_VERSION,
    siteId: input.siteId,
    versionId: input.versionId,
    theme: { ...themeKnobs, tokens: { ...input.themeTokens } },
    locales: { default: defaultLocale, enabled: publishedLocales },
    chrome: {
      navStyle: structure.navStyle,
      footerStyle: structure.footerStyle,
      // WhatsApp is only ever offered when there is a number to send people to.
      whatsappEnabled: structure.whatsappEnabled && input.facts.whatsappE164 !== null,
    },
    pages,
    copy,
    media,
    links,
    jsonLdInputs: structure.jsonLd,
    facts: input.facts,
    blog,
  };

  const parsed = SiteDocSchema.safeParse(doc);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      add('invalid_document', issue.path.map(String).join('.') || '<root>', issue.message);
    }
  }

  return { doc, issues };
}
