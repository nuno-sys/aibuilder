import { DAYS_OF_WEEK, mintId, slugify } from '@aibuilder/core';
import type { DayOfWeek, Intake } from '@aibuilder/core';
import { shard, shardById } from '@aibuilder/db';
import type { SiteVersionId } from '@aibuilder/db';
import {
  genToDoc,
  hasBlockingFindings,
  lintSiteDoc,
  pageMetaSlotId,
  pageNavSlotId,
  sectionSlotId,
} from '@aibuilder/site-schema';
import type {
  BlogPostInput,
  LintFinding,
  LocaleBundleGen,
  MediaAsset,
  PageGen,
  SectionGen,
  SiteFacts,
  SiteStructureGen,
} from '@aibuilder/site-schema';

import { putArtifact, runArtifactKey } from '../artifacts';
import type { ArtifactRef } from '../artifacts';
import type { Env } from '../env';
import { DocumentInvalidError } from '../errors';
import type { RunIds } from '../ids';
import type { LegalDocument, LegalPack } from './legal';
import type { MediaManifest } from './media';

/**
 * Step 7, `assemble` — generated documents, D1 facts and the server-built manifests become one
 * `SiteDoc`.
 *
 * `genToDoc()` does the conversion and it is deliberately TOTAL: it reports problems as issues
 * rather than throwing, because it runs in a step where the alternative is losing a paid
 * generation. This file's job is everything around it — resolving the version identity, projecting
 * the intake onto `SiteFacts`, overwriting the legal pages, and deciding what a lint finding means.
 *
 * WHY THE LEGAL PACK IS APPLIED TO THE *STRUCTURE* AND NOT TO THE DOCUMENT. Slot ids are derived
 * from the section list, so a legal page whose sections are rewritten after conversion would have
 * copy addressed by ids that no longer exist. Rewriting the structure first, and injecting the
 * matching bundle entries, means the ONE derivation in `deriveSlotInventory()` produces the ids for
 * the deterministic text exactly as it does for the model's — no special case in the renderer, no
 * second code path, and no way for a hallucinated GDPR clause to survive because someone forgot to
 * overwrite it.
 *
 * WHY `themeTokens` IS EMPTY HERE. The resolved CSS custom properties come from `site-kit`'s
 * `tokens/resolve.ts`, and `site-kit` is the package that owns the `render` step — which is out of
 * this delivery (VERIFIED-FACTS.md, deliberate deviation 2). `lintSiteDoc()` reports each unresolved
 * pair as a `token_missing` WARNING rather than an error, which is exactly right: contrast has not
 * been checked yet, and the linter says so instead of passing a site whose contrast was never
 * proven. When `render` lands, this becomes a populated record and those warnings become the
 * blocking contrast errors §7 requires.
 */

/** Where the assembled document ended up, and what the linter thought of it. */
export interface AssembleResult {
  readonly sitedoc: ArtifactRef;
  readonly versionId: string;
  readonly pageCount: number;
  readonly blogCount: number;
  readonly mediaCount: number;
  /** Non-blocking findings, carried to the audit step. Blocking ones throw before this exists. */
  readonly warnings: readonly string[];
  /** `genToDoc()`'s own issues: missing copy, dangling refs, duplicate paths. */
  readonly issues: readonly string[];
}

/* -- Facts ------------------------------------------------------------------------------------ */

/** True when a stored string is one of the seven day names the document schema accepts. */
function isDayOfWeek(value: string): value is DayOfWeek {
  return (DAYS_OF_WEEK as readonly string[]).includes(value);
}

/**
 * Projects the validated intake onto the verified facts half of a `SiteDoc`.
 *
 * EVERY FIELD HERE IS THE HALF THE MODEL NEVER SAW. E-mail, phone, street address and the Google
 * Business Profile URL are stripped from the prompt by `businessFactsFromIntake()` and merged back
 * in here, at assembly, from D1 (§8). That is what kills the lead-theft vector and what makes the
 * data crossing to a US sub-processor business marketing copy rather than personal data.
 *
 * `reviewsSource` is `none` and not an omission: review markup is gated on it, and self-serving
 * review markup has been rich-result-ineligible since 2019 and is a per-se unfair practice under
 * UCPD Annex I 23b/23c. Phase 1 collects no verified reviews, so the honest value is `none`.
 */
export function siteFactsFrom(intake: Intake): SiteFacts {
  const hours = intake.openingHours;
  return {
    businessName: intake.businessName,
    legalName: null,
    industryKey: intake.industryKey,
    shortDescription: intake.shortDescription,
    contactEmail: intake.contactEmail,
    phoneE164: intake.phoneE164,
    whatsappE164: intake.whatsappE164,
    gbpUrl: intake.gbpUrl,
    address: intake.address,
    serviceArea: intake.serviceArea,
    openingHours:
      hours === null
        ? null
        : {
            tz: hours.tz,
            byAppointmentOnly: hours.byAppointmentOnly,
            spec: hours.spec.map((entry) => ({
              dayOfWeek: entry.dayOfWeek,
              opens: entry.opens,
              closes: entry.closes,
            })),
            // Narrowed rather than cast: the intake column stores free strings, and a day name the
            // document schema does not know would fail validation after everything else succeeded.
            closed: hours.closed.filter(isDayOfWeek),
            exceptions: hours.exceptions,
          },
    reviewsSource: 'none',
    // Collected by the Phase 2 dashboard. Reported as a missing fact by the legal step rather than
    // invented here — a wrong KvK number in a footer is a worse outcome than an absent one.
    vatId: null,
    companyRegistrationId: null,
  };
}

/* -- The legal overwrite ---------------------------------------------------------------------- */

/** The page roles the legal pack owns outright. */
const LEGAL_ROLES: Readonly<Record<string, LegalDocument['kind']>> = {
  privacy: 'privacy',
  terms: 'terms',
  cookies: 'cookies',
};

/** A structure and bundle with the legal pages replaced by deterministic content. */
export interface LegalApplication {
  readonly structure: SiteStructureGen;
  readonly bundle: LocaleBundleGen;
  /** Documents whose page the model did not plan. Materialised standalone by `publish`. */
  readonly unplaced: readonly LegalDocument[];
}

/** Returns a section id that is free across the whole structure. */
function freeSectionId(structure: SiteStructureGen, preferred: string): string {
  const taken = new Set<string>();
  for (const page of structure.pages) {
    for (const section of page.sections) taken.add(section.id);
  }
  if (!taken.has(preferred)) return preferred;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${preferred}-${String(suffix)}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Unreachable for any structure `normalize()` produced: it de-duplicates section ids and a
  // site has far fewer than a hundred sections. Present so the loop has no implicit fall-through.
  return `${preferred}-legal`;
}

/**
 * Replaces every legal page's sections with the reviewed text, and rewrites its copy entries.
 *
 * Guarantees: after this runs, no string on a `privacy`, `terms` or `cookies` page came from a
 * model; the bundle contains an entry for every slot the rewritten pages derive, so `genToDoc()`
 * reports no `missing_copy` for them; and entries belonging to the sections that were removed are
 * dropped, so the bundle does not carry copy for slots that no longer exist.
 *
 * Pure: it returns new documents rather than mutating its inputs, because both are read again by
 * the audit step.
 */
export function applyLegalPack(
  structure: SiteStructureGen,
  bundle: LocaleBundleGen,
  pack: LegalPack,
): LegalApplication {
  const byKind = new Map<string, LegalDocument>(pack.documents.map((doc) => [doc.kind, doc]));
  const placed = new Set<string>();
  const removedSectionIds = new Set<string>();
  const injected = new Map<string, string>();

  const pages: PageGen[] = structure.pages.map((page) => {
    const kind = LEGAL_ROLES[page.role];
    const doc = kind === undefined ? undefined : byKind.get(kind);
    if (doc === undefined) return page;
    placed.add(doc.kind);

    for (const section of page.sections) removedSectionIds.add(section.id);
    const sectionId = freeSectionId(structure, `${doc.kind}-tekst`);
    const section: SectionGen = {
      id: sectionId,
      type: 'rich_text',
      // Narrow measure: a legal document is read, not scanned, and a 90-character line length is
      // the difference between "read" and "skimmed and misunderstood".
      variant: 'prose_narrow',
      paragraphs: doc.paragraphs.map((paragraph) => ({ style: paragraph.style })),
    };

    // Every section owns a `headline` slot, visually hidden or not: a landmark region without an
    // accessible name is a WCAG 1.3.1 failure.
    injected.set(sectionSlotId(sectionId, 'headline'), doc.title);
    doc.paragraphs.forEach((paragraph, index) => {
      injected.set(sectionSlotId(sectionId, 'paragraphs', index, 'text'), paragraph.text);
    });
    injected.set(pageMetaSlotId(page.pageId, 'title'), doc.title);
    injected.set(pageMetaSlotId(page.pageId, 'description'), doc.metaDescription);
    injected.set(pageMetaSlotId(page.pageId, 'slug'), doc.slugSeed);
    if (page.showInNav) injected.set(pageNavSlotId(page.pageId), doc.navLabel);

    return { ...page, noindex: true, sections: [section] };
  });

  const entries = bundle.entries
    .filter((entry) => {
      if (injected.has(entry.id)) return false;
      const owner = entry.id.split('.')[0] ?? '';
      return !removedSectionIds.has(owner);
    })
    .concat([...injected].map(([id, text]) => ({ id, text })));

  return {
    structure: { ...structure, pages },
    bundle: { ...bundle, entries },
    unplaced: pack.documents.filter((doc) => !placed.has(doc.kind)),
  };
}

/* -- Version identity ------------------------------------------------------------------------- */

/**
 * Resolves the draft version this run is building, creating it once.
 *
 * Idempotent because it reads `generation_jobs.site_version_id` first: a retried `assemble` reuses
 * the version it already created rather than opening a second one, which would leave an orphaned
 * `site_versions` row behind on every retry and would break the `(site_id, version_no)` numbering
 * the rollback path counts on.
 */
async function resolveVersion(env: Env, ids: RunIds): Promise<SiteVersionId> {
  const db = shardById(ids.shardId, env);
  const job = await shard.generationJobs.getGenerationJob(db, ids.jobId);
  const existing = job === null ? null : job.site_version_id;
  if (existing !== null) return existing;

  const versionId = mintId('siteVersion');
  const versionNo = await shard.versions.getNextVersionNo(db, ids.siteId);
  await shard.versions.insertSiteVersion(db, {
    id: versionId,
    siteId: ids.siteId,
    orgId: ids.orgId,
    versionNo,
    parentVersionId: null,
    origin: 'generation',
    generationJobId: ids.jobId,
    label: null,
    schemaVersion: 1,
    createdBy: null,
    now: Date.now(),
  });
  // Attaching the version to the job is what makes the next attempt find it. `markJobStreaming`
  // also moves the run out of `running`, which is the correct lifecycle state once a version exists.
  await shard.generationJobs.markJobStreaming(db, {
    jobId: ids.jobId,
    versionId,
    now: Date.now(),
  });
  return versionId;
}

/* -- The step ---------------------------------------------------------------------------------- */

/** Renders one lint finding as a single log-safe line. */
function describe(finding: LintFinding): string {
  return `${finding.code}@${finding.path}: ${finding.message}`;
}

/**
 * Builds and stores the `SiteDoc`.
 *
 * Guarantees: the document is validated against `SiteDocSchema` by `genToDoc()` before it is
 * written; a BLOCKING lint finding throws `DocumentInvalidError` rather than storing a document the
 * publish step would have to refuse later; and warnings are carried forward to the audit step
 * rather than swallowed.
 *
 * Idempotent: it reuses the run's version id and overwrites one artefact key.
 */
export async function runAssembleStep(
  env: Env,
  ids: RunIds,
  input: {
    readonly intake: Intake;
    readonly manifest: MediaManifest;
    readonly structure: SiteStructureGen;
    readonly bundle: LocaleBundleGen;
    readonly blog: readonly BlogPostInput[];
    readonly legal: LegalPack;
  },
): Promise<AssembleResult> {
  const versionId = await resolveVersion(env, ids);
  const applied = applyLegalPack(input.structure, input.bundle, input.legal);

  const media: Record<string, MediaAsset> = {};
  for (const [refId, asset] of Object.entries(input.manifest.assets)) {
    media[refId] = asset;
  }

  const { doc, issues } = genToDoc({
    siteId: ids.siteId,
    versionId,
    structure: applied.structure,
    bundles: [applied.bundle],
    blog: [...input.blog],
    facts: siteFactsFrom(input.intake),
    media,
    heroVideo: input.manifest.heroVideo,
    // Re-checked against the RESOLVED theme, for the same reason the section grounds are assigned
    // here. The media step picked this before a theme existed, from the industry's design DNA; if
    // the model then chose the other mode, a ground whose luminance disagrees is not a duller
    // footer, it is a footer whose legal identity block cannot be read.
    footerMediaRefId: keepIfLuminanceMatches(
      input.manifest,
      input.manifest.footerMediaRefId,
      applied.structure.theme.colorMode,
    ),
    // Assigned here rather than in the media step, which runs before section ids exist. The pick is
    // made against the RESOLVED theme, so a background whose luminance disagrees with the mode the
    // model actually chose is dropped instead of being rendered under unreadable copy.
    sectionBackgrounds: assignSectionBackgrounds(
      applied.structure,
      input.manifest,
      applied.structure.theme.colorMode,
    ),
    // Empty in Phase 1: the only external URL onboarding collects is the Google Business Profile
    // link, which is emitted as a `sameAs` from `facts` and is never a link target the model can
    // choose (§8).
    externalLinks: {},
    // See the file header: resolved by `site-kit` at render, which is out of this delivery.
    themeTokens: {},
    enabledLocales: [input.intake.defaultLocale],
    slugify: (request) => slugify(request.seed, request.locale),
  });

  const findings = lintSiteDoc(doc);
  if (hasBlockingFindings(findings)) {
    throw new DocumentInvalidError(
      findings.filter((finding) => finding.severity === 'error').map(describe),
    );
  }

  const ref = await putArtifact(env.BLOBS, runArtifactKey(ids.jobId, 'sitedoc'), doc);
  return {
    sitedoc: ref,
    versionId,
    pageCount: doc.pages.length,
    blogCount: doc.blog.length,
    mediaCount: Object.keys(doc.media).length,
    warnings: findings.map(describe),
    issues: issues.map((issue) => `${issue.code}@${issue.path}: ${issue.message}`),
  };
}

/**
 * Keeps a ground only while its measured luminance matches the mode the copy will be set in.
 *
 * @returns the ref id, or `null` when it disagrees or was never resolved.
 */
export function keepIfLuminanceMatches(
  manifest: MediaManifest,
  refId: string | null,
  colorMode: 'light' | 'dark',
): string | null {
  if (refId === null) return null;
  const asset = manifest.assets[refId];
  return asset !== undefined && asset.luminance === colorMode ? refId : null;
}

/**
 * Chooses which sections get a photographic ground.
 *
 * Deliberately conservative: the hero already carries full-bleed media, so a page whose every band
 * is a photo reads as a slideshow rather than as a business. One ground per page, on the section
 * most likely to benefit — the services grid or the contact block — and only when its luminance
 * matches the mode the copy will be set in.
 */
export function assignSectionBackgrounds(
  structure: SiteStructureGen,
  manifest: MediaManifest,
  colorMode: 'light' | 'dark',
): Record<string, string> {
  const WANTS_GROUND = new Set(['services_grid', 'contact_form', 'cta_band', 'booking']);
  const usable = Object.values(manifest.assets).filter(
    (asset) => asset.width > asset.height && asset.luminance === colorMode,
  );
  if (usable.length === 0) return {};

  // The footer's ground was chosen in the media step, before section ids existed, so the two
  // cannot negotiate — but they can avoid each other from this side. The same photograph in a
  // services band and again in the footer reads as a site that ran out of pictures.
  const taken = new Set<string>(
    manifest.footerMediaRefId === null ? [] : [manifest.footerMediaRefId],
  );
  const backgrounds: Record<string, string> = {};
  for (const page of structure.pages) {
    const target = page.sections.find((section) => WANTS_GROUND.has(section.type));
    if (target === undefined) continue;
    const pick = usable.find((asset) => !taken.has(asset.refId));
    if (pick === undefined) break;
    taken.add(pick.refId);
    backgrounds[target.id] = pick.refId;
  }
  return backgrounds;
}
