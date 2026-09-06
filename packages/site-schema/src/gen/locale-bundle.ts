import { z } from 'zod';
import { GenSchemaVersion, Locale } from './common';

/**
 * `LocaleBundleGen` — generation document B: every visible string of one locale.
 *
 * Deliberately a flat `entries[]` array rather than an object keyed by slot id:
 * dynamic object keys cannot be expressed in the structured-output grammar, and a
 * flat list makes translation a pure `entries[] -> entries[]` map, the editor's left
 * panel a flat list of rows, and D1 storage exactly one blob per `(page, locale)`.
 *
 * `id` is not free-form in practice — `validateBundle()` proves the key set is
 * exactly `deriveSlotInventory(structure)`, and `normalizeLocaleBundle()` drops
 * anything the model invented.
 */
export const LocaleBundleGen = z.object({
  schemaVersion: GenSchemaVersion,
  locale: Locale,
  entries: z.array(
    z.object({
      id: z.string(),
      /** Plain text. Escaped at render; no markup is ever interpreted. */
      text: z.string(),
    }),
  ),
});
export type LocaleBundleGen = z.infer<typeof LocaleBundleGen>;

/** One `(slotId, text)` pair from a locale bundle. */
export type LocaleBundleEntry = LocaleBundleGen['entries'][number];
