import { minifyCss } from '../minify';

export const CSS: string = minifyCss(`
@layer sections{
  .s-team__item{ --stack-gap:var(--space-2) }
  .s-team__item h3{ font-size:var(--step-1) }
  .s-team__role{ color:var(--t-fg-muted); font-size:var(--step--1) }
  .s-team__portrait{ aspect-ratio:4/5; object-fit:cover; border-radius:var(--radius-lg); inline-size:100% }
  /* No media: an initials avatar built from the name slot, never a stock face. */
  .s-team__initials{
    aspect-ratio:4/5; display:grid; place-items:center;
    background:var(--t-chip-bg); color:var(--t-chip-fg);
    border-radius:var(--radius-lg); font-family:var(--font-display); font-size:var(--step-3);
  }
  .s-team[data-variant="list_compact"] .s-team__item{
    display:grid; grid-template-columns:64px 1fr; gap:var(--space-4); align-items:center;
  }
  .s-team[data-variant="list_compact"] .s-team__portrait,
  .s-team[data-variant="list_compact"] .s-team__initials{ aspect-ratio:1; font-size:var(--step-0) }
}
`);
