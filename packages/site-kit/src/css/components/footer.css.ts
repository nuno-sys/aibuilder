import { minifyCss } from '../minify';

/**
 * `footer` — the second surface that puts text over pixels nobody has seen.
 *
 * The photographic ground reuses the HERO's scrim alpha rather than introducing its own, and that
 * is the whole reason it is safe. `--hero-scrim-band` is derived, not chosen: alpha compositing on
 * an opaque backdrop is `α·scrim + (1−α)·backdrop` per channel, so the worst case over any image
 * is a single known colour — pure white behind a black scrim, pure black behind a white one — and
 * both solve above 7:1. A second constant would be a second thing to keep true.
 *
 * Over a ground the footer switches to PURE ink and derives its rules and muted text from
 * `currentColor`. Theme tokens are proven against `--t-bg`, and `--t-bg` is not what is behind the
 * type any more; a slightly-off-white would cost a few percent of the proof for no visual gain.
 */
export const CSS: string = minifyCss(`
@layer chrome{
  .site-footer{
    background:var(--t-bg); color:var(--t-fg);
    border-block-start:var(--hairline) solid var(--t-border);
    padding-block:var(--section-y);
  }
  .site-footer[data-ground]{ position:relative; isolation:isolate; overflow:clip }
  .site-footer__media{ position:absolute; inset:0; z-index:-2 }
  .site-footer__media picture{ display:block; block-size:100% }
  .site-footer__ground{
    inline-size:100%; block-size:100%;
    object-fit:cover; object-position:var(--focal,50% 50%);
  }
  .site-footer__scrim{ position:absolute; inset:0; z-index:-1 }
  /* Pure #fff / #000, not a theme token: the scrim algebra is derived for the extreme ink, and a
     slightly-off-white would invalidate the proof by a few percent for no visual gain. */
  [data-ink="light"] .site-footer[data-ground]{ color:#fff }
  [data-ink="light"] .site-footer__scrim{ background:rgb(0 0 0 / var(--hero-scrim-band)) }
  [data-ink="dark"] .site-footer[data-ground]{ color:#000 }
  [data-ink="dark"] .site-footer__scrim{ background:rgb(255 255 255 / var(--hero-scrim-band)) }
  /* Every colour that was a theme token becomes the pure ink. The proof covers currentColor over
     the scrim; it does not cover --t-fg-muted, which was proven against --t-bg — and --t-bg
     is not what is behind the type any more. */
  .site-footer[data-ground] a,
  .site-footer[data-ground] .site-footer__legal{ color:inherit }
  .site-footer[data-ground],
  .site-footer[data-ground] .site-footer__legal{
    border-color:color-mix(in oklab,currentColor 28%,transparent);
  }
  .site-footer__grid{ display:grid; gap:var(--space-8) }
  @media (min-width:52em){
    .site-footer[data-style="rich_4col"] .site-footer__grid{ grid-template-columns:repeat(4,1fr) }
    .site-footer[data-style="rich_3col_map"] .site-footer__grid{ grid-template-columns:repeat(3,1fr) }
    .site-footer[data-style="compact_2col"] .site-footer__grid{ grid-template-columns:repeat(2,1fr) }
  }
  .site-footer h2{ font-size:var(--step-1) }
  .site-footer ul{ list-style:none; padding:0; margin:0; display:grid; gap:var(--space-2) }
  .site-footer a{ display:inline-flex; align-items:center; min-block-size:44px }
  .site-footer__legal{
    margin-block-start:var(--space-10); padding-block-start:var(--space-5);
    border-block-start:var(--hairline) solid var(--t-border);
    color:var(--t-fg-muted); font-size:var(--step--1);
  }
  /* Reserve the WhatsApp pill's footprint so it never covers a footer link at the very bottom. */
  @media (max-width:40em){
    .site-footer{ padding-block-end:calc(var(--space-10) + 48px) }
  }
}
`);
