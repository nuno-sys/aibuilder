import type { SectionOf } from '@aibuilder/site-schema';
import { SectionHeading, SectionShell, slot } from './shared';
import type { Markup, SectionProps } from './shared';

/**
 * The numbers band.
 *
 * `<dt>` is the **label** and `<dd>` is the **value**, with CSS reversing the visual order. A
 * description list means "term → description", and "12" is not a term: a screen reader that reads
 * "12, years in business" has been told the truth, one that reads "years in business, 12" has been
 * told it backwards.
 *
 * `stat_value` is a copy slot rather than a number, so "12 jaar" / "12 Jahre" localises instead of
 * needing a formatter that would put `Intl` on the render path.
 */
export function StatsBand(props: SectionProps<SectionOf<'stats_band'>>): Markup {
  const { section, doc, scope } = props;
  return (
    <SectionShell section={section} tone={props.tone} ctx={props.ctx} extraClass="s-stats">
      <div class="wrap">
        <SectionHeading
          sectionId={section.id}
          level={props.headingLevel}
          text={slot(doc, scope, section.id, 'headline')}
          fallback={doc.facts.businessName}
          visuallyHidden={section.variant === 'plain'}
          extraClass="section__head"
        />
        <dl class="s-stats__list">
          {section.items.map((_item, index) => (
            <div class="s-stats__item">
              <dt>{slot(doc, scope, section.id, 'items', index, 'label')}</dt>
              <dd>{slot(doc, scope, section.id, 'items', index, 'value')}</dd>
            </div>
          ))}
        </dl>
      </div>
    </SectionShell>
  );
}
