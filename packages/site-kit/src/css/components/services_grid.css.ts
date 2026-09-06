import { minifyCss } from '../minify';

export const CSS: string = minifyCss(`
@layer sections{
  .s-svc__item{ position:relative; --stack-gap:var(--space-3) }
  .s-svc__item h3{ font-size:var(--step-1) }
  .s-svc__price{ color:var(--t-accent-text); font-weight:600 }
  /* The card is not a link — nested interactive content. The heading holds the anchor and the
     ::after overlay lends it the card's hit area, so the accessible name stays the title. */
  .s-svc__item h3 a::after{ content:""; position:absolute; inset:0 }
  .s-svc__item:has(a:hover){ border-color:var(--t-border-strong) }
  .s-svc[data-variant="cards_3col"] .s-svc__item,
  .s-svc[data-variant="image_tiles"] .s-svc__item{
    background:var(--t-surface); color:var(--t-fg-on-surface);
    border:var(--hairline) solid var(--t-border); border-radius:var(--radius-lg);
    padding:var(--space-6); overflow:clip;
  }
  .s-svc[data-variant="list_split"] .s-svc__list{ display:grid; gap:var(--space-6) }
  @media (min-width:52em){
    .s-svc[data-variant="list_split"] .s-svc__list{ grid-template-columns:1fr 1fr }
  }
  .s-svc[data-variant="list_split"] .s-svc__item{
    border-block-end:var(--hairline) solid var(--t-border); padding-block-end:var(--space-5);
  }
  .s-svc__details{
    border:var(--hairline) solid var(--t-border); border-radius:var(--radius-md);
    padding:var(--space-4) var(--space-5);
  }
  .s-svc__details summary{ cursor:pointer; min-block-size:44px; display:flex; align-items:center }
  .s-svc__details summary h3{ font-size:var(--step-1) }
}
`);
