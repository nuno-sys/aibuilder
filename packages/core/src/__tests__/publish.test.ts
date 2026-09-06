import { describe, expect, it } from 'vitest';

import { publishVersion, rollbackTo } from '../publish';
import type { PublishObject, PublishPlan, PublishPorts } from '../publish';
import { ROUTING_MANIFEST_VERSION, parseRoutingManifest } from '../routing';
import type { RoutingManifest } from '../routing';

const NOW = 1_757_000_000_000;
const SITE_ID = 'ste_01J0000000000000000000000A';
const ORG_ID = 'org_01J0000000000000000000000B';
const VERSION_ID = 'ver_01J0000000000000000000000C';
const HOST = 'bakkerij-jansen.mijnsaas.com';

function manifest(overrides: Partial<RoutingManifest> = {}): RoutingManifest {
  return {
    v: ROUTING_MANIFEST_VERSION,
    siteId: SITE_ID,
    shardId: 0,
    orgId: ORG_ID,
    liveVersion: VERSION_ID,
    canonicalHost: HOST,
    locales: ['nl'],
    defaultLocale: 'nl',
    indexState: 'noindex',
    goneAt: null,
    publishedAt: NOW,
    ...overrides,
  };
}

/** A recording double. Every port appends its name, which is how the ORDER is asserted. */
interface Recorder extends PublishPorts {
  readonly calls: string[];
  readonly written: PublishObject[];
  readonly pointers: Map<string, string>;
}

function ports(
  options: { readonly sealed?: boolean; readonly absentKeys?: readonly string[] } = {},
): Recorder {
  const calls: string[] = [];
  const written: PublishObject[] = [];
  const pointers = new Map<string, string>();
  const absent = new Set(options.absentKeys ?? []);

  return {
    calls,
    written,
    pointers,
    now: () => NOW,
    async putBlob(object) {
      calls.push(`putBlob:${object.key}`);
      written.push(object);
    },
    async blobExists(key) {
      calls.push(`blobExists:${key}`);
      return !absent.has(key);
    },
    async isVersionSealed() {
      calls.push('isVersionSealed');
      return options.sealed === true;
    },
    async writeProjection() {
      calls.push('writeProjection');
    },
    async setPublishedVersion() {
      calls.push('setPublishedVersion');
    },
    async putRoutingPointer(args) {
      calls.push(`putRoutingPointer:${args.key}`);
      pointers.set(args.key, args.value);
    },
    async storeQualityReport() {
      calls.push('storeQualityReport');
    },
    async recordDeployment() {
      calls.push('recordDeployment');
    },
    async pingIndexNow() {
      calls.push('pingIndexNow');
    },
  };
}

function plan(overrides: Partial<PublishPlan> = {}): PublishPlan {
  return {
    manifest: manifest(),
    hosts: [HOST],
    siteDoc: {
      key: `sites/${SITE_ID}/${VERSION_ID}/sitedoc.json`,
      body: '{}',
      contentType: 'application/json; charset=utf-8',
    },
    projection: {
      siteId: SITE_ID,
      orgId: ORG_ID,
      versionId: VERSION_ID,
      pages: [],
      retiredPaths: [],
      manifestSha256: new Uint8Array(32),
      manifestBytes: 2,
      themeTokens: null,
    },
    derived: [
      {
        key: `sites/${SITE_ID}/${VERSION_ID}/sitemaps/nl.xml.br`,
        body: new Uint8Array([1, 2, 3]),
        contentType: 'application/xml',
        contentEncoding: 'br',
      },
    ],
    renderedKeys: [
      `sites/${SITE_ID}/${VERSION_ID}/nl/index.html`,
      `sites/${SITE_ID}/${VERSION_ID}/index.html`,
    ],
    indexNowUrls: [`https://${HOST}/nl/`],
    quality: null,
    deployment: {
      deploymentId: 'dep_01J0000000000000000000000D',
      siteId: SITE_ID,
      versionId: VERSION_ID,
      pagesWritten: 2,
      bytesWritten: 1234,
      url: `https://${HOST}`,
    },
    ...overrides,
  };
}

describe('publishVersion ordering', () => {
  it('writes the SiteDoc, the projection, the derived artefacts, then the pointer LAST', async () => {
    const recorder = ports();
    const outcome = await publishVersion(recorder, plan());

    expect(outcome).toEqual({ ok: true, resumed: false, objectsVerified: 2, hostsPointed: 1 });

    const sitedoc = recorder.calls.findIndex((call) => call.endsWith('sitedoc.json'));
    const projection = recorder.calls.indexOf('writeProjection');
    const sitemap = recorder.calls.findIndex((call) => call.includes('sitemaps/nl.xml.br'));
    const verify = recorder.calls.findIndex((call) => call.startsWith('blobExists:'));
    const published = recorder.calls.indexOf('setPublishedVersion');
    const flip = recorder.calls.findIndex((call) => call.startsWith('putRoutingPointer:'));

    expect(sitedoc).toBeGreaterThan(-1);
    expect(sitedoc).toBeLessThan(projection);
    expect(projection).toBeLessThan(sitemap);
    expect(sitemap).toBeLessThan(verify);
    expect(verify).toBeLessThan(published);
    expect(published).toBeLessThan(flip);

    // Nothing that can change what a visitor sees may run after the flip.
    expect(recorder.calls.slice(flip + 1)).toEqual(['recordDeployment', 'pingIndexNow']);
  });

  it('writes a parseable manifest under every host', async () => {
    const recorder = ports();
    await publishVersion(recorder, plan({ hosts: [HOST, 'www.bakkerijjansen.nl'] }));
    expect([...recorder.pointers.keys()]).toEqual([HOST, 'www.bakkerijjansen.nl']);
    expect(parseRoutingManifest(recorder.pointers.get(HOST) ?? null)).toEqual(manifest());
  });
});

describe('publishVersion failure modes', () => {
  it('does NOT flip when a rendered object is missing', async () => {
    const missing = `sites/${SITE_ID}/${VERSION_ID}/nl/index.html`;
    const recorder = ports({ absentKeys: [missing] });

    const outcome = await publishVersion(recorder, plan());

    expect(outcome).toEqual({ ok: false, reason: 'missing_rendered_objects', missing: [missing] });
    expect(recorder.calls.some((call) => call.startsWith('putRoutingPointer'))).toBe(false);
    expect(recorder.calls).not.toContain('setPublishedVersion');
    expect(recorder.pointers.size).toBe(0);
  });

  it('survives a retry after the version was already sealed', async () => {
    // A Workflow step is retried. The seal is what turns a second attempt into a resume rather than
    // a duplicate page set — the shard triggers would refuse the write anyway.
    const recorder = ports({ sealed: true });
    const outcome = await publishVersion(recorder, plan());

    expect(outcome).toMatchObject({ ok: true, resumed: true });
    expect(recorder.calls).not.toContain('writeProjection');
    expect(recorder.calls.some((call) => call.endsWith('sitedoc.json'))).toBe(false);
    expect(recorder.calls.some((call) => call.startsWith('putRoutingPointer'))).toBe(true);
  });

  it('still reports success when the post-flip records fail', async () => {
    const recorder = ports();
    const failing: PublishPorts = {
      ...recorder,
      recordDeployment: () => Promise.reject(new Error('deployments table busy')),
      pingIndexNow: () => Promise.reject(new Error('endpoint down')),
    };
    await expect(publishVersion(failing, plan())).resolves.toMatchObject({ ok: true });
  });

  it('works without the optional ports at all', async () => {
    const recorder = ports();
    const minimal: PublishPorts = {
      now: recorder.now,
      putBlob: recorder.putBlob,
      blobExists: recorder.blobExists,
      isVersionSealed: recorder.isVersionSealed,
      writeProjection: recorder.writeProjection,
      setPublishedVersion: recorder.setPublishedVersion,
      putRoutingPointer: recorder.putRoutingPointer,
    };
    await expect(publishVersion(minimal, plan())).resolves.toMatchObject({ ok: true });
  });
});

describe('rollbackTo', () => {
  it('is one KV write and touches nothing else', async () => {
    const recorder = ports();
    const previous = manifest({ liveVersion: 'ver_01J0000000000000000000000B' });
    await rollbackTo(recorder, { manifest: previous, hosts: [HOST] });

    expect(recorder.calls).toEqual([`putRoutingPointer:${HOST}`]);
    expect(parseRoutingManifest(recorder.pointers.get(HOST) ?? null)?.liveVersion).toBe(
      'ver_01J0000000000000000000000B',
    );
  });
});
