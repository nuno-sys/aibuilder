import type { Locale, SiteDoc } from '@aibuilder/site-schema';
import { pageNavSlotId, textFor } from '@aibuilder/site-schema';
import type { Markup } from '../sections/shared';
import { uiStrings } from '../ui';

/**
 * The site header — the `banner` landmark.
 *
 * The three `navStyle` values differ only in grid placement, so the markup is identical for all
 * three and the accessible structure cannot vary with a design choice. `position: sticky` pairs
 * with the `scroll-padding-block-start` in the reset, so an anchor target is never hidden behind it.
 *
 * The mobile menu is a native `<dialog>` opened by a real `<button aria-expanded>`. That is ~180 B
 * of script (in `js/site.ts`) rather than a focus-trap implementation, because `showModal()` already
 * does the trap, the inert background and the Escape handling correctly.
 */
export function SiteHeader(props: {
  readonly doc: SiteDoc;
  readonly locale: Locale;
  readonly currentPageId: string;
}): Markup {
  const { doc, locale } = props;
  const strings = uiStrings(locale);

  const pages = doc.pages
    .filter((page) => page.showInNav && page.perLocale[locale] !== undefined)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const items = pages.map((page) => {
    const routing = page.perLocale[locale];
    const label = textFor(doc, locale, pageNavSlotId(page.pageId));
    return (
      <li>
        <a
          href={routing?.path ?? '/'}
          aria-current={page.pageId === props.currentPageId ? 'page' : undefined}
        >
          {label === '' ? (routing?.title ?? '') : label}
        </a>
      </li>
    );
  });

  const home = doc.pages.find((page) => page.role === 'home')?.perLocale[locale]?.path ?? '/';

  return (
    <header class="site-header" data-nav={doc.chrome.navStyle}>
      <div class="wrap">
        <div class="site-header__inner">
          <a class="site-header__brand" href={home}>
            {doc.facts.businessName}
          </a>
          <nav class="site-nav" aria-label={strings.mainMenu}>
            <ul>{items}</ul>
          </nav>
          <button
            class="site-header__toggle"
            type="button"
            aria-expanded="false"
            aria-controls="site-menu"
            data-menu-open
          >
            {strings.openMenu}
          </button>
        </div>
      </div>
      <dialog class="site-header__dialog" id="site-menu" aria-label={strings.mainMenu}>
        <div class="site-header__panel">
          <button class="btn btn--ghost" type="button" data-menu-close>
            {strings.closeMenu}
          </button>
          <nav aria-label={strings.mainMenu}>
            <ul>{items}</ul>
          </nav>
        </div>
      </dialog>
    </header>
  );
}
