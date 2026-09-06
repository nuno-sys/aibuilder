import type { SectionOf } from '@aibuilder/site-schema';
import { CtaLink, SectionHeading, SectionShell, imageFor, slot } from '../sections/shared';
import type { Markup, SectionProps } from '../sections/shared';

/**
 * The hero — a full-screen bright video header that still scores 100/100.
 *
 * Everything here exists to satisfy one invariant: **poster intrinsic area ≥ video intrinsic area,
 * at every breakpoint.** LCP size is the viewport intersection capped by intrinsic size, and a new
 * candidate replaces the old only when it is *strictly larger*, so a video that is intrinsically
 * smaller than its poster can never take the attribution away. Timing cannot save you; only size
 * can. `core/media-pipeline.ts` asserts the pair at publish and a failing pair fails the publish.
 *
 * Four guards, in decreasing order of reliability: the size invariant (the actual guarantee),
 * `opacity: 0` until mounted (Chrome excludes fully transparent elements from LCP), mounting only
 * after LCP was attributed to the poster, and **never** putting `poster=` on the `<video>` — that
 * makes the video element itself the candidate and hands Lighthouse a "video did not have a
 * preload" audit.
 *
 * Only `video_fullbleed` puts text over unknown pixels, so only it carries a scrim and only it
 * needs the alpha algebra. The other three variants are provable by ordinary token contrast, which
 * is the point of having four.
 */
export function Hero(props: SectionProps<SectionOf<'hero'>>): Markup {
  const { section, doc, scope, ctx } = props;
  const fullbleed = section.variant === 'video_fullbleed';
  const hero = ctx.hero;
  const fallbackImage = imageFor(doc, ctx, section.media);
  const poster = hero?.poster ?? fallbackImage;

  // `--hero-ink` is the one resolved token CSS never consumes: a custom property cannot be selected
  // on, so the renderer copies its value onto `data-ink`, where `[data-ink="light"]` can match. It
  // stays in the token set anyway so the editor changes it in one place and so `resolveTheme` can
  // prove the scrim alpha against it.
  const inkAttr = fullbleed
    ? doc.theme.tokens['--hero-ink'] === 'light'
      ? 'light'
      : 'dark'
    : undefined;

  // The only style attribute site-kit ever emits, and both values come from closed sources: a
  // `CHECK`-constrained hex column and the `FocalPoint` enum. No model string reaches it.
  const inlineStyle = [
    poster?.dominantColor === null || poster?.dominantColor === undefined
      ? ''
      : `--hero-bg:${poster.dominantColor}`,
    poster === null || poster === undefined ? '' : `--hero-focal:${poster.focal}`,
    `--sec-h:${Math.round(ctx.sectionHeights[section.id] ?? 720)}px`,
  ]
    .filter((part) => part !== '')
    .join(';');

  const copy = (
    <div class="hero__copy stack">
      <SectionHeading
        sectionId={section.id}
        level={props.headingLevel}
        text={slot(doc, scope, section.id, 'headline')}
        fallback={doc.facts.businessName}
      />
      <p class="hero__sub">{slot(doc, scope, section.id, 'subhead')}</p>
      {section.showTrustline ? (
        <p class="hero__trust">{slot(doc, scope, section.id, 'trustline')}</p>
      ) : null}
      <div class="cluster hero__cta">
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
  );

  const media =
    poster === null || poster === undefined ? null : (
      <picture class="hero__media">
        {(hero?.portraitSources ?? []).map((source) => (
          <source
            media="(max-width:767px)"
            type={source.type}
            sizes="100vw"
            srcset={source.srcset}
          />
        ))}
        {poster.sources.map((source) => (
          <source type={source.type} sizes="100vw" srcset={source.srcset} />
        ))}
        {/*
          `alt=""` because the poster is decorative — the `<h1>` carries the meaning — and an empty
          alt does NOT disqualify an image from being the LCP element. `decoding="sync"`, not
          `async`: for the single LCP element you want it decoded in the frame it paints. No
          `loading` attribute at all, because `loading="lazy"` on the LCP image is an automatic
          Lighthouse failure. `width`/`height` are the POSTER's intrinsic size, not the video's, so
          the aspect-ratio box is known before either loads.
        */}
        <img
          class="hero__poster"
          src={poster.src}
          alt=""
          width={String(poster.width)}
          height={String(poster.height)}
          sizes="100vw"
          fetchpriority="high"
          decoding="sync"
        />
      </picture>
    );

  const video =
    fullbleed && hero?.video != null ? (
      // No `src` and `preload="none"`: the element exists for layout, generates zero network
      // activity, and is invisible to both the a11y tree and the tab order until `js/site.ts`
      // decides it has earned the bandwidth.
      <video
        class="hero__video"
        muted
        loop
        playsinline
        disablepictureinpicture
        disableremoteplayback
        preload="none"
        aria-hidden="true"
        tabindex={-1}
        width={String(hero.video.width)}
        height={String(hero.video.height)}
        data-src-desktop-av1={hero.video.desktopAv1}
        data-src-desktop-h264={hero.video.desktopH264}
        data-src-mobile-av1={hero.video.mobileAv1}
        data-src-mobile-h264={hero.video.mobileH264}
      />
    ) : null;

  if (fullbleed) {
    return (
      <section
        class="hero s-hero"
        id={section.id}
        data-variant={section.variant}
        data-ink={inkAttr}
        data-tone="page"
        style={inlineStyle}
        aria-labelledby={`${section.id}-h`}
      >
        {media}
        {video}
        <div class="hero__scrim" aria-hidden="true" />
        {copy}
      </section>
    );
  }

  // The three non-scrim variants share the section shell so their tone, `--sec-h` and landmark
  // naming are identical to every other section's; only the media layer differs.
  return (
    <SectionShell section={section} tone="page" ctx={ctx} extraClass="hero s-hero">
      <div class="wrap">
        <div class="hero__inner">
          {copy}
          {section.variant === 'type_centered' ? null : media}
        </div>
      </div>
    </SectionShell>
  );
}
