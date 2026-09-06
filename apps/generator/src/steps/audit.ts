import { assertId } from '@aibuilder/core';
import { shard, shardById } from '@aibuilder/db';
import type { PageDoc, SiteDoc } from '@aibuilder/site-schema';
import { z } from 'zod';

import { putArtifact, runArtifactKey } from '../artifacts';
import type { ArtifactRef } from '../artifacts';
import type { Env } from '../env';
import { GeneratorError } from '../errors';
import type { RunIds } from '../ids';
import type { LegalPack } from './legal';

/**
 * Step 8, `audit` — the last gate before anything is rendered or published.
 *
 * WHAT THIS STEP CAN HONESTLY CHECK TODAY, AND WHAT IT CANNOT. §7's budgets are stated in rendered
 * bytes, Lighthouse scores and contrast ratios over resolved theme tokens. Two of those three need
 * `site-kit`, which owns the `render` step and is out of this delivery. Pretending to check them
 * here — asserting a CSS budget against a document with no CSS — would be a green gate that proves
 * nothing, which is worse than an absent one. So this step checks what a `SiteDoc` alone can prove,
 * and NAMES the checks that move here when `render` lands. Each of those is listed in
 * `DEFERRED_CHECKS` and reported in the stored report, so the gap is visible in production data
 * rather than in a comment nobody reads.
 *
 * ERRORS BLOCK, WARNINGS DO NOT — and which is which is a decision, not a mood. A page with no
 * title, a hero pointing at media that does not exist, or a page with no copy at all are
 * objectively broken and block. Thinness and uniqueness are CALIBRATION-DEPENDENT: §10 risk 3 is
 * explicit that an uncalibrated threshold on template-generated sites would noindex paying
 * customers, so the quality gate is WARN-ONLY in Phase 1 and its thresholds are set from 200
 * fixture sites before it is allowed to block anything.
 */

/** Checks that belong to this step but need a rendered page. Reported, never silently skipped. */
export const DEFERRED_CHECKS: readonly string[] = [
  'css_budget_11kb',
  'inline_js_budget_4kb',
  'contrast_over_resolved_tokens',
  'lcp_poster_larger_than_video',
  'csp_no_inline_handlers',
];

/** One audit finding. */
export const AuditFindingSchema = z.object({
  code: z.string().min(1).max(64),
  severity: z.enum(['error', 'warning']),
  path: z.string().max(200),
  message: z.string().max(400),
});

/** The stored report. */
export const AuditReportSchema = z.object({
  versionId: z.string().min(1).max(64),
  state: z.enum(['pass', 'warn', 'fail']),
  findings: z.array(AuditFindingSchema),
  deferred: z.array(z.string()),
  metrics: z.object({
    pages: z.number().int().nonnegative(),
    sections: z.number().int().nonnegative(),
    blogPosts: z.number().int().nonnegative(),
    mediaAssets: z.number().int().nonnegative(),
    copyCharacters: z.number().int().nonnegative(),
  }),
});

/** An audit report. */
export type AuditReport = z.infer<typeof AuditReportSchema>;

/** One audit finding. */
export type AuditFinding = z.infer<typeof AuditFindingSchema>;

/** What the audit step hands back. */
export interface AuditResult {
  readonly report: ArtifactRef;
  readonly state: AuditReport['state'];
  readonly errorCount: number;
  readonly warningCount: number;
}

/* -- Thresholds ------------------------------------------------------------------------------- */

/**
 * Minimum visible copy on the home page, in characters.
 *
 * A number to be replaced by measurement, not a law: §10 risk 3 requires it to be set from 200
 * fixture sites with a target false-positive rate before it is ever allowed to block a publish.
 * Until then it only warns, which is why a rough figure is acceptable here and a blocking one would
 * not be.
 */
const MIN_HOME_COPY_CHARACTERS = 700;

/** Minimum visible copy on any other indexable page. */
const MIN_PAGE_COPY_CHARACTERS = 300;

/** Above this, a page is doing too much and the render budget starts to bite. */
const MAX_SECTIONS_PER_PAGE = 12;

/** How often one exact string may repeat across a site before it reads as boilerplate. */
const MAX_STRING_REPEATS = 3;

/* -- Checks ----------------------------------------------------------------------------------- */

/** Sums the visible copy of one page in one locale. */
function copyCharactersOf(doc: SiteDoc, page: PageDoc, locale: string): number {
  const copy = doc.copy[locale] ?? {};
  let total = 0;
  for (const [slotId, text] of Object.entries(copy)) {
    // Slot ids are `${sectionId}.…` for section copy and `page.${pageId}.…` for meta. Meta is not
    // visible copy and must not be counted towards thinness, or a page with a long title would pass.
    if (slotId.startsWith('page.')) continue;
    const owner = slotId.split('.')[0] ?? '';
    if (page.sections.some((section) => section.id === owner)) total += text.length;
  }
  return total;
}

/**
 * Runs every check a `SiteDoc` alone can prove.
 *
 * Pure and total: it returns findings and never throws, so the caller decides what blocks. That
 * split is what lets the same function run in a fixture test over 200 documents without a Worker.
 */
export function auditSiteDoc(doc: SiteDoc, legal: LegalPack): readonly AuditFinding[] {
  const findings: AuditFinding[] = [];
  const add = (
    code: string,
    severity: 'error' | 'warning',
    path: string,
    message: string,
  ): void => {
    findings.push({ code, severity, path, message });
  };

  const locale = doc.locales.default;

  for (const [index, page] of doc.pages.entries()) {
    const where = `pages.${String(index)}`;
    const routing = page.perLocale[locale];

    if (routing === undefined) {
      add('page_without_routing', 'error', where, `page "${page.pageId}" has no path in ${locale}`);
      continue;
    }
    if (routing.title.trim().length === 0) {
      add('missing_title', 'error', `${where}.perLocale.${locale}.title`, 'no meta title');
    }
    if (routing.description.trim().length === 0) {
      add(
        'missing_description',
        'error',
        `${where}.perLocale.${locale}.description`,
        'no meta description',
      );
    }
    if (page.sections.length === 0) {
      add('empty_page', 'error', where, `page "${page.pageId}" has no sections`);
    }
    if (page.sections.length > MAX_SECTIONS_PER_PAGE) {
      add(
        'page_too_long',
        'warning',
        where,
        `${String(page.sections.length)} sections; the render budget assumes at most ${String(MAX_SECTIONS_PER_PAGE)}`,
      );
    }

    // Thinness. WARN-ONLY in Phase 1 (§10 risk 3): an uncalibrated threshold on template-generated
    // sites is how a quality gate noindexes a paying customer.
    if (!page.noindex) {
      const characters = copyCharactersOf(doc, page, locale);
      const minimum = page.role === 'home' ? MIN_HOME_COPY_CHARACTERS : MIN_PAGE_COPY_CHARACTERS;
      if (characters < minimum) {
        add(
          'thin_content',
          'warning',
          where,
          `${String(characters)} characters of copy, below the ${String(minimum)} guideline`,
        );
      }
    }
  }

  // Media refs. `genToDoc()` prunes dangling ones, so a section that still names one is a
  // conversion defect rather than a model defect — and a hero with no image is a blank LCP element.
  for (const [index, page] of doc.pages.entries()) {
    for (const [sectionIndex, section] of page.sections.entries()) {
      if (!('media' in section) || section.media === null) continue;
      // `gallery` carries an array of refs; every other section type carries one or none.
      const refs = Array.isArray(section.media) ? section.media : [section.media];
      for (const [refIndex, ref] of refs.entries()) {
        if (doc.media[ref.refId] !== undefined) continue;
        const where = Array.isArray(section.media)
          ? `pages.${String(index)}.sections.${String(sectionIndex)}.media.${String(refIndex)}`
          : `pages.${String(index)}.sections.${String(sectionIndex)}.media`;
        add('unresolved_media_ref', 'error', where, `refId "${ref.refId}" is not in the manifest`);
      }
    }
  }

  // Accessibility: every image needs alternative text. A warning rather than an error because the
  // renderer emits `alt=""` for a decorative image, which is valid — but an unlabelled hero is a
  // real defect and this is where it becomes visible.
  for (const [refId, asset] of Object.entries(doc.media)) {
    if (asset.altText === null || asset.altText.trim().length === 0) {
      add('media_without_alt', 'warning', `media.${refId}`, 'no alternative text');
    }
  }

  // Uniqueness, the cheap half: exact strings repeated across the site. The MinHash near-duplicate
  // check §7 specifies needs a corpus and is the same calibration problem as thinness, so this is
  // the part that can be proven from one document.
  const counts = new Map<string, number>();
  for (const text of Object.values(doc.copy[locale] ?? {})) {
    const key = text.trim().toLowerCase();
    if (key.length < 24) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [text, count] of counts) {
    if (count > MAX_STRING_REPEATS) {
      add(
        'repeated_copy',
        'warning',
        `copy.${locale}`,
        `"${text.slice(0, 40)}…" appears ${String(count)} times`,
      );
    }
  }

  // The legal step's own reports, surfaced where a human will see them.
  if (legal.localeFallback) {
    add(
      'legal_locale_fallback',
      'warning',
      'legal',
      `no reviewed legal template for "${legal.locale}"; the English text was used`,
    );
  }
  for (const missing of legal.missingFacts) {
    add('legal_missing_fact', 'warning', 'legal', `footer requires ${missing}, which is not known`);
  }

  if (!doc.pages.some((page) => page.role === 'home')) {
    add('no_home_page', 'error', 'pages', 'the site has no home page');
  }

  return findings;
}

/**
 * Audits the assembled document and records the verdict on the version.
 *
 * Guarantees: a blocking finding throws `audit_failed` before `render` or `publish` can run; the
 * verdict is written to `site_versions.quality_state` even when it passes, so a version's quality is
 * never unknown; and the full report is in R2 for the support tooling to read back.
 *
 * Idempotent: pure checks over a stored document, one artefact key, one idempotent UPDATE.
 */
export async function runAuditStep(
  env: Env,
  ids: RunIds,
  input: {
    readonly doc: SiteDoc;
    readonly legal: LegalPack;
    readonly versionId: string;
  },
): Promise<AuditResult> {
  const findings = auditSiteDoc(input.doc, input.legal);
  const errorCount = findings.filter((finding) => finding.severity === 'error').length;
  const warningCount = findings.length - errorCount;
  const state: AuditReport['state'] = errorCount > 0 ? 'fail' : warningCount > 0 ? 'warn' : 'pass';

  const sections = input.doc.pages.reduce((total, page) => total + page.sections.length, 0);
  const copyCharacters = Object.values(input.doc.copy).reduce(
    (total, bundle) => total + Object.values(bundle).reduce((sum, text) => sum + text.length, 0),
    0,
  );

  const report: AuditReport = {
    versionId: input.versionId,
    state,
    findings: [...findings],
    deferred: [...DEFERRED_CHECKS],
    metrics: {
      pages: input.doc.pages.length,
      sections,
      blogPosts: input.doc.blog.length,
      mediaAssets: Object.keys(input.doc.media).length,
      copyCharacters,
    },
  };
  const ref = await putArtifact(env.BLOBS, runArtifactKey(ids.jobId, 'audit'), report);

  const db = shardById(ids.shardId, env);
  await shard.versions.setVersionQuality(db, {
    versionId: assertId('siteVersion', input.versionId),
    state,
    // The column stores JSON; the findings are the report, and the artefact is the full copy.
    report: JSON.stringify({ findings: report.findings, deferred: report.deferred }),
    now: Date.now(),
  });

  if (errorCount > 0) {
    throw new GeneratorError('audit_failed', `${String(errorCount)} blocking audit finding(s)`, {
      retryable: false,
      detail: findings
        .filter((finding) => finding.severity === 'error')
        .slice(0, 5)
        .map((finding) => `${finding.code}@${finding.path}`)
        .join(';'),
    });
  }

  return { report: ref, state, errorCount, warningCount };
}
