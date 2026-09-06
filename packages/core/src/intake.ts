import { z } from 'zod';

// §S5 declares `Locale` as part of this contract; it lives in `locales.ts` so that adding a
// seventh locale stays a single-entry change, and is re-exported from the package root.
import { Locale } from './locales';

/**
 * The onboarding intake contract — architecture §S5.
 *
 * This is the **API boundary** schema, and it is the mirror image of `packages/site-schema/src/gen/*`:
 * where the model-facing schemas carry no constraints at all (they would be stripped by the SDK and
 * then fire client-side after a paid generation), this one carries every real constraint, because it
 * runs against a request body that has cost nothing yet. It is validated in `POST /v1/onboarding/submit`
 * before a single token is spent, and **it never goes to the model**: architecture §8 keeps email,
 * phone, street address and the GBP URL out of the prompt entirely and merges them back in from D1 at
 * render time.
 */

/** Days of the week as schema.org spells them. Monday-first: this is a European product. */
export const DAYS_OF_WEEK = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

/** A schema.org `DayOfWeek` short name. */
export type DayOfWeek = (typeof DAYS_OF_WEEK)[number];

/**
 * E.164 phone number.
 *
 * The same shape is enforced a second time by the `phone_e164 NOT GLOB '*[^0-9+]*'` CHECK in D1,
 * because this value ends up in a `tel:` href, a `wa.me` URL and a JSON-LD `telephone` field —
 * three sinks where `+31<script>` must never arrive.
 */
export const E164 = z.string().regex(/^\+[1-9]\d{6,14}$/);

/** `HH:MM`, 24-hour, no timezone suffix — exactly what schema.org wants in `opens`/`closes`. */
export const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Opening hours as the onboarding modal collects them. */
export const OpeningHours = z.object({
  tz: z.string(),
  byAppointmentOnly: z.boolean(),
  spec: z
    .array(
      z.object({
        dayOfWeek: z.array(z.enum(DAYS_OF_WEEK)).min(1),
        opens: z.string().regex(TIME_OF_DAY_PATTERN),
        closes: z.string().regex(TIME_OF_DAY_PATTERN),
      }),
    )
    .max(21),
  closed: z.array(z.string()),
  exceptions: z.array(z.object({ from: z.string(), to: z.string(), closed: z.boolean() })).max(24),
});

/** Opening hours, as stored on the site row and consumed by `hours.ts`. */
export type OpeningHours = z.infer<typeof OpeningHours>;

/** One weekly opening interval covering one or more days. */
export type OpeningHoursEntry = OpeningHours['spec'][number];

/** One dated exception window (a holiday closure, or a season). */
export type OpeningHoursException = OpeningHours['exceptions'][number];

/**
 * The full onboarding payload.
 *
 * Address-or-service-area is a `.refine`, not two optional fields, because `LocalBusiness` needs one
 * of them and the JSON-LD emitter branches on which one is present (architecture §S5, §7.15).
 */
export const IntakeSchema = z
  .object({
    businessName: z.string().trim().min(2).max(120).regex(/\p{L}/u),
    slug: z
      .string()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
      .refine((s) => !s.includes('--')),
    industryKey: z.string().min(1).max(40),
    defaultLocale: Locale,
    // Phase 1: at most one extra locale. Phase 2 fans out.
    extraLocales: z.array(Locale).max(1),
    serviceArea: z
      .object({ city: z.string().max(80), radiusKm: z.enum(['5', '10', '25', '50']) })
      .nullable(),
    address: z
      .object({
        line1: z.string().max(120),
        line2: z.string().max(120).nullable(),
        postalCode: z.string().max(16),
        city: z.string().max(80),
        country: z.string().regex(/^[A-Z]{2}$/),
        latitude: z.number().min(-90).max(90).nullable(),
        longitude: z.number().min(-180).max(180).nullable(),
        geoSource: z.enum(['none', 'geocoded', 'user_pin']),
      })
      .nullable(),
    openingHours: OpeningHours.nullable(),
    phoneE164: E164,
    whatsappE164: E164.nullable(),
    // Stored for `sameAs`; NEVER fetched. Architecture §8 keeps it out of the prompt as well.
    gbpUrl: z.string().url().startsWith('https://').max(500).nullable(),
    shortDescription: z.string().max(600).nullable(),
    contactEmail: z.string().email().max(254),
    marketingOptIn: z.boolean(),
    mediaIds: z.array(z.string()).max(12),
  })
  .refine((v) => v.address !== null || v.serviceArea !== null, {
    message: 'address_or_service_area_required',
  });

/** A validated onboarding payload. */
export type Intake = z.infer<typeof IntakeSchema>;

/** The postal address half of the intake, when the business has a visitable location. */
export type IntakeAddress = NonNullable<Intake['address']>;

/** The service-area half of the intake, for businesses that travel to the customer. */
export type IntakeServiceArea = NonNullable<Intake['serviceArea']>;

/** Provenance of `latitude`/`longitude`; §7.15 forbids emitting `geo` unless this is not `none`. */
export type GeoSource = IntakeAddress['geoSource'];
