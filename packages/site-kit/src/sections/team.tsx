import type { SectionOf } from '@aibuilder/site-schema';
import { Picture, SectionHeading, SectionShell, imageFor, slot } from './shared';
import type { Markup, SectionProps } from './shared';

/**
 * The people.
 *
 * No `<address>` and no e-mail links. A generated staff page with harvestable addresses is a spam
 * magnet, and the business already has one contact channel on the contact page.
 *
 * When a person has no portrait the fallback is an initials avatar built from their own name slot,
 * never a stock face: a stock photograph of a person who does not work there is a misrepresentation
 * the business would be liable for.
 */
function initials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/u)
    .filter((part) => part !== '');
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

export function Team(props: SectionProps<SectionOf<'team'>>): Markup {
  const { section, doc, scope, ctx } = props;

  return (
    <SectionShell section={section} tone={props.tone} ctx={props.ctx} extraClass="s-team">
      <div class="wrap">
        <div class="section__head">
          <SectionHeading
            sectionId={section.id}
            level={props.headingLevel}
            text={slot(doc, scope, section.id, 'headline')}
            fallback={doc.facts.businessName}
          />
        </div>
        <ul role="list" class="grid-auto s-team__list" style="--col:14rem">
          {section.items.map((item, index) => {
            const name = slot(doc, scope, section.id, 'items', index, 'name');
            const image = imageFor(doc, ctx, item.media);
            return (
              <li class="s-team__item stack">
                {image === null ? (
                  <p class="s-team__initials" aria-hidden="true">
                    {initials(name)}
                  </p>
                ) : (
                  <Picture
                    image={image}
                    sizes="(min-width:52em) 25vw, 50vw"
                    extraClass="s-team__portrait"
                  />
                )}
                <h3>{name}</h3>
                <p class="s-team__role">{slot(doc, scope, section.id, 'items', index, 'role')}</p>
                {item.showBio ? <p>{slot(doc, scope, section.id, 'items', index, 'bio')}</p> : null}
              </li>
            );
          })}
        </ul>
      </div>
    </SectionShell>
  );
}
