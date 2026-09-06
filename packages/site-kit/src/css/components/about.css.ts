import { minifyCss } from '../minify';

export const CSS: string = minifyCss(`
@layer sections{
  .s-about__body{ --stack-gap:var(--space-4) }
  .s-about[data-variant="image_text"] .s-about__inner{ direction:rtl }
  .s-about[data-variant="image_text"] .s-about__inner > *{ direction:ltr }
  .s-about__quote{
    font-family:var(--font-display); font-size:var(--step-3); line-height:1.25;
    border-inline-start:4px solid var(--t-accent-edge);
    padding-inline-start:var(--space-6);
    max-inline-size:var(--measure);
  }
  .s-about__timeline{ list-style:none; padding:0; counter-reset:step }
  .s-about__timeline > li{
    counter-increment:step; position:relative;
    padding-inline-start:var(--space-10); padding-block-end:var(--space-6);
    border-inline-start:var(--hairline) solid var(--t-border);
    margin-inline-start:var(--space-2);
  }
  .s-about__timeline > li::before{
    content:counter(step); position:absolute; inset-inline-start:calc(var(--space-5) * -1);
    inline-size:var(--space-8); block-size:var(--space-8);
    display:grid; place-items:center; border-radius:var(--radius-pill);
    background:var(--t-accent); color:var(--t-fg-on-accent); font-size:var(--step--1);
  }
}
`);
