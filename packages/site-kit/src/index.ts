/**
 * `@aibuilder/site-kit` — the tenant-site component library.
 *
 * It depends on `@aibuilder/site-schema` and on `hono/jsx`, and on nothing else: no bindings, no
 * `cloudflare:*`, no `node:*`, no `env`. Everything it would otherwise reach into `@aibuilder/core`
 * for — the opening-hours formatter and JSON-LD builder, the industry row, the resolved media URLs
 * — arrives through `RenderContext`, which is the same injected-capability shape the rest of the
 * system uses and is what lets the whole package render in a plain Node test runner.
 *
 * Four things in here are security boundaries rather than style, and all four are enforced:
 *
 *  1. **Every model-authored string is escaped.** Section markup is `hono/jsx` (escapes by
 *     construction); the document shell is the single seam where escaping is explicit. There is no
 *     `innerHTML`, no `dangerouslySetInnerHTML`, no markdown parser and no rich-text run anywhere,
 *     and eslint fails the build on the first two.
 *  2. **No URL is built from model output.** `links.ts` resolves every `LinkRef` through the
 *     document's own routing table, a `CHECK`-constrained column, or the server-built allowlist.
 *  3. **JSON-LD is built by code** from D1 facts and typed enum inputs, and serialised through one
 *     function that escapes `<` as a JSON unicode escape.
 *  4. **Colour cannot leave the token layer.** Section CSS may read only the 17 `--t-*` names, and
 *     `assembleCss`'s lint fails the build otherwise — which is what makes the analytic contrast
 *     proof a statement about the rendered page rather than about `:root`.
 */

export * from './escape';
export * from './icons';
export * from './context';
export * from './links';
export * from './ui';

export * from './tokens/oklch';
export * from './tokens/dna';
export * from './tokens/resolve';
export * from './tokens/tones';
export * from './tokens/contract';

export * from './css/layers';
export * from './css/theme';
export * from './css/assemble';
export { BASE_CSS, LAYOUT_CSS, RESET_CSS, STATE_CSS } from './css/base.css';
export { COMPONENT_CSS } from './css/components/index';

export * from './seo/allowlist';
export * from './seo/hreflang';
export * from './seo/jsonld';

export * from './js/site';
export * from './project';
export * from './render';

export { renderSection, toneFor } from './sections/index';
export { SiteHeader } from './layout/header';
export { SiteFooter } from './layout/footer';
export { WhatsAppWidget } from './layout/whatsapp';
export { Hero } from './layout/hero';
export { SPECULATION_RULES, documentOpen, renderHead, skipLink } from './layout/document';
