import { minifyCss } from '../minify';

/**
 * The sticky WhatsApp pill.
 *
 * It reads PALETTE tokens directly — one of exactly three `TONE_EXEMPT_READS` (§2). That is by
 * design, not an oversight: the pill floats over whatever tone happens to be under it, including a
 * hero video, so it cannot inherit a tone. `--color-accent-edge` is what gives it a 3:1 boundary
 * against any ground, which matters more here than anywhere else in the system.
 */
export const CSS: string = minifyCss(`
@layer chrome{
  .wa{
    position:fixed;
    inset-block-end:calc(var(--wa-lift,0px) + max(var(--space-4),env(safe-area-inset-bottom)));
    inset-inline-end:var(--space-4);
    z-index:60;
    display:inline-flex; align-items:center; gap:var(--space-2);
    min-block-size:48px; min-inline-size:48px;
    padding-block:var(--space-3); padding-inline:var(--space-4);
    border-radius:var(--radius-pill);
    background:var(--color-accent); color:var(--color-fg-on-accent);
    border:var(--hairline) solid var(--color-accent-edge);
    box-shadow:var(--shadow-1);
    text-decoration:none; font-weight:600; line-height:1;
    contain:layout paint;
    transition:transform var(--dur) var(--ease);
  }
  .wa:hover{ background:var(--color-accent-hover) }
  .wa:active{ transform:translateY(1px) }
  @media (max-width:40em){ .wa__label{ display:none } }
}
`);
