import { minifyCss } from '../minify';

export const CSS: string = minifyCss(`
@layer sections{
  .s-hours__table{ inline-size:100%; max-inline-size:32rem }
  .s-hours__table th{ text-align:start; font-weight:600; padding-block:var(--space-2); padding-inline-end:var(--space-4) }
  .s-hours__table td{ text-align:end; padding-block:var(--space-2); color:var(--t-fg-muted) }
  .s-hours__table tr + tr th,.s-hours__table tr + tr td{ border-block-start:var(--hairline) solid var(--t-border) }
  .s-hours__map img{ inline-size:100%; border-radius:var(--radius-lg) }
  .s-hours__note{ color:var(--t-fg-muted) }
  @media (min-width:52em){
    .s-hours[data-variant="map_right"] .s-hours__inner{ grid-template-columns:1fr 1fr }
    .s-hours[data-variant="map_left"] .s-hours__inner{ grid-template-columns:1fr 1fr }
    .s-hours[data-variant="map_left"] .s-hours__map{ order:-1 }
  }
}
`);
