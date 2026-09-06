/**
 * String primitives shared by the validators and the industry search.
 *
 * They live together because they are the same three ideas — fold, compare, sanitise — and because
 * `useIndustrySearch` and `validation.ts` would otherwise each grow their own edit-distance
 * implementation that drifts from the other's.
 */

/**
 * Characters that are invisible, change the direction of the text around them, or both.
 *
 * Stripped from every free-text field before it is stored. A zero-width joiner inside a business
 * name silently breaks the slug; a U+202E RIGHT-TO-LEFT OVERRIDE inside one makes a filename
 * ending in `.exe` render as though it ended in `.jpg` wherever that name is echoed.
 * Neither is ever intentional in a Dutch shop name, and both are cheap to remove here rather than
 * to defend against in six render paths.
 */
const INVISIBLE_PATTERN = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Removes zero-width and bidirectional-control characters. */
export function stripInvisible(value: string): string {
  return value.replace(INVISIBLE_PATTERN, '');
}

/** Trims, then collapses every run of whitespace to a single space. */
export function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** `stripInvisible` + `collapseWhitespace`, the normalisation every free-text field gets. */
export function normaliseFreeText(value: string): string {
  return collapseWhitespace(stripInvisible(value));
}

/**
 * Lowercase, diacritic-free form used for matching.
 *
 * NFD decomposition plus removal of the combining marks, so `Café`, `CAFE` and `cafe` all fold to
 * `cafe`. This is the matching key; `Intl.Collator(locale, { sensitivity: 'base' })` is used
 * separately for the *exact-match* test, where the locale's own collation rules are what decide
 * whether two strings are the same word.
 */
export function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/**
 * Optimal string alignment distance, capped.
 *
 * This is the Damerau-Levenshtein variant with adjacent transposition — `kapsaoln` → `kapsalon` is
 * one edit, not two, which matters because transposition is the single most common typing error.
 * (It is the *restricted* variant: a substring is not edited twice. For a ≤ 2 threshold over short
 * words the unrestricted version cannot disagree.)
 *
 * `maxDistance` bounds the work: the function returns `maxDistance + 1` as soon as every cell of a
 * row exceeds the threshold, which turns a full O(n·m) matrix into an early exit for the ~99 % of
 * candidate pairs that are nowhere near each other.
 */
export function damerauLevenshtein(a: string, b: string, maxDistance = 2): number {
  if (a === b) {
    return 0;
  }
  if (Math.abs(a.length - b.length) > maxDistance) {
    return maxDistance + 1;
  }
  if (a.length === 0 || b.length === 0) {
    return Math.max(a.length, b.length);
  }

  let previousPrevious: number[] = [];
  let previous: number[] = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  // Assigned at the top of every iteration before it is read, and never read after the loop.
  let current: number[];

  for (let i = 1; i <= a.length; i += 1) {
    current = new Array<number>(b.length + 1);
    current[0] = i;
    let rowMinimum = i;

    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const deletion = (previous[j] ?? Number.MAX_SAFE_INTEGER) + 1;
      const insertion = (current[j - 1] ?? Number.MAX_SAFE_INTEGER) + 1;
      const substitution = (previous[j - 1] ?? Number.MAX_SAFE_INTEGER) + cost;
      let value = Math.min(deletion, insertion, substitution);

      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (previousPrevious[j - 2] ?? Number.MAX_SAFE_INTEGER) + 1);
      }

      current[j] = value;
      rowMinimum = Math.min(rowMinimum, value);
    }

    if (rowMinimum > maxDistance) {
      return maxDistance + 1;
    }

    previousPrevious = previous;
    previous = current;
  }

  return previous[b.length] ?? maxDistance + 1;
}

/** True when `haystack` contains `needle` at a word boundary. Both must already be folded. */
export function containsAtWordBoundary(haystack: string, needle: string): boolean {
  if (needle.length === 0) {
    return false;
  }
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    const before = index === 0 ? ' ' : haystack.charAt(index - 1);
    if (!/[\p{L}\p{N}]/u.test(before)) {
      return true;
    }
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}
