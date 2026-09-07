import {
  MEDIA_LIBRARY,
  classifyLuminance,
  industryByKey,
  mediaOriginalKey,
  selectGrounds,
  selectHeroVideo,
} from '@aibuilder/core';
import type { MediaGroupKey } from '@aibuilder/core';
import type { IndustryGroupKey, Intake } from '@aibuilder/core';
import { shard, shardById } from '@aibuilder/db';
import type { MediaAssetId, MediaAssetRow } from '@aibuilder/db';
import type { MediaCandidate } from '@aibuilder/ai';
import { HeroVideoSchema, LuminanceClassSchema } from '@aibuilder/site-schema';
import type { HeroVideo, LuminanceClass } from '@aibuilder/site-schema';
import { DNA } from '@aibuilder/site-kit';
import { z } from 'zod';

import { putArtifact, runArtifactKey } from '../artifacts';
import type { ArtifactRef } from '../artifacts';
import type { Env } from '../env';
import { readOptionalSecret } from '../env';
import type { RunIds } from '../ids';

/**
 * Step 2, `resolve-media` — what the model is allowed to put on the page.
 *
 * THE MODEL NEVER NAMES AN ASSET. It addresses media by `refId` out of a manifest this step builds,
 * and a `refId` that is not in the manifest is deleted by `normalize()` before anything renders.
 * That is invariant 2 of §4 and it is why this step runs BEFORE `plan-brief`: a structure planned
 * against imagery that does not exist is a structure that has to be repaired at Opus prices.
 *
 * THREE SOURCES, IN ORDER OF PREFERENCE:
 *
 *   1. The customer's own uploads, verified and re-encoded by the queue consumer in
 *      `src/queue/media-consumer.ts`. Only `ready` rows count — an upload still in `verifying` has
 *      not been proven to be an image yet, and putting it in the manifest would mean planning a
 *      hero around a file that might turn out to be a polyglot.
 *
 *   2. A curated per-industry stock pool. "Curated" here means a hand-written, vetted English query
 *      per industry group — NOT a list of photo ids, which would rot the first time a photographer
 *      deleted an upload and would silently degrade to no imagery at all. The query is composed
 *      with the industry and hashed, and the hash is the KV cache key: Pexels' default allowance is
 *      200 requests/hour and 20,000/month (§S3), which without a cache throttles signup throughput
 *      to 20-30 sites an hour. The cache is what makes the 301st bakery of the month free.
 *
 *   3. Nothing. An empty manifest is a legitimate outcome, not a failure: the structure task turn
 *      tells the model to choose section variants that do not depend on imagery when the manifest
 *      is empty. A stock provider being down must never fail a paid generation.
 *
 * RE-HOSTING IS NOT OPTIONAL. A stock URL is a third-party dependency on the critical rendering
 * path of a customer's business site, with a third party's uptime, a third party's cookies and a
 * third party's ability to change what the image shows. The bytes are copied into the EU media
 * bucket under a content-addressed key, so 300 pizzerias that pick the same photo store one object.
 *
 * PHASE 1 ACCEPTS NO USER VIDEO AT ALL (§0). There is no build compute in this stack — ffmpeg
 * cannot run in a Worker — so a hero video comes exclusively from a pre-vetted pool we re-host, and
 * this step therefore only ever produces `kind: 'image'`.
 */

/* -- The curated pool ------------------------------------------------------------------------ */

/**
 * The vetted stock queries, one set per industry group.
 *
 * English, because Pexels' index is English and a Dutch query returns a fraction of the results.
 * Each one is written to describe a SCENE rather than a product — "baker shaping dough on a wooden
 * counter" and not "bread" — because a scene photographs like a real business and a product shot
 * photographs like a catalogue, and the difference is the whole visual argument of the generated
 * site. Two to four entries per group, so two businesses in the same trade do not get the same
 * hero.
 */
export const CURATED_STOCK_QUERIES: Readonly<Record<IndustryGroupKey, readonly string[]>> = {
  food_drink: [
    'warm restaurant interior with people eating',
    'chef plating food in a professional kitchen',
    'barista pouring coffee at a counter',
    'baker shaping dough on a wooden counter',
  ],
  beauty: [
    'bright hair salon interior with styling chairs',
    'hairdresser working with a client',
    'calm spa treatment room with soft light',
    'manicure at a clean nail studio table',
  ],
  health: [
    'modern medical practice waiting room',
    'physiotherapist working with a patient',
    'dental practice treatment room daylight',
    'friendly doctor talking with a patient',
  ],
  sport: [
    'people training in a bright gym',
    'yoga studio with natural light',
    'personal trainer coaching one client',
    'indoor sports hall with wooden floor',
  ],
  trades: [
    'craftsman working on a building site',
    'plumber installing pipework in a home',
    'electrician working on a wall socket',
    'carpenter measuring wood in a workshop',
  ],
  automotive: [
    'clean car repair workshop interior',
    'mechanic working under a car on a lift',
    'bicycle repair workshop with tools',
    'car detailing with polishing machine',
  ],
  retail: [
    'small independent shop interior',
    'shopkeeper arranging a window display',
    'boutique store with wooden shelves',
    'flower shop counter with bouquets',
  ],
  professional: [
    'bright modern office meeting room',
    'two people talking across a desk',
    'accountant working with documents',
    'architect studio with drawings on a table',
  ],
  events: [
    'wedding reception table setting',
    'live band performing at a small venue',
    'photographer working at an event',
    'catering table with prepared food',
  ],
  education: [
    'small classroom with students working',
    'music lesson with a teacher and student',
    'driving instructor and learner in a car',
    'language course around a table',
  ],
  real_estate: [
    'estate agent showing a house to a couple',
    'bright empty living room with wooden floor',
    'dutch canal houses street view',
    'keys handed over in a new apartment',
  ],
  travel: [
    'small hotel reception desk',
    'bed and breakfast bedroom with morning light',
    'campsite with tents at golden hour',
    'travel agent helping a customer',
  ],
  pets: [
    'veterinarian examining a dog',
    'dog groomer washing a dog',
    'pet shop interior with supplies',
    'dog walker with dogs in a park',
  ],
  crafts: [
    'ceramics workshop with a potter at the wheel',
    'artist painting in a bright studio',
    'goldsmith working at a bench',
    'upholstery workshop with fabric rolls',
  ],
};

/** Largest number of stock photos one generation will re-host. */
const MAX_STOCK_PHOTOS = 3;

/** Width the re-hosted original is requested at. Feeds the 1600 rung of the derivative ladder. */
const STOCK_WIDTH = 1600;

/** Refuse anything larger. A hero photo is under 2 MB; 8 MB is a provider misbehaving. */
const MAX_STOCK_BYTES = 8 * 1024 * 1024;

/** Search results live a week. The query set is fixed, so a longer TTL is strictly cheaper. */
const QUERY_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** A resolved object survives a year: it is content-addressed, so it can never go stale. */
const OBJECT_CACHE_TTL_SECONDS = 365 * 24 * 60 * 60;

/** Pexels is given four seconds. Beyond that the image-free layout is the better product. */
const PEXELS_TIMEOUT_MS = 4_000;

/* -- The artefact ---------------------------------------------------------------------------- */

/** One entry the assemble step resolves a `refId` against. Mirrors `MediaAssetSchema`. */
export const ResolvedMediaSchema = z.object({
  refId: z.string().min(1).max(64),
  r2Key: z.string().min(1).max(512),
  mimeType: z.string().min(3).max(80),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  blurhash: z.string().max(120).nullable(),
  dominantColor: z.string().max(32).nullable(),
  /**
   * Measured from the decoded pixels by this step, never asked of the model.
   *
   * It decides which scrim goes over the image and which theme may use it at all. A model looking
   * at a thumbnail can tell you a scene is "moody"; only the pixels tell you whether white text
   * will survive on it.
   */
  luminance: LuminanceClassSchema.nullable(),
  /** The responsive ladder for library assets; `null` for a single-file upload. */
  renditions: z
    .object({
      avifKeyTemplate: z.string().min(1).max(512),
      webpKeyTemplate: z.string().min(1).max(512),
      widths: z.array(z.number().int().positive()).min(1).max(8),
    })
    .nullable(),
  altText: z.string().max(300).nullable(),
  credit: z.string().max(200).nullable(),
});

/** The media manifest, as stored in R2 between steps. */
export const MediaManifestSchema = z.object({
  /** What the model sees: descriptions and orientations, never keys or URLs. */
  candidates: z.array(
    z.object({
      refId: z.string(),
      kind: z.enum(['image', 'video']),
      description: z.string(),
      orientation: z.enum(['landscape', 'portrait', 'square']),
      source: z.enum(['upload', 'stock']),
    }),
  ),
  /** What `genToDoc()` resolves refs against. Keyed by `refId`. */
  assets: z.record(z.string(), ResolvedMediaSchema),
  /**
   * The hero's motion layer, or `null` when nothing relevant enough was found.
   *
   * `null` is a complete outcome, not a hole: the hero poster is an ordinary entry in `assets` and
   * is always present, so the header is a full-screen relevant still either way.
   */
  heroVideo: HeroVideoSchema.nullable(),
  /** Photographic footer ground, luminance-matched to the theme, or `null` for the token ground. */
  footerMediaRefId: z.string().min(1).max(64).nullable(),
  /** Photographic grounds behind ordinary sections, keyed by section id. */
  sectionBackgrounds: z.record(z.string(), z.string().min(1).max(64)),
});

/** The media manifest. */
export type MediaManifest = z.infer<typeof MediaManifestSchema>;

/** What the media step hands to the rest of the run. */
export interface MediaResult {
  readonly manifest: ArtifactRef;
  readonly uploadCount: number;
  readonly stockCount: number;
}

/* -- Helpers --------------------------------------------------------------------------------- */

/** Lowercase hex SHA-256 of a UTF-8 string. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Lowercase hex SHA-256 of raw bytes. The content address a re-hosted object is stored under. */
async function sha256HexBytes(input: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Crockford base32, as ULIDs use it.
 *
 * `I`, `L`, `O` and `U` are absent, which is exactly the set the `media_assets.id` CHECK excludes —
 * so an id built from this alphabet satisfies the column by construction.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Derives a stable media id for one re-hosted stock photo.
 *
 * A fresh ULID would make this step non-idempotent in the one way that leaves rubbish behind: a
 * retried `media` step would insert a SECOND `media_assets` row for the same photo, and the first
 * would be an orphan nothing references. Deriving the id from the run and the photo instead means a
 * retry's insert collides with the row it already wrote — which the caller treats as success,
 * because the row it needed exists.
 *
 * Guarantees a value the column's CHECK accepts: 30 characters, `med_` prefix, a Crockford-base32
 * body whose first character is `0`-`7` (the ULID timestamp-high constraint).
 */
async function stockMediaId(jobId: string, photoId: number): Promise<MediaAssetId> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${jobId}:pexels:${photoId}`)),
  );
  let bits = 0;
  let value = 0;
  let body = '';
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      body += CROCKFORD[(value >>> bits) & 31] ?? '0';
    }
    if (body.length >= 26) break;
  }
  // The first character of a ULID encodes the top bits of a 48-bit timestamp and is therefore
  // always `0`-`7`; the CHECK enforces it.
  const head = CROCKFORD[(body.charCodeAt(0) + digest.length) % 8] ?? '0';
  return `med_${head}${body.slice(1, 26)}` as MediaAssetId;
}

/** FNV-1a over a string. Not cryptographic and does not need to be: it only spreads a choice. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/** Classifies an aspect ratio the way the section catalogue's variants think about it. */
function orientationOf(width: number, height: number): 'landscape' | 'portrait' | 'square' {
  const ratio = width / height;
  if (ratio > 1.15) return 'landscape';
  if (ratio < 0.87) return 'portrait';
  return 'square';
}

/**
 * Composes the stock query for one site.
 *
 * Deterministic in the site id, so a retried step picks the same query and re-hosts the same photo
 * rather than quietly changing the customer's hero between attempts. The city is deliberately NOT
 * part of the query: "hair salon Utrecht" returns tourism photography of Utrecht, and a generic
 * European interior beats a wrong-but-local one.
 */
export function composeStockQuery(args: {
  readonly industryKey: string;
  readonly siteId: string;
}): string {
  const industry = industryByKey(args.industryKey);
  const group: IndustryGroupKey = industry?.groupKey ?? 'professional';
  const pool = CURATED_STOCK_QUERIES[group];
  const first = pool[fnv1a(args.siteId) % pool.length];
  // `pool` is a non-empty literal for every group, so the modulus always lands on an entry; the
  // fallback exists because `noUncheckedIndexedAccess` cannot know that.
  return first ?? 'small european business interior';
}

/* -- Pexels ---------------------------------------------------------------------------------- */

/** The fields of a Pexels photo this step reads. Everything else is ignored. */
const PexelsPhotoSchema = z.object({
  id: z.number(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  alt: z.string().nullable().optional(),
  photographer: z.string().optional(),
  /**
   * Pexels' own average colour for the photo, e.g. `#3A2E24`.
   *
   * The only luminance signal available here: a Worker cannot decode a JPEG, and the Images binding
   * runs later in the queue consumer. Optional because it is absent on some older library entries,
   * and an absent value classifies as `null` rather than as a guess.
   */
  avg_color: z.string().nullable().optional(),
  src: z.object({ original: z.string() }),
});

const PexelsSearchSchema = z.object({ photos: z.array(PexelsPhotoSchema) });

/** The trimmed result cached in KV, so a cache hit does not depend on Pexels' response shape. */
const CachedPhotoSchema = z.object({
  id: z.number(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  alt: z.string(),
  credit: z.string(),
  avgColor: z.string().nullable(),
  original: z.string().url(),
});
type CachedPhoto = z.infer<typeof CachedPhotoSchema>;
const CachedSearchSchema = z.array(CachedPhotoSchema);

/**
 * The URL a re-hosted original is fetched from.
 *
 * `src.original` carries no query string, and Pexels' documented resize parameters preserve the
 * aspect ratio when only a width is given — which is what keeps the stored intrinsic dimensions
 * true, and intrinsic dimensions are what stop the hero from causing a layout shift (§7).
 */
function stockSourceUrl(original: string, width: number): string {
  return `${original}?auto=compress&cs=tinysrgb&w=${String(width)}`;
}

/**
 * Searches the stock provider, through the KV cache.
 *
 * Guarantees an empty array rather than a throw on every failure path — no key, a non-200, a
 * timeout, a response that does not parse. The degradation path for stock imagery is an image-free
 * layout, never a failed generation.
 */
export async function searchStock(env: Env, query: string): Promise<readonly CachedPhoto[]> {
  const cacheKey = `stock:q:${await sha256Hex(query)}`;
  const cached = await env.STOCK_CACHE.get(cacheKey, 'json').catch(() => null);
  if (cached !== null) {
    const parsed = CachedSearchSchema.safeParse(cached);
    if (parsed.success) return parsed.data;
  }

  const key = await readOptionalSecret(env.PEXELS_KEY);
  if (key === null) return [];

  // Every path out of the try either returns or assigns, so there is no initialiser to give.
  let photos: readonly CachedPhoto[];
  try {
    const url = new URL('https://api.pexels.com/v1/search');
    url.searchParams.set('query', query);
    url.searchParams.set('orientation', 'landscape');
    url.searchParams.set('per_page', String(MAX_STOCK_PHOTOS * 2));
    const response = await fetch(url, {
      headers: { authorization: key },
      signal: AbortSignal.timeout(PEXELS_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const parsed = PexelsSearchSchema.safeParse(await response.json());
    if (!parsed.success) return [];
    photos = parsed.data.photos.map((photo) => ({
      id: photo.id,
      width: photo.width,
      height: photo.height,
      alt: (photo.alt ?? '').slice(0, 280),
      credit: photo.photographer === undefined ? 'Pexels' : `${photo.photographer} / Pexels`,
      avgColor: photo.avg_color ?? null,
      original: photo.src.original,
    }));
  } catch {
    return [];
  }

  // Written after the fact and never awaited on the failure path: a cache that cannot be written is
  // a slower next signup, not a failed one.
  await env.STOCK_CACHE.put(cacheKey, JSON.stringify(photos), {
    expirationTtl: QUERY_CACHE_TTL_SECONDS,
  }).catch(() => undefined);
  return photos;
}

/** What re-hosting one photo produced. */
interface RehostedPhoto {
  readonly sha256: string;
  readonly r2Key: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Copies one stock photo into the EU media bucket, content-addressed.
 *
 * Guarantees the object is stored under `orig/{sha256}` so identical photos deduplicate across
 * tenants, that an object already present is not downloaded twice, and that `null` is returned
 * rather than thrown on any failure.
 */
async function rehostPhoto(env: Env, photo: CachedPhoto): Promise<RehostedPhoto | null> {
  const cacheKey = `stock:obj:${String(photo.id)}:${String(STOCK_WIDTH)}`;
  const cached = await env.STOCK_CACHE.get(cacheKey, 'json').catch(() => null);
  if (cached !== null && typeof cached === 'object') {
    const record = cached as Partial<RehostedPhoto>;
    if (
      typeof record.sha256 === 'string' &&
      typeof record.r2Key === 'string' &&
      typeof record.mimeType === 'string' &&
      typeof record.bytes === 'number' &&
      typeof record.width === 'number' &&
      typeof record.height === 'number'
    ) {
      return record as RehostedPhoto;
    }
  }

  let body: ArrayBuffer;
  let mimeType: string;
  try {
    const response = await fetch(stockSourceUrl(photo.original, STOCK_WIDTH), {
      signal: AbortSignal.timeout(PEXELS_TIMEOUT_MS * 3),
    });
    if (!response.ok) return null;
    mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? 'image/jpeg';
    if (!mimeType.startsWith('image/')) return null;
    body = await response.arrayBuffer();
  } catch {
    return null;
  }
  if (body.byteLength === 0 || body.byteLength > MAX_STOCK_BYTES) return null;

  const sha256 = await sha256HexBytes(body);
  const r2Key = mediaOriginalKey(sha256);
  // Content-addressed: an object that exists is byte-identical, so re-uploading it would spend a
  // write to produce the same bytes.
  const existing = await env.MEDIA.head(r2Key);
  if (existing === null) {
    await env.MEDIA.put(r2Key, body, { httpMetadata: { contentType: mimeType } });
  }

  const width = Math.min(STOCK_WIDTH, photo.width);
  const resolved: RehostedPhoto = {
    sha256,
    r2Key,
    mimeType,
    bytes: body.byteLength,
    width,
    height: Math.max(1, Math.round((photo.height / photo.width) * width)),
  };
  await env.STOCK_CACHE.put(cacheKey, JSON.stringify(resolved), {
    expirationTtl: OBJECT_CACHE_TTL_SECONDS,
  }).catch(() => undefined);
  return resolved;
}

/* -- The step -------------------------------------------------------------------------------- */

/** Turns a verified upload row into a manifest pair. `null` when the row is not usable as media. */
function fromUpload(row: MediaAssetRow): {
  readonly candidate: MediaCandidate;
  readonly asset: z.infer<typeof ResolvedMediaSchema>;
} | null {
  if (row.status !== 'ready' || row.kind !== 'image') return null;
  if (row.width === null || row.height === null) return null;

  const description =
    row.alt_text ?? (row.role === 'logo' ? 'the business logo' : 'a photo supplied by the owner');
  return {
    candidate: {
      refId: row.id,
      kind: 'image',
      description,
      orientation: orientationOf(row.width, row.height),
      source: 'upload',
    },
    asset: {
      refId: row.id,
      r2Key: row.r2_key,
      mimeType: row.mime_type,
      width: row.width,
      height: row.height,
      blurhash: row.blurhash,
      dominantColor: row.dominant_color,
      luminance: classifyLuminance(row.dominant_color),
      // Phase 3: the queue consumer's derivatives become a ladder here.
      renditions: null,
      altText: row.alt_text,
      credit: row.attribution,
    },
  };
}

/**
 * Resolves every image this run may use and stores the manifest.
 *
 * Guarantees: only `ready` uploads are offered to the model; stock is fetched only when the
 * customer supplied none; every stock photo is re-hosted in the EU media bucket before it appears
 * in the manifest; and a total stock outage produces an EMPTY manifest rather than an error, which
 * the structure task turn is written to handle.
 *
 * Idempotent: re-running re-reads the same rows, resolves the same deterministic query, hits the
 * content address for an already-stored object, derives the same `media_assets` id, and overwrites
 * the same artefact. A retry therefore leaves no orphaned rows and no duplicate objects behind.
 */
export async function runMediaStep(env: Env, ids: RunIds, intake: Intake): Promise<MediaResult> {
  const db = shardById(ids.shardId, env);
  const uploads = await shard.media.listMediaForDraft(db, ids.draftId);

  const candidates: MediaCandidate[] = [];
  const assets: Record<string, z.infer<typeof ResolvedMediaSchema>> = {};

  for (const row of uploads) {
    const resolved = fromUpload(row);
    if (resolved === null) continue;
    candidates.push(resolved.candidate);
    assets[resolved.asset.refId] = resolved.asset;
  }
  const uploadCount = candidates.length;

  let stockCount = 0;
  if (uploadCount === 0) {
    const query = composeStockQuery({ industryKey: intake.industryKey, siteId: ids.siteId });
    const photos = await searchStock(env, query);
    const now = Date.now();

    for (const photo of photos.slice(0, MAX_STOCK_PHOTOS)) {
      const rehosted = await rehostPhoto(env, photo);
      if (rehosted === null) continue;

      const mediaId = await stockMediaId(ids.jobId, photo.id);
      try {
        await shard.media.insertMediaAsset(db, {
          id: mediaId,
          draftId: null,
          siteId: ids.siteId,
          orgId: ids.orgId,
          r2Bucket: env.R2_MEDIA_BUCKET,
          r2Key: rehosted.r2Key,
          kind: 'image',
          source: 'pexels',
          mimeType: rehosted.mimeType,
          bytes: rehosted.bytes,
          width: rehosted.width,
          height: rehosted.height,
          role: stockCount === 0 ? 'hero_image' : 'gallery',
          createdBy: null,
          now,
        });
        // The three-statement walk is the schema's, not a preference: `insertMediaAsset` opens the
        // row at `pending`, `commitMediaAsset` records a digest and moves it to `verifying`, and
        // only `promoteMediaAsset` may write `ready`. Stock bytes come from a vetted provider and
        // are hashed here, so the "verification" this row records is a re-host rather than a scan —
        // but it still walks the same states, because a status a sweep does not recognise is a row
        // that gets swept.
        await shard.media.commitMediaAsset(db, {
          mediaId,
          sha256: hexToBytes(rehosted.sha256),
          now,
        });
        await shard.media.promoteMediaAsset(db, {
          mediaId,
          r2Bucket: env.R2_MEDIA_BUCKET,
          r2Key: rehosted.r2Key,
          sha256: hexToBytes(rehosted.sha256),
          mimeType: rehosted.mimeType,
          bytes: rehosted.bytes,
          width: rehosted.width,
          height: rehosted.height,
          blurhash: null,
          dominantColor: null,
          variants: null,
          durationMs: null,
          now,
        });
      } catch {
        // A ledger row that cannot be written must not cost the customer their hero image: the
        // object is already in the bucket and the manifest can still reference it. The row is
        // reconciled by the media sweep, which lists assets stuck before `ready`.
      }

      candidates.push({
        refId: mediaId,
        kind: 'image',
        description: photo.alt.length > 0 ? photo.alt : `stock photography: ${query}`,
        orientation: orientationOf(rehosted.width, rehosted.height),
        source: 'stock',
      });
      assets[mediaId] = {
        refId: mediaId,
        r2Key: rehosted.r2Key,
        mimeType: rehosted.mimeType,
        width: rehosted.width,
        height: rehosted.height,
        blurhash: null,
        dominantColor: photo.avgColor,
        luminance: classifyLuminance(photo.avgColor),
        renditions: null,
        altText: photo.alt.length > 0 ? photo.alt : null,
        credit: photo.credit,
      };
      stockCount += 1;
    }
  }

  // The theme is not resolved yet — `structure` runs after this step — but the DNA is, because it
  // is a property of the INDUSTRY and the industry came in on the intake. That is enough to pick a
  // footer ground whose luminance will match the site that gets built on top of it.
  const expectedMode = expectedColorMode(intake);
  // Library grounds enter the SAME asset map as uploads and stock: one resolution path, one place
  // a dangling ref can be caught, and the editor sees them as ordinary media it can swap out.
  for (const ground of selectLibraryGrounds(intake, ids.siteId, LIBRARY_GROUND_COUNT)) {
    assets[ground.refId] = ground.asset;
    candidates.push(ground.candidate);
  }
  const footerMediaRefId = pickFooterGround(assets, expectedMode);

  const manifest: MediaManifest = {
    candidates,
    assets,
    // Selected from the pre-built library, not searched for. Every clip in it was transcoded and
    // measured at ingest, so this is an array filter against bundled data: no network call, no
    // quota, no transcode, and no failure mode on the path the customer is watching.
    heroVideo: selectLibraryHero(intake, ids.siteId),
    footerMediaRefId,
    // Section ids do not exist yet: they are minted by the structure step. `assemble` assigns
    // backgrounds once it has both the manifest and the page tree.
    sectionBackgrounds: {},
  };
  const ref = await putArtifact(env.BLOBS, runArtifactKey(ids.jobId, 'media'), manifest);
  return { manifest: ref, uploadCount, stockCount };
}

/** Decodes a lowercase hex digest into the bytes the `sha256` BLOB column stores. */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/* -- Luminance-matched grounds ---------------------------------------------------------------- */

/**
 * The colour mode this site will almost certainly be built in.
 *
 * Derived from the industry's design DNA rather than from the theme, because the media step runs
 * BEFORE the structure step and there is no theme yet. The model may still shift the mode; a
 * background whose luminance then disagrees is dropped at assembly rather than rendered wrong.
 */
export function expectedColorMode(intake: Intake): 'light' | 'dark' {
  const industry = industryByKey(intake.industryKey);
  if (industry === undefined || industry === null) return 'light';
  return DNA[industry.dnaId].canonicalMode;
}

/**
 * Picks a footer ground: landscape, and luminance-matched to the site being built.
 *
 * Returns `null` freely. A footer over its token ground is a finished design, and forcing a
 * mismatched photo behind one is how footers become unreadable.
 */
export function pickFooterGround(
  assets: Readonly<
    Record<
      string,
      { readonly width: number; readonly height: number; readonly luminance: LuminanceClass | null }
    >
  >,
  mode: 'light' | 'dark',
): string | null {
  for (const [refId, asset] of Object.entries(assets)) {
    if (asset.width <= asset.height) continue;
    if (asset.luminance === mode) return refId;
  }
  return null;
}

/**
 * Picks the hero clip out of the pre-built library.
 *
 * Luminance is a hard constraint and the accent hue is a preference — see
 * `packages/core/src/media-library/select.ts`. Seeded on the site id so the choice is stable across
 * re-runs of the same job and different between two businesses in the same trade.
 *
 * Returns `null` when the library cannot dress this combination. That is a complete answer: the
 * poster is an ordinary asset in the manifest and the header is a full-screen still either way.
 */
export function selectLibraryHero(intake: Intake, siteId: string): HeroVideo | null {
  const industry = industryByKey(intake.industryKey);
  if (industry === undefined || industry === null) return null;
  const dna = DNA[industry.dnaId];
  const chosen = selectHeroVideo(MEDIA_LIBRARY, {
    group: industry.groupKey as MediaGroupKey,
    colorMode: dna.canonicalMode,
    accentHue: dna.accent.hue,
    seed: siteId,
  });
  if (chosen === null) return null;
  return {
    landscape: {
      av1R2Key: chosen.landscape.av1Key,
      h264R2Key: chosen.landscape.h264Key,
      width: chosen.landscape.width,
      height: chosen.landscape.height,
      maxBytes: chosen.landscape.maxBytes,
    },
    portrait: {
      av1R2Key: chosen.portrait.av1Key,
      h264R2Key: chosen.portrait.h264Key,
      width: chosen.portrait.width,
      height: chosen.portrait.height,
      maxBytes: chosen.portrait.maxBytes,
    },
    durationSeconds: chosen.durationSeconds,
    luminance: chosen.luminance,
    credit: chosen.credit,
  };
}

/**
 * How many grounds to pull from the library.
 *
 * Three, not more. The hero already carries full-bleed motion; a page whose every band is a photo
 * reads as a slideshow rather than as a business. `assemble` assigns at most one per page.
 */
const LIBRARY_GROUND_COUNT = 3;

/** A library ground, in the shape the manifest and the model's candidate list both need. */
interface SelectedGround {
  readonly refId: string;
  readonly asset: z.infer<typeof ResolvedMediaSchema>;
  readonly candidate: MediaCandidate;
}

/**
 * Photographic grounds for ordinary sections, from the pre-built library.
 *
 * Same rules as the hero: luminance must match the mode the copy will be set in, hue is a
 * preference, and the seed keeps two businesses in one trade from getting the same set.
 *
 * `r2Key` points at the LARGEST WebP as the single-file fallback, and `renditions` carries the
 * whole ladder — which is what actually gets served. Without the ladder a phone would download a
 * 2560px still, which is the exact waste pre-optimising exists to remove.
 */
export function selectLibraryGrounds(
  intake: Intake,
  siteId: string,
  count: number,
): readonly SelectedGround[] {
  const industry = industryByKey(intake.industryKey);
  if (industry === undefined || industry === null) return [];
  const dna = DNA[industry.dnaId];
  const chosen = selectGrounds(
    MEDIA_LIBRARY,
    {
      group: industry.groupKey as MediaGroupKey,
      colorMode: dna.canonicalMode,
      accentHue: dna.accent.hue,
      seed: siteId,
    },
    count,
  );
  return chosen.map((image, index) => {
    const refId = `lib_${String(index)}`;
    const widest =
      image.rendition.widths[image.rendition.widths.length - 1] ?? image.rendition.width;
    return {
      refId,
      asset: {
        refId,
        r2Key: image.rendition.webpKeyTemplate.replace('{width}', String(widest)),
        mimeType: 'image/webp',
        width: image.rendition.width,
        height: image.rendition.height,
        blurhash: null,
        dominantColor: null,
        luminance: image.luminance,
        renditions: {
          avifKeyTemplate: image.rendition.avifKeyTemplate,
          webpKeyTemplate: image.rendition.webpKeyTemplate,
          widths: [...image.rendition.widths],
        },
        altText: image.description,
        credit: image.credit,
      },
      candidate: {
        refId,
        kind: 'image',
        description: image.description,
        orientation: 'landscape',
        source: 'stock',
      },
    };
  });
}
