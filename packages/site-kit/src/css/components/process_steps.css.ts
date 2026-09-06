import { minifyCss } from '../minify';

export const CSS: string = minifyCss(`
@layer sections{
  .s-steps__list{ list-style:none; padding:0; counter-reset:step; display:grid; gap:var(--space-6) }
  .s-steps__item{ counter-increment:step; --stack-gap:var(--space-2) }
  /* The number is generated content: the accessible order comes from the ol, not from a glyph. */
  .s-steps__item::before{
    content:counter(step);
    display:grid; place-items:center;
    inline-size:var(--space-10); block-size:var(--space-10);
    border-radius:var(--radius-pill);
    background:var(--t-accent); color:var(--t-fg-on-accent);
    font-family:var(--font-display); font-size:var(--step-1);
    margin-block-end:var(--space-3);
  }
  .s-steps__item h3{ font-size:var(--step-1) }
  @media (min-width:52em){
    .s-steps[data-variant="numbered_horizontal"] .s-steps__list,
    .s-steps[data-variant="arrow_flow"] .s-steps__list{
      grid-template-columns:repeat(auto-fit,minmax(min(100%,15rem),1fr));
    }
  }
  .s-steps[data-variant="arrow_flow"] .s-steps__item{ position:relative }
  .s-steps[data-variant="arrow_flow"] .s-steps__item + .s-steps__item::after{
    content:"\\2192"; position:absolute; inset-block-start:var(--space-2);
    inset-inline-start:calc(var(--space-6) * -1); color:var(--t-fg-subtle);
  }
  .s-steps[data-variant="vertical_timeline"] .s-steps__item{
    border-inline-start:var(--hairline) solid var(--t-border);
    padding-inline-start:var(--space-6); margin-inline-start:var(--space-5);
  }
}
`);
