/**
 * Regenerates the taxonomy region of `migrations/cp/0007_seed.sql` from the TypeScript registry.
 *
 * `packages/core/src/industries.ts` is the single source of truth for the taxonomy: it is what the
 * onboarding combobox filters, what `genToDoc()` reads for the schema.org type, and what the
 * design-DNA mapping keys on. The D1 seed is a projection of it, and a hand-maintained projection
 * of a 104-row table drifts — it already had, by 72 rows, before this script existed.
 *
 * Run: `pnpm seed:taxonomy`. The region between the BEGIN/END markers is replaced; everything
 * else in the file (locales, reserved slugs, the header) is left alone. `pnpm test` asserts the
 * result still matches the registry, so a forgotten run fails CI rather than production.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = new URL('..', import.meta.url).pathname;
const SEED = join(REPO, 'migrations/cp/0007_seed.sql');
const BEGIN = '-- >>> GENERATED TAXONOMY — do not edit by hand; run `pnpm seed:taxonomy`. >>>';
const END = '-- <<< GENERATED TAXONOMY <<<';

/** Single-quotes a SQL string literal, doubling any embedded quote. */
const lit = (value) => `'${String(value).replaceAll("'", "''")}'`;
/** `NULL` or a quoted literal. */
const litOrNull = (value) => (value === null || value === undefined ? 'NULL' : lit(value));

/** Bundles the registry and imports it, so the SQL is generated from the code that ships. */
async function loadRegistry() {
  const dir = mkdtempSync(join(tmpdir(), 'aib-taxonomy-'));
  const out = join(dir, 'industries.mjs');
  execFileSync(
    join(REPO, 'node_modules/.bin/esbuild'),
    [
      join(REPO, 'packages/core/src/industries.ts'),
      '--bundle',
      '--format=esm',
      `--outfile=${out}`,
      '--log-level=error',
    ],
    { stdio: 'inherit' },
  );
  return import(pathToFileURL(out).href);
}

const { INDUSTRIES, INDUSTRY_GROUPS } = await loadRegistry();
const LOCALES = ['nl', 'en', 'de', 'fr', 'es', 'pt'];

// `created_at` is a constant rather than a clock read: the seed has to be byte-stable so that
// re-running it produces no diff, and so the parity test can compare files rather than databases.
const CREATED_AT = 'unixepoch() * 1000';

const groupRows = INDUSTRY_GROUPS.map((group, index) => {
  const labels = JSON.stringify(
    Object.fromEntries(LOCALES.map((locale) => [locale, group.labels[locale]])),
  );
  return `  (${lit(group.key)}, ${lit(group.icon)}, ${lit(labels)}, 1, ${(index + 1) * 10}, ${CREATED_AT})`;
});

const industryRows = INDUSTRIES.map((industry, index) => {
  const additional = litOrNull(industry.additionalType);
  return (
    `  (${lit(industry.key)}, ${lit(industry.groupKey)}, ${lit(industry.schemaOrgType)}, ` +
    `${lit(industry.dnaId)}, ${additional}, NULL, 1, ${(index + 1) * 10}, ${CREATED_AT})`
  );
});

const translationRows = INDUSTRIES.flatMap((industry) =>
  LOCALES.map((locale) => {
    // `search_terms` is nl+en only, and the column CHECK requires it lowercased. The other four
    // locales get the label with no aliases until their rollout adds them — a plain UPDATE.
    const terms =
      locale === 'nl' || locale === 'en'
        ? lit(industry.searchTerms.join(',').toLowerCase())
        : 'NULL';
    return `  (${lit(industry.key)}, ${lit(locale)}, ${lit(industry.labels[locale])}, ${terms})`;
  }),
);

const region = [
  BEGIN,
  '--',
  '-- Projected from packages/core/src/industries.ts by scripts/generate-taxonomy-seed.mjs.',
  `-- ${String(INDUSTRY_GROUPS.length)} groups, ${String(INDUSTRIES.length)} industries, ${String(translationRows.length)} translations.`,
  '--',
  '-- `additional_type` carries the meaning `schema_org_type` had to drop when no LocalBusiness',
  '-- subtype fits; `design_preset` is NULL everywhere in Phase 1, which means "take the archetype\'s',
  '-- own knob defaults" from packages/site-kit/src/tokens/dna.ts.',
  '--',
  '-- `stock_query` is NULL by design: Phase 1 sources hero photography from the per-GROUP pool in',
  '-- apps/generator/src/steps/media.ts (CURATED_STOCK_QUERIES), which is scene-written and',
  '-- deliberately gives two businesses in one trade different heroes. A per-industry override here',
  '-- is an UPDATE when one is worth writing, never a migration.',
  '',
  'INSERT INTO industry_groups (key, icon, labels, is_active, sort_order, created_at) VALUES',
  `${groupRows.join(',\n')}`,
  'ON CONFLICT(key) DO UPDATE SET',
  '  icon = excluded.icon, labels = excluded.labels, sort_order = excluded.sort_order;',
  '',
  'INSERT INTO industries (key, group_key, schema_org_type, dna_id, additional_type, stock_query, is_active, sort_order, created_at) VALUES',
  `${industryRows.join(',\n')}`,
  'ON CONFLICT(key) DO UPDATE SET',
  '  group_key = excluded.group_key, schema_org_type = excluded.schema_org_type,',
  '  dna_id = excluded.dna_id, additional_type = excluded.additional_type,',
  '  sort_order = excluded.sort_order;',
  '',
  'INSERT INTO industry_translations (industry_key, locale, label, search_terms) VALUES',
  `${translationRows.join(',\n')}`,
  'ON CONFLICT(industry_key, locale) DO UPDATE SET',
  '  label = excluded.label, search_terms = excluded.search_terms;',
  '',
  END,
].join('\n');

const current = readFileSync(SEED, 'utf8');
const start = current.indexOf(BEGIN);
const stop = current.indexOf(END);
if (start === -1 || stop === -1) {
  throw new Error(`Markers not found in ${SEED}. Add the BEGIN/END markers around the taxonomy.`);
}
const next = current.slice(0, start) + region + current.slice(stop + END.length);
writeFileSync(SEED, next);
console.log(
  `Wrote ${String(INDUSTRY_GROUPS.length)} groups, ${String(INDUSTRIES.length)} industries, ` +
    `${String(translationRows.length)} translations to migrations/cp/0007_seed.sql`,
);
