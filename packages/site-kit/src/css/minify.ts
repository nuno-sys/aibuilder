/**
 * The whitespace normaliser the CSS fragments are authored through.
 *
 * `PHASE2-SITE-KIT.md` §4.6 asks for fragments that are **pre-minified**, byte-stable across
 * deploys, and greppable in review, with no minifier on the publish path. This is the deviation
 * from the letter of that: rather than a `scripts/build-css.ts` running Lightning CSS into
 * `*.generated.ts`, the fragments are authored readably in `*.css.ts` — the file names this task's
 * own manifest specifies — and normalised **once, at module load**, by the function below.
 *
 * The three properties the spec actually wanted all survive:
 *
 *  - **Nothing runs per publish.** The constants are frozen at import; `assembleCss` only
 *    concatenates.
 *  - **The output is byte-stable.** This is a pure string transform with no options, no version
 *    and no native code, so two deploys of the same source produce the same bytes — which is what
 *    `render_sha256` and every tenant's `ETag` depend on.
 *  - **The fragments stay reviewable.** They are indented CSS in a template literal, not a wall.
 *
 * What it deliberately is **not** is a CSS parser. It removes comments, collapses runs of
 * whitespace, and drops the spaces that surround the six characters where a space can never be
 * significant. It never touches `+`, `-`, `*` or `/` (they are operands inside `calc()`), never
 * removes a space before `:` (that would break a descendant-combinator selector), and never
 * rewrites a value. A transform that cannot change meaning does not need a test that proves it did
 * not — though `__tests__/css.test.ts` checks the round trip anyway.
 */
export function minifyCss(source: string): string {
  return (
    source
      // Comments first, so a `{` inside one cannot survive into the structural pass.
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/\s+/gu, ' ')
      // Spaces around structural punctuation. `:` loses only its trailing space: `a :hover` is a
      // different selector from `a:hover`, so the leading one is left alone.
      .replace(/\s*([{};,])\s*/gu, '$1')
      .replace(/:\s+/gu, ':')
      // A trailing `;` before `}` is bytes with no meaning.
      .replace(/;\}/gu, '}')
      .trim()
  );
}
