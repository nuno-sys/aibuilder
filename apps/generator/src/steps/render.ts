import { NotImplementedInPhase1 } from '@aibuilder/core';
import type { Locale } from '@aibuilder/core';
import type { SiteDoc } from '@aibuilder/site-schema';

import type { Env } from '../env';
import type { RunIds } from '../ids';

/**
 * Step 9, `render` — SiteDoc to HTML, one document per (locale, page), including `/`.
 *
 * OUT OF SCOPE FOR THIS DELIVERY, and deliberately so (VERIFIED-FACTS.md, deliberate deviation 2).
 * It is not "not written yet": it CANNOT be written here. Rendering is
 * `@aibuilder/site-kit`'s job — `sections/*.tsx`, `layout/document.tsx`, `css/assemble.ts` and
 * `render.ts` — and that package deliberately depends on nothing but `@aibuilder/site-schema` so
 * that a tenant page renders in a plain test runner with no bindings and no `env` (§2). Putting a
 * renderer in the generator would invert that dependency and would mean the highest-exposure code
 * in the product — the one that turns attacker-influenced content into markup — lived in the Worker
 * that holds `ANTHROPIC_API_KEY`.
 *
 * WHY A THROWING FUNCTION AND NOT AN ABSENT ONE. The signature below is the real, final signature.
 * It compiles today, the Workflow calls it today, and the failure is loud, named and classified as
 * `not_implemented` by the retry ladder — instead of a step that quietly returns an empty page map
 * and a publish that ships a site with no HTML. A stub that returns a plausible value is the
 * failure mode this shape exists to prevent.
 *
 * What lands here when `site-kit` ships:
 *   - `renderPage(doc, locale, pageId) -> { html, renderSha256 }` for every page and every post.
 *   - The `/` document: a 200 serving the default locale's content, not a 308 (§7.2).
 *   - The CSS assembly pass, asserting the 11 KB inline budget before it is inlined.
 *   - `render_sha256` per page, which is what `content_changed_at` and therefore `lastmod` derive
 *     from — so a regeneration that changes nothing does not lie to a crawler about freshness.
 */

/** One materialised document, keyed by the R2 key it will be written to. */
export interface RenderedPage {
  readonly key: string;
  readonly locale: Locale;
  readonly pageId: string;
  readonly path: string;
  readonly bytes: number;
  /** Hex SHA-256 of the rendered bytes. The input to `content_changed_at`, never the deploy time. */
  readonly renderSha256: string;
}

/** What the render step will hand to `publish`. */
export interface RenderResult {
  readonly pages: readonly RenderedPage[];
  readonly cssBytes: number;
  readonly jsBytes: number;
}

/**
 * Materialises every page of a version.
 *
 * @throws NotImplementedInPhase1 always. The renderer is owned by `@aibuilder/site-kit`, which is
 * not part of this delivery; the signature is final so that the Workflow's call site, its step
 * timeout and its retry policy are all real and reviewed today.
 */
export function runRenderStep(
  _env: Env,
  _ids: RunIds,
  _input: { readonly doc: SiteDoc; readonly versionId: string },
): Promise<RenderResult> {
  throw new NotImplementedInPhase1(
    'render: @aibuilder/site-kit owns renderPage() and the CSS assembly pass',
  );
}
