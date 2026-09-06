import { minifyCss } from '../minify';

export const CSS: string = minifyCss(`
@layer chrome{
  .site-header{
    position:sticky; inset-block-start:0; z-index:50;
    background:var(--t-bg); border-block-end:var(--hairline) solid var(--t-border);
  }
  .site-header__inner{ display:flex; align-items:center; gap:var(--space-4); min-block-size:var(--space-16) }
  .site-header__brand{ font-family:var(--font-display); font-weight:700; text-decoration:none }
  .site-nav ul{ display:flex; flex-wrap:wrap; gap:var(--space-4); list-style:none; padding:0; margin:0 }
  .site-nav a{ display:inline-flex; align-items:center; min-block-size:44px; text-decoration:none; color:var(--t-fg) }
  .site-nav a[aria-current="page"]{ text-decoration:underline; text-underline-offset:.3em }
  .site-header[data-nav="logo_left_links_right"] .site-nav{ margin-inline-start:auto }
  .site-header[data-nav="centered_logo_slim"] .site-header__inner{ flex-direction:column; gap:var(--space-2) }
  .site-header__toggle{
    margin-inline-start:auto; min-block-size:44px; min-inline-size:44px;
    border:var(--hairline) solid var(--t-border-strong); border-radius:var(--radius-md);
    padding-inline:var(--space-3);
  }
  .site-header__dialog{ margin:0; margin-inline-start:auto; block-size:100%; max-block-size:100% }
  .site-header__panel{
    background:var(--t-surface); color:var(--t-fg-on-surface);
    block-size:100%; inline-size:min(90vw,20rem); padding:var(--space-6);
  }
  .site-header__panel ul{ flex-direction:column; align-items:stretch }
  @media (min-width:52em){
    .site-header__toggle{ display:none }
  }
  @media (max-width:51.99em){
    .site-header > .wrap > .site-header__inner > .site-nav{ display:none }
  }
}
`);
