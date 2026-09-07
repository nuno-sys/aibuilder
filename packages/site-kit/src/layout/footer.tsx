import type { Locale, SiteDoc } from '@aibuilder/site-schema';
import { pageNavSlotId, textFor } from '@aibuilder/site-schema';
import type { RenderContext } from '../context';
import { Picture } from '../sections/shared';
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
 *
 * THE PHOTOGRAPHIC GROUND. When the media pipeline picked one (`chrome.footerMediaRefId`), the
 * footer closes the page on the same footage the header opened it with — dark under a dark site,
 * light under a light one, because luminance is a hard constraint at selection. The text over it
 * is pure ink under the hero's own scrim alpha, which is derived rather than chosen: alpha
 * compositing on an opaque backdrop is `α·scrim + (1−α)·backdrop`, so the worst case over any
 * photograph is a single known colour and the 7:1 proof holds whatever the image turns out to be.
 * Reusing `--hero-scrim-band` rather than inventing a second constant is what keeps it a proof.
 *
 * The ground is `loading="lazy"`: it is below every fold there is, and an eager fetch here would
 * compete with the LCP element for bandwidth on exactly the connections that cannot spare it.
 */
export function SiteFooter(props: {
  readonly doc: SiteDoc;
  readonly ctx: RenderContext;
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

  const groundRefId = doc.chrome.footerMediaRefId;
  const ground = groundRefId === null ? null : (props.ctx.images[groundRefId] ?? null);
  // Same ink decision as the hero, from the same resolved token: one answer for every surface that
  // puts type over pixels, so a site cannot read white-on-photo at the top and black-on-photo at
  // the bottom. A custom property cannot be selected on, hence the data attribute.
  const inkAttr = doc.theme.tokens['--hero-ink'] === 'light' ? 'light' : 'dark';

  return (
    <footer
      class="site-footer"
      data-style={doc.chrome.footerStyle}
      data-ground={ground === null ? undefined : '1'}
      data-ink={ground === null ? undefined : inkAttr}
    >
      {ground === null ? null : (
        <div class="site-footer__media" aria-hidden="true">
          <Picture image={ground} sizes="100vw" extraClass="site-footer__ground" />
          <div class="site-footer__scrim"></div>
        </div>
      )}
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
