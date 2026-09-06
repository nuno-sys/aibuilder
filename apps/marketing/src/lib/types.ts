/**
 * The onboarding draft model — UX §7.1, adjusted to the shapes the API actually accepts.
 *
 * NOTE ON DEPENDENCIES: this module imports types from `@aibuilder/core`, which is a workspace
 * dependency the island needs declared in `apps/marketing/package.json`. See
 * `src/islands/DEPENDENCIES.md` for the exact lines.
 *
 * TWO THINGS THIS FILE EXISTS TO KEEP APART, because conflating them is a 422 in production:
 *
 *  1. **`DraftValues` is exactly the key set `PUT /v1/drafts/me` accepts.** That schema is
 *     `.strict()`, so a single extra key — `whatsappSame`, `descriptionSource`, a UI flag — fails
 *     the whole autosave with a validation error. Everything the wizard needs but the server does
 *     not store therefore lives in `DraftUiState`, a sibling object that is never serialised into
 *     the request body. The separation is structural rather than conventional: it is not possible
 *     to leak a UI flag into the patch without changing a type.
 *
 *  2. **`serviceArea.radiusKm` is a NUMBER on the draft route and a STRING in `IntakeSchema`.**
 *     The draft column is an integer; the intake enum is `'5'|'10'|'25'|'50'`. The draft is the
 *     canonical local form and the conversion happens once, at submit.
 */

import type { Locale, OpeningHours, UploadMimeType } from '@aibuilder/core';

/** The six input steps. Act 7 (generation) is a separate phase, not a step. */
export type StepIndex = 1 | 2 | 3 | 4 | 5 | 6;

/** Every step, in order. Index + 1 is the `StepIndex`. */
export const STEP_IDS = ['name', 'industry', 'address', 'hours', 'contact', 'story'] as const;

/** Stable id of one step, used for headings, anchors and analytics. */
export type StepId = (typeof STEP_IDS)[number];

/** The number of input steps. Written once so the rail, the copy and the clamp cannot disagree. */
export const STEP_COUNT = STEP_IDS.length;

/** Postal address as the draft route stores it: always an object, every field nullable. */
export interface DraftAddress {
  line1: string | null;
  line2: string | null;
  postalCode: string | null;
  city: string | null;
  /** ISO 3166-1 alpha-2, uppercase. */
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  geoSource: 'none' | 'geocoded' | 'user_pin';
}

/** The radius options of the service-area slider, as numbers (the draft column's type). */
export const SERVICE_RADII = [5, 10, 25, 50] as const;

/** One service radius in kilometres. */
export type ServiceRadiusKm = (typeof SERVICE_RADII)[number];

/** "I travel to the customer" — the alternative to a visitable address. */
export interface DraftServiceArea {
  city: string;
  radiusKm: ServiceRadiusKm;
}

/**
 * The intake as the wizard holds it: every field nullable, because a wizard is a half-filled form.
 *
 * The key set is exactly `PUT /v1/drafts/me`'s `values`. Adding a key here without adding it there
 * turns every autosave into a 422.
 */
export interface DraftValues {
  businessName: string | null;
  slug: string | null;
  industryKey: string | null;
  defaultLocale: Locale | null;
  extraLocales: Locale[];
  serviceArea: DraftServiceArea | null;
  address: DraftAddress;
  openingHours: OpeningHours | null;
  phoneE164: string | null;
  whatsappE164: string | null;
  gbpUrl: string | null;
  shortDescription: string | null;
  contactEmail: string | null;
  marketingOptIn: boolean;
  mediaIds: string[];
}

/** The four hour presets plus the escape hatch, from UX §2.4. */
export type HoursPresetId =
  'weekdays_9_17' | 'mon_sat_9_18' | 'tue_sun_12_22' | 'appointment' | 'always';

/**
 * Wizard state that is never sent to the server.
 *
 * Each field is here because the server's stored shape cannot express it: a service-area draft
 * still has an address object, a phone number that equals the WhatsApp number says nothing about
 * whether the user *chose* that, and "the AI wrote this description" is a fact about the editing
 * session rather than about the site.
 */
export interface DraftUiState {
  locationMode: 'address' | 'service_area';
  /** NL/BE start on the two-field postcode lookup; everyone else types the address. */
  addressEntry: 'lookup' | 'manual';
  hoursPreset: HoursPresetId | null;
  /** The 7-day grid stays collapsed until the user edits a day (UX §2.4). */
  hoursGridOpen: boolean;
  whatsappSame: boolean;
  descriptionSource: 'user' | 'ai';
  /** ISO 3166-1 alpha-2 driving `AsYouType` and the example number in the error copy. */
  phoneCountry: string;
}

/** Lifecycle of one uploaded file, as the tile renders it (UX §4.5). */
export type MediaStatus = 'queued' | 'compressing' | 'uploading' | 'verifying' | 'ready' | 'error';

/** Machine codes for every upload failure the UI has copy for. */
export type MediaErrorCode =
  | 'wrongType'
  | 'tooLarge'
  | 'tooSmall'
  | 'tooMany'
  | 'decodeFailed'
  | 'uploadFailed'
  | 'quarantined'
  | 'offline';

/** One file in the media grid. `mediaId` is null until the server has signed an upload for it. */
export interface MediaItem {
  /** Client-minted, stable across the whole lifecycle — the React key and the reorder identity. */
  readonly clientId: string;
  /** Server id (`med_…`), assigned by `POST /v1/media/sign`. */
  mediaId: string | null;
  /** Original filename, display-only. Never sent; the object key is derived server-side. */
  readonly name: string;
  /** `blob:` URL of the local preview, revoked when the tile is removed. */
  previewUrl: string | null;
  width: number;
  height: number;
  bytes: number;
  mime: UploadMimeType;
  status: MediaStatus;
  /** 0–100, meaningful while `status === 'uploading'`. */
  progress: number;
  errorCode: MediaErrorCode | null;
  /** Interpolated into the error copy (a filename, a size, a dimension pair). */
  errorParams: Readonly<Record<string, string>>;
}

/** What survives a refresh. Blobs never do — only the R2-backed ids and the metadata. */
export interface PersistedMedia {
  readonly clientId: string;
  readonly mediaId: string | null;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly mime: UploadMimeType;
  readonly status: MediaStatus;
}

/** The whole draft, as stored locally and mirrored to D1. */
export interface Draft {
  /** Schema version. A mismatch discards the local copy rather than migrating it. */
  readonly v: number;
  /** `drf_…`. Minted SERVER-side (architecture §3b) — a client-minted id is an open relay. */
  draftId: string | null;
  locale: Locale;
  step: StepIndex;
  /** Ceiling for forward jumps. A deep link can never exceed `furthestStep + 1`. */
  furthestStep: StepIndex;
  values: DraftValues;
  ui: DraftUiState;
  media: PersistedMedia[];
  /** Milliseconds. Compared against the server's copy to resolve a conflict. */
  updatedAt: number;
}

/** A validation failure on one field, in the UI's locale. */
export interface FieldError {
  /** Dotted field path, matching the input's `id`: `businessName`, `address.postalCode`. */
  readonly field: string;
  /** Human copy, already localised. Anchor text in the error summary is exactly this string. */
  readonly message: string;
}
