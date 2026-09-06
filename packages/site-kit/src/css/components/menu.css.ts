import { minifyCss } from '../minify';

export const CSS: string = minifyCss(`
@layer sections{
  .s-menu__group + .s-menu__group{ margin-block-start:var(--space-10) }
  .s-menu__group h3{
    font-size:var(--step-2);
    border-block-end:var(--hairline) solid var(--t-border);
    padding-block-end:var(--space-2); margin-block-end:var(--space-4);
  }
  /* A dl is the right element: a menu is a name -> (price, description) association list, and a
     table would imply a grid the design does not have. */
  .s-menu__list{ display:grid; gap:var(--space-1) var(--space-4); align-items:baseline }
  .s-menu__list dt{ font-weight:600; grid-column:1 }
  .s-menu__price{ grid-column:2; text-align:end; color:var(--t-accent-text); white-space:nowrap }
  .s-menu__desc{ grid-column:1/3; color:var(--t-fg-muted); font-size:var(--step--1) }
  .s-menu__tags{ grid-column:1/3; gap:var(--space-2) }
  .s-menu[data-variant="two_column"] .s-menu__groups{ columns:2 24rem; column-gap:var(--space-10) }
  .s-menu[data-variant="two_column"] .s-menu__group{ break-inside:avoid }
  .s-menu[data-variant="cards"] .s-menu__group{
    background:var(--t-surface); color:var(--t-fg-on-surface);
    border-radius:var(--radius-lg); padding:var(--space-6);
  }
  .s-menu[data-variant="chalkboard"]{ --stack-gap:var(--space-6) }
  .s-menu[data-variant="chalkboard"] .s-menu__group h3{ text-transform:uppercase; letter-spacing:.08em }
}
`);
