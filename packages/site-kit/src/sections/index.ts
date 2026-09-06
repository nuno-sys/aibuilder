import type { SectionGen } from '@aibuilder/site-schema';
import { Hero } from '../layout/hero';
import type { Tone } from '../tokens/tones';
import { About } from './about';
import { BlogTeaser } from './blog_teaser';
import { Booking } from './booking';
import { ContactForm } from './contact_form';
import { CtaBand } from './cta_band';
import { Faq } from './faq';
import { Gallery } from './gallery';
import { MapHours } from './map_hours';
import { Menu } from './menu';
import { ProcessSteps } from './process_steps';
import { Reviews } from './reviews';
import { RichText } from './rich_text';
import { ServicesGrid } from './services_grid';
import type { Markup, SectionProps } from './shared';
import { StatsBand } from './stats_band';
import { Team } from './team';
import { UspTrio } from './usp_trio';

/**
 * The section dispatcher, and the tone rule.
 *
 * Sections alternate `page` / `alt` by index unless the variant fixes the tone. The alternation is
 * computed here rather than chosen by the model, which is what stops a generated document from
 * producing six identical bands or a stripe pattern.
 */

/** Section types and variants that override the alternation. */
export function toneFor(section: SectionGen, index: number): Tone {
  if (section.type === 'hero' || section.type === 'rich_text') return 'page';
  // `contact_form` may only sit on a neutral ground: a lead form on a saturated band would need a
  // danger colour that survives it, and there is no such token by design.
  if (section.type === 'contact_form') return index % 2 === 0 ? 'page' : 'alt';
  if (section.type === 'cta_band' && section.variant === 'accent_full') return 'accent';
  if (section.type === 'stats_band' && section.variant === 'accent_bg') return 'accent';
  return index % 2 === 0 ? 'page' : 'alt';
}

/**
 * Renders one section.
 *
 * The switch is exhaustive over the union: adding a section type to `site-schema` without adding a
 * component here is a compile error, not a silently missing band on a customer's home page.
 */
export function renderSection(props: SectionProps): Markup {
  const { section } = props;
  switch (section.type) {
    case 'hero':
      return Hero({ ...props, section });
    case 'usp_trio':
      return UspTrio({ ...props, section });
    case 'about':
      return About({ ...props, section });
    case 'services_grid':
      return ServicesGrid({ ...props, section });
    case 'menu':
      return Menu({ ...props, section });
    case 'gallery':
      return Gallery({ ...props, section });
    case 'reviews':
      return Reviews({ ...props, section });
    case 'team':
      return Team({ ...props, section });
    case 'process_steps':
      return ProcessSteps({ ...props, section });
    case 'stats_band':
      return StatsBand({ ...props, section });
    case 'faq':
      return Faq({ ...props, section });
    case 'booking':
      return Booking({ ...props, section });
    case 'contact_form':
      return ContactForm({ ...props, section });
    case 'map_hours':
      return MapHours({ ...props, section });
    case 'cta_band':
      return CtaBand({ ...props, section });
    case 'blog_teaser':
      return BlogTeaser({ ...props, section });
    case 'rich_text':
      return RichText({ ...props, section });
    default: {
      const unreachable: never = section;
      throw new Error(`Unhandled section type: ${JSON.stringify(unreachable)}`);
    }
  }
}

export { About, BlogTeaser, Booking, ContactForm, CtaBand, Faq, Gallery, Hero, MapHours, Menu };
export { ProcessSteps, Reviews, RichText, ServicesGrid, StatsBand, Team, UspTrio };
