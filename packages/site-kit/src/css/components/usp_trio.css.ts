import { minifyCss } from '../minify';

export const CSS: string = minifyCss(`
@layer sections{
  .s-usp__item{ --stack-gap:var(--space-3) }
  .s-usp__item h3{ font-size:var(--step-1) }
  .s-usp[data-variant="numbered_cards"] .s-usp__list{ counter-reset:usp }
  .s-usp[data-variant="numbered_cards"] .s-usp__item{
    counter-increment:usp; padding:var(--space-6);
    background:var(--t-surface); color:var(--t-fg-on-surface);
    border-radius:var(--radius-lg);
  }
  /* Generated content, never a text node: a screen reader must not read "1" before every title. */
  .s-usp[data-variant="numbered_cards"] .s-usp__item::before{
    content:counter(usp); display:block;
    font-family:var(--font-display); font-size:var(--step-3); color:var(--t-accent-text);
  }
  .s-usp[data-variant="bordered_grid"] .s-usp__item{
    border:var(--hairline) solid var(--t-border); border-radius:var(--radius-lg);
    padding:var(--space-6);
  }
}
`);
