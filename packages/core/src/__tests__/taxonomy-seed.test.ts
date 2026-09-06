import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { INDUSTRIES, INDUSTRY_GROUPS } from '../industries';

/**
 * The D1 seed is a projection of this package, and projections drift.
 *
 * They already did: the seed was hand-written against a guessed kebab-case taxonomy while the
 * registry used snake_case, and only 32 of 104 keys lined up. Nothing failed — the migration
 * applied cleanly, every test passed, and the first symptom would have been a production signup
 * whose `industry_key` violated a foreign key after the customer had filled in six steps.
 *
 * `scripts/generate-taxonomy-seed.mjs` regenerates the seed from the registry; this test is what
 * makes forgetting to run it a red build instead of an outage.
 */
const SEED = readFileSync(
  fileURLToPath(new URL('../../../../migrations/cp/0007_seed.sql', import.meta.url)),
  'utf8',
);

/** Pulls the first column of every row of a generated `INSERT INTO <table> ... VALUES` block. */
function seededKeys(table: string): string[] {
  const start = SEED.indexOf(`INSERT INTO ${table} (`);
  expect(start, `no INSERT INTO ${table} in the seed`).toBeGreaterThan(-1);
  const end = SEED.indexOf('ON CONFLICT', start);
  const block = SEED.slice(start, end);
  return [...block.matchAll(/^ {2}\('([a-z0-9_-]+)'/gm)].map((match) => match[1] ?? '');
}

describe('the D1 taxonomy seed', () => {
  it('seeds exactly the groups in the registry, in registry order', () => {
    expect(seededKeys('industry_groups')).toEqual(INDUSTRY_GROUPS.map((group) => group.key));
  });

  it('seeds exactly the industries in the registry, in registry order', () => {
    expect(seededKeys('industries')).toEqual(INDUSTRIES.map((industry) => industry.key));
  });

  it('seeds one translation row per industry per locale', () => {
    // Six locales per industry. The keys repeat, so this asserts the count and the coverage.
    const rows = seededKeys('industry_translations');
    expect(rows).toHaveLength(INDUSTRIES.length * 6);
    expect(new Set(rows)).toEqual(new Set(INDUSTRIES.map((industry) => industry.key)));
  });

  it('carries every key the industries table can hold under its CHECK constraint', () => {
    // `industries.key` is `NOT GLOB '*[^a-z0-9_-]*'` and must start with a letter. A registry key
    // that violates it fails at migration time, which is far too late to find out.
    for (const industry of INDUSTRIES) {
      expect(industry.key, `${industry.key} is not a legal industries.key`).toMatch(
        /^[a-z][a-z0-9_-]{1,47}$/,
      );
    }
    for (const group of INDUSTRY_GROUPS) {
      expect(group.key).toMatch(/^[a-z][a-z0-9_-]{1,47}$/);
    }
  });

  it('references only groups that are seeded', () => {
    const groups = new Set(INDUSTRY_GROUPS.map((group) => group.key));
    for (const industry of INDUSTRIES) {
      expect(groups.has(industry.groupKey), `${industry.key} -> ${industry.groupKey}`).toBe(true);
    }
  });

  it('only emits https additionalType URIs, which is what the column CHECK allows', () => {
    for (const industry of INDUSTRIES) {
      if (industry.additionalType === null) continue;
      expect(industry.additionalType).toMatch(/^https:\/\/\S{6,}$/);
      expect(industry.additionalType.length).toBeLessThanOrEqual(200);
    }
  });
});
