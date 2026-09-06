import type { LinkRef, Locale, SiteDoc } from '@aibuilder/site-schema';
import { externalLinkFor } from '@aibuilder/site-schema';
import { uiStrings } from './ui';

/**
 * `LinkRef` → `href`. The whole of invariant 2 lives in this file.
 *
 * **No URL is ever built from a model string.** Every one of the seven kinds resolves through
 * something code owns:
 *
 *  - `page` / `anchor` — resolved against the document's own routing table, and the id must *also*
 *    match a code-owned pattern before it is interpolated. Existing in the document is not enough
 *    on its own: `normalize()` sanitises ids upstream, and this is the second gate, so a future
 *    change there cannot silently open a hole here.
 *  - `tel` / `whatsapp` / `email` — built from `CHECK`-constrained D1 columns, re-validated here
 *    against the same shapes rather than trusted because they came out of a parsed document.
 *  - `route` — built from the geocoded coordinates, or from the postal address, and always points
 *    at Google's documented `dir/?api=1` universal link.
 *  - `external` — an index into the server-built allowlist, which is `https:`-only by schema.
 *
 * A ref that cannot be resolved returns `null`, and the caller omits the link entirely rather than
 * rendering a dead `href="#"` or falling back to another locale's page. A missing button is a
 * content defect the linter already reports; a button that silently changes language is a bug the
 * visitor discovers.
 */

/** A resolved link, ready to become an `<a>`. */
export interface ResolvedLink {
  readonly href: string;
  /** `rel` the renderer must apply, or `null`. */
  readonly rel: string | null;
  /** True for links that leave the site. Adds `target="_blank"` and forces `rel="noopener"`. */
  readonly external: boolean;
}

/** Ids that may be interpolated into a URL. Deliberately narrower than the schema's `max(64)`. */
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/iu;

/** E.164, restated here so this file does not trust a column it did not check. */
const E164 = /^\+[1-9]\d{6,14}$/u;

/** The e-mail shape `SiteFactsSchema` enforces, restated for the same reason. */
const EMAIL = /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/u;

/**
 * The allowlist is `https:`-only by schema, and this restates it.
 *
 * Not redundant: `SiteDoc` is validated on the read path, but the renderer must not be one schema
 * edit away from emitting `javascript:` in an `href`. A ref that fails here is dropped, which
 * costs one link; trusting it costs the whole injection boundary.
 */
const HTTPS_HREF = /^https:\/\/[^\s"'<>\\`]+$/u;

/** The page a section belongs to, and that page's path in this locale. */
function pathOfPage(doc: SiteDoc, pageId: string, locale: Locale): string | null {
  const page = doc.pages.find((candidate) => candidate.pageId === pageId);
  if (page === undefined) return null;
  const routing = page.perLocale[locale];
  // Omit, never substitute: a page with no translation in this locale has no address in it.
  return routing?.path ?? null;
}

/** The page that owns a section id, if any. */
function pageOfSection(doc: SiteDoc, sectionId: string): string | null {
  for (const page of doc.pages) {
    if (page.sections.some((section) => section.id === sectionId)) return page.pageId;
  }
  return null;
}

/** `wa.me` wants the number without the leading `+`. */
export function whatsappHref(
  phoneE164: string,
  businessName: string,
  locale: Locale,
): string | null {
  if (!E164.test(phoneE164)) return null;
  const text = uiStrings(locale).whatsappPrefill(businessName);
  // The official universal link: it opens the installed app on Android and iOS and lands on
  // WhatsApp Web on desktop. Never `whatsapp://send`, which fails hard in in-app browsers.
  return `https://wa.me/${phoneE164.slice(1)}?text=${encodeURIComponent(text)}`;
}

/** `tel:` from the `CHECK`-constrained column, or `null`. */
export function telHref(phoneE164: string): string | null {
  return E164.test(phoneE164) ? `tel:${phoneE164}` : null;
}

/** Google's documented route universal link, which opens the native maps app on mobile. */
export function routeHref(doc: SiteDoc): string | null {
  const address = doc.facts.address;
  if (address === null) return null;
  const hasPin =
    address.geoSource !== 'none' && address.latitude !== null && address.longitude !== null;
  const destination = hasPin
    ? `${address.latitude},${address.longitude}`
    : [address.line1, address.postalCode, address.city, address.country].filter(Boolean).join(', ');
  if (destination.trim() === '') return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}

/** Resolves one `LinkRef` for one locale. Returns `null` when the ref cannot be honoured. */
export function resolveLink(doc: SiteDoc, ref: LinkRef, locale: Locale): ResolvedLink | null {
  switch (ref.kind) {
    case 'page': {
      if (!SAFE_ID.test(ref.pageId)) return null;
      const path = pathOfPage(doc, ref.pageId, locale);
      return path === null ? null : { href: path, rel: null, external: false };
    }
    case 'anchor': {
      if (!SAFE_ID.test(ref.sectionId)) return null;
      const owner = pageOfSection(doc, ref.sectionId);
      if (owner === null) return null;
      const path = pathOfPage(doc, owner, locale);
      if (path === null) return null;
      return { href: `${path}#${ref.sectionId}`, rel: null, external: false };
    }
    case 'tel': {
      const href = telHref(doc.facts.phoneE164);
      return href === null ? null : { href, rel: null, external: false };
    }
    case 'whatsapp': {
      const number = doc.facts.whatsappE164;
      if (number === null) return null;
      const href = whatsappHref(number, doc.facts.businessName, locale);
      return href === null ? null : { href, rel: 'noopener', external: true };
    }
    case 'email': {
      const address = doc.facts.contactEmail;
      if (!EMAIL.test(address)) return null;
      return { href: `mailto:${address}`, rel: null, external: false };
    }
    case 'route': {
      const href = routeHref(doc);
      return href === null ? null : { href, rel: 'noopener', external: true };
    }
    case 'external': {
      const entry = externalLinkFor(doc, ref);
      if (entry === null || !HTTPS_HREF.test(entry.href)) return null;
      // The allowlist is `https:`-only by schema; `rel` is whatever the server stored, and
      // `noopener` is added unconditionally by the renderer for anything that opens a new context.
      return { href: entry.href, rel: entry.rel, external: true };
    }
    default: {
      // Exhaustiveness: a new `LinkKind` fails to compile until it has a resolution rule, rather
      // than falling through to a dead link.
      const unreachable: never = ref;
      throw new Error(`Unhandled link kind: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** The `rel` an `<a>` actually gets, merging the stored value with the mandatory `noopener`. */
export function relFor(link: ResolvedLink): string | undefined {
  const parts = new Set<string>();
  if (link.rel !== null)
    for (const token of link.rel.split(/\s+/u)) if (token !== '') parts.add(token);
  if (link.external) parts.add('noopener');
  return parts.size === 0 ? undefined : [...parts].join(' ');
}
