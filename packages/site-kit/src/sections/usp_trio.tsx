import type { SectionOf } from '@aibuilder/site-schema';
import { Icon, SectionHeading, SectionShell, slot } from './shared';
import type { Markup, SectionProps } from './shared';

/**
 * 2–6 differentiators, icon-led.
 *
 * The heading is `.vh` in `icons_row` (the design shows no title) and visible in the other two. The
 * *markup* is identical and only a class differs, so the section's accessible name never depends on
 * the variant. `numbered_cards` renders the index as a CSS counter, never as text content, so a
 * screen reader does not read "1" before every title.
 */
export function UspTrio(props: SectionProps<SectionOf<'usp_trio'>>): Markup {
  const { section, doc, scope } = props;
  return (
    <SectionShell section={section} tone={props.tone} ctx={props.ctx} extraClass="s-usp">
      <div class="wrap">
        <SectionHeading
          sectionId={section.id}
          level={props.headingLevel}
          text={slot(doc, scope, section.id, 'headline')}
          fallback={doc.facts.businessName}
          visuallyHidden={section.variant === 'icons_row'}
        />
        <ul role="list" class="grid-auto s-usp__list" style="--col:16rem">
          {section.items.map((item, index) => (
            <li class="s-usp__item stack">
              <Icon id={item.iconId} />
              <h3>{slot(doc, scope, section.id, 'items', index, 'title')}</h3>
              <p>{slot(doc, scope, section.id, 'items', index, 'body')}</p>
            </li>
          ))}
        </ul>
      </div>
    </SectionShell>
  );
}
