import { describe, expect, it } from 'vitest';
import { JsonLdError, buildGraph, businessType, ldScript, validateGraph } from '../seo/jsonld';
import type { GraphNode, QaNote } from '../seo/jsonld';
import { LOCALBUSINESS_SUBTYPES, isLocalBusinessSubtype } from '../seo/allowlist';
import { HOSTILE, hostileDoc, renderContext } from './fixtures';

/**
 * The JSON-LD contract.
 *
 * Invariant 4: the model never authors a graph. Everything here is either a D1 fact or a closed
 * enum, and one function serialises it. The gates below are the ones that matter commercially — a
 * wrong `@type` silently disables every rich result, and review markup on unverified reviews is a
 * per-se unfair commercial practice under UCPD Annex I 23b/23c with penalties to 4 % of turnover.
 */

const ctx = renderContext();

function graphFor(doc = hostileDoc()): { graph: GraphNode[]; notes: QaNote[] } {
  const page = doc.pages[0];
  if (page === undefined) throw new Error('fixture has no home page');
  const notes: QaNote[] = [];
  const graph = buildGraph({
    doc,
    page,
    locale: 'nl',
    ctx,
    canonical: `${ctx.origin}/nl/`,
    notes,
  });
  return { graph, notes };
}

describe('serialisation', () => {
  it('cannot close the script element it sits in', () => {
    const { graph } = graphFor();
    const markup = ldScript(graph);
    const json = markup.slice(markup.indexOf('>') + 1, markup.lastIndexOf('</script>'));
    // No literal `<` survives anywhere in the payload, so no string in the graph can terminate the
    // element.
    expect(json).not.toContain('<');
    expect(json).toContain('\\u003cscript>');
    // And it is still valid JSON that parses back to the same graph.
    expect(JSON.parse(json)).toStrictEqual({
      '@context': 'https://schema.org',
      '@graph': JSON.parse(JSON.stringify(graph)),
    });
  });

  it('escapes the two line terminators that are legal in JSON but not in script source', () => {
    const node: GraphNode = { '@type': 'Thing', '@id': 'x', name: 'a b c' };
    const markup = ldScript([node]);
    expect(markup).toContain('\\u2028');
    expect(markup).toContain('\\u2029');
    expect(markup).not.toContain(' ');
  });
});

describe('@type resolution', () => {
  it('takes the industry row over the model and records the divergence', () => {
    const notes: QaNote[] = [];
    // The fixture's model pick is `Restaurant`; the industry row says `Bakery`.
    expect(businessType('Bakery', 'Restaurant', notes)).toStrictEqual(['LocalBusiness', 'Bakery']);
    expect(notes).toStrictEqual([
      {
        code: 'jsonld.schemaOrgType.divergence',
        detail: { industry: 'Bakery', model: 'Restaurant' },
      },
    ]);
  });

  it('does not double up when the row is LocalBusiness itself', () => {
    expect(businessType('LocalBusiness', 'LocalBusiness', [])).toBe('LocalBusiness');
  });

  it('throws rather than emitting an invented type', () => {
    // An invented `@type` does not warn — Google simply stops matching — so this must fail the
    // publish rather than degrade.
    expect(() => businessType('ButcherShop', 'Store', [])).toThrow(JsonLdError);
    expect(isLocalBusinessSubtype('ButcherShop')).toBe(false);
    expect(isLocalBusinessSubtype('Store')).toBe(true);
    expect(LOCALBUSINESS_SUBTYPES.size).toBeGreaterThan(100);
  });
});

describe('the graph', () => {
  const { graph, notes } = graphFor();
  const byType = (type: string): GraphNode | undefined =>
    graph.find((node) => {
      const value = node['@type'];
      return Array.isArray(value) ? value.includes(type) : value === type;
    });

  it('is structurally valid: no dangling @id, every URL https', () => {
    expect(validateGraph(graph, hostileDoc())).toStrictEqual([]);
  });

  it('scopes the business and website ids without a locale', () => {
    expect(byType('WebSite')?.['@id']).toBe('https://bakkerij.mijnsaas.com/#website');
    expect(byType('Bakery')?.['@id']).toBe('https://bakkerij.mijnsaas.com/#business');
    // One real business, one entity — even on a three-language site.
    expect(String(byType('Bakery')?.['@id'])).not.toContain('/nl/');
    expect(byType('WebPage')?.['@id']).toBe('https://bakkerij.mijnsaas.com/nl/#webpage');
  });

  it('carries the industry row additionalType verbatim', () => {
    expect(byType('Bakery')?.additionalType).toBe('https://www.wikidata.org/wiki/Q274393');
    expect(notes.map((note) => note.code)).toContain('jsonld.schemaOrgType.divergence');
  });

  it('emits geo only for a real pin', () => {
    expect(byType('Bakery')?.geo).toStrictEqual({
      '@type': 'GeoCoordinates',
      latitude: 52.3625,
      longitude: 4.9384,
    });
    const guessed = hostileDoc();
    const address = guessed.facts.address;
    if (address === null) throw new Error('fixture has no address');
    const withoutPin = {
      ...guessed,
      facts: { ...guessed.facts, address: { ...address, geoSource: 'none' as const } },
    };
    const page = withoutPin.pages[0];
    if (page === undefined) throw new Error('fixture has no home page');
    const built = buildGraph({
      doc: withoutPin,
      page,
      locale: 'nl',
      ctx,
      canonical: `${ctx.origin}/nl/`,
      notes: [],
    });
    // A guessed city centre that contradicts the postal address is worse than nothing.
    const business = built.find(
      (node) => node['@id'] === 'https://bakkerij.mijnsaas.com/#business',
    );
    expect(business).toBeDefined();
    expect(business === undefined ? true : 'geo' in business).toBe(false);
    // …but the address itself stays, because Google requires one for local rich results.
    expect(business?.address).toBeDefined();
  });

  it('never emits review markup for a tenant without verified reviews', () => {
    // `lint.ts` blocks the document; this builder is the second gate.
    for (const node of graph) {
      expect('aggregateRating' in node).toBe(false);
      expect('review' in node).toBe(false);
    }
    expect(validateGraph(graph, hostileDoc({ reviewsSource: 'manual' }))).toStrictEqual([]);
    // And the validator catches it if a future change ever emits one.
    const contrived: GraphNode[] = [{ '@type': 'Thing', '@id': 'x', aggregateRating: { a: 1 } }];
    expect(validateGraph(contrived, hostileDoc({ reviewsSource: 'manual' }))).toContain(
      'review markup emitted for a tenant whose reviews are not from a verified platform',
    );
  });

  it('emits the closed enums in enum order, not model order', () => {
    // The fixture asks for `['ideal', 'cash']`; `PAYMENT_METHODS` orders cash before ideal, so a
    // model that reorders its answer cannot move a tenant's bytes.
    expect(byType('Bakery')?.paymentAccepted).toBe('Cash, iDEAL');
    expect(byType('Bakery')?.amenityFeature).toStrictEqual([
      { '@type': 'LocationFeatureSpecification', name: 'wheelchairAccessible', value: true },
      { '@type': 'LocationFeatureSpecification', name: 'parking', value: true },
    ]);
  });

  it('feeds the hours node from the same value the visible table renders', () => {
    expect(byType('Bakery')?.openingHoursSpecification).toStrictEqual([
      {
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: ['Tuesday', 'Wednesday', 'Thursday'],
        opens: '08:30',
        closes: '18:00',
      },
    ]);
  });

  it('emits FAQPage only for a faq section that asked for it and has items', () => {
    const faq = graph.find((node) => node['@type'] === 'FAQPage');
    expect(faq).toBeDefined();
    expect(Array.isArray(faq?.mainEntity)).toBe(true);
    const suppressed = hostileDoc({
      sections: [
        {
          id: 's11',
          type: 'faq',
          variant: 'accordion',
          emitFaqSchema: false,
          items: [{ expandedByDefault: false }],
        },
      ],
    });
    const page = suppressed.pages[0];
    if (page === undefined) throw new Error('fixture has no home page');
    const built = buildGraph({
      doc: suppressed,
      page,
      locale: 'nl',
      ctx,
      canonical: `${ctx.origin}/nl/`,
      notes: [],
    });
    expect(built.find((node) => node['@type'] === 'FAQPage')).toBeUndefined();
  });

  it('keeps free text as a JSON value and never as markup', () => {
    // `description` and `servesCuisine` are the only free text a graph ever carries.
    expect(byType('Bakery')?.description).toBe(HOSTILE);
    expect(byType('Bakery')?.servesCuisine).toStrictEqual([HOSTILE]);
    // Both go through `ldScript`'s `<` escape like everything else.
    expect(ldScript(graph)).not.toContain('<script>alert(1)');
  });

  it('builds a breadcrumb whose positions start at 1 and are contiguous', () => {
    const crumb = graph.find((node) => node['@type'] === 'BreadcrumbList');
    const items = crumb?.itemListElement;
    expect(Array.isArray(items)).toBe(true);
    if (!Array.isArray(items)) return;
    items.forEach((item, index) => {
      expect(typeof item === 'object' && item !== null && !Array.isArray(item)).toBe(true);
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return;
      expect(item.position).toBe(index + 1);
    });
  });

  it('reports a dangling @id rather than emitting it', () => {
    const broken: GraphNode[] = [
      {
        '@type': 'WebPage',
        '@id': 'https://x.test/#p',
        about: { '@id': 'https://x.test/#missing' },
      },
    ];
    expect(validateGraph(broken, hostileDoc())).toStrictEqual([
      '@graph[0].about: dangling @id reference https://x.test/#missing',
    ]);
  });
});
