import type { ShardBindings } from '@aibuilder/db';

/**
 * Every binding declared in `apps/generator/wrangler.jsonc`, as one typed interface.
 *
 * WHY THIS IS HAND-AUTHORED. Architecture §2 prefers `wrangler types`, and that generator remains
 * the cross-check: run it and the shapes must agree. It is not the compile-time source here for
 * three reasons. First, a generated global `Env` cannot be imported by name, so every module would
 * depend on ambient state instead of an explicit import, and a step function could not state which
 * bindings it needs. Second, the two secrets are read through `readSecret()` so that a plain
 * `wrangler secret put` value keeps working while Secrets Store is in open beta (§8). Third, the
 * queue message is a contract with `apps/api`'s producer, and a contract is worth writing down.
 *
 * Adding a binding is therefore two edits — `wrangler.jsonc` and this file — and forgetting the
 * second one is a compile error at the first use, not a runtime `undefined`.
 */

/** A Secrets Store binding: the value is fetched asynchronously and cached per isolate. */
export interface StoredSecret {
  get(): Promise<string>;
}

/** A secret in either of the two shapes the platform can deliver. */
export type SecretBinding = StoredSecret | string;

/**
 * The message `POST /v1/media/:mediaId/commit` puts on `aibuilder-media`.
 *
 * Field-for-field `MediaVerifyMessage` in `apps/api/src/env.ts`. The two Workers are deployed
 * separately, so this shape is a wire contract and not a shared type: widening it means shipping
 * the producer first and tolerating both shapes here for one deploy.
 *
 * `claimedSha256` is the browser's claim about what it uploaded. It is recorded, never trusted —
 * the consumer hashes the object itself.
 */
export interface MediaVerifyMessage {
  readonly type: 'verify';
  readonly mediaId: string;
  readonly draftId: string;
  readonly shardId: number;
  readonly bucket: string;
  readonly key: string;
  readonly declaredMimeType: string;
  readonly claimedSha256: string;
}

/**
 * The Cloudflare Images binding, narrowed to the one call this Worker makes.
 *
 * Declared structurally rather than imported so the consumer compiles against the shape it uses
 * independently of which `@cloudflare/workers-types` release is installed, and so the
 * `metadata: 'none'` obligation from §8 is visible in the type rather than buried in a call site.
 */
export interface ImagesBinding {
  /**
   * Reads an image's real format and dimensions.
   *
   * The dimensions are not a nicety: `media_assets` refuses a `ready` image without width and
   * height, because a hero rendered with no intrinsic size is a guaranteed layout shift and §7
   * treats that as publish-blocking. The format is a second, independent opinion on what the bytes
   * are — the consumer's own magic-byte sniff is the first.
   */
  info(stream: ReadableStream<Uint8Array>): Promise<ImageInfoResult>;
  input(stream: ReadableStream<Uint8Array>): ImagesTransformer;
}

/** What `info()` reports. */
export interface ImageInfoResult {
  readonly format: string;
  readonly fileSize?: number;
  readonly width?: number;
  readonly height?: number;
}

/** A transformation chain over one input image. */
export interface ImagesTransformer {
  transform(options: ImageTransformOptions): ImagesTransformer;
  output(options: ImageOutputOptions): Promise<ImagesOutputResult>;
}

/** The geometry half of a transform. Only the fields the derivative ladder sets. */
export interface ImageTransformOptions {
  readonly width?: number;
  readonly height?: number;
  readonly fit?: 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad';
}

/**
 * The encoding half.
 *
 * `metadata: 'none'` is not a default and is not optional: dropping EXIF is what turns a customer's
 * holiday photo into an asset that does not leak their home GPS coordinates, and a GPS leak is a
 * GDPR incident rather than a bug (§8).
 */
export interface ImageOutputOptions {
  readonly format: 'image/avif' | 'image/webp' | 'image/jpeg' | 'image/png';
  readonly quality?: number;
  readonly metadata: 'none';
}

/** What `output()` resolves to. */
export interface ImagesOutputResult {
  response(): Response;
  contentType(): string;
}

/**
 * The Analytics Engine binding, narrowed to `writeDataPoint`.
 *
 * Typed here rather than imported for the same reason as `ImagesBinding`, and deliberately
 * synchronous and fire-and-forget: telemetry that can fail a generation is worse than no telemetry.
 */
export interface AnalyticsEngineBinding {
  writeDataPoint(event: {
    readonly indexes?: readonly string[];
    readonly blobs?: readonly (string | null)[];
    readonly doubles?: readonly number[];
  }): void;
}

/**
 * The Workflow binding.
 *
 * Structural for the same reason as the two above, and narrowed to the three methods this Worker
 * uses: `create` on dispatch, `get` to look an instance up, and the instance's `terminate` for the
 * cancellation path (§6.4 — a cancelled job that keeps running burns tokens through the most
 * expensive steps while the UI shows it stopped).
 */
export interface WorkflowBinding<P> {
  create(options: { readonly id: string; readonly params: P }): Promise<WorkflowInstanceHandle>;
  get(id: string): Promise<WorkflowInstanceHandle>;
}

/** One Workflow instance, as this Worker uses it. */
export interface WorkflowInstanceHandle {
  readonly id: string;
  status(): Promise<{ readonly status: string }>;
  terminate(): Promise<void>;
}

/**
 * The parameters one generation run is dispatched with.
 *
 * IDENTIFIERS ONLY. The generator holds both D1 bindings and reads the draft itself, which keeps
 * the intake — including the fields that never reach a model — out of a second hop, and keeps the
 * Workflow's durable parameter record free of personal data.
 */
export interface SiteGenerationParams {
  readonly jobId: string;
  readonly orgId: string;
  readonly siteId: string;
  readonly draftId: string;
  readonly shardId: number;
  readonly slug: string;
  readonly canonicalHost: string;
}

/** The generator Worker's environment. */
export interface Env extends ShardBindings {
  /** Control plane. The draft, its policy verdict and the site's identity row. */
  readonly CP: D1Database;

  /** SiteDocs, materialised HTML, sitemaps and AI transcripts. EU jurisdiction, binding-only. */
  readonly BLOBS: R2Bucket;
  /** Verified originals, derivatives and re-hosted stock. EU jurisdiction, binding-only. */
  readonly MEDIA: R2Bucket;
  /** Unverified uploads. Read and then deleted by the media consumer; 24-hour lifecycle rule. */
  readonly QUARANTINE: R2Bucket;

  /** Composed-query hash -> stock lookup result. See `src/steps/media.ts` for why it must exist. */
  readonly STOCK_CACHE: KVNamespace;

  /** Per-job SSE hub. Always addressed through `src/do/jurisdiction.ts`. */
  readonly JOB_HUB: DurableObjectNamespace;
  /** Per-subject onboarding quotas (§8 layer 5). */
  readonly QUOTA: DurableObjectNamespace;
  /** The single global spend ceiling with staged degradation (§8 layer 6). */
  readonly BUDGET: DurableObjectNamespace;

  readonly SITEGEN: WorkflowBinding<SiteGenerationParams>;

  readonly IMAGES: ImagesBinding;
  readonly AE: AnalyticsEngineBinding;

  /** The one key that justifies this Worker existing separately. */
  readonly ANTHROPIC_API_KEY: SecretBinding;
  /** Stock photography. Absent or failing degrades to an image-free layout, never to a failed run. */
  readonly PEXELS_KEY: SecretBinding;

  readonly ENVIRONMENT: 'production' | 'staging';
  /** Pinned so the model id is a deploy-time decision. Never date-suffixed. */
  readonly ANTHROPIC_MODEL: string;
  readonly SITES_ROOT_DOMAIN: string;
  readonly MEDIA_ORIGIN: string;
  /** `media_assets.r2_bucket` stores a bucket NAME, which an R2 binding does not expose. */
  readonly R2_MEDIA_BUCKET: string;
  readonly R2_BLOBS_BUCKET: string;
}

/** Thrown when a secret binding resolves to nothing. Never carries the value. */
export class MissingSecretError extends Error {
  public readonly binding: string;

  public constructor(binding: string) {
    super(`Secret binding "${binding}" is not configured`);
    this.name = 'MissingSecretError';
    this.binding = binding;
    // esbuild downlevels `extends Error` on some targets, severing the prototype chain and breaking
    // `instanceof` across bundle boundaries.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Resolves a secret binding to its value.
 *
 * Accepts both shapes so that rotating the delivery mechanism is not a code change. Guarantees a
 * non-empty string or a thrown `MissingSecretError` — never an empty key silently authenticating
 * nothing.
 */
export async function readSecret(binding: SecretBinding, name: string): Promise<string> {
  const value = typeof binding === 'string' ? binding : await binding.get();
  if (typeof value !== 'string' || value.length === 0) {
    throw new MissingSecretError(name);
  }
  return value;
}

/**
 * Resolves an optional secret, returning `null` rather than throwing when it is absent.
 *
 * Exactly one caller: `PEXELS_KEY`. Stock imagery has a documented degradation path (an image-free
 * layout), so a missing key must not fail a paid generation the way a missing model key must.
 */
export async function readOptionalSecret(
  binding: SecretBinding | undefined,
): Promise<string | null> {
  if (binding === undefined) return null;
  try {
    const value = typeof binding === 'string' ? binding : await binding.get();
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
