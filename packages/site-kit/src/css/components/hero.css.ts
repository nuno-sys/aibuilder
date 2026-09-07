import { HERO_COPY_BAND_START_PERCENT } from '../../tokens/resolve';
import { minifyCss } from '../minify';

/**
 * `hero` — the only section that puts text over pixels nobody has seen.
 *
 * Three of the four variants are provable by ordinary token contrast, so only `video_fullbleed`
 * carries a scrim. The band boundary and `grid-template-rows` are emitted from the SAME constant,
 * because a geometric proof is only a proof while the two numbers cannot drift apart.
 */
const BAND = `${HERO_COPY_BAND_START_PERCENT}%`;

export const CSS: string = minifyCss(`
@layer sections{
  .hero{
    position:relative;
    /* Fallback for UAs without svh. */
    min-block-size:100vh;
    /* SMALL viewport height: the value with the URL bar EXPANDED. It never changes as the bar
       collapses, so there is no resize-driven shift. 100dvh changes on scroll (CLS); bare 100vh
       is iOS's LARGE viewport, where the hero overflows and the CTA hides under the chrome. */
    min-block-size:100svh;
    display:grid;
    grid-template-rows:${BAND} 1fr;
    overflow:clip;
    isolation:isolate;
    background:var(--hero-bg,var(--t-bg));
    content-visibility:visible;
  }
  /* Poster and video occupy the EXACT same box: mounting the video reflows nothing. */
  .hero__media,.hero__video{
    position:absolute; inset:0; z-index:-2; inline-size:100%; block-size:100%;
  }
  .hero__poster{
    inline-size:100%; block-size:100%;
    object-fit:cover; object-position:var(--hero-focal,50% 50%);
  }
  .hero__video{
    object-fit:cover; object-position:var(--hero-focal,50% 50%);
    /* Fully transparent elements are excluded from LCP candidacy. */
    opacity:0; transition:opacity .6s ease-out; z-index:-1; pointer-events:none;
  }
  .hero__video[data-ready="1"]{ opacity:1 }
  .hero__scrim{
    position:absolute; inset:0; z-index:-1;
    background:linear-gradient(180deg,
      rgb(0 0 0 / var(--hero-scrim-top)) 0%,
      rgb(0 0 0 / var(--hero-scrim-top)) 20%,
      rgb(0 0 0 / var(--hero-scrim-band)) ${BAND},
      rgb(0 0 0 / var(--hero-scrim-band)) 100%);
  }
  .hero[data-ink="dark"] .hero__scrim{
    background:linear-gradient(180deg,
      rgb(255 255 255 / var(--hero-scrim-top)) 0%,
      rgb(255 255 255 / var(--hero-scrim-top)) 20%,
      rgb(255 255 255 / var(--hero-scrim-band)) ${BAND},
      rgb(255 255 255 / var(--hero-scrim-band)) 100%);
  }
  .hero__copy{
    grid-row:2; align-self:center; justify-self:center;
    position:relative; z-index:1;
    inline-size:min(100% - var(--gutter)*2,56ch);
    text-align:center;
    padding-block-end:var(--space-10);
    color:var(--hero-copy-ink);
  }
  /* Pure #fff / #000, not a theme token: the scrim algebra is derived for the extreme ink, and a
     slightly-off-white would invalidate the proof by a few percent for no visual gain. */
  .hero[data-ink="light"]{ --hero-copy-ink:#fff }
  .hero[data-ink="dark"]{ --hero-copy-ink:#000 }
  .hero__copy p{ max-inline-size:none; margin-inline:auto }
  .hero__sub{ font-size:var(--step-1) }
  .hero__trust{ font-size:var(--step--1); letter-spacing:.06em; text-transform:uppercase; opacity:.92 }
  .hero__cta{ justify-content:center }
  .hero[data-variant="image_split"],
  .hero[data-variant="type_centered"],
  .hero[data-variant="image_offset_grid"]{
    grid-template-rows:1fr; min-block-size:auto; padding-block:var(--section-y);
    --hero-copy-ink:var(--t-fg);
  }
  /* The grid-row:2 above is written for video_fullbleed, where .hero IS the two-row grid and the
     copy belongs in the lower band under the scrim. These two variants move the grid down to
     .hero__inner, so that declaration would place the copy in an implicit SECOND ROW of the split
     — media alone in row 1 column 1, copy in row 2 column 1, and column 2 left empty. Reset it. */
  .hero[data-variant="image_split"] .hero__copy,
  .hero[data-variant="image_offset_grid"] .hero__copy{
    grid-row:auto; text-align:start; justify-self:stretch;
  }
  .hero[data-variant="image_split"] .hero__media,
  .hero[data-variant="image_offset_grid"] .hero__media{ position:static; z-index:0 }
  .hero[data-variant="image_split"] .hero__inner{ display:grid; gap:var(--space-8); align-items:center }
  @media (min-width:52em){
    .hero[data-variant="image_split"] .hero__inner{ grid-template-columns:1.1fr 1fr }
  }
  .hero[data-variant="image_offset_grid"] .hero__inner{ display:grid; gap:var(--space-8) }
  @media (min-width:52em){
    .hero[data-variant="image_offset_grid"] .hero__inner{ grid-template-columns:repeat(12,1fr) }
    .hero[data-variant="image_offset_grid"] .hero__copy{ grid-column:1/7 }
    .hero[data-variant="image_offset_grid"] .hero__media{ grid-column:7/13 }
  }
  @media (prefers-reduced-motion:reduce){
    .hero__video{ display:none !important }
  }
}
`);
