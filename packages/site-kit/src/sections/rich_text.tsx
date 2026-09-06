import type { ProseStyle, SectionOf } from '@aibuilder/site-schema';
import { SectionHeading, SectionShell, slot } from './shared';
import type { Markup, SectionProps } from './shared';

/**
 * Long-form prose for legal and editorial pages.
 *
 * `ProseStyle` maps to a class on a `<p>` and nothing else. These are still plain-text slots: there
 * is no markdown parser in this package and there never will be, because a parser is exactly the
 * component that would turn a prompt injection into markup (invariant 1).
 */
const PROSE_CLASS: Readonly<Record<ProseStyle, string | undefined>> = {
  paragraph: undefined,
  lead: 'lead',
  note: 'u-fine',
};

export function RichText(props: SectionProps<SectionOf<'rich_text'>>): Markup {
  const { section, doc, scope } = props;
  return (
    <SectionShell section={section} tone={props.tone} ctx={props.ctx} extraClass="s-prose">
      <div class={section.variant === 'prose_narrow' ? 'wrap wrap--narrow' : 'wrap'}>
        <div class="s-prose stack">
          <SectionHeading
            sectionId={section.id}
            level={props.headingLevel}
            text={slot(doc, scope, section.id, 'headline')}
            fallback={doc.facts.businessName}
          />
          {section.paragraphs.map((paragraph, index) => (
            <p class={PROSE_CLASS[paragraph.style]}>
              {slot(doc, scope, section.id, 'paragraphs', index, 'text')}
            </p>
          ))}
        </div>
      </div>
    </SectionShell>
  );
}
