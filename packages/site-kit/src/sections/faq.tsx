import type { SectionOf } from '@aibuilder/site-schema';
import { SectionHeading, SectionShell, slot } from './shared';
import type { Markup, SectionProps } from './shared';

/**
 * The FAQ.
 *
 * `<details>` / `<summary>`, one per item: zero JavaScript, zero INP contribution, and the answers
 * are findable by in-page search in Chrome even while collapsed. The `<summary>` contains the
 * `<h3>` rather than the other way round, because a heading that contains the disclosure widget
 * puts the widget inside the document outline.
 *
 * `emitFaqSchema` is an input to the JSON-LD builder and changes nothing here.
 */
export function Faq(props: SectionProps<SectionOf<'faq'>>): Markup {
  const { section, doc, scope } = props;
  return (
    <SectionShell section={section} tone={props.tone} ctx={props.ctx} extraClass="s-faq">
      <div class="wrap wrap--narrow">
        <div class="section__head">
          <SectionHeading
            sectionId={section.id}
            level={props.headingLevel}
            text={slot(doc, scope, section.id, 'headline')}
            fallback={doc.facts.businessName}
          />
        </div>
        <div class="s-faq__list">
          {section.items.map((item, index) => (
            <details class="s-faq__item" open={item.expandedByDefault}>
              <summary>
                <h3>{slot(doc, scope, section.id, 'items', index, 'question')}</h3>
              </summary>
              <p class="s-faq__answer">{slot(doc, scope, section.id, 'items', index, 'answer')}</p>
            </details>
          ))}
        </div>
      </div>
    </SectionShell>
  );
}
