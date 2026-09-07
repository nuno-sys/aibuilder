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

```
scripts/media-library/sources/<group>/<name>.mp4     the clip
scripts/media-library/sources/<group>/<name>.json    { "description": "...", "credit": "..." }
```

`<group>` is one of the fourteen industry groups. `luminance` and `hue` are **not** read from the
sidecar — they are measured off the pixels, because they are the two properties a human judges worst
and the renderer depends on most. Get luminance wrong and the copy is unreadable.

Then:

```bash
pnpm media:ingest       # transcode + measure + write .media-library/media-library.json
pnpm media:catalogue    # project that into packages/core/src/media-library/catalogue.generated.ts
```

`ingest` is incremental: anything already encoded is skipped unless you pass `--force`.
`--synthesize` writes abstract stand-in clips first, so the whole path can be exercised without
licensed footage.

## What ships where

|                                                          |                                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/core/src/media-library/catalogue.generated.ts` | the index — committed, bundled into the Workers                              |
| `.media-library/out/**`                                  | the binaries — git-ignored, uploaded to R2 under exactly the manifest's keys |

Only the index travels in the bundle. It is a few dozen kilobytes of data that changes when someone
deliberately adds footage, which makes a KV read pure cost: a round trip and an error branch bought
nothing.

## Coverage

The ingest exits non-zero when any group cannot dress **both** a light and a dark site with at least
two clips. Most groups contain both — a nightclub and a wedding planner are both `events` — so
luminance is carried per clip and treated as a hard constraint at selection.

## Renditions

Per clip: AV1 + H.264, landscape 1920×1080 and portrait 720×1280. The portrait encode is the whole
reason background video can be affordable on a phone: roughly a quarter of the bytes, and it fills
the viewport instead of being letterboxed into it.

Per still: AVIF + WebP at 640 / 960 / 1280 / 1920 / 2560. AVIF first because it is ~30% smaller at
the same quality; WebP always built because AVIF is not universal. No JPEG rung — the `<img>` src
points at the largest WebP, which every browser reaching this markup can decode.
