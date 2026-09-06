import { minifyCss } from '../minify';

export const CSS: string = minifyCss(`
@layer sections{
  .s-reviews__item{
    background:var(--t-surface); color:var(--t-fg-on-surface);
    border:var(--hairline) solid var(--t-border); border-radius:var(--radius-lg);
    padding:var(--space-6); --stack-gap:var(--space-3);
  }
  .s-reviews blockquote{ margin:0; font-size:var(--step-1); line-height:1.5 }
  .s-reviews footer{ color:var(--t-fg-muted); font-size:var(--step--1) }
  .s-reviews__stars{ color:var(--t-accent-text); letter-spacing:.1em }
  .s-reviews__disclosure{ margin-block-start:var(--space-6) }
  .s-reviews[data-variant="single_large"] blockquote{ font-size:var(--step-2) }
  .s-reviews[data-variant="marquee"] .s-reviews__list{
    display:flex; gap:var(--space-4); overflow:hidden;
  }
  .s-reviews[data-variant="marquee"] .s-reviews__item{ flex:0 0 min(80%,24rem) }
  @media (prefers-reduced-motion:no-preference){
    .s-reviews[data-variant="marquee"] .s-reviews__list{ animation:s-reviews-scroll 40s linear infinite }
  }
  @keyframes s-reviews-scroll{ from{ transform:translateX(0) } to{ transform:translateX(-50%) } }
}
`);
