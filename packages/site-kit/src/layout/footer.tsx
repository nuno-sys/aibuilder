import type { Locale, SiteDoc } from '@aibuilder/site-schema';
import { pageNavSlotId, textFor } from '@aibuilder/site-schema';
import type { Markup } from '../sections/shared';
import { LOCALE_META, uiStrings } from '../ui';

/**
 * The site footer — the `contentinfo` landmark.
 *
 * It carries the EU-mandated identity block (`companyRegistrationId` — KvK / Handelsregister — and
 * `vatId`, both from `facts`), the legal links, and the locale switcher as plain anchors with
 * `hreflang` and `lang` set, one per enabled locale.
 *
 * The "made with" line is **plain text**, not a link. A sitewide followed backlink from every
 * tenant site to the platform's apex is the fastest available route to a manual action, and the
 * marginal SEO value of a `nofollow sponsored` link on a few thousand small-business sites does not
 * come close to justifying the risk to the whole estate.
 */
export function SiteFooter(props: {
  readonly doc: SiteDoc;
  readonly locale: Locale;
  readonly currentPageId: string;
  readonly madeWith: string;
}): Markup {
  const { doc, locale } = props;
  const strings = uiStrings(locale);
  const legalRoles = new Set(['privacy', 'terms', 'cookies']);

  const legalPages = doc.pages.filter(
    (page) => legalRoles.has(page.role) && page.perLocale[locale] !== undefined,
  );
  const navPages = doc.pages
    .filter((page) => page.showInNav && page.perLocale[locale] !== undefined)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const current = doc.pages.find((page) => page.pageId === props.currentPageId);

  return (
    <footer class="site-footer" data-style={doc.chrome.footerStyle}>
      <div class="wrap">
        <div class="site-footer__grid">
          <div>
            <h2>{doc.facts.businessName}</h2>
            {doc.facts.address === null ? null : (
              <p class="u-fine">
                {doc.facts.address.line1}
                {`, ${doc.facts.address.postalCode} ${doc.facts.address.city}`}
              </p>
            )}
            <p class="u-fine">
              <a href={`tel:${doc.facts.phoneE164}`}>{doc.facts.phoneE164}</a>
            </p>
          </div>
          <nav aria-label={strings.mainMenu}>
            <ul>
              {navPages.map((page) => {
                const label = textFor(doc, locale, pageNavSlotId(page.pageId));
                const routing = page.perLocale[locale];
                return (
                  <li>
                    <a href={routing?.path ?? '/'}>
                      {label === '' ? (routing?.title ?? '') : label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>
          <nav aria-label={strings.languageSwitcher}>
            <ul>
              {doc.locales.enabled.map((enabled) => {
                const routing = current?.perLocale[enabled];
                if (routing === undefined) return null;
                return (
                  <li>
                    <a
                      href={routing.path}
                      hreflang={LOCALE_META[enabled].tag}
                      lang={LOCALE_META[enabled].tag}
                    >
                      {LOCALE_META[enabled].tag.toUpperCase()}
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>
          <nav aria-label={strings.legalLinks}>
            <ul>
              {legalPages.map((page) => {
                const routing = page.perLocale[locale];
                return (
                  <li>
                    <a href={routing?.path ?? '/'}>{routing?.title ?? ''}</a>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>
        <p class="site-footer__legal u-fine">
          {doc.facts.legalName ?? doc.facts.businessName}
          {doc.facts.companyRegistrationId === null
            ? null
            : ` · ${strings.registrationId}: ${doc.facts.companyRegistrationId}`}
          {doc.facts.vatId === null ? null : ` · ${strings.vatId}: ${doc.facts.vatId}`}
          {` · ${props.madeWith}`}
        </p>
      </div>
    </footer>
  );
}
