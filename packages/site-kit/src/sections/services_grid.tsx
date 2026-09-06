import type { SectionOf } from '@aibuilder/site-schema';
import { Picture, SectionHeading, SectionShell, imageFor, slot } from './shared';
import type { Markup, SectionProps } from './shared';
import { relFor, resolveLink } from '../links';

/**
 * Services, treatments or packages.
 *
 * When an item carries a `target`, the **card is not a link** — nested interactive content breaks
 * both the a11y tree and the tab order. The `<h3>` contains the `<a>` and CSS lends it the card's
 * hit area through an `::after` overlay, so the accessible name stays the service title.
 *
 * `showPrice` emits a visible price, and the same value must appear in any JSON-LD `offers`:
 * Google cross-checks them, and a visible price that disagrees with a structured one is a
 * structured-data penalty rather than a cosmetic bug.
 */
export function ServicesGrid(props: SectionProps<SectionOf<'services_grid'>>): Markup {
  const { section, doc, scope, ctx } = props;

  const item = (index: number, target: SectionOf<'services_grid'>['items'][number]): Markup => {
    const title = slot(doc, scope, section.id, 'items', index, 'title');
    const image = imageFor(doc, ctx, target.media);
    // A ref that does not resolve costs the link, never the title: an empty `<h3>` would leave the
    // card unreadable and un-nameable, which is a worse failure than a service without a detail page.
    const link = target.target === null ? null : resolveLink(doc, target.target, scope.locale);
    return (
      <li class="s-svc__item stack">
        {image === null || section.variant !== 'image_tiles' ? null : (
          <Picture image={image} sizes="(min-width:52em) 33vw, 100vw" />
        )}
        <h3>
          {link === null ? (
            title
          ) : (
            <a href={link.href} rel={relFor(link)} target={link.external ? '_blank' : undefined}>
              {title}
            </a>
          )}
        </h3>
        <p>{slot(doc, scope, section.id, 'items', index, 'body')}</p>
        {target.showPrice ? (
          <p class="s-svc__price">{slot(doc, scope, section.id, 'items', index, 'price')}</p>
        ) : null}
      </li>
    );
  };

  const accordion = (
    <div class="stack s-svc__list">
      {section.items.map((entry, index) => (
        <details class="s-svc__details">
          <summary>
            <h3>{slot(doc, scope, section.id, 'items', index, 'title')}</h3>
          </summary>
          <p>{slot(doc, scope, section.id, 'items', index, 'body')}</p>
          {entry.showPrice ? (
            <p class="s-svc__price">{slot(doc, scope, section.id, 'items', index, 'price')}</p>
          ) : null}
        </details>
      ))}
    </div>
  );

  return (
    <SectionShell section={section} tone={props.tone} ctx={props.ctx} extraClass="s-svc">
      <div class="wrap">
        <div class="section__head">
          <SectionHeading
            sectionId={section.id}
            level={props.headingLevel}
            text={slot(doc, scope, section.id, 'headline')}
            fallback={doc.facts.businessName}
          />
        </div>
        {section.variant === 'accordion' ? (
          accordion
        ) : (
          <ul role="list" class="grid-auto s-svc__list" style="--col:18rem">
            {section.items.map((entry, index) => item(index, entry))}
          </ul>
        )}
      </div>
    </SectionShell>
  );
}
