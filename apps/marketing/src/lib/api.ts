/**
 * The typed client for every route in architecture §S4 that the onboarding modal touches.
 *
 * ONE `request()` FUNCTION, and every call goes through it (UX §7.6). It owns the 12-second
 * timeout, the retry ladder, the jitter, `Retry-After`, and the translation of an error body into a
 * typed `ApiError` carrying the Dutch and English copy the API already wrote. A component never
 * sees a `Response`, never sees a status code, and never has to remember `credentials: 'include'`.
 *
 * THREE THINGS THAT ARE NOT NEGOTIABLE AND ARE EASY TO GET WRONG:
 *
 *  1. **`credentials: 'include'` on every call.** The marketing host and the API host are different
 *     origins on the same registrable domain, so the `__Host-aib_draft` cookie is same-site and
 *     rides along under `SameSite=Lax` — but only if the request opts in. Without it every
 *     cookie-authenticated route answers 401 and the whole flow silently loses its draft.
 *
 *  2. **A request carrying a Turnstile token is never retried.** Turnstile tokens are single-use:
 *     a retry spends a consumed token and comes back `403 timeout-or-duplicate`, which reads to the
 *     user as "we decided you are a bot" on a request that actually succeeded. Those two calls
 *     (`POST /v1/drafts`, `POST /v1/onboarding/submit`) get a fresh token from the widget instead.
 *
 *  3. **The upload PUT does not go through `request()`.** It goes to R2, not to our API, and it
 *     uses `XMLHttpRequest` because `fetch` still has no upload progress event in Safari — and an
 *     upload with no progress bar is the second-most-abandoned interaction in the flow.
 */

import { NotImplementedInPhase1 } from '@aibuilder/core';
import type { Locale, OpeningHours } from '@aibuilder/core';

import { API_ORIGIN } from './config';
import type { DraftAddress, StepIndex } from './types';

/** How long any single attempt may take before it is aborted. */
const TIMEOUT_MS = 12_000;

/** Total attempts, including the first. */
const MAX_ATTEMPTS = 3;

/** `500 ms × 2^n`, then jittered. */
const BACKOFF_BASE_MS = 500;

/** Statuses worth trying again. Everything else is a decision, not a hiccup. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);

/* ── Errors ──────────────────────────────────────────────────────────────────────────────────── */

/** A field-keyed validation map, exactly as `422` returns it: `{ "address.postalCode": ["too_small"] }`. */
export type ApiFieldErrors = Readonly<Record<string, readonly string[]>>;

/**
 * A failed API call.
 *
 * Carries the API's own stable machine code plus both copy strings, so a caller can either switch
 * on `code` or show `message` without inventing wording the API already owns.
 */
export class ApiError extends Error {
  public readonly status: number;
  /** Stable, never localised, never derived from user input. */
  public readonly code: string;
  /** Dutch, user-facing. */
  public readonly messageNl: string;
  /** English, for the English modal and for logs. */
  public readonly messageEn: string;
  /** Present on 422. */
  public readonly fields: ApiFieldErrors | null;
  /** The rest of the body: `retryAfterSeconds`, `mode`, `server`, `suggestion`, … */
  public readonly extra: Readonly<Record<string, unknown>>;

  public constructor(params: {
    status: number;
    code: string;
    messageNl: string;
    messageEn: string;
    fields?: ApiFieldErrors | null;
    extra?: Readonly<Record<string, unknown>>;
  }) {
    super(`${params.code} (${String(params.status)})`);
    this.name = 'ApiError';
    this.status = params.status;
    this.code = params.code;
    this.messageNl = params.messageNl;
    this.messageEn = params.messageEn;
    this.fields = params.fields ?? null;
    this.extra = params.extra ?? {};
    // Vite downlevels `extends Error` on some targets, which severs the prototype chain.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** The message in the UI's locale. Anything but `nl` reads English (Phase 2 adds the rest). */
  public localised(locale: Locale): string {
    return locale === 'nl' ? this.messageNl : this.messageEn;
  }
}

/** The network never answered: offline, DNS, TLS, or the 12-second timeout. */
export class NetworkError extends Error {
  public readonly timedOut: boolean;

  public constructor(timedOut: boolean, cause?: unknown) {
    super(timedOut ? 'The request timed out.' : 'The network request failed.');
    this.name = 'NetworkError';
    this.timedOut = timedOut;
    if (cause !== undefined) {
      this.cause = cause;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/* ── The one request function ─────────────────────────────────────────────────────────────────── */

/** Options for a single logical call (which may become several attempts). */
interface RequestOptions {
  // `| undefined` is explicit on every member: the repo builds with `exactOptionalPropertyTypes`,
  // under which `{ signal }` where `signal: AbortSignal | undefined` is NOT assignable to
  // `signal?: AbortSignal`. Every call site here forwards an optional signal that way.
  readonly method?: 'GET' | 'POST' | 'PUT' | undefined;
  readonly body?: unknown | undefined;
  readonly signal?: AbortSignal | undefined;
  /**
   * Whether a transient failure may be retried. Defaults to `true` for `GET` and `false` for
   * everything else — a mutation is only safe to repeat when the server deduplicates it, which is a
   * property of the route and therefore stated at the call site.
   */
  readonly retry?: boolean | undefined;
  /** Sent through as the request body without JSON encoding; used by nothing yet. */
  readonly keepalive?: boolean | undefined;
}

/** `Math.random()` bounded to ±25 %, the jitter the retry ladder applies to every wait. */
function jitter(delayMs: number): number {
  return delayMs * (0.75 + Math.random() * 0.5);
}

/** Reads `Retry-After` in either of its two legal forms, or `null`. */
function retryAfterMs(header: string | null): number | null {
  if (header === null) {
    return null;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/** Resolves after `ms`, or rejects the moment `signal` aborts. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new NetworkError(false, signal?.reason));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Combines the caller's signal with a per-attempt timeout.
 *
 * Written by hand rather than with `AbortSignal.any()`, which Safari only shipped in 17.4 — this
 * island has to run on the phone in the shop, not on the phone in the office.
 */
function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  let didTimeOut = false;
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = (): void => {
    controller.abort();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/** Turns a non-2xx response into a typed `ApiError`, falling back when the body is not our shape. */
async function toApiError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const record: Record<string, unknown> =
    typeof body === 'object' && body !== null ? { ...(body as Record<string, unknown>) } : {};
  const code =
    typeof record['error'] === 'string' ? record['error'] : `http_${String(response.status)}`;
  const messageNl =
    typeof record['message'] === 'string'
      ? record['message']
      : 'Er ging iets mis. Probeer het zo nog eens.';
  const messageEn =
    typeof record['messageEn'] === 'string'
      ? record['messageEn']
      : 'Something went wrong. Please try again.';
  const fields =
    typeof record['fields'] === 'object' && record['fields'] !== null
      ? (record['fields'] as ApiFieldErrors)
      : null;
  const retryAfter = retryAfterMs(response.headers.get('retry-after'));
  return new ApiError({
    status: response.status,
    code,
    messageNl,
    messageEn,
    fields,
    extra: retryAfter === null ? record : { ...record, retryAfterMs: retryAfter },
  });
}

/**
 * Performs one API call, retrying transient failures.
 *
 * Guarantees: the returned promise either resolves with the parsed body or rejects with an
 * `ApiError` (the server answered and said no) or a `NetworkError` (nobody answered). It never
 * rejects with a bare `TypeError`, and it never resolves with a non-2xx response.
 *
 * The parsed body is returned as `T` without runtime validation. This API is first-party, its
 * response shapes are covered by its own tests, and re-validating every field in the client would
 * cost bundle size to defend against a failure mode (our own API lying about its schema) that a
 * schema check could not repair anyway.
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const mayRetry = options.retry ?? method === 'GET';
  const url = `${API_ORIGIN}${path}`;

  let lastError: ApiError | NetworkError | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const timeout = withTimeout(options.signal, TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method,
        // Same-site, cross-origin: the draft cookie only travels when the request asks for it.
        credentials: 'include',
        // `Origin` is set by the browser and is checked with `===` by the API; `content-type`
        // forces the preflight that the Origin check then answers, which is deliberate.
        headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.keepalive === true ? { keepalive: true } : {}),
        signal: timeout.signal,
      });

      if (response.ok) {
        if (response.status === 204) {
          return undefined as T;
        }
        return (await response.json()) as T;
      }

      const error = await toApiError(response);
      lastError = error;
      if (!mayRetry || !RETRYABLE_STATUSES.has(response.status)) {
        throw error;
      }
      const advertised = retryAfterMs(response.headers.get('retry-after'));
      const wait = advertised ?? jitter(BACKOFF_BASE_MS * 2 ** attempt);
      if (attempt < MAX_ATTEMPTS - 1) {
        await delay(wait, options.signal);
      }
    } catch (caught: unknown) {
      if (caught instanceof ApiError) {
        throw caught;
      }
      // An abort from the CALLER's signal is a cancellation, not a failure to retry around.
      if (options.signal?.aborted === true) {
        throw new NetworkError(false, caught);
      }
      lastError = new NetworkError(timeout.timedOut(), caught);
      if (!mayRetry || attempt === MAX_ATTEMPTS - 1) {
        throw lastError;
      }
      await delay(jitter(BACKOFF_BASE_MS * 2 ** attempt), options.signal);
    } finally {
      timeout.dispose();
    }
  }

  throw lastError ?? new NetworkError(false);
}

/* ── Response shapes (architecture §S4) ───────────────────────────────────────────────────────── */

/** One locale offered by the language switcher. */
export interface BootstrapLocale {
  readonly code: Locale;
  readonly label: string;
  readonly urlSegment: string;
}

/** One top-level industry group, already localised. */
export interface BootstrapGroup {
  readonly key: string;
  readonly label: string;
  readonly icon: string;
}

/**
 * One leaf industry, already localised.
 *
 * This — not the compiled taxonomy in `@aibuilder/core` — is what the combobox scores against. The
 * bundle would otherwise carry 104 industries × 6 locales for a session that uses one, and the
 * response is `public, max-age=3600` with an ETag, so it costs one cached request (UX §2.2).
 */
export interface BootstrapIndustry {
  readonly key: string;
  readonly groupKey: string;
  readonly label: string;
  /** Lowercase aliases. These matter more than the label: people type `kapper`, not `kapsalon`. */
  readonly searchTerms: readonly string[];
  readonly icon: string;
}

/** `GET /v1/bootstrap`. Contains no user data by design — the draft is a separate, no-store route. */
export interface BootstrapResponse {
  readonly locales: readonly BootstrapLocale[];
  readonly groups: readonly BootstrapGroup[];
  readonly industries: readonly BootstrapIndustry[];
  readonly turnstileSiteKey: string;
  /** `cf.country`, or `null` when Cloudflare could not determine it. */
  readonly country: string | null;
}

/** `POST /v1/drafts`. */
export interface CreateDraftResponse {
  readonly draftId: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

/** The `values` half of a server-side draft. `radiusKm` is a NUMBER here and a string in the intake. */
export interface ServerDraftValues {
  readonly businessName: string | null;
  readonly slug: string | null;
  readonly industryKey: string | null;
  readonly defaultLocale: string | null;
  readonly extraLocales: readonly string[];
  readonly serviceArea: { readonly city: string; readonly radiusKm: number } | null;
  readonly address: DraftAddress;
  readonly openingHours: OpeningHours | null;
  readonly phoneE164: string | null;
  readonly whatsappE164: string | null;
  readonly gbpUrl: string | null;
  readonly shortDescription: string | null;
  readonly contactEmail: string | null;
  readonly marketingOptIn: boolean;
  readonly mediaIds: readonly string[];
}

/** `GET /v1/drafts/me` → `{ draft }`; also the body of a `409 draft_conflict`. */
export interface ServerDraft {
  readonly draftId: string;
  readonly status: string;
  readonly uiLocale: string;
  readonly step: number;
  readonly furthestStep: number;
  readonly updatedAt: number;
  readonly values: ServerDraftValues;
}

/** The autosave patch. `values` must carry ONLY keys the server's `.strict()` schema knows. */
export interface DraftPatch {
  readonly step: StepIndex;
  readonly furthestStep: StepIndex;
  /** The client's `updatedAt`; the server rejects the write if its own copy is newer. */
  readonly updatedAt: number;
  readonly values: Readonly<Record<string, unknown>>;
}

/** `GET /v1/slug-check`. */
export interface SlugCheckResponse {
  readonly available: boolean;
  readonly normalized: string;
  readonly suggestion?: string;
  readonly reason?: 'invalid' | 'reserved' | 'taken' | 'homoglyph';
}

/** `POST /v1/geo/nl-be`. */
export interface GeoResolveResponse {
  readonly addressLine1: string;
  readonly city: string;
  readonly postalCode: string;
  readonly country: 'NL' | 'BE';
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly source: 'geocoded';
}

/** `POST /v1/media/sign`. `headers` are the headers the PUT must carry. */
export interface SignMediaResponse {
  readonly mediaId: string;
  readonly uploadUrl: string;
  readonly expiresInSeconds: number;
  readonly headers: Readonly<Record<string, string>>;
}

/** `GET /v1/media/:mediaId`. */
export interface MediaStatusResponse {
  readonly status: 'verifying' | 'ready' | 'failed' | 'quarantined';
  readonly width: number | null;
  readonly height: number | null;
  readonly blurhash: string | null;
  readonly dominantColor: string | null;
}

/**
 * Where a job stands with respect to the trial (`generation_jobs.payment_state`).
 *
 * Orthogonal to `status`. `awaiting_payment` is a job that exists, holds a reserved slug and a
 * promoted media set, and will not run until the `checkout.session.completed` webhook releases it —
 * so it is emphatically not a failure, and the UI must never render it as one.
 */
export type PaymentState = 'not_required' | 'awaiting_payment' | 'paid' | 'abandoned';

/**
 * `POST /v1/onboarding/submit` — 202 on the first call, 200 on an idempotent replay.
 *
 * Under the trial-first funnel (DECISIONS §D2) this route dispatches nothing. It reserves the slug,
 * writes the job in `awaiting_payment` and hands back a Stripe Checkout URL; the Workflow is started
 * by the webhook. The three payment fields are typed OPTIONAL rather than required even though the
 * route always sends them, so that a modal deployed ahead of the API — the ordinary state of affairs
 * for ten minutes during a rollout — degrades to the Phase 1 behaviour (straight into the theatre)
 * instead of rendering `undefined` into the conversion screen.
 */
export interface SubmitResponse {
  readonly jobId: string;
  readonly slug: string;
  readonly siteUrl: string;
  /** Path, not an absolute URL: `/v1/jobs/job_…/events`. */
  readonly eventsUrl: string;
  readonly paymentState?: PaymentState;
  /** Absolute `https://checkout.stripe.com/…`. Absent when no payment is required. */
  readonly checkoutUrl?: string;
  /** Epoch milliseconds. Stripe's own `expires_at`, 30 minutes out. */
  readonly checkoutExpiresAt?: number;
}

/**
 * `POST /v1/billing/checkout/:jobId` — mints a fresh Checkout Session for a job that already exists.
 *
 * The recovery path for every way the first session can be lost: the customer pressed Back, the
 * 30-minute window expired, or `submit` answered `402 checkout_unavailable` because Stripe was down
 * at exactly the wrong moment. Capped server-side at five sessions per job for its whole life.
 */
export interface CheckoutSessionResponse {
  readonly jobId: string;
  readonly paymentState: PaymentState;
  readonly checkoutUrl: string;
  readonly checkoutExpiresAt: number;
}

/** `GET /v1/jobs/:jobId` — the polling fallback for the SSE stream. */
export interface JobStatusResponse {
  readonly status: string;
  readonly phase: string;
  readonly progress: number;
  readonly message: string | null;
  readonly siteUrl?: string;
  readonly error?: string;
  readonly paymentState?: PaymentState;
  readonly checkoutExpiresAt?: number;
}

/* ── Routes ───────────────────────────────────────────────────────────────────────────────────── */

/** Everything the modal needs before it can render step 1. Cached by the browser for an hour. */
export function getBootstrap(
  params: { locale: Locale; country?: string | undefined },
  signal?: AbortSignal,
): Promise<BootstrapResponse> {
  const query = new URLSearchParams({ locale: params.locale });
  if (params.country !== undefined && params.country.length === 2) {
    query.set('country', params.country);
  }
  return request<BootstrapResponse>(`/v1/bootstrap?${query.toString()}`, { signal });
}

/**
 * Creates the server-side draft and sets the session cookie.
 *
 * Never retried: the Turnstile token is single-use, and the route is already idempotent for a live
 * cookie (it returns the open draft instead of minting a second one).
 */
export function createDraft(
  params: { turnstileToken: string; locale: Locale },
  signal?: AbortSignal,
): Promise<CreateDraftResponse> {
  return request<CreateDraftResponse>('/v1/drafts', {
    method: 'POST',
    body: params,
    retry: false,
    signal,
  });
}

/** The cookie's current draft, or `null` when there is none (the route answers 404). */
export async function getDraft(signal?: AbortSignal): Promise<ServerDraft | null> {
  try {
    const body = await request<{ readonly draft: ServerDraft }>('/v1/drafts/me', { signal });
    return body.draft;
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Autosave. Retried, because the route is last-write-wins guarded by `updatedAt`.
 *
 * A `409 draft_conflict` carries the server's copy in `extra.server`; the caller resolves it with
 * the one-tap choice in UX §7.2 rather than silently overwriting either side.
 */
export function putDraft(patch: DraftPatch, signal?: AbortSignal): Promise<{ updatedAt: number }> {
  return request<{ updatedAt: number }>('/v1/drafts/me', {
    method: 'PUT',
    body: patch,
    retry: true,
    signal,
  });
}

/**
 * The last-gasp save on `pagehide`.
 *
 * `navigator.sendBeacon` is deliberately NOT used, and this is the one place in the flow where the
 * obvious API is the wrong one: `sendBeacon` can only issue a **POST**, and the autosave route is a
 * **PUT** — the beacon would arrive as a 405 and the user's last twenty seconds of typing would be
 * lost exactly when it matters. `fetch(..., { keepalive: true })` is the same guarantee (the
 * request outlives the document) on the correct method.
 *
 * Returns nothing and throws nothing: a save the page is not around to observe cannot report.
 */
export function flushDraftOnUnload(patch: DraftPatch): void {
  try {
    void fetch(`${API_ORIGIN}/v1/drafts/me`, {
      method: 'PUT',
      credentials: 'include',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => undefined);
  } catch {
    // A browser that refuses a keepalive fetch during unload has already discarded the page.
  }
}

/** Slug availability against `reserved_slugs` and the total unique index on `sites.slug`. */
export function checkSlug(
  params: {
    slug: string;
    locale: Locale;
    city?: string | undefined;
    businessName?: string | undefined;
    industryKey?: string | undefined;
  },
  signal?: AbortSignal,
): Promise<SlugCheckResponse> {
  const query = new URLSearchParams({ slug: params.slug, locale: params.locale });
  if (params.city !== undefined && params.city.length > 0) {
    query.set('city', params.city);
  }
  if (params.businessName !== undefined && params.businessName.length > 0) {
    query.set('businessName', params.businessName);
  }
  if (params.industryKey !== undefined && params.industryKey.length > 0) {
    query.set('industryKey', params.industryKey);
  }
  return request<SlugCheckResponse>(`/v1/slug-check?${query.toString()}`, { signal });
}

/** NL/BE postcode + house number → a complete, verified address. Never blocks Continue. */
export function resolveNlBeAddress(
  params: { country: 'NL' | 'BE'; postalCode: string; houseNumber: string },
  signal?: AbortSignal,
): Promise<GeoResolveResponse> {
  return request<GeoResolveResponse>('/v1/geo/nl-be', {
    method: 'POST',
    body: params,
    retry: true,
    signal,
  });
}

/** Reserves a media row and returns a 120-second presigned R2 PUT. */
export function signMedia(
  params: {
    role: 'hero' | 'gallery' | 'logo';
    declaredType: string;
    bytes: number;
    width: number;
    height: number;
  },
  signal?: AbortSignal,
): Promise<SignMediaResponse> {
  return request<SignMediaResponse>('/v1/media/sign', {
    method: 'POST',
    body: params,
    // Safe to repeat: a signed-but-unused row is reaped, and the alternative to a retry is a photo
    // the customer watched fail for a reason that was gone a second later.
    retry: true,
    signal,
  });
}

/** Hands the browser's claimed digest to the verify/re-encode queue. Commit is not "ready". */
export function commitMedia(
  params: { mediaId: string; sha256: string },
  signal?: AbortSignal,
): Promise<{ mediaId: string; status: string }> {
  return request<{ mediaId: string; status: string }>(
    `/v1/media/${encodeURIComponent(params.mediaId)}/commit`,
    { method: 'POST', body: { sha256: params.sha256 }, retry: true, signal },
  );
}

/** Verification status of one uploaded file. Polled while a tile is `verifying`. */
export function getMediaStatus(
  mediaId: string,
  signal?: AbortSignal,
): Promise<MediaStatusResponse> {
  return request<MediaStatusResponse>(`/v1/media/${encodeURIComponent(mediaId)}`, { signal });
}

/**
 * The submit. Never retried by the transport — see the module header on Turnstile tokens.
 *
 * Idempotency is the SERVER's: it uses the key stored on the draft row, which is why the request
 * carries no `Idempotency-Key` header. A replay answers 200 with the same body as the original 202.
 */
export function submitOnboarding(
  payload: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<SubmitResponse> {
  return request<SubmitResponse>('/v1/onboarding/submit', {
    method: 'POST',
    body: payload,
    retry: false,
    signal,
  });
}

/** The polling fallback for a job whose SSE stream will not stay up. */
export function getJobStatus(jobId: string, signal?: AbortSignal): Promise<JobStatusResponse> {
  return request<JobStatusResponse>(`/v1/jobs/${encodeURIComponent(jobId)}`, { signal });
}

/**
 * Mints a new Checkout Session for a job that is still `awaiting_payment`.
 *
 * NEVER RETRIED, and the reason is not Turnstile this time — this route carries no token. It is that
 * a 5xx after Stripe has already created the session would create a second one, and each attempt is
 * counted against a lifetime cap of five (PHASE2-BILLING-AUTH §5.4). Burning the customer's recovery
 * budget on a response we never saw is exactly the failure the cap exists to prevent. A rate-limit
 * refusal (`429`) is likewise a decision and not a hiccup: the caller surfaces it and lets the person
 * press the button again.
 */
export function resumeCheckout(
  jobId: string,
  signal?: AbortSignal,
): Promise<CheckoutSessionResponse> {
  return request<CheckoutSessionResponse>(`/v1/billing/checkout/${encodeURIComponent(jobId)}`, {
    method: 'POST',
    retry: false,
    signal,
  });
}

/** Absolute URL of a job's SSE stream, built from the path the submit response returned. */
export function jobEventsUrl(eventsPath: string): string {
  return `${API_ORIGIN}${eventsPath}`;
}

/* ── The R2 upload ────────────────────────────────────────────────────────────────────────────── */

/** Progress of one file upload, 0–1. */
export type UploadProgress = (fraction: number) => void;

/** Headers the browser sets itself and silently ignores if we try to. */
const FORBIDDEN_UPLOAD_HEADERS: ReadonlySet<string> = new Set([
  'content-length',
  'host',
  'connection',
]);

/**
 * PUTs one blob straight to R2 with a presigned URL.
 *
 * `XMLHttpRequest`, not `fetch`, and that is not nostalgia: `fetch` has no upload progress event in
 * Safari, and this is a phone on a shop's Wi-Fi uploading a 1.6 MB photo. A progress ring that
 * moves is the difference between waiting and abandoning.
 *
 * `content-length` is returned by the signer because it is bound into the signature, but it is a
 * forbidden header name — the browser computes it from the body. The size is therefore *asserted*
 * against the signed value instead: a mismatch would fail the signature at R2 with an opaque 403,
 * and failing here says which file and why.
 */
export function uploadToR2(params: {
  url: string;
  headers: Readonly<Record<string, string>>;
  blob: Blob;
  onProgress?: UploadProgress | undefined;
  signal?: AbortSignal | undefined;
}): Promise<void> {
  const signedLength = params.headers['content-length'];
  if (signedLength !== undefined && Number(signedLength) !== params.blob.size) {
    return Promise.reject(
      new NetworkError(
        false,
        `Signed length ${signedLength} does not match the ${String(params.blob.size)}-byte body.`,
      ),
    );
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', params.url, true);
    for (const [name, value] of Object.entries(params.headers)) {
      if (!FORBIDDEN_UPLOAD_HEADERS.has(name.toLowerCase())) {
        xhr.setRequestHeader(name, value);
      }
    }

    const onAbort = (): void => {
      xhr.abort();
    };
    params.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = (): void => {
      params.signal?.removeEventListener('abort', onAbort);
    };

    xhr.upload.addEventListener('progress', (event: ProgressEvent) => {
      if (event.lengthComputable && params.onProgress !== undefined) {
        params.onProgress(event.loaded / event.total);
      }
    });
    xhr.addEventListener('load', () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        params.onProgress?.(1);
        resolve();
      } else {
        reject(new NetworkError(false, `R2 answered ${String(xhr.status)}.`));
      }
    });
    xhr.addEventListener('error', () => {
      cleanup();
      reject(new NetworkError(false));
    });
    xhr.addEventListener('timeout', () => {
      cleanup();
      reject(new NetworkError(true));
    });
    xhr.addEventListener('abort', () => {
      cleanup();
      reject(new NetworkError(false));
    });

    xhr.send(params.blob);
  });
}

/* ── Phase 2 boundaries ───────────────────────────────────────────────────────────────────────── */

/**
 * "Schrijf het voor mij" — the streaming AI description drafter (UX §2.6).
 *
 * NOT IN PHASE 1. The route it needs (`POST /v1/onboarding/draft-description`) is not among the
 * Phase 1 endpoints in architecture §S4, and the modal therefore does not offer the button: step 6
 * tells the user plainly that the field may be left empty and that we will write something. This
 * function exists so the call site is typed today and the gap is loud rather than silent — a
 * plausible-looking stub that returned invented copy would be far worse than a throw.
 */
export function requestAiDescription(_params: {
  readonly tone: 'warm' | 'professional' | 'playful';
  readonly locale: Locale;
}): Promise<string> {
  throw new NotImplementedInPhase1(
    'POST /v1/onboarding/draft-description (AI description drafter)',
  );
}
