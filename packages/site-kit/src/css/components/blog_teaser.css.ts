import { minifyCss } from '../minify';

export const CSS: string = minifyCss(`
@layer sections{
  .s-blog__item{ --stack-gap:var(--space-2) }
  .s-blog__item h3{ font-size:var(--step-1) }
  .s-blog__item time{ color:var(--t-fg-subtle); font-size:var(--step--1) }
  .s-blog__excerpt{ color:var(--t-fg-muted) }
  .s-blog[data-variant="cards_2col"] .s-blog__item{
    background:var(--t-surface); color:var(--t-fg-on-surface);
    border:var(--hairline) solid var(--t-border); border-radius:var(--radius-lg);
    padding:var(--space-6);
  }
  .s-blog[data-variant="list"] .s-blog__item + .s-blog__item{
    border-block-start:var(--hairline) solid var(--t-border);
    padding-block-start:var(--space-5); margin-block-start:var(--space-5);
  }
}
`);
