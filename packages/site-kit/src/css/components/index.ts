import type { ComponentKey } from '../layers';
import { CSS as ABOUT } from './about.css';
import { CSS as BLOG_TEASER } from './blog_teaser.css';
import { CSS as BOOKING } from './booking.css';
import { CSS as CONTACT_FORM } from './contact_form.css';
import { CSS as COOKIE_BANNER } from './cookie_banner.css';
import { CSS as CTA_BAND } from './cta_band.css';
import { CSS as FAQ } from './faq.css';
import { CSS as FOOTER } from './footer.css';
import { CSS as GALLERY } from './gallery.css';
import { CSS as HEADER } from './header.css';
import { CSS as HERO } from './hero.css';
import { CSS as MAP_HOURS } from './map_hours.css';
import { CSS as MENU } from './menu.css';
import { CSS as PROCESS_STEPS } from './process_steps.css';
import { CSS as REVIEWS } from './reviews.css';
import { CSS as RICH_TEXT } from './rich_text.css';
import { CSS as SERVICES_GRID } from './services_grid.css';
import { CSS as STATS_BAND } from './stats_band.css';
import { CSS as TEAM } from './team.css';
import { CSS as USP_TRIO } from './usp_trio.css';
import { CSS as WHATSAPP } from './whatsapp.css';

/**
 * Every fragment, keyed by the component it styles.
 *
 * Typed as a total record over `ComponentKey`, so adding a section type to `site-schema` without
 * adding its CSS is a compile error rather than an unstyled band on a customer's home page.
 */
export const COMPONENT_CSS: Readonly<Record<ComponentKey, string>> = {
  hero: HERO,
  usp_trio: USP_TRIO,
  about: ABOUT,
  services_grid: SERVICES_GRID,
  menu: MENU,
  gallery: GALLERY,
  reviews: REVIEWS,
  team: TEAM,
  process_steps: PROCESS_STEPS,
  stats_band: STATS_BAND,
  faq: FAQ,
  booking: BOOKING,
  contact_form: CONTACT_FORM,
  map_hours: MAP_HOURS,
  cta_band: CTA_BAND,
  blog_teaser: BLOG_TEASER,
  rich_text: RICH_TEXT,
  header: HEADER,
  footer: FOOTER,
  whatsapp: WHATSAPP,
  cookie_banner: COOKIE_BANNER,
};
