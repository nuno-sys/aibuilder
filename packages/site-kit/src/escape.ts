/**
 * The three escapes, and the reason there are exactly three.
 *
 * Architecture §4, invariant 1: no model string ever reaches the DOM except as a text node. Section
 * markup is `hono/jsx`, which escapes every text child and every attribute value on its own — so
 * inside `sections/` and `layout/` the invariant holds by construction and these functions are not
 * called. They exist for the one place JSX cannot reach: the document shell in `render.ts`, which is
 * assembled as a string because it has to emit `<!doctype html>`, an unescaped `<style>` body, an
 * unescaped `<script>` body and a JSON-LD block, none of which can be a JSX text child without being
 * corrupted.
 *
 * That is a deliberate, single, auditable seam rather than a general escape hatch:
 * `render.ts` is the only module that concatenates markup, everything it interpolates goes through
 * one of these three functions, and `__tests__/render.test.ts` feeds hostile copy through the whole
 * page to prove it.
 *
 * There is no `unescape`, no `raw()`, no `dangerouslySetInnerHTML` and no markdown parser anywhere
 * in this package, and eslint fails the build on the first two.
 */

/**
 * Escapes text for an HTML **text node**.
 *
 * `&`, `<` and `>` are the complete set for text content; the quotes are escaped anyway so that a
 * single function is safe in both positions and a call site can never pick the wrong one.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

/**
 * Escapes text for a double-quoted HTML **attribute value**.
 *
 * Identical output to `escapeHtml` today. It is a separate name because the two obligations are
 * genuinely different — an attribute must not be able to close its own quote, a text node must not
 * be able to open a tag — and a future change to one must not silently change the other.
 */
export function escapeAttr(value: string): string {
  return escapeHtml(value);
}

/**
 * Serialises a value for the raw text of a `<script type="application/ld+json">` element.
 *
 * HTML-escaping would corrupt the JSON, so this escapes at the JSON layer instead:
 *
 *  - `<` becomes `<`, which is legal JSON and identical after `JSON.parse`, so no string in
 *    the graph — a business name, a cuisine, a review body — can close the `<script>` it sits in.
 *  - U+2028 / U+2029 are legal inside a JSON string but are literal line terminators in JavaScript
 *    source, and a script parser sees the element's raw text rather than the parsed JSON.
 *
 * That is the correct and sufficient escape, and it is the only one.
 */
export function escapeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003c')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');
}
