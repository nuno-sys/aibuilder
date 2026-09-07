# Developer preview harness

Four realistic demo tenant sites, one per Phase 1 design DNA, rendered with the real
`renderPage()` from `@aibuilder/site-kit` and screenshotted. It exists because everything in this
repository is code and tests: the only `SiteDoc` that ships is `hostileDoc()`, whose every string
is `<script>alert(1)</script>` because its job is to prove the escaping. You cannot judge a colour
ramp through it.

Nothing here is imported by the product. The harness owns `scripts/preview/**` and writes to
`.preview/`, which is git-ignored.

## Hero footage

The demos play clips from the pre-optimised media library (`scripts/media-library/`), chosen by the
same selector the builder uses — not by anything this harness decides. Run `pnpm media:ingest`
first, or the header falls back to a full-screen poster, which is exactly what production does when
the library cannot dress a combination.

## Run it

```bash
cd scripts/preview && npm install && cd -   # once: playwright + the four font families
pnpm preview                                 # render, then screenshot
pnpm preview:serve                           # browse them at http://localhost:4321
```

`pnpm preview` is a thin alias for `node scripts/preview/run.mjs all`; the sub-commands
(`render`, `shoot`, `media`, `serve`) are still available directly.

`npm install` inside `scripts/preview` is deliberate. Playwright is not a dependency of this
repository and the root `package.json` is not this harness's to edit, so the harness carries its
own `package.json` and installs into `scripts/preview/node_modules`. The directory is **not** a
pnpm workspace member (`pnpm-workspace.yaml` globs `apps/*` and `packages/*`), so `pnpm install` at
the root neither sees it nor is affected by it. Set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` if your
environment already provides Chromium — this harness never runs `playwright install` and points
`executablePath` at the browser it was told to use (override with `PREVIEW_CHROMIUM`).

Individual steps:

| command                               | what it does                                                            |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `node scripts/preview/run.mjs render` | writes the placeholder media, the fonts and every page into `.preview/` |
| `node scripts/preview/run.mjs serve`  | serves it, one port per demo site (index on `:4321`, `--port=` to move) |
| `node scripts/preview/run.mjs shoot`  | screenshots every page at 1440×1100 @2x and 390×844 @3x                 |
| `node scripts/preview/run.mjs media`  | regenerates only the imagery                                            |
| `node scripts/preview/run.mjs all`    | `render`, then `shoot`                                                  |

There is no `tsx` in this repository (`node_modules/.bin` has esbuild, tsc, vitest and wrangler),
so `run.mjs` bundles each entry point with the repo's own esbuild into `scripts/preview/dist/` and
imports the bundle. `dist/` is chosen because the root `.gitignore` and the root eslint config
already ignore that name everywhere.

Type-check and lint the harness with the repository's own settings:

```bash
node_modules/.bin/tsc --noEmit -p scripts/preview
node_modules/.bin/eslint scripts/preview
node_modules/.bin/prettier --write scripts/preview
```

## What is in it

| file            |                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `demo-sites.ts` | four `SiteDoc`s: a nightclub, an Italian restaurant, a dental practice and a car garage, with real Dutch copy. All 17 section types and 41 of the 51 layout variants appear across the set. |
| `media.ts`      | the placeholder imagery, synthesised as SVG from each archetype's own resolved tokens, plus the favicons as hand-encoded PNG, plus the four woff2 families.                                 |
| `render.ts`     | the composition root: builds a `RenderContext`, lints each document, calls `renderPage`, writes `.preview/<site>/<locale>/…/index.html`.                                                    |
| `serve.ts`      | a static server over the output, one port per site, answering the media and font paths from `media.ts`.                                                                                     |
| `shoot.ts`      | Playwright screenshots, plus a PNG decoder that measures every capture for blankness.                                                                                                       |

Every demo business is fictional — the names, addresses, postcodes, phone numbers, VAT and KvK
numbers, the `.example` e-mail hosts (reserved by RFC 2606) and the reviews. The review cards say
in their own text that they are placeholders, because a fabricated testimonial is a per-se unfair
commercial practice under UCPD Annex I 23b/23c. Every image is generated and carries a visible
`PLACEHOLDER` label.

The `industryKey` of each demo is a real key from `packages/core/src/industries.ts`, and
`render.ts` asserts that the row's `dnaId` is the archetype the demo claims, so a demo cannot
quietly show the wrong design for its trade.

## What this proves, and what it does not

It proves **layout, colour, type and component markup**: these are the bytes `renderPage()` emits
for these documents, with the real theme resolver, the real CSS assembler, the real JSON-LD builder
and the real four font families, checked by `lintSiteDoc()` before rendering and by a broken-image
audit after. What you see is what the publish pipeline would write for the same document.

It does **not** prove Lighthouse, and no number from it should be quoted as a performance result.
The real media pipeline is not in the loop — there are no AVIF/WebP ladders, no art-directed
renditions and no hero video, only single-rendition SVG placeholders — and neither is the edge
cache, the compression, the immutable asset headers or the HTTP/3 connection a visitor actually
gets. The screenshots are also taken with one declaration injected (`content-visibility: visible`
on off-screen sections, with the containment it implies restored by hand), because Chromium's
full-page capture otherwise hands back empty coloured bands where the deferred sections should be.
That injection changes what the _camera_ sees, not what a visitor sees, and it is applied after the
page has been scrolled end to end.

Known gaps, all deliberate: one locale (`nl`) per demo, so the hreflang cluster and the footer's
language switcher are single-entry; no hero video, so `video_fullbleed` renders as poster + scrim;
blog-teaser links resolve to a 404 page that explains itself, because a blog post is not a
`PageDoc` and this harness renders `doc.pages` only.
