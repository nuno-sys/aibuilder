import { minifyCss } from './minify';

/**
 * The `reset`, `base`, `layout` and `state` layers — the four fragments that ship on every page.
 *
 * `!important` appears exactly twice in this whole package and both are here, both documented in
 * place: `[hidden]` in the reset and the reduced-motion block in `base`. State must not be
 * overridable, and a user's motion preference must not be overridable by a `motionId` knob.
 */

export const RESET_CSS: string = minifyCss(`
@layer reset{
  *,*::before,*::after{ box-sizing:border-box }
  html{
    -webkit-text-size-adjust:100%;
    /* Anchor targets must clear the sticky header, so the offset lives with the header's height. */
    scroll-padding-block-start:calc(var(--space-unit)*24);
  }
  body,h1,h2,h3,h4,p,figure,blockquote,dl,dd,ul,ol{ margin:0 }
  ul[role="list"],ol[role="list"]{ list-style:none; padding:0 }
  /* Not cosmetic: this is the difference between a German compound noun breaking and a 320 px
     page scrolling horizontally, which is the single most common generated-site defect. */
  h1,h2,h3,h4{ text-wrap:balance; overflow-wrap:break-word }
  p,li,dd{ text-wrap:pretty; overflow-wrap:break-word }
  img,picture,video,canvas,svg{ display:block; max-inline-size:100%; block-size:auto }
  input,button,textarea,select{ font:inherit; color:inherit }
  button{ background:none; border:0 }
  table{ border-collapse:collapse }
  :where(a){ color:inherit }
  [hidden]{ display:none !important }
}
`);

export const BASE_CSS: string = minifyCss(`
@layer base{
  /* The 4 px grid. Fixed for every theme: density moves rhythm, not the grid, because a density
     knob that rescaled the grid would move every optical relationship in the system. */
  :root{
    --space-1:calc(var(--space-unit)*1);  --space-2:calc(var(--space-unit)*2);
    --space-3:calc(var(--space-unit)*3);  --space-4:calc(var(--space-unit)*4);
    --space-5:calc(var(--space-unit)*5);  --space-6:calc(var(--space-unit)*6);
    --space-8:calc(var(--space-unit)*8);  --space-10:calc(var(--space-unit)*10);
    --space-12:calc(var(--space-unit)*12);--space-16:calc(var(--space-unit)*16);
    --space-20:calc(var(--space-unit)*20);--space-24:calc(var(--space-unit)*24);
  }
  body{
    margin:0;
    background:var(--t-bg);
    color:var(--t-fg);
    font-family:var(--font-body);
    font-size:var(--step-0);
    line-height:1.6;
    font-synthesis-weight:none;
    text-rendering:optimizeLegibility;
  }
  h1,h2,h3,h4{
    font-family:var(--font-display);
    font-variation-settings:"wght" var(--font-display-wght),"wdth" var(--font-display-wdth);
    letter-spacing:var(--font-display-tracking);
    line-height:1.1;
  }
  h1{ font-size:var(--step-5) }
  h2{ font-size:var(--step-4) }
  h3{ font-size:var(--step-2) }
  h4{ font-size:var(--step-1) }
  p,li{ max-inline-size:var(--measure) }
  small,.u-fine{ font-size:var(--step--1); color:var(--t-fg-muted) }
  strong{ font-weight:600 }
  a{ color:var(--t-accent-text); text-underline-offset:.18em; text-decoration-thickness:.08em }
  a:hover{ text-decoration-thickness:.14em }

  /* One focus rule for the whole site, drawn OUTSIDE the control. The 3 px offset is why
     --t-focus is proven against the GROUNDS rather than against the control it rings. */
  :focus-visible{
    outline:3px solid var(--t-focus);
    outline-offset:3px;
    border-radius:var(--radius-sm);
    box-shadow:0 0 0 6px var(--color-focus-halo);
  }
  :focus:not(:focus-visible){ outline:none }

  /* clip-path, not the legacy clip: rect(). Both hide; clip-path does not suppress selection
     announcements in some AT builds. */
  .vh{
    position:absolute; inline-size:1px; block-size:1px; padding:0; margin:-1px;
    overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0;
  }
  .skip{
    position:absolute; inset-block-start:0; inset-inline-start:0; z-index:100;
    transform:translateY(-120%);
    background:var(--t-surface); color:var(--t-fg-on-surface);
    padding:var(--space-3) var(--space-4); border-radius:var(--radius-md);
  }
  .skip:focus{ transform:none }

  .btn{
    display:inline-flex; align-items:center; justify-content:center; gap:var(--space-2);
    min-block-size:44px; min-inline-size:44px;
    padding-block:var(--space-3); padding-inline:var(--space-5);
    border-radius:var(--radius-md);
    font-weight:600; line-height:1.2; text-decoration:none;
    transition:background-color var(--dur) var(--ease),border-color var(--dur) var(--ease);
  }
  .btn--primary{
    background:var(--t-accent); color:var(--t-fg-on-accent);
    border:var(--hairline) solid var(--t-accent-edge);
  }
  .btn--primary:hover{ background:var(--t-accent-hover); border-color:var(--t-accent-hover) }
  .btn--secondary{
    background:transparent; color:var(--t-accent-text);
    border:2px solid var(--t-accent-edge);
  }
  .btn--ghost{
    background:transparent; color:var(--t-accent-text);
    text-decoration:underline; text-underline-offset:.2em; padding-inline:var(--space-2);
  }

  .chip{
    display:inline-block;
    background:var(--t-chip-bg); color:var(--t-chip-fg);
    border-radius:var(--radius-pill);
    padding:var(--space-1) var(--space-3);
    font-size:var(--step--1); line-height:1.4;
  }

  .icon{ inline-size:28px; block-size:28px; color:var(--t-accent-text) }

  /* The user preference and the motionId knob cannot disagree: this wins. */
  @media (prefers-reduced-motion:reduce){
    *,*::before,*::after{
      animation-duration:.001ms !important; animation-iteration-count:1 !important;
      transition-duration:.001ms !important; scroll-behavior:auto !important;
    }
  }
}
`);

export const LAYOUT_CSS: string = minifyCss(`
@layer layout{
  .wrap{ inline-size:min(100% - var(--gutter)*2,var(--wrap-max,72rem)); margin-inline:auto }
  .wrap--narrow{ --wrap-max:46rem }
  .wrap--wide{ --wrap-max:84rem }
  .section{
    padding-block:var(--section-y);
    background:var(--t-bg); color:var(--t-fg);
    content-visibility:auto;
    contain-intrinsic-size:auto var(--sec-h,720px);
  }
  /* Never defer the LCP section. */
  .section:first-of-type{ content-visibility:visible }
  .stack > * + *{ margin-block-start:var(--stack-gap,var(--space-4)) }
  .cluster{ display:flex; flex-wrap:wrap; gap:var(--space-3); align-items:center }
  /* The inner min() is the fix for auto-fit overflow at 320 px: without it a 17 rem minimum
     forces a 272 px column inside a 280 px content box and the first long word overflows. */
  .grid-auto{
    display:grid; gap:var(--space-6);
    grid-template-columns:repeat(auto-fit,minmax(min(100%,var(--col,17rem)),1fr));
  }
  .split{ display:grid; gap:var(--space-8); align-items:center }
  @media (min-width:52em){ .split{ grid-template-columns:var(--split,1fr 1fr) } }
  .card{
    background:var(--t-surface); color:var(--t-fg-on-surface);
    border:var(--hairline) solid var(--t-border); border-radius:var(--radius-lg);
    padding:var(--space-6);
  }
  .lead{ font-size:var(--step-1); color:var(--t-fg-muted); max-inline-size:var(--measure) }
  .section__head{ margin-block-end:var(--space-8) }
  .media{ border-radius:var(--radius-lg); overflow:clip }
  .media img{ inline-size:100%; block-size:100%; object-fit:cover; object-position:var(--focal,50% 50%) }
}
`);

export const STATE_CSS: string = minifyCss(`
@layer state{
  [aria-expanded="false"] + .nav__panel{ display:none }
  dialog::backdrop{ background:rgb(0 0 0 / .6) }
  dialog[open]{ border:0; padding:0; background:transparent; max-inline-size:100% }
  [data-ready="1"]{ opacity:1 }
  @media print{
    .wa,.site-header,.cookie-banner,.hero__video,.hero__scrim{ display:none !important }
    .section{ content-visibility:visible; padding-block:0 }
    a[href^="http"]::after{ content:" (" attr(href) ")"; font-size:.8em }
  }
}
`);
