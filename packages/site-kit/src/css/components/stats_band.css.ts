import { minifyCss } from '../minify';

export const CSS: string = minifyCss(`
@layer sections{
  .s-stats__list{ display:grid; gap:var(--space-6); grid-template-columns:repeat(auto-fit,minmax(min(100%,10rem),1fr)) }
  /* dt is the LABEL and dd is the VALUE, because a description list means term -> description and
     "12" is not a term. CSS reverses the visual order; the DOM order stays correct. */
  .s-stats__item{ display:flex; flex-direction:column-reverse; gap:var(--space-1); text-align:center }
  .s-stats__item dd{ margin:0; font-family:var(--font-display); font-size:var(--step-4); line-height:1 }
  .s-stats__item dt{ color:var(--t-fg-muted); font-size:var(--step--1) }
  .s-stats[data-variant="boxed"] .s-stats__item{
    background:var(--t-surface); color:var(--t-fg-on-surface);
    border-radius:var(--radius-lg); padding:var(--space-6);
  }
  .s-stats[data-variant="accent_bg"] .s-stats__item dt{ color:var(--t-fg-muted) }
}
`);
