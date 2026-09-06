/**
 * The quality gate — **WARN-ONLY**, and that is a decision with a date on it.
 *
 * Architecture §7.27 and §10 risk 3, adopted verbatim: the original design gated `index_state` on a
 * MinHash near-duplicate threshold of 0.35 that was *asserted and never calibrated*. Two bakeries
 * generated from the same archetype share a footer, an address block, an opening-hours table, a
 * cookie statement and a privacy policy — before a word of their actual copy is compared. On text
 * shingles that routinely clears 0.35, so the gate as specified would have silently `noindex`ed the
 * paying customer base, and the dashboard remediation it offered ("add two photos") cannot move a
 * text-only similarity score at all.
 *
 * So this module ships with **no blocking threshold**. Every check computes and reports its score;
 * `thresholdCalibrated` is `false` on all of them; `blocking` is `false` on the report. The
 * threshold is set from the observed distribution over 200 fixture sites, with a stated
 * false-positive target, before anything is allowed to read this to withhold indexing. Until then
 * the gate's job is to produce the distribution, not to act on it.
 *
 * Every check carries its own `remediation`, because a score with no action attached is a support
 * ticket rather than a signal, and support needs a manual override that does not depend on this
 * code agreeing.
 *
 * Pure: no bindings, no clock, no randomness. The MinHash permutations are seeded from constants,
 * so the same site scores identically on every run and across deploys — a similarity score that
 * moves on its own is not evidence of anything.
 */

/* -- Report shape ------------------------------------------------------------------------------ */

/** Identifier of one check. Stable: it is written to `site_versions.quality_report` and grepped. */
export type QualityCheckId =
  | 'facts_completeness'
  | 'content_thinness'
  | 'cross_site_uniqueness'
  | 'owned_media'
  | 'doorway_pages';

/** One check's observation. */
export interface QualityCheckResult {
  readonly id: QualityCheckId;
  /**
   * Normalised 0..1, where 1 is best. Comparable across sites; that is what makes the eventual
   * calibration possible.
   */
  readonly score: number;
  /** The raw numbers behind `score`, so a distribution can be re-derived without a re-run. */
  readonly observed: Readonly<Record<string, number>>;
  /**
   * The threshold this check WOULD use, once calibrated. Reported so the eventual cut can be
   * simulated over historical reports rather than guessed a second time.
   */
  readonly provisionalThreshold: number;
  /** Always `false` in this phase. A check may not block until this is `true` (§10 risk 3). */
  readonly thresholdCalibrated: boolean;
  /** True when the score is below `provisionalThreshold`. Advisory only. */
  readonly wouldFail: boolean;
  /** What a human can actually do about it. Empty when the check passed. */
  readonly remediation: string;
}

/** The stored verdict. */
export interface QualityReport {
  /** Report format version, so a calibration run can skip shapes it does not understand. */
  readonly v: 1;
  /**
   * `pass` when no check is below its provisional threshold, `warn` otherwise.
   *
   * Never `fail`. `site_versions.quality_state` accepts `fail`, and nothing in this phase writes it.
   */
  readonly state: 'pass' | 'warn';
  /** Always `false`. Present in the stored JSON so a reader cannot mistake `warn` for a block. */
  readonly blocking: false;
  readonly checks: readonly QualityCheckResult[];
}

/* -- Input ------------------------------------------------------------------------------------- */

/** One page, reduced to what the gate looks at. */
export interface QualityPageInput {
  readonly pageKey: string;
  readonly locale: string;
  readonly path: string;
  readonly title: string;
  readonly description: string;
  /** Every rendered copy slot on the page, concatenated. Not the HTML. */
  readonly text: string;
  readonly indexable: boolean;
}

/** The verified facts, as booleans — the gate never sees the values, only whether they exist. */
export interface QualityFactsInput {
  readonly hasBusinessName: boolean;
  readonly hasAddressOrServiceArea: boolean;
  readonly hasPhone: boolean;
  readonly hasOpeningHours: boolean;
  readonly hasDescription: boolean;
  readonly hasRegistrationId: boolean;
}

/** What the gate is run over. */
export interface QualityGateInput {
  readonly pages: readonly QualityPageInput[];
  readonly facts: QualityFactsInput;
  /** Media the tenant uploaded themselves, and the total including re-hosted stock. */
  readonly ownedMediaCount: number;
  readonly totalMediaCount: number;
  /**
   * MinHash signatures of other sites to compare against, if any.
   *
   * Empty is the normal case for a first publish and yields a perfect uniqueness score — which is
   * honest: with nothing to compare against, there is no evidence of duplication. A nightly job
   * supplies the corpus once one exists.
   */
  readonly corpus: readonly MinHashSignature[];
}

/* -- MinHash ----------------------------------------------------------------------------------- */

/** Number of permutations. 64 gives a Jaccard standard error around 0.125 — enough to bin, not to cut. */
export const MINHASH_PERMUTATIONS = 64;

/** Words per shingle. Five is the usual near-duplicate window for prose. */
export const SHINGLE_SIZE = 5;

/** A site's MinHash signature: one 32-bit minimum per permutation. */
export type MinHashSignature = readonly number[];

/** FNV-1a, 32-bit, seeded. Deterministic across runtimes; no crypto and no allocation per byte. */
function fnv1a(input: string, seed: number): number {
  let hash = (2166136261 ^ seed) >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash ^ input.charCodeAt(index)) >>> 0;
    // 16777619, expressed as shifts so the multiply stays inside 32 bits on every engine.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Normalises text for shingling: lowercase, letters and digits only, single-spaced.
 *
 * Punctuation and casing are stripped because they are the first thing a template varies and the
 * last thing a reader notices; keeping them would let two identical pages score as different.
 */
export function normaliseForShingles(text: string): readonly string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length > 0);
}

/** Builds the w-shingle set of a text. */
export function shingles(text: string, size: number = SHINGLE_SIZE): readonly string[] {
  const words = normaliseForShingles(text);
  if (words.length < size) return words.length === 0 ? [] : [words.join(' ')];
  const out: string[] = [];
  for (let index = 0; index + size <= words.length; index += 1) {
    out.push(words.slice(index, index + size).join(' '));
  }
  return out;
}

/**
 * Computes a MinHash signature.
 *
 * An empty document yields an all-`0xffffffff` signature, which compares as maximally dissimilar to
 * everything — including to another empty document. That is deliberate: two empty pages are not
 * evidence of duplication, they are evidence of a thin site, and `content_thinness` is the check
 * that should say so.
 */
export function minHashSignature(text: string): MinHashSignature {
  const signature = new Array<number>(MINHASH_PERMUTATIONS).fill(0xffffffff);
  for (const shingle of shingles(text)) {
    for (let permutation = 0; permutation < MINHASH_PERMUTATIONS; permutation += 1) {
      const hashed = fnv1a(shingle, permutation * 0x9e3779b1);
      const current = signature[permutation];
      if (current !== undefined && hashed < current) signature[permutation] = hashed;
    }
  }
  return signature;
}

/** Estimated Jaccard similarity of two signatures: the fraction of permutations that agree. */
export function estimateJaccard(a: MinHashSignature, b: MinHashSignature): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let matches = 0;
  for (let index = 0; index < length; index += 1) {
    if (a[index] === b[index]) matches += 1;
  }
  return matches / length;
}

/* -- The checks -------------------------------------------------------------------------------- */

/** Words below which a page is considered thin. Provisional — see the module header. */
export const THIN_PAGE_WORDS = 120;

/** Provisional similarity above which a site would be considered a near-duplicate. */
export const PROVISIONAL_MAX_SIMILARITY = 0.6;

function result(
  id: QualityCheckId,
  score: number,
  observed: Readonly<Record<string, number>>,
  provisionalThreshold: number,
  remediation: string,
): QualityCheckResult {
  const wouldFail = score < provisionalThreshold;
  return {
    id,
    score: Math.max(0, Math.min(1, score)),
    observed,
    provisionalThreshold,
    thresholdCalibrated: false,
    wouldFail,
    remediation: wouldFail ? remediation : '',
  };
}

/** Fraction of the six verified facts this site actually has. */
function checkFacts(facts: QualityFactsInput): QualityCheckResult {
  const flags = [
    facts.hasBusinessName,
    facts.hasAddressOrServiceArea,
    facts.hasPhone,
    facts.hasOpeningHours,
    facts.hasDescription,
    facts.hasRegistrationId,
  ];
  const present = flags.filter(Boolean).length;
  return result(
    'facts_completeness',
    present / flags.length,
    { present, total: flags.length },
    // A `LocalBusiness` graph needs a name, a location and a way to be contacted; the other three
    // improve it. Four of six is the point below which the markup starts losing rich results.
    4 / 6,
    'Add the missing business details — opening hours, a company registration number and a short description are the three that most often move a local result.',
  );
}

/** Fraction of indexable pages carrying more than `THIN_PAGE_WORDS` of copy. */
function checkThinness(pages: readonly QualityPageInput[]): QualityCheckResult {
  const indexable = pages.filter((page) => page.indexable);
  if (indexable.length === 0) {
    return result('content_thinness', 1, { pages: 0, thin: 0, medianWords: 0 }, 0.7, '');
  }
  const counts = indexable
    .map((page) => normaliseForShingles(page.text).length)
    .sort((a, b) => a - b);
  const thin = counts.filter((count) => count < THIN_PAGE_WORDS).length;
  const middle = Math.floor(counts.length / 2);
  const median =
    counts.length % 2 === 1
      ? (counts[middle] ?? 0)
      : ((counts[middle - 1] ?? 0) + (counts[middle] ?? 0)) / 2;
  return result(
    'content_thinness',
    (indexable.length - thin) / indexable.length,
    { pages: indexable.length, thin, medianWords: median },
    0.7,
    'Some pages have very little copy. Expand them, or set them to noindex so they are not competing with the pages that do.',
  );
}

/**
 * How unlike every other site in the corpus this one is.
 *
 * `score = 1 - maxSimilarity`. Reported, never acted on. See the module header for why the
 * threshold that used to be here was removed rather than tuned.
 */
function checkUniqueness(
  pages: readonly QualityPageInput[],
  corpus: readonly MinHashSignature[],
): QualityCheckResult {
  const combined = pages.map((page) => page.text).join('\n');
  const signature = minHashSignature(combined);
  let worst = 0;
  for (const other of corpus) {
    const similarity = estimateJaccard(signature, other);
    if (similarity > worst) worst = similarity;
  }
  return result(
    'cross_site_uniqueness',
    1 - worst,
    { maxSimilarity: worst, corpusSize: corpus.length },
    1 - PROVISIONAL_MAX_SIMILARITY,
    'This site reads much like another one we generated. Rewrite the home and services copy in the words the business actually uses.',
  );
}

/** Fraction of media the tenant supplied rather than stock. */
function checkOwnedMedia(owned: number, total: number): QualityCheckResult {
  if (total === 0) {
    return result(
      'owned_media',
      0,
      { owned: 0, total: 0 },
      0.25,
      'The site has no images at all. Two or three real photographs of the business do more for a local result than any amount of copy.',
    );
  }
  return result(
    'owned_media',
    owned / total,
    { owned, total },
    0.25,
    'Most images are stock. Replacing the hero and one gallery image with real photographs is the single highest-value change here.',
  );
}

/**
 * Detects doorway pages: near-identical pages within the SAME site.
 *
 * This is the check the original threshold should have been on. Cross-site similarity is dominated
 * by shared boilerplate; within one site, two pages that differ only by a city name are the actual
 * pattern that earns a manual action (§7.28), and they are cheap to detect because the boilerplate
 * is common to both and therefore cancels out of neither — the similarity is genuinely near 1.
 */
function checkDoorways(pages: readonly QualityPageInput[]): QualityCheckResult {
  const indexable = pages.filter((page) => page.indexable);
  const signatures = indexable.map((page) => minHashSignature(page.text));
  let worst = 0;
  let pairs = 0;
  for (let i = 0; i < signatures.length; i += 1) {
    for (let j = i + 1; j < signatures.length; j += 1) {
      const a = signatures[i];
      const b = signatures[j];
      if (a === undefined || b === undefined) continue;
      pairs += 1;
      const similarity = estimateJaccard(a, b);
      if (similarity > worst) worst = similarity;
    }
  }
  return result(
    'doorway_pages',
    1 - worst,
    { maxPairSimilarity: worst, comparedPairs: pairs },
    // Two pages on one site that agree on 80% of their five-word shingles are the same page.
    0.2,
    'Two pages on this site are nearly identical. Merge them, or give each one content that is genuinely about a different thing.',
  );
}

/* -- Entry point ------------------------------------------------------------------------------- */

/**
 * Runs every check and returns the report.
 *
 * NEVER THROWS AND NEVER BLOCKS. The caller stores the report against the version and continues.
 * A gate that can fail a publish is a gate that can take a paying customer's site offline for a
 * threshold nobody has measured, which is the exact outcome §10 risk 3 exists to prevent.
 */
export function runQualityGate(input: QualityGateInput): QualityReport {
  const checks: readonly QualityCheckResult[] = [
    checkFacts(input.facts),
    checkThinness(input.pages),
    checkUniqueness(input.pages, input.corpus),
    checkOwnedMedia(input.ownedMediaCount, input.totalMediaCount),
    checkDoorways(input.pages),
  ];
  return {
    v: 1,
    state: checks.some((check) => check.wouldFail) ? 'warn' : 'pass',
    blocking: false,
    checks,
  };
}
