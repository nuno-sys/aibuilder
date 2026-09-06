import type { SectionOf } from '@aibuilder/site-schema';
import { CtaLink, SectionHeading, SectionShell, imageFor, slot } from './shared';
import type { Markup, SectionProps } from './shared';

/**
 * The conversion band.
 *
 * `accent_full` sets `data-tone="accent"`, which inverts its buttons for free: on that tone
 * `--t-accent` binds to `--color-fg-on-accent` and `--t-fg-on-accent` to `--color-accent`, so a
 * primary button becomes paper fill with accent ink. That is both the correct visual answer and
 * zero new tokens — `contrast(a, b)` is symmetric, so the pair is already proven.
 *
 * `image_overlay` places its copy on a **solid** plate at the proven alpha rather than a gradient:
 * the geometry here is a box, not a band, so the band argument does not apply and a flat plate is
 * the composition that can be proven.
 */
export function CtaBand(props: SectionProps<SectionOf<'cta_band'>>): Markup {
  const { section, doc, scope, ctx } = props;
  const image = section.variant === 'image_overlay' ? imageFor(doc, ctx, section.media) : null;

  return (
    <SectionShell section={section} tone={props.tone} ctx={props.ctx} extraClass="s-cta">
      {image === null ? null : (
        <>
          <img
            src={image.src}
            alt=""
            width={String(image.width)}
            height={String(image.height)}
            loading="lazy"
            decoding="async"
          />
          <div class="s-cta__plate" aria-hidden="true" />
        </>
      )}
      <div class="wrap">
        <div class="s-cta__inner stack">
          <SectionHeading
            sectionId={section.id}
            level={props.headingLevel}
            text={slot(doc, scope, section.id, 'headline')}
            fallback={doc.facts.businessName}
          />
          <p>{slot(doc, scope, section.id, 'body')}</p>
          <div class="cluster s-cta__actions">
            {section.ctas.map((cta, index) => (
              <CtaLink
                cta={cta}
                label={slot(doc, scope, section.id, 'ctas', index, 'label')}
                doc={doc}
                scope={scope}
              />
            ))}
          </div>
        </div>
      </div>
    </SectionShell>
  );
}
