import { z } from 'zod';
import {
  ColorMode,
  DensityId,
  DnaId,
  GenSchemaVersion,
  Hue,
  Locale,
  MediaRef,
  MotionId,
  PaletteVariant,
  RadiusId,
  TypeScaleId,
} from './common';
import { SectionGen } from './section';

/**
 * `SiteStructureGen` — generation document A.
 *
 * One Anthropic call, locale-independent, and it contains ZERO prose. It decides
 * *what the site is*: which pages exist, which sections they hold, which design DNA
 * dresses them, and which typed facts feed the JSON-LD builder. Everything the
 * visitor will actually read arrives later in a `LocaleBundleGen`, addressed by slot
 * ids derived from this document.
 */

/* ── Theme ──────────────────────────────────────────────────────────────── */

/**
 * The complete design surface exposed to the model (invariant 3).
 *
 * Eight closed enums. No colour, no length, no font name — `site-kit` resolves this
 * to ~40 OKLCH-derived CSS custom properties with contrast provable by construction.
 */
export const ThemeGen = z.object({
  dnaId: DnaId,
  paletteVariant: PaletteVariant,
  accentHueShift: Hue,
  typeScaleId: TypeScaleId,
  radiusId: RadiusId,
  densityId: DensityId,
  motionId: MotionId,
  colorMode: ColorMode,
  /** QA + editor hints. Never rendered, never stored on `SiteDoc`. */
  rationale: z.string(),
});
export type ThemeGen = z.infer<typeof ThemeGen>;

/* ── Pages ──────────────────────────────────────────────────────────────── */

export const PAGE_ROLES = [
  'home',
  'about',
  'services',
  'menu',
  'gallery',
  'reviews',
  'team',
  'contact',
  'booking',
  'blog_index',
  'privacy',
  'terms',
  'cookies',
] as const;
export const PageRole = z.enum(PAGE_ROLES);
export type PageRole = z.infer<typeof PageRole>;

/**
 * A page.
 *
 * No `titleSlot` / `descriptionSlot` / `slugSeedSlot`: those slot ids are derived as
 * `page.${pageId}.meta.{title,description,slug}`. The model writes the *phrase*;
 * code slugifies it with locale-aware transliteration.
 */
export const PageGen = z.object({
  pageId: z.string(),
  role: PageRole,
  noindex: z.boolean(),
  showInNav: z.boolean(),
  ogMedia: MediaRef.nullable(),
  sections: z.array(SectionGen),
});
export type PageGen = z.infer<typeof PageGen>;

/* ── JSON-LD inputs (invariant 4) ───────────────────────────────────────── */

/**
 * The compiled `LocalBusiness` subtype allowlist.
 *
 * An invented `@type` (`DJService`) silently disables every rich result, so the set
 * is closed at the grammar level. A DJ is a `ProfessionalService`.
 */
export const SCHEMA_ORG_TYPES = [
  'Restaurant',
  'CafeOrCoffeeShop',
  'Bakery',
  'BarOrPub',
  'NightClub',
  'HairSalon',
  'BeautySalon',
  'NailSalon',
  'HealthAndBeautyBusiness',
  'Dentist',
  'Physician',
  'MedicalClinic',
  'LegalService',
  'Accounting',
  'Plumber',
  'Electrician',
  'HVACBusiness',
  'GeneralContractor',
  'RoofingContractor',
  'HousePainter',
  'Locksmith',
  'MovingCompany',
  'RealEstateAgent',
  'AutoRepair',
  'AutoDealer',
  'GasStation',
  'Florist',
  'PetStore',
  'VeterinaryCare',
  'ExerciseGym',
  'SportsActivityLocation',
  'DaySpa',
  'Photographer',
  'TattooParlor',
  'DrivingSchool',
  'ChildCare',
  'ProfessionalService',
  'Store',
  'LocalBusiness',
] as const;
export const SchemaOrgType = z.enum(SCHEMA_ORG_TYPES);
export type SchemaOrgType = z.infer<typeof SchemaOrgType>;

export const PRICE_RANGES = ['€', '€€', '€€€', '€€€€'] as const;
export const PriceRange = z.enum(PRICE_RANGES);
export type PriceRange = z.infer<typeof PriceRange>;

export const PAYMENT_METHODS = [
  'cash',
  'credit_card',
  'debit_card',
  'ideal',
  'bancontact',
  'paypal',
  'apple_pay',
  'google_pay',
  'bank_transfer',
  'invoice',
] as const;
export const PaymentMethod = z.enum(PAYMENT_METHODS);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

export const AMENITIES = [
  'wheelchair_accessible',
  'parking',
  'wifi',
  'outdoor_seating',
  'takeaway',
  'delivery',
  'pet_friendly',
  'kids_welcome',
  'air_conditioning',
  'ev_charging',
] as const;
export const Amenity = z.enum(AMENITIES);
export type Amenity = z.infer<typeof Amenity>;

/**
 * Typed inputs to the JSON-LD `@graph` builder — never a serialised graph.
 *
 * `servesCuisine` is free text because cuisine names are open-ended; it is the one
 * string here and it is length-clamped by `normalize()` and emitted as a JSON string
 * value, never interpolated into markup.
 */
export const JsonLdInputsGen = z.object({
  schemaOrgType: SchemaOrgType,
  priceRange: PriceRange.nullable(),
  servesCuisine: z.array(z.string()).nullable(),
  acceptsReservations: z.boolean().nullable(),
  paymentAccepted: z.array(PaymentMethod),
  amenities: z.array(Amenity),
});
export type JsonLdInputsGen = z.infer<typeof JsonLdInputsGen>;

/* ── Chrome ─────────────────────────────────────────────────────────────── */

export const NAV_STYLES = [
  'centered_logo_slim',
  'logo_left_links_right',
  'minimal_burger',
] as const;
export const NavStyle = z.enum(NAV_STYLES);
export type NavStyle = z.infer<typeof NavStyle>;

export const FOOTER_STYLES = ['rich_4col', 'rich_3col_map', 'compact_2col'] as const;
export const FooterStyle = z.enum(FOOTER_STYLES);
export type FooterStyle = z.infer<typeof FooterStyle>;

/* ── The document ───────────────────────────────────────────────────────── */

/**
 * Generation document A: the whole site's structure, theme and typed SEO inputs.
 *
 * `inputSafety` is the model's own report on the tenant's free-text intake. It is a
 * signal for the moderation ladder, never a control-flow decision on its own — an
 * injected intake would obviously report itself clean.
 */
export const SiteStructureGen = z.object({
  schemaVersion: GenSchemaVersion,
  theme: ThemeGen,
  primaryLocale: Locale,
  pages: z.array(PageGen),
  jsonLd: JsonLdInputsGen,
  navStyle: NavStyle,
  footerStyle: FooterStyle,
  whatsappEnabled: z.boolean(),
  /** 2–4 words; code composes the final stock-media query and hashes it for caching. */
  stockQueryHint: z.string(),
  inputSafety: z.object({
    containsInstructions: z.boolean(),
    note: z.string(),
  }),
});
export type SiteStructureGen = z.infer<typeof SiteStructureGen>;
