import { minifyCss } from '../minify';

export const CSS: string = minifyCss(`
@layer sections{
  .s-booking__inner{ --stack-gap:var(--space-5); max-inline-size:var(--measure) }
  .s-booking__form{ display:grid; gap:var(--space-4) }
  .s-booking__field{ display:grid; gap:var(--space-2) }
  .s-booking__field input,.s-booking__field select{
    min-block-size:44px; padding:var(--space-2) var(--space-3);
    border:var(--hairline) solid var(--t-border-strong); border-radius:var(--radius-md);
    background:var(--t-surface); color:var(--t-fg-on-surface);
  }
}
`);
