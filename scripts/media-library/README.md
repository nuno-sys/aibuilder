# The pre-optimised media library

Curated footage and stills, transcoded once, selected at generation time as plain data.

## Why this exists

Searching a stock provider while a site is being generated is the obvious design and the wrong one.
It puts a third-party API on the critical path of the one operation the customer is watching, spends
a rate-limited quota per signup, returns whatever the search found that day, and still leaves a clip
that has to be transcoded — which is compute a Worker does not have.

Curating once removes all four. By the time someone clicks "maak mijn website", every clip has
already been encoded to every rendition it will be served in and measured for luminance and hue.
Selection is an array filter over bundled data: no network, no quota, no transcode, no failure mode.

The cost is that the library has to be filled deliberately. That is a feature — it is the only way
to guarantee a human has actually looked at every clip that ships.

## Filling it

Two ways in. The automatic one is the one to use.

### Automatically, from Pexels

Add a repository secret `PEXELS_KEY` (free and instant at <https://www.pexels.com/api/>), then run
the **Media library** workflow from the Actions tab. It fetches real footage, transcodes it,
measures it, uploads the binaries to R2, commits the index, and dispatches Deploy. Nothing to click
twice.

It has to run there rather than locally or in an agent sandbox because three things must happen in
one place: reach Pexels over the open internet, run `libaom-av1` for the better part of an hour, and
hold a couple of gigabytes of intermediates. A GitHub-hosted runner has all three.

The same fetch runs locally if you have the key:

```bash
PEXELS_KEY=... pnpm media:fetch                       # fill every empty slot
PEXELS_KEY=... pnpm media:fetch --groups=beauty       # just one group
PEXELS_KEY=... pnpm media:fetch --groups=beauty --force
```

The searches live in `QUERIES` in `fetch-footage.mjs` and are the one editorial decision in the
whole pipeline — everything downstream is measurement. Two queries per group, deliberately pulling
in opposite directions on light, because the coverage gate wants both moods and a single query
returns one. A group that cannot fill a slot after twelve downloads says so and fails the run: that
is a prompt to retune its query, not something to retry.

Clips are named `<luminance>-<pexels id>`, and the luminance in that name is **measured**, never
inferred from the query that found the clip. The id is there because library keys are served
`immutable` for a year: new footage gets new keys, so a refresh never overwrites bytes something is
still caching.

### By hand

```
scripts/media-library/sources/<group>/<name>.mp4     the clip
scripts/media-library/sources/<group>/<name>.json    { "description": "...", "credit": "..." }
```

`<group>` is one of the fourteen industry groups, or `brand` — the marketing site's own header,
which goes through the identical encoder so the sales page ships the same bytes the product does.

`luminance` and `hue` are **not** read from the
sidecar — they are measured off the pixels, because they are the two properties a human judges worst
and the renderer depends on most. Get luminance wrong and the copy is unreadable.

Then:

```bash
pnpm media:ingest       # transcode + measure + write .media-library/media-library.json
pnpm media:catalogue    # project that into packages/core/src/media-library/catalogue.generated.ts
pnpm media:marketing    # stage the `brand` clip into apps/marketing/public/media/hero/
pnpm media:upload       # put the binaries in R2 under library/<key>
```

`media:upload` refuses to overwrite a key that already exists. Library keys are not
content-addressed yet are served `immutable` for a year, so that promise is only honest while a
key's bytes never change: adding footage is free because new footage gets new names, and replacing
what a published key holds takes `--force` and a deliberate decision about the caches still holding
the old object. `--dry-run` lists what would be written.

`ingest` is incremental: anything already encoded is skipped unless you pass `--force`.
`--synthesize` writes abstract stand-in clips first, so the whole path can be exercised without
licensed footage.

## What ships where

|                                                          |                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/core/src/media-library/catalogue.generated.ts` | the index — committed, bundled into the Workers                           |
| `.media-library/out/**`                                  | the binaries — git-ignored, uploaded to R2 under `library/<key>`          |
| `apps/marketing/public/media/hero/**`                    | the `brand` clip's renditions — committed, so the sales page builds in CI |
| `apps/marketing/src/content/hero-media.generated.ts`     | their URLs, sizes and measured byte cost — committed                      |

Only the index travels in the bundle. It is a few dozen kilobytes of data that changes when someone
deliberately adds footage, which makes a KV read pure cost: a round trip and an error branch bought
nothing.

## Coverage

The ingest exits non-zero when any group cannot dress **both** a light and a dark site with at least
two clips. Most groups contain both — a nightclub and a wedding planner are both `events` — so
luminance is carried per clip and treated as a hard constraint at selection.

## Renditions

Per clip: AV1 + H.264, landscape 1920×1080 and portrait 720×1560. The portrait encode is the whole
reason background video can be affordable on a phone: roughly a quarter of the bytes, and it fills
the viewport instead of being letterboxed into it.

Per still, two ladders. Landscape: AVIF + WebP at 640 / 960 / 1280 / 1920 / 2560. Portrait, cropped
9:19.5 to match the portrait clip: 540 / 720 / 1080 / 1440. AVIF first because it is ~30% smaller at
the same quality; WebP always built because AVIF is not universal. No JPEG rung — the `<img>` src
points at the largest WebP, which every browser reaching this markup can decode.

The portrait ladder is not art direction for its own sake. LCP scores an image at
`min(visible area, intrinsic area)`, so cover-fitting a 16:9 still into a phone viewport picks a
rung _smaller_ than the hero is displayed at — the poster is scored down, the portrait video is
scored at the full box, and the video takes the LCP entry away from it.

9:19.5 rather than 9:16 is what turns that from a hope into a proof. A rung of width `w` is selected
when `viewport width × DPR` is about `w`, so at DPR 1 the box is `w` CSS px wide and as tall as the
device — up to 19.5/9 of its width on the tallest phones shipping. Cut at 9:16 the rung is _smaller_
than that box and the video, clamped to the same box, still scores strictly higher. Cut at 9:19.5 it
_is_ the box, so the video can at best tie, and a tie keeps the poster: the algorithm only replaces
a candidate with a strictly larger one.

## Serving

The catalogue names R2 keys; a tenant page addresses them as `/_a/l/<key>` on its own origin, parsed
back by `parseAssetPath` against a closed grammar and mapped to `library/<key>` in the media bucket.
Same-origin, so `img-src 'self'` in the tenant CSP stays true and no third origin appears on the LCP
path.
