import { minifyCss } from '../minify';

export const CSS: string = minifyCss(`
@layer sections{
  .s-gallery figure{ margin:0 }
  .s-gallery figcaption{ font-size:var(--step--1); color:var(--t-fg-muted); padding-block-start:var(--space-2) }
  .s-gallery img{ inline-size:100%; block-size:auto; border-radius:var(--radius-md) }
  /* columns(), not grid masonry, which is not Baseline. */
  .s-gallery[data-variant="masonry"] .s-gallery__list{ columns:3 16rem; column-gap:var(--space-4) }
  .s-gallery[data-variant="masonry"] .s-gallery__item{ break-inside:avoid; margin-block-end:var(--space-4) }
  .s-gallery[data-variant="grid_square"] .s-gallery__item img{ aspect-ratio:1; object-fit:cover }
  /* A CSS scroll-snap strip: no JS, so no INP contribution. */
  .s-gallery[data-variant="carousel"] .s-gallery__list{
    display:flex; gap:var(--space-4); overflow-x:auto; scroll-snap-type:x mandatory;
    padding-block-end:var(--space-3);
  }
  .s-gallery[data-variant="carousel"] .s-gallery__item{
    flex:0 0 min(80%,22rem); scroll-snap-align:start;
  }
  .s-gallery__wipe{ position:relative; display:grid }
  .s-gallery__wipe > *{ grid-area:1/1 }
  .s-gallery__wipe input[type="range"]{ inline-size:100%; min-block-size:44px; align-self:end; z-index:1 }
  .s-gallery__zoom{ display:block; inline-size:100%; cursor:zoom-in; border-radius:var(--radius-md) }
  .s-gallery__dialog{ background:var(--t-surface); border-radius:var(--radius-lg); padding:var(--space-4) }
}
`);
