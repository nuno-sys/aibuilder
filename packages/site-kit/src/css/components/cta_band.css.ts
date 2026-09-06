import { minifyCss } from '../minify';

export const CSS: string = minifyCss(`
@layer sections{
  .s-cta__inner{ --stack-gap:var(--space-4); text-align:center; max-inline-size:46rem; margin-inline:auto }
  .s-cta__inner p{ margin-inline:auto }
  .s-cta__actions{ justify-content:center }
  .s-cta[data-variant="minimal_rule"]{
    border-block:var(--hairline) solid var(--t-border); background:transparent;
  }
  .s-cta[data-variant="image_overlay"]{ position:relative; overflow:clip; isolation:isolate }
  .s-cta[data-variant="image_overlay"] img{
    position:absolute; inset:0; z-index:-2; inline-size:100%; block-size:100%; object-fit:cover;
  }
  /* A SOLID plate at the proven alpha, not a gradient: the geometry here is a box, not a band. */
  .s-cta[data-variant="image_overlay"] .s-cta__plate{
    position:absolute; inset:0; z-index:-1; background:rgb(0 0 0 / .66);
  }
  .s-cta[data-variant="image_overlay"] .s-cta__inner{ color:#fff; position:relative }
  /* The widget's footprint, so the pill never covers the last CTA on a phone. */
  @media (max-width:40em){
    .s-cta:last-of-type{ padding-block-end:calc(var(--section-y) + 48px) }
  }
}
`);
