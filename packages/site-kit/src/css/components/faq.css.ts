import { minifyCss } from '../minify';

export const CSS: string = minifyCss(`
@layer sections{
  /* details/summary: zero JS, zero INP contribution, and the content is findable by in-page
     search in Chrome. */
  .s-faq__item{ border-block-end:var(--hairline) solid var(--t-border) }
  .s-faq__item summary{
    cursor:pointer; min-block-size:44px; display:flex; align-items:center;
    padding-block:var(--space-3); gap:var(--space-3);
  }
  .s-faq__item summary h3{ font-size:var(--step-1) }
  .s-faq__answer{ padding-block-end:var(--space-4); color:var(--t-fg-muted) }
  @media (min-width:52em){
    .s-faq[data-variant="two_column"] .s-faq__list{ columns:2; column-gap:var(--space-10) }
    .s-faq[data-variant="two_column"] .s-faq__item{ break-inside:avoid }
  }
}
`);
