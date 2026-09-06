import { SECTION_TYPES } from '@aibuilder/site-schema';
import type { SectionType } from '@aibuilder/site-schema';

/**
 * The cascade contract.
 *
 * Layer order is fixed by the **first** `@layer` statement in the document, so this one line is the
 * whole contract and it must be emitted before anything else:
 *
 *  | layer      | contents                                                   | why here |
 *  |------------|------------------------------------------------------------|----------|
 *  | `reset`    | box-sizing, margin zeroing, media defaults                  | lowest, so everything overrides it without specificity games |
 *  | `tokens`   | the `:root` theme block and the five `[data-tone]` blocks   | above reset so a tone can restate a reset colour |
 *  | `base`     | element defaults, links, focus ring, `.vh`, `.skip`, `.btn` | the "unstyled page still looks right" layer |
 *  | `layout`   | the nine layout primitives every section composes from      | shared, so 17 fragments do not each ship a grid |
 *  | `sections` | one fragment per section type, all rules prefixed `.s-…`    | the only layer that varies per page |
 *  | `chrome`   | header, footer, WhatsApp, cookie banner                     | always present, sized once |
 *  | `state`    | `[hidden]`, `[open]`, `@media print`                        | highest: state must beat everything without `!important` |
 *
 * The theme block goes **inside** `@layer tokens`, not unlayered. Unlayered rules beat every layer,
 * and the live editor writes its 0 ms preview as inline styles on `documentElement`, which beat
 * layers *and* unlayered rules. Keeping the published theme in a layer means preview and publish
 * differ by exactly one mechanism, which is easy to reason about and easy to flush on save.
 */
export const LAYER_STATEMENT = '@layer reset,tokens,base,layout,sections,chrome,state;';

/** Chrome fragments — always-present page furniture, keyed separately from section types. */
export const CHROME_KEYS = ['header', 'footer', 'whatsapp', 'cookie_banner'] as const;
export type ChromeKey = (typeof CHROME_KEYS)[number];

/** Every fragment `assembleCss` can be asked for. */
export type ComponentKey = SectionType | ChromeKey;

/**
 * The catalogue order fragments are emitted in.
 *
 * A fixed array rather than iteration over the used-set. `Set` iteration order is insertion order,
 * which is section order, which varies per page — and a page whose CSS is the same rules in a
 * different order is a different string, a different `render_sha256` and a spurious `lastmod` move.
 * Emitting in catalogue order makes the bundle a pure function of the *set*.
 */
export const COMPONENT_ORDER: readonly ComponentKey[] = [...SECTION_TYPES, ...CHROME_KEYS];
