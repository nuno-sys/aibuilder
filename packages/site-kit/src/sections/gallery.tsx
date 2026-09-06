import type { SectionOf } from '@aibuilder/site-schema';
import { Picture, SectionHeading, SectionShell, imageFor, slot } from './shared';
import type { Markup, SectionProps } from './shared';
import { uiStrings } from '../ui';

/**
 * The photo wall.
 *
 * `alt` comes from `MediaAsset.altText`, written by the media pipeline — never from the model, and
 * never from the caption slot. A caption and an alt are different jobs: the caption is editorial,
 * the alt describes the picture for someone who cannot see it, and using one as the other produces
 * a page that reads its own captions twice.
 *
 * `carousel` is a CSS scroll-snap strip with a focusable scroller and a `role="group"` label — no
 * JavaScript, so it contributes nothing to INP. `before_after` is a CSS-only wipe whose range input
 * has a real (visually hidden) label.
 */
export function Gallery(props: SectionProps<SectionOf<'gallery'>>): Markup {
  const { section, doc, scope, ctx } = props;
  const strings = uiStrings(scope.locale);
  const images = section.media.map((ref) => imageFor(doc, ctx, ref));

  const figure = (index: number): Markup | null => {
    const image = images[index];
    if (image === undefined || image === null) return null;
    const caption = section.showCaptions
      ? slot(doc, scope, section.id, 'media', index, 'caption')
      : '';
    return (
      <li class="s-gallery__item">
        <figure>
          <Picture image={image} sizes="(min-width:52em) 33vw, 100vw" />
          {caption === '' ? null : <figcaption>{caption}</figcaption>}
        </figure>
      </li>
    );
  };

  const first = images[0];
  const second = images[1];
  const beforeAfter =
    first === undefined || first === null || second === undefined || second === null ? null : (
      <div class="s-gallery__wipe">
        <Picture image={first} sizes="100vw" />
        <Picture image={second} sizes="100vw" />
        <label class="vh" for={`${section.id}-wipe`}>
          {strings.beforeAfterLabel}
        </label>
        <input id={`${section.id}-wipe`} type="range" min="0" max="100" value="50" />
      </div>
    );

  return (
    <SectionShell section={section} tone={props.tone} ctx={props.ctx} extraClass="s-gallery">
      <div class="wrap wrap--wide">
        <div class="section__head">
          <SectionHeading
            sectionId={section.id}
            level={props.headingLevel}
            text={slot(doc, scope, section.id, 'headline')}
            fallback={doc.facts.businessName}
          />
        </div>
        {section.variant === 'before_after' ? (
          beforeAfter
        ) : (
          <ul
            role={section.variant === 'carousel' ? 'group' : 'list'}
            class="s-gallery__list"
            aria-label={section.variant === 'carousel' ? strings.galleryLabel : undefined}
            tabindex={section.variant === 'carousel' ? 0 : undefined}
          >
            {section.media.map((_ref, index) => figure(index))}
          </ul>
        )}
      </div>
    </SectionShell>
  );
}
