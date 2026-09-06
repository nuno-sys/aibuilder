import { minifyCss } from '../minify';

export const CSS: string = minifyCss(`
@layer sections{
  .s-contact__form{ display:grid; gap:var(--space-4) }
  .s-contact__field{ display:grid; gap:var(--space-2) }
  .s-contact__field label{ font-weight:600 }
  .s-contact__field input,.s-contact__field textarea,.s-contact__field select{
    min-block-size:44px; padding:var(--space-2) var(--space-3);
    border:var(--hairline) solid var(--t-border-strong); border-radius:var(--radius-md);
    background:var(--t-surface); color:var(--t-fg-on-surface);
    inline-size:100%;
  }
  .s-contact__field textarea{ min-block-size:8rem; resize:vertical }
  .s-contact__consent{ display:grid; grid-template-columns:auto 1fr; gap:var(--space-3); align-items:start }
  .s-contact__consent input{ min-block-size:24px; min-inline-size:24px; margin-block-start:.35em }
  .s-contact__required{ color:var(--t-danger) }
  /* There is no filled danger surface anywhere in the system, which is why the token set has
     --color-danger and no --color-fg-on-danger. */
  .s-contact__error{ color:var(--t-danger); font-size:var(--step--1) }
  .s-contact__field:has(.s-contact__error) input,
  .s-contact__field:has(.s-contact__error) textarea{ border-inline-start:4px solid var(--t-danger) }
  .s-contact__turnstile{ min-block-size:70px }
  @media (min-width:52em){
    .s-contact[data-variant="split_map"] .s-contact__inner{ display:grid; grid-template-columns:1fr 1fr; gap:var(--space-8) }
  }
  .s-contact[data-variant="boxed_accent"] .s-contact__inner{
    background:var(--t-surface); color:var(--t-fg-on-surface);
    border-radius:var(--radius-lg); padding:var(--space-8);
    border-block-start:4px solid var(--t-accent-edge);
  }
}
`);
