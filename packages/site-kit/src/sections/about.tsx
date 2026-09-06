import type { SectionOf } from '@aibuilder/site-schema';
import { CtaLink, Picture, SectionHeading, SectionShell, imageFor, slot } from './shared';
import type { Markup, SectionProps } from './shared';

/**
 * The story block.
 *
 * `wide_quote` wraps paragraph 0 in a `<blockquote>` with **no** `<cite>`: there is no attribution
 * slot, and inventing one would be fabricated provenance on a page the business's customers read.
 * `timeline` renders an `<ol>` whose ordinals are CSS-generated, so the order is carried by the list
 * semantics rather than by a glyph.
 */
export function About(props: SectionProps<SectionOf<'about'>>): Markup {
  const { section, doc, scope, ctx } = props;
  const image = imageFor(doc, ctx, section.media);
  const ctaLabel = slot(doc, scope, section.id, 'cta', 'label');

  const paragraphs = section.paragraphs.map((paragraph, index) => (
    <p class={paragraph.emphasis === 'lead' ? 'lead' : undefined}>
      {slot(doc, scope, section.id, 'paragraphs', index, 'text')}
    </p>
  ));

  const body =
    section.variant === 'wide_quote' ? (
      <div class="s-about__body stack">
        <blockquote class="s-about__quote">{paragraphs[0]}</blockquote>
        {paragraphs.slice(1)}
      </div>
    ) : section.variant === 'timeline' ? (
      <ol class="s-about__timeline">
        {section.paragraphs.map((_paragraph, index) => (
          <li>{slot(doc, scope, section.id, 'paragraphs', index, 'text')}</li>
        ))}
      </ol>
    ) : (
      <div class="s-about__body stack">{paragraphs}</div>
    );

  return (
    <SectionShell section={section} tone={props.tone} ctx={props.ctx} extraClass="s-about">
      <div class="wrap">
        <div class={image === null ? 's-about__inner' : 's-about__inner split'}>
          <div class="stack">
            <SectionHeading
              sectionId={section.id}
              level={props.headingLevel}
              text={slot(doc, scope, section.id, 'headline')}
              fallback={doc.facts.businessName}
            />
            {body}
            {section.cta === null ? null : (
              <div class="cluster">
                <CtaLink cta={section.cta} label={ctaLabel} doc={doc} scope={scope} />
              </div>
            )}
          </div>
          {image === null ? null : (
            <div class="media">
              <Picture image={image} sizes="(min-width:52em) 50vw, 100vw" />
            </div>
          )}
        </div>
      </div>
    </SectionShell>
  );
}
