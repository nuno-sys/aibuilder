import type { Intake } from '@aibuilder/core';
import { SECTION_TYPES, SiteStructureGen, deriveSlotInventory } from '@aibuilder/site-schema';
import { describe, expect, it } from 'vitest';
import {
  CACHE_BREAKPOINT_INDEX,
  exemplarCopyIds,
  exemplarStructures,
  systemBlocks,
  systemBlocksHash,
  systemPrefixText,
} from '../prompt/blocks';
import { businessFactsFromIntake, businessFactsMessage, newEnvelopeSecrets } from '../prompt/tasks';

/**
 * The cache-prefix invariant and the data-minimisation invariant, which are the two properties of
 * this package that fail silently in production: a varying prefix costs 1.25x forever without an
 * error, and a leaked phone number is a GDPR incident nobody notices until a customer asks.
 */

// Deliberately unlike the golden exemplars in the prefix: if a fixture shared a name or a city with
// one, the "no tenant data in the prefix" assertion below would pass or fail for the wrong reason.
const TENANT_A: Intake = {
  businessName: 'Bakkerij De Korenaar',
  slug: 'bakkerij-de-korenaar',
  industryKey: 'bakery',
  defaultLocale: 'nl',
  extraLocales: [],
  serviceArea: null,
  address: {
    line1: 'Brink 12',
    line2: null,
    postalCode: '7411 BS',
    city: 'Deventer',
    country: 'NL',
    latitude: 52.2551,
    longitude: 6.1639,
    geoSource: 'geocoded',
  },
  openingHours: {
    tz: 'Europe/Amsterdam',
    byAppointmentOnly: false,
    spec: [
      {
        dayOfWeek: ['Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        opens: '07:00',
        closes: '17:30',
      },
    ],
    closed: [],
    exceptions: [],
  },
  phoneE164: '+31570123456',
  whatsappE164: null,
  gbpUrl: 'https://maps.google.com/?cid=987654321',
  shortDescription:
    'Ambachtelijke bakkerij met desembrood uit de steenoven en taart op bestelling.',
  contactEmail: 'hallo@dekorenaar.nl',
  marketingOptIn: true,
  mediaIds: [],
};

const TENANT_B: Intake = {
  businessName: 'Elektra Meijer',
  slug: 'elektra-meijer',
  industryKey: 'electrician',
  defaultLocale: 'nl',
  extraLocales: ['en'],
  serviceArea: { city: 'Zwolle', radiusKm: '25' },
  address: null,
  openingHours: null,
  phoneE164: '+31612345678',
  whatsappE164: '+31612345678',
  gbpUrl: null,
  shortDescription: 'Groepenkasten, laadpalen en storingen voor particulieren en kleine bedrijven.',
  contactEmail: 'storing@elektrameijer.nl',
  marketingOptIn: false,
  mediaIds: [],
};

const NO_MANIFESTS = { media: [], externalLinks: [] } as const;

describe('the frozen system prefix', () => {
  it('is byte-identical across two calls with different tenants', async () => {
    const before = systemPrefixText();
    const beforeHash = await systemBlocksHash();

    const factsA = businessFactsFromIntake(TENANT_A, NO_MANIFESTS);
    const messageA = businessFactsMessage(factsA, newEnvelopeSecrets());
    const afterA = systemPrefixText();

    const factsB = businessFactsFromIntake(TENANT_B, NO_MANIFESTS);
    const messageB = businessFactsMessage(factsB, newEnvelopeSecrets());
    const afterB = systemPrefixText();
    const afterHash = await systemBlocksHash();

    // The two tenants really are different, so the equality below is not vacuous.
    expect(messageA.content).not.toEqual(messageB.content);
    expect(afterA).toBe(before);
    expect(afterB).toBe(before);
    expect(afterHash).toBe(beforeHash);
    expect(beforeHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('carries no tenant data at all', () => {
    const text = systemPrefixText();
    const forbidden = [
      TENANT_A.businessName,
      TENANT_A.contactEmail,
      TENANT_A.phoneE164,
      TENANT_A.address?.line1 ?? '',
      TENANT_A.address?.postalCode ?? '',
      TENANT_A.gbpUrl ?? '',
      TENANT_A.shortDescription ?? '',
      TENANT_B.businessName,
      TENANT_B.contactEmail,
      TENANT_B.phoneE164,
      TENANT_B.shortDescription ?? '',
    ];
    for (const value of forbidden) {
      expect(value.length).toBeGreaterThan(0);
      expect(text).not.toContain(value);
    }
  });

  it('carries no silent cache invalidator', () => {
    const text = systemPrefixText();
    // An ISO timestamp, an `undefined` or a `NaN` in the prefix all mean the same thing: a derivation
    // that reads something it should not, and a cache entry nothing will ever hit.
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u);
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('[object Object]');
  });

  it('marks exactly one cache breakpoint, on the last block', () => {
    const blocks = systemBlocks();
    expect(blocks).toHaveLength(4);
    expect(CACHE_BREAKPOINT_INDEX).toBe(blocks.length - 1);
    const marked = blocks.filter((block) => block.cache_control !== undefined);
    expect(marked).toHaveLength(1);
    expect(blocks[CACHE_BREAKPOINT_INDEX]?.cache_control).toEqual({ type: 'ephemeral' });
    // A `ttl` would double the write price for a break-even this traffic will not reach.
    expect(systemPrefixText()).not.toContain('"ttl"');
  });

  it('returns the same memoised block objects', () => {
    expect(systemBlocks()).toBe(systemBlocks());
  });
});

describe('the derived catalogue', () => {
  it('documents every section type in the live schema', () => {
    const text = systemPrefixText();
    for (const type of SECTION_TYPES) {
      expect(text).toContain(`\n${SECTION_TYPES.indexOf(type) + 1}. ${type}\n`);
    }
  });

  it('teaches slot id templates, not literal indices', () => {
    const text = systemPrefixText();
    expect(text).toContain('{sectionId}.items.{i}.title');
    expect(text).toContain('{sectionId}.groups.{i}.items.{j}.name');
  });
});

describe('the golden exemplars', () => {
  it('still satisfy the live structure schema', () => {
    for (const structure of exemplarStructures()) {
      const parsed = SiteStructureGen.safeParse(structure);
      expect(parsed.success).toBe(true);
    }
  });

  it('only use slot ids the derivation actually produces', () => {
    const known = new Set<string>();
    for (const structure of exemplarStructures()) {
      for (const id of deriveSlotInventory(structure).ids) known.add(id);
    }
    for (const id of exemplarCopyIds()) {
      expect(known.has(id)).toBe(true);
    }
  });

  it('appear in the cached block, not in a per-request turn', () => {
    const blocks = systemBlocks();
    expect(blocks[CACHE_BREAKPOINT_INDEX]?.text).toContain('Golden exemplars');
  });
});

describe('business facts', () => {
  it('never carries personal data to the model', () => {
    const facts = businessFactsFromIntake(TENANT_A, NO_MANIFESTS);
    const serialised = businessFactsMessage(facts, newEnvelopeSecrets()).content;
    for (const value of [
      TENANT_A.contactEmail,
      TENANT_A.phoneE164,
      TENANT_A.address?.line1 ?? '',
      TENANT_A.address?.postalCode ?? '',
      TENANT_A.gbpUrl ?? '',
      '52.2551',
      '6.1639',
    ]) {
      expect(serialised).not.toContain(value);
    }
    // ...but it does carry the non-personal facts the model cannot design without.
    expect(serialised).toContain('Bakkerij De Korenaar');
    expect(serialised).toContain('Deventer');
    expect(serialised).toContain('bakery');
    expect(facts.channels.googleBusinessProfile).toBe(true);
    expect(facts.channels.whatsapp).toBe(false);
    expect(facts.hasVisitableAddress).toBe(true);
  });

  it('represents a service-area business without an address', () => {
    const facts = businessFactsFromIntake(TENANT_B, NO_MANIFESTS);
    expect(facts.hasVisitableAddress).toBe(false);
    expect(facts.serviceArea).toEqual({ city: 'Zwolle', radiusKm: '25' });
    expect(facts.channels.whatsapp).toBe(true);
    expect(facts.channels.googleBusinessProfile).toBe(false);
    expect(facts.designDnaHint).toBe('garage_steel');
  });

  it('wraps untrusted text in an envelope an attacker cannot close', () => {
    const secrets = newEnvelopeSecrets();
    const facts = businessFactsFromIntake(TENANT_A, NO_MANIFESTS);
    const content = businessFactsMessage(facts, secrets).content;
    expect(content).toContain(`<business_facts nonce="${secrets.nonce}"`);
    expect(content).toContain(`</business_facts nonce="${secrets.nonce}">`);
    expect(secrets.nonce).toMatch(/^[0-9a-f]{32}$/u);
    expect(secrets.canary.startsWith('AIB-CANARY-')).toBe(true);
    expect(newEnvelopeSecrets().nonce).not.toBe(secrets.nonce);
  });
});
