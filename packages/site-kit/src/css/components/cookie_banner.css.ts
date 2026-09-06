import { minifyCss } from '../minify';

/**
 * Emitted only when the tenant enabled a non-essential cookie, which by default they have not.
 * The banner sets `--wa-lift` so the WhatsApp pill moves above it — a style change on a fixed
 * element, so no layout and no CLS — and sits at a higher z-index so it wins mid-transition.
 */
export const CSS: string = minifyCss(`
@layer chrome{
  .cookie-banner{
    position:fixed; inset-inline:0; inset-block-end:0; z-index:70;
    background:var(--t-surface); color:var(--t-fg-on-surface);
    border-block-start:var(--hairline) solid var(--t-border-strong);
    padding:var(--space-4); padding-block-end:max(var(--space-4),env(safe-area-inset-bottom));
  }
  .cookie-banner__inner{ display:grid; gap:var(--space-4); align-items:center }
  @media (min-width:52em){ .cookie-banner__inner{ grid-template-columns:1fr auto } }
  .cookie-banner__actions{ gap:var(--space-3) }
}
`);
