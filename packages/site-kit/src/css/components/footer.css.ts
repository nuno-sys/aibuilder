import { minifyCss } from '../minify';

export const CSS: string = minifyCss(`
@layer chrome{
  .site-footer{
    background:var(--t-bg); color:var(--t-fg);
    border-block-start:var(--hairline) solid var(--t-border);
    padding-block:var(--section-y);
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
