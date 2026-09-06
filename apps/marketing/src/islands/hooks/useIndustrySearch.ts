/**
 * The industry combobox's matching engine. Entirely client-side, zero network per keystroke.
 *
 * The taxonomy arrives once with `GET /v1/bootstrap` (~14 KB, `public, max-age=3600`, ETagged) and
 * is searched in memory. A server round trip per keystroke would put 40–120 ms between a letter and
 * its results on a mobile connection, which is precisely the latency at which people stop trusting
 * a search box and start scrolling the list instead.
 *
 * SCORING LADDER (architecture §S6, UX §2.2), highest wins:
 *
 *   100  label, exact          `kapsalon` → Kapsalon
 *    90  label, prefix         `kaps` → Kapsalon
 *    85  alias, exact          `kapper` → Kapsalon
 *    75  alias, prefix         `kapp` → Kapsalon
 *    60  substring at a word boundary   `salon` → Schoonheidssalon
 *    45  Damerau-Levenshtein ≤ 2        `kapsaon` → Kapsalon
 *
 * Ties break on display order (`sort_order`), never alphabetically: the taxonomy is ordered by how
 * often a trade is picked, and alphabetical ordering would put `Aannemer` above `Kapsalon` for
 * every ambiguous query in the Dutch market.
 *
 * ALIASES MATTER MORE THAN LABELS. A Dutch hairdresser types `kapper`, which is not the label; an
 * expat types `hairdresser`, which is not the Dutch label either. `searchTerms` carries both, which
 * is why the alias rungs sit above the substring rung.
 */

import { useMemo } from 'react';
import type { Locale } from '@aibuilder/core';

import type { BootstrapGroup, BootstrapIndustry } from '../../lib/api';
import { containsAtWordBoundary, damerauLevenshtein, fold } from '../../lib/text';

/** Score awarded by each rung. Exported so the ordering can be asserted in a test. */
export const SCORE = {
  labelExact: 100,
  labelPrefix: 90,
  aliasExact: 85,
  aliasPrefix: 75,
  substring: 60,
  fuzzy: 45,
} as const;

/** Shortest query that gets fuzzy matching. Below this every three-letter word is within 2 edits. */
const MIN_FUZZY_LENGTH = 4;

/** Most rows rendered at once. A listbox longer than this is a scroll, not a choice. */
const MAX_RESULTS = 12;

/** One scored row. */
export interface IndustryMatch {
  readonly industry: BootstrapIndustry;
  readonly score: number;
  /** Display order of the industry in the taxonomy; the tie-break. */
  readonly order: number;
}

/** Matches under one parent group, for the `role="group"` structure of the listbox. */
export interface IndustryGroupResult {
  readonly group: BootstrapGroup;
  readonly matches: readonly IndustryMatch[];
}

/**
 * The eight trades a Dutch visitor is most likely to pick, shown as chips before they type.
 *
 * An empty combobox with no suggestions is a blank page; eight chips turn step 2 into one tap for a
 * large share of the market. The list is per-country because a Belgian visitor's eight are not a
 * Dutch visitor's, and the fallback is the taxonomy's own leading entries — which are ordered by
 * pick frequency, so it degrades into exactly the right thing.
 */
const POPULAR_BY_COUNTRY: Readonly<Record<string, readonly string[]>> = {
  NL: [
    'hairdresser',
    'restaurant',
    'plumber',
    'physiotherapist',
    'cafe',
    'beauty_salon',
    'general_contractor',
    'photographer',
  ],
  BE: [
    'hairdresser',
    'restaurant',
    'bakery',
    'plumber',
    'beauty_salon',
    'physiotherapist',
    'car_repair',
    'florist',
  ],
  DE: [
    'hairdresser',
    'restaurant',
    'bakery',
    'car_repair',
    'physiotherapist',
    'electrician',
    'beauty_salon',
    'photographer',
  ],
};

/** Scores one industry against a folded query. `0` means no match. */
function scoreIndustry(
  industry: BootstrapIndustry,
  folded: string,
  collator: Intl.Collator,
  rawQuery: string,
): number {
  const label = fold(industry.label);

  // The exact test goes through the collator rather than through the folded strings, because
  // "is this the same word in this language" is a collation question: `Café` and `cafe` are equal
  // at base sensitivity in every locale, and only the collator knows the locale's own rules.
  if (collator.compare(industry.label, rawQuery) === 0) {
    return SCORE.labelExact;
  }
  if (label === folded) {
    return SCORE.labelExact;
  }
  if (label.startsWith(folded)) {
    return SCORE.labelPrefix;
  }

  let best = 0;
  for (const term of industry.searchTerms) {
    const alias = fold(term);
    if (alias === folded) {
      return SCORE.aliasExact;
    }
    if (alias.startsWith(folded)) {
      best = Math.max(best, SCORE.aliasPrefix);
    }
  }
  if (best > 0) {
    return best;
  }

  if (containsAtWordBoundary(label, folded)) {
    return SCORE.substring;
  }
  for (const term of industry.searchTerms) {
    if (containsAtWordBoundary(fold(term), folded)) {
      return SCORE.substring;
    }
  }

  if (folded.length >= MIN_FUZZY_LENGTH) {
    if (damerauLevenshtein(label, folded, 2) <= 2) {
      return SCORE.fuzzy;
    }
    for (const term of industry.searchTerms) {
      if (damerauLevenshtein(fold(term), folded, 2) <= 2) {
        return SCORE.fuzzy;
      }
    }
  }

  return 0;
}

/** What the combobox renders. */
export interface UseIndustrySearchResult {
  /** Flat, ranked. This is the `aria-activedescendant` traversal order. */
  readonly matches: readonly IndustryMatch[];
  /** The same matches under their parent groups, in rank order of their best match. */
  readonly grouped: readonly IndustryGroupResult[];
  /** Chips shown when the query is empty. */
  readonly popular: readonly BootstrapIndustry[];
}

/**
 * Ranks the taxonomy against a query.
 *
 * Guarantees a stable order for equal scores (display order), at most `MAX_RESULTS` rows, and no
 * allocation at all when the query is empty — the popular chips are computed once per taxonomy.
 */
export function useIndustrySearch(params: {
  industries: readonly BootstrapIndustry[];
  groups: readonly BootstrapGroup[];
  query: string;
  locale: Locale;
  country: string | null;
}): UseIndustrySearchResult {
  const { industries, groups, query, locale, country } = params;

  const popular = useMemo<readonly BootstrapIndustry[]>(() => {
    const byKey = new Map(industries.map((industry) => [industry.key, industry]));
    const keys = POPULAR_BY_COUNTRY[country ?? ''] ?? [];
    const picked = keys
      .map((key) => byKey.get(key))
      .filter((industry): industry is BootstrapIndustry => industry !== undefined);
    return picked.length > 0 ? picked : industries.slice(0, 8);
  }, [industries, country]);

  const collator = useMemo(() => new Intl.Collator(locale, { sensitivity: 'base' }), [locale]);

  const matches = useMemo<readonly IndustryMatch[]>(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return [];
    }
    const folded = fold(trimmed);
    const scored: IndustryMatch[] = [];
    industries.forEach((industry, order) => {
      const score = scoreIndustry(industry, folded, collator, trimmed);
      if (score > 0) {
        scored.push({ industry, score, order });
      }
    });
    scored.sort((a, b) => (b.score === a.score ? a.order - b.order : b.score - a.score));
    return scored.slice(0, MAX_RESULTS);
  }, [industries, query, collator]);

  const grouped = useMemo<readonly IndustryGroupResult[]>(() => {
    const byGroup = new Map<string, IndustryMatch[]>();
    for (const match of matches) {
      const bucket = byGroup.get(match.industry.groupKey);
      if (bucket === undefined) {
        byGroup.set(match.industry.groupKey, [match]);
      } else {
        bucket.push(match);
      }
    }
    const groupByKey = new Map(groups.map((group) => [group.key, group]));
    const result: IndustryGroupResult[] = [];
    // Iteration order of the map is insertion order, which is rank order of each group's best
    // match — so the group containing the top hit is rendered first.
    for (const [key, groupMatches] of byGroup) {
      const group = groupByKey.get(key);
      if (group !== undefined) {
        result.push({ group, matches: groupMatches });
      }
    }
    return result;
  }, [matches, groups]);

  return { matches, grouped, popular };
}
