import { z } from 'zod';

/**
 * Model-facing primitives shared by every generation document.
 *
 * RULES FOR THIS DIRECTORY (`src/gen/**`) — see `gen/section.ts` for the full
 * invariant block:
 *   - flat and non-recursive;
 *   - every field REQUIRED and `.nullable()` — never `.optional()`;
 *   - every bounded value is a `z.enum`, because enums are the only constraint the
 *     API's grammar-constrained decoder actually enforces;
 *   - NO `.regex()`, `.min()`, `.max()`, `.length()`. Those are stripped or rejected
 *     before the request leaves the SDK and would then fire client-side *after* a
 *     30K-token generation has already been paid for. Every such constraint lives in
 *     `normalize.ts`, which clamps and never throws.
 */

/* ── Locale ─────────────────────────────────────────────────────────────── */

/** UI + content locales supported by the product. `nl` is the primary market. */
export const LOCALES = ['nl', 'en', 'de', 'fr', 'es', 'pt'] as const;

/** Locale of a generated document. */
export const Locale = z.enum(LOCALES);
export type Locale = z.infer<typeof Locale>;

/** Type guard for untrusted locale strings (query params, D1 columns, model output). */
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/* ── Schema version ─────────────────────────────────────────────────────── */

/**
 * Version stamp on every *generation* document.
 *
 * It is a string here and a number on `SiteDoc` on purpose: grammar-constrained
 * decoding handles string literals most reliably, while migrations compare versions
 * numerically. `genToDoc()` performs the one conversion.
 */
export const GenSchemaVersion = z.literal('1');
export type GenSchemaVersion = z.infer<typeof GenSchemaVersion>;

/* ── Theme knobs ────────────────────────────────────────────────────────── */

/**
 * Accent hue rotation in OKLCH degrees, as a string enum.
 *
 * A number with `min`/`max` would be an unenforced constraint; five discrete steps
 * are a grammar-enforced one, and ±30° is the whole useful range before the accent
 * stops belonging to the design DNA it was derived from.
 */
export const HUE_SHIFTS = ['-30', '-15', '0', '15', '30'] as const;
export const Hue = z.enum(HUE_SHIFTS);
export type Hue = z.infer<typeof Hue>;

/**
 * Design-DNA presets available to the model. Phase 1 ships four archetypes end to
 * end; the remaining twenty land in Phase 2 with the editor.
 */
export const DNA_IDS = [
  'midnight_neon',
  'warm_trattoria',
  'clinical_trust',
  'garage_steel',
] as const;
export const DnaId = z.enum(DNA_IDS);
export type DnaId = z.infer<typeof DnaId>;

/** Which of the DNA's pre-computed palettes to use. */
export const PALETTE_VARIANTS = ['default', 'alt', 'inverse'] as const;
export const PaletteVariant = z.enum(PALETTE_VARIANTS);
export type PaletteVariant = z.infer<typeof PaletteVariant>;

export const TYPE_SCALE_IDS = ['compact', 'regular', 'editorial', 'display'] as const;
export const TypeScaleId = z.enum(TYPE_SCALE_IDS);
export type TypeScaleId = z.infer<typeof TypeScaleId>;

export const RADIUS_IDS = ['sharp', 'soft', 'round', 'pill'] as const;
export const RadiusId = z.enum(RADIUS_IDS);
export type RadiusId = z.infer<typeof RadiusId>;

export const DENSITY_IDS = ['compact', 'regular', 'airy'] as const;
export const DensityId = z.enum(DENSITY_IDS);
export type DensityId = z.infer<typeof DensityId>;

export const MOTION_IDS = ['none', 'subtle', 'expressive'] as const;
export const MotionId = z.enum(MOTION_IDS);
export type MotionId = z.infer<typeof MotionId>;

export const COLOR_MODES = ['light', 'dark'] as const;
export const ColorMode = z.enum(COLOR_MODES);
export type ColorMode = z.infer<typeof ColorMode>;

/* ── Icons ──────────────────────────────────────────────────────────────── */

/**
 * The closed icon set. The model picks an id; `site-kit` owns the SVG paths, so no
 * model string ever reaches an `<svg>`.
 */
export const ICON_IDS = [
  'clock',
  'shield',
  'star',
  'leaf',
  'truck',
  'heart',
  'wrench',
  'scissors',
  'cup',
  'sparkle',
  'euro',
  'phone',
] as const;
export const IconId = z.enum(ICON_IDS);
export type IconId = z.infer<typeof IconId>;

/* ── Media ──────────────────────────────────────────────────────────────── */

export const FOCAL_POINTS = ['center', 'top', 'bottom', 'left', 'right'] as const;
export const FocalPoint = z.enum(FOCAL_POINTS);
export type FocalPoint = z.infer<typeof FocalPoint>;

/**
 * A symbolic reference into the server-built media manifest.
 *
 * `refId` is an index, never a URL and never an R2 key: the model can only point at
 * assets the pipeline already uploaded, and `normalize()` nulls out any ref that is
 * not in the manifest.
 */
export const MediaRef = z.object({
  refId: z.string(),
  focalPoint: FocalPoint,
});
export type MediaRef = z.infer<typeof MediaRef>;

/* ── Links ──────────────────────────────────────────────────────────────── */

export const LINK_KINDS = [
  'page',
  'anchor',
  'tel',
  'whatsapp',
  'email',
  'route',
  'external',
] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/**
 * The ONLY way the model addresses the outside world (invariant 2).
 *
 * There is no `href` here and there never will be. `tel:`/`wa.me:`/`mailto:` targets
 * are built by code from the CHECK-constrained D1 columns; `external` indexes a
 * server-built allowlist that is `https:`-only; `page`/`anchor` are resolved against
 * the document's own ids at render time.
 *
 * The value-less kinds carry `_: z.null()` because the gen layer forbids optional
 * fields, and a discriminated-union member with no payload confuses several
 * structured-output grammars.
 */
export const LinkRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('page'), pageId: z.string() }),
  z.object({ kind: z.literal('anchor'), sectionId: z.string() }),
  z.object({ kind: z.literal('tel'), _: z.null() }),
  z.object({ kind: z.literal('whatsapp'), _: z.null() }),
  z.object({ kind: z.literal('email'), _: z.null() }),
  z.object({ kind: z.literal('route'), _: z.null() }),
  z.object({ kind: z.literal('external'), refId: z.string() }),
]);
export type LinkRef = z.infer<typeof LinkRef>;

export const CTA_STYLES = ['primary', 'secondary', 'ghost'] as const;
export const CtaStyle = z.enum(CTA_STYLES);
export type CtaStyle = z.infer<typeof CtaStyle>;

/**
 * A call to action.
 *
 * There is no `labelSlot`: the label's slot id is DERIVED as
 * `${sectionId}.ctas.${index}.label` by `deriveSlotInventory()`, which is what makes
 * `validateBundle()` a real check rather than model output compared against model
 * output.
 */
export const Cta = z.object({
  target: LinkRef,
  style: CtaStyle,
});
export type Cta = z.infer<typeof Cta>;
