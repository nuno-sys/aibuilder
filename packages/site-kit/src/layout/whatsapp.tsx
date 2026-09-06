import type { Locale, SiteDoc } from '@aibuilder/site-schema';
import type { Markup } from '../sections/shared';
import { whatsappHref } from '../links';
import { uiStrings } from '../ui';

/**
 * The sticky WhatsApp widget: zero JavaScript, site colours, opens the app directly on mobile.
 *
 * Every decision here is a constraint, not taste.
 *
 *  - **`https://wa.me/<E.164 without +>`** is the official universal link: it opens the installed
 *    app on Android and iOS and lands on WhatsApp Web on desktop. Never `whatsapp://send`, which
 *    fails hard on desktop and inside in-app browsers. The number comes from a `CHECK`-constrained
 *    column and the `text=` prefill is built in code from the business name — no model string ever
 *    reaches the URL.
 *  - **No INP contribution at all.** A native anchor activation is not measured as an interaction
 *    with processing time, and there is no listener on this element anywhere in the package.
 *  - **No CLS.** `position: fixed` is out of flow and the element is in the initial HTML — never
 *    injected — so it neither shifts anything nor is shifted.
 *  - **`data-no-prerender`** keeps it out of the Speculation Rules prerender set: it is
 *    cross-origin and not prerenderable.
 *
 * The icon is the WhatsApp glyph rather than one of the twelve `IconId`s, because this is a brand
 * mark for a named third party and substituting a generic speech bubble would misidentify it.
 */
const WHATSAPP_GLYPH =
  'M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.46 1.32 4.96L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.9-4.45 9.9-9.91C21.95 6.45 17.5 2 12.04 2Zm5.8 14.16c-.24.68-1.42 1.31-1.95 1.36-.5.05-1.13.07-1.82-.11a16.5 16.5 0 0 1-1.65-.62c-2.9-1.25-4.8-4.17-4.94-4.36-.15-.2-1.19-1.58-1.19-3.02 0-1.43.75-2.14 1.02-2.43.27-.29.58-.36.78-.36h.56c.18 0 .42-.07.66.5.24.59.83 2.02.9 2.17.07.15.12.32.02.51-.1.2-.15.32-.29.49-.15.17-.31.38-.44.51-.15.15-.3.31-.13.6.17.3.76 1.25 1.63 2.02 1.12 1 2.06 1.31 2.36 1.46.29.15.46.12.63-.07.17-.2.73-.85.92-1.14.2-.29.39-.24.66-.15.27.1 1.7.8 1.99.95.29.15.48.22.55.34.07.12.07.7-.17 1.38Z';

export function WhatsAppWidget(props: {
  readonly doc: SiteDoc;
  readonly locale: Locale;
}): Markup | null {
  const { doc, locale } = props;
  if (!doc.chrome.whatsappEnabled) return null;
  const number = doc.facts.whatsappE164;
  // `lint.ts` already errors on `whatsappEnabled` with a null number; this is the second gate, so a
  // linter regression produces a missing widget rather than a `wa.me/null` link.
  if (number === null) return null;
  const href = whatsappHref(number, doc.facts.businessName, locale);
  if (href === null) return null;
  const strings = uiStrings(locale);

  return (
    <a
      class="wa"
      data-no-prerender
      href={href}
      target="_blank"
      rel="noopener"
      aria-label={strings.whatsappAria(doc.facts.businessName)}
    >
      <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">
        <path fill="currentColor" d={WHATSAPP_GLYPH} />
      </svg>
      <span class="wa__label">{strings.whatsappLabel}</span>
    </a>
  );
}
