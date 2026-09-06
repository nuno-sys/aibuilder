/**
 * Normalisation and stripping of user text that will reach the model.
 *
 * Architecture §8: prompt injection is defeated *structurally* by the four §4 invariants — the model
 * cannot author a URL, CSS, JSON-LD or markup, so a fully successful injection yields bad copy, not
 * code execution. This module is the second layer, and it exists because the first layer says
 * nothing about text that is invisible to the human who typed it:
 *
 *   - **bidi overrides** reorder rendered text without changing its bytes, so a reviewer approving
 *     a description can be shown something different from what the model receives;
 *   - **zero-width characters** hide an instruction inside an innocuous sentence and survive a
 *     copy/paste review;
 *   - **Unicode tag characters** (U+E0000-U+E007F) encode an entire ASCII payload that renders as
 *     absolutely nothing anywhere;
 *   - **control and format characters** break the nonce-wrapped envelope that separates untrusted
 *     tenant data from the task instruction.
 *
 * NFKC runs first so compatibility forms (fullwidth Latin, ligatures, styled maths letters) collapse
 * to the characters a downstream filter would actually recognise.
 *
 * Every pattern below is written with `\u` escapes on purpose: the characters they match are by
 * definition invisible, and a literal one in this file would be unreviewable in a diff.
 *
 * This is a *normaliser*, not a validator: it always returns a string and never throws. Use
 * `inspectForModel()` when the abuse signal matters — `abuse_events` gets a row when a submission
 * contained hidden characters, because no legitimate bakery types a bidi override into its opening
 * description.
 */

/** Left-to-right/right-to-left marks, embeddings, overrides and isolates. */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** Zero-width space/non-joiner/joiner, word joiner, invisible operators and the BOM. */
const ZERO_WIDTH = /[\u200B-\u200D\u2060-\u2064\uFEFF]/gu;

/** Unicode tag characters — a complete invisible ASCII channel. */
const TAG_CHARACTERS = /[\u{E0000}-\u{E007F}]/gu;

/**
 * Variation selectors supplement. The BMP selectors (U+FE00-U+FE0F) are deliberately left alone:
 * U+FE0F is what makes an emoji render as an emoji, and emoji in business copy are legitimate.
 */
const VARIATION_SELECTORS = /[\u{E0100}-\u{E01EF}]/gu;

/** C0 and C1 controls, keeping `\t`, `\n` and `\r` (normalised separately below). */
// eslint-disable-next-line no-control-regex -- matching control characters is this module's job.
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

/** Everything else in the `Cf` (format) category, including the soft hyphen. */
const REMAINING_FORMAT = /\p{Cf}/gu;

/** Which class of hidden character was found. */
export type RedactionCategory =
  'bidi' | 'zero_width' | 'tag' | 'variation_selector' | 'control' | 'format';

/** What `inspectForModel()` found and removed. */
export interface RedactionReport {
  /** The cleaned text. Identical to `redactForModel()`'s return value. */
  readonly text: string;
  /** Number of characters removed, excluding whitespace collapsing. */
  readonly removed: number;
  /** Classes of hidden character that were present, in detection order. */
  readonly categories: readonly RedactionCategory[];
}

/** One strip pass: the pattern, and the label reported when it matches. */
const PASSES: readonly (readonly [RegExp, RedactionCategory])[] = [
  [BIDI_CONTROLS, 'bidi'],
  [ZERO_WIDTH, 'zero_width'],
  [TAG_CHARACTERS, 'tag'],
  [VARIATION_SELECTORS, 'variation_selector'],
  [CONTROLS, 'control'],
  [REMAINING_FORMAT, 'format'],
];

/**
 * Normalises and strips one piece of user text, reporting what was removed.
 *
 * Guarantees the result contains no bidi control, no zero-width character, no Unicode tag character
 * and no control or format character; that line endings are `\n`; that horizontal whitespace runs
 * are single spaces; and that there are never more than two consecutive newlines. Paragraph
 * structure survives, because it carries meaning in a business description.
 */
export function inspectForModel(text: string): RedactionReport {
  let out = text.normalize('NFKC');
  const categories: RedactionCategory[] = [];
  let removed = 0;

  for (const [pattern, category] of PASSES) {
    const before = out.length;
    // `String.replace` with a global regex resets `lastIndex`, which is why these shared patterns
    // are only ever used through `replace` and never through `test`.
    out = out.replace(pattern, '');
    const delta = before - out.length;
    if (delta > 0) {
      removed += delta;
      categories.push(category);
    }
  }

  out = out
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text: out, removed, categories };
}

/**
 * Normalises and strips one piece of user text for the prompt.
 *
 * The convenience form of `inspectForModel()`. Every untrusted string that enters the
 * `<business_facts>` message goes through this: architecture §8 requires it, and the nonce-wrapped
 * envelope depends on it.
 */
export function redactForModel(text: string): string {
  return inspectForModel(text).text;
}

/**
 * Applies `redactForModel()` to every string value of a flat record.
 *
 * The prompt builder assembles the facts block from a record of tenant strings; doing this in one
 * call is what stops a newly added field from reaching the block unredacted.
 */
export function redactRecordForModel<K extends string>(
  values: Readonly<Record<K, string | null>>,
): Readonly<Record<K, string | null>> {
  const out: Partial<Record<K, string | null>> = {};
  for (const [key, value] of Object.entries(values) as [K, string | null][]) {
    out[key] = value === null ? null : redactForModel(value);
  }
  return out as Readonly<Record<K, string | null>>;
}

/**
 * True when the text contained characters no human types by accident.
 *
 * Intended as an abuse signal, not a rejection: a legitimate paste out of Word can contain a soft
 * hyphen, so the caller scores it rather than blocking on it.
 */
export function containsHiddenCharacters(text: string): boolean {
  return inspectForModel(text).categories.length > 0;
}
