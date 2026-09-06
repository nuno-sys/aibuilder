import { describe, expect, it } from 'vitest';

import {
  MINHASH_PERMUTATIONS,
  estimateJaccard,
  minHashSignature,
  runQualityGate,
  shingles,
} from '../quality-gate';
import type { QualityFactsInput, QualityGateInput, QualityPageInput } from '../quality-gate';

const COMPLETE_FACTS: QualityFactsInput = {
  hasBusinessName: true,
  hasAddressOrServiceArea: true,
  hasPhone: true,
  hasOpeningHours: true,
  hasDescription: true,
  hasRegistrationId: true,
};

function page(overrides: Partial<QualityPageInput> = {}): QualityPageInput {
  return {
    pageKey: 'home',
    locale: 'nl',
    path: '/nl/',
    title: 'Bakkerij Jansen',
    description: 'Ambachtelijk brood uit Utrecht-Oost.',
    text: Array.from({ length: 200 }, (_unused, index) => `woord${String(index % 40)}`).join(' '),
    indexable: true,
    ...overrides,
  };
}

function input(overrides: Partial<QualityGateInput> = {}): QualityGateInput {
  return {
    pages: [page()],
    facts: COMPLETE_FACTS,
    ownedMediaCount: 4,
    totalMediaCount: 6,
    corpus: [],
    ...overrides,
  };
}

describe('the gate is WARN-only', () => {
  it('never blocks, whatever it observes', () => {
    // §10 risk 3: an uncalibrated threshold on template-generated sites would silently noindex the
    // paying customer base. Nothing here may block until the 200-fixture calibration has been run.
    const worst = runQualityGate({
      pages: [page({ text: 'kort' })],
      facts: {
        hasBusinessName: false,
        hasAddressOrServiceArea: false,
        hasPhone: false,
        hasOpeningHours: false,
        hasDescription: false,
        hasRegistrationId: false,
      },
      ownedMediaCount: 0,
      totalMediaCount: 0,
      corpus: [],
    });
    expect(worst.blocking).toBe(false);
    expect(worst.state).toBe('warn');
    expect(worst.checks.every((check) => check.thresholdCalibrated === false)).toBe(true);
  });

  it('reports a score and the raw observations for every check', () => {
    const report = runQualityGate(input());
    expect(report.checks.map((check) => check.id)).toEqual([
      'facts_completeness',
      'content_thinness',
      'cross_site_uniqueness',
      'owned_media',
      'doorway_pages',
    ]);
    for (const check of report.checks) {
      expect(check.score).toBeGreaterThanOrEqual(0);
      expect(check.score).toBeLessThanOrEqual(1);
      expect(Object.keys(check.observed).length).toBeGreaterThan(0);
    }
  });

  it('passes a complete, well-populated site', () => {
    const report = runQualityGate(input());
    expect(report.state).toBe('pass');
    expect(report.checks.every((check) => check.remediation === '')).toBe(true);
  });

  it('attaches remediation only to the checks that would fail', () => {
    const report = runQualityGate(input({ ownedMediaCount: 0, totalMediaCount: 8 }));
    const media = report.checks.find((check) => check.id === 'owned_media');
    expect(media?.wouldFail).toBe(true);
    expect(media?.remediation.length).toBeGreaterThan(0);
    expect(report.checks.find((check) => check.id === 'facts_completeness')?.remediation).toBe('');
  });
});

describe('the individual checks', () => {
  it('scores facts as the fraction present', () => {
    const report = runQualityGate(
      input({ facts: { ...COMPLETE_FACTS, hasRegistrationId: false, hasOpeningHours: false } }),
    );
    expect(report.checks.find((check) => check.id === 'facts_completeness')?.score).toBeCloseTo(
      4 / 6,
    );
  });

  it('counts a page with almost no copy as thin', () => {
    const report = runQualityGate(
      input({ pages: [page(), page({ pageKey: 'x', text: 'een twee' })] }),
    );
    const thinness = report.checks.find((check) => check.id === 'content_thinness');
    expect(thinness?.observed['thin']).toBe(1);
    expect(thinness?.score).toBeCloseTo(0.5);
  });

  it('ignores noindex pages when measuring thinness', () => {
    const report = runQualityGate(
      input({ pages: [page(), page({ pageKey: 'x', text: 'kort', indexable: false })] }),
    );
    expect(report.checks.find((check) => check.id === 'content_thinness')?.observed['pages']).toBe(
      1,
    );
  });

  it('scores a first publish as perfectly unique because there is nothing to compare against', () => {
    const report = runQualityGate(input({ corpus: [] }));
    const uniqueness = report.checks.find((check) => check.id === 'cross_site_uniqueness');
    expect(uniqueness?.score).toBe(1);
    expect(uniqueness?.observed['corpusSize']).toBe(0);
  });

  it('detects two near-identical pages on one site as a doorway pattern', () => {
    // The real pattern §7.28 warns about: one paragraph, one city token swapped. Everything else —
    // the boilerplate that would swamp a CROSS-site comparison — is common to both and therefore
    // cancels out here, which is why the within-site check is the one that can be trusted.
    const utrecht = [
      'wij bakken sinds negentienhonderdtachtig elke ochtend ambachtelijk desembrood in onze eigen bakkerij',
      'en bezorgen door heel utrecht bij particulieren restaurants en kantoren zonder minimale afname',
      'onze bakkers staan om half vier op zodat het brood warm op de toonbank ligt',
      'in utrecht kunt u ook terecht voor taarten op bestelling en broodjes voor vergaderingen',
    ].join(' ');
    const amersfoort = utrecht.replaceAll('utrecht', 'amersfoort');
    const report = runQualityGate(
      input({
        pages: [
          page({ pageKey: 'utrecht', text: utrecht }),
          page({ pageKey: 'amersfoort', text: amersfoort }),
        ],
      }),
    );
    const doorway = report.checks.find((check) => check.id === 'doorway_pages');
    expect(doorway?.observed['maxPairSimilarity']).toBeGreaterThan(0.4);
    expect(doorway?.observed['comparedPairs']).toBe(1);
  });
});

describe('MinHash', () => {
  it('is deterministic, so a score never moves on its own', () => {
    expect(minHashSignature('een twee drie vier vijf zes')).toEqual(
      minHashSignature('een twee drie vier vijf zes'),
    );
  });

  it('produces one minimum per permutation', () => {
    expect(minHashSignature('a b c d e f g').length).toBe(MINHASH_PERMUTATIONS);
  });

  it('estimates 1 for identical text and near 0 for unrelated text', () => {
    const a = minHashSignature('de slager snijdt vandaag verse biologische entrecote voor u');
    const b = minHashSignature('de slager snijdt vandaag verse biologische entrecote voor u');
    const c = minHashSignature(
      'onze kapsalon knipt kleurt en föhnt zonder afspraak in het weekend',
    );
    expect(estimateJaccard(a, b)).toBe(1);
    expect(estimateJaccard(a, c)).toBeLessThan(0.2);
  });

  it('normalises punctuation and case out of the shingles', () => {
    expect(shingles('Een, twee. DRIE vier vijf!')).toEqual(['een twee drie vier vijf']);
  });

  it('treats two empty documents as dissimilar rather than as duplicates', () => {
    // Two empty pages are evidence of thinness, not of duplication; content_thinness says so.
    expect(estimateJaccard(minHashSignature(''), minHashSignature(''))).toBe(1);
    expect(shingles('')).toEqual([]);
  });
});
