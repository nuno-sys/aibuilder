import type { SectionOf } from '@aibuilder/site-schema';
import { Icon, SectionHeading, SectionShell, slot } from './shared';
import type { Markup, SectionProps } from './shared';

/**
 * "How it works" in n steps.
 *
 * An `<ol>`: the ordering is carried by the list, and the visible number is `counter(step)` in a
 * `::before`, which makes it decorative by construction. `arrow_flow`'s arrows are generated
 * content for the same reason — generated content is not in the accessibility tree, so nobody hears
 * "right arrow" between every step.
 */
export function ProcessSteps(props: SectionProps<SectionOf<'process_steps'>>): Markup {
  const { section, doc, scope } = props;
  return (
    <SectionShell section={section} tone={props.tone} ctx={props.ctx} extraClass="s-steps">
      <div class="wrap">
        <div class="section__head">
          <SectionHeading
            sectionId={section.id}
            level={props.headingLevel}
            text={slot(doc, scope, section.id, 'headline')}
            fallback={doc.facts.businessName}
          />
        </div>
        <ol class="s-steps__list">
          {section.items.map((item, index) => (
            <li class="s-steps__item">
              {item.iconId === null ? null : <Icon id={item.iconId} size={24} />}
              <h3>{slot(doc, scope, section.id, 'items', index, 'title')}</h3>
              <p>{slot(doc, scope, section.id, 'items', index, 'body')}</p>
            </li>
          ))}
        </ol>
      </div>
    </SectionShell>
  );
}
