import { ROUTING_MANIFEST_VERSION, encodeRoutingManifest } from '@aibuilder/core';
import type { RoutingManifest } from '@aibuilder/core';

import type { CacheLike } from '../cache';
import type { Env } from '../env';

/**
 * Typed test doubles for the four bindings this Worker holds.
 *
 * The suite runs in real workerd, so `Request`, `Response`, `Headers` and the router are the real
 * ones. What is faked is exactly the set of bindings that cannot exist in a test process: KV, two
 * R2 buckets, an Analytics Engine dataset and a service binding.
 *
 * Each factory ends in one cast, for the same reason as `apps/api`'s doubles: the platform
 * interfaces carry members no test touches, and structurally satisfying every one of them would be
 * a page of `throw new Error('unused')` per binding.
 */

/** A stored R2 object, reduced to what this Worker reads. */
export interface FakeObject {
  readonly body: string | Uint8Array;
  readonly etag?: string;
  readonly customMetadata?: Readonly<Record<string, string>>;
}

/** Builds a read-only `R2Bucket` over a plain map of keys. */
export function fakeR2(objects: Readonly<Record<string, FakeObject>>): R2Bucket {
  const bucket = {
    get(key: string): Promise<unknown> {
      const object = objects[key];
      if (object === undefined) return Promise.resolve(null);
      const bytes =
        typeof object.body === 'string' ? new TextEncoder().encode(object.body) : object.body;
      return Promise.resolve({
        key,
        body: new Blob([bytes]).stream(),
        httpEtag: object.etag ?? `"${key.length.toString(16)}"`,
        customMetadata: object.customMetadata,
      });
    },
    head(key: string): Promise<unknown> {
      return Promise.resolve(objects[key] === undefined ? null : { key });
    },
  };
  return bucket as unknown as R2Bucket;
}

/** Builds a read-only `KVNamespace` over a plain map. */
export function fakeKv(entries: Readonly<Record<string, string>>): KVNamespace {
  const namespace = {
    get(key: string): Promise<string | null> {
      return Promise.resolve(entries[key] ?? null);
    },
  };
  return namespace as unknown as KVNamespace;
}

/** Records every data point, so a test can assert what was and was not collected. */
export interface FakeAnalytics {
  readonly dataset: AnalyticsEngineDataset;
  readonly points: {
    readonly indexes?: readonly string[];
    readonly blobs?: readonly (string | null)[];
    readonly doubles?: readonly number[];
  }[];
}

/** Builds an Analytics Engine dataset that records instead of sending. */
export function fakeAnalytics(): FakeAnalytics {
  const points: FakeAnalytics['points'] = [];
  const dataset = {
    writeDataPoint(event: unknown): void {
      points.push(event as FakeAnalytics['points'][number]);
    },
  };
  return { dataset: dataset as unknown as AnalyticsEngineDataset, points };
}

/** Records the request the lead forward produced and answers with a fixed response. */
export interface FakeFetcher {
  readonly binding: Fetcher;
  readonly seen: Request[];
}

/** Builds a service binding double. */
export function fakeFetcher(status = 202): FakeFetcher {
  const seen: Request[] = [];
  const binding = {
    fetch(request: Request): Promise<Response> {
      seen.push(request);
      return Promise.resolve(new Response('{"ok":true}', { status }));
    },
  };
  return { binding: binding as unknown as Fetcher, seen };
}

/**
 * An in-memory cache, so a test can prove WHICH key was used.
 *
 * `caches.default` exists in workerd but is opaque — nothing can read back the key it stored under.
 * The tenant-isolation property is a property of the key, so the test needs a cache it can inspect.
 */
export interface FakeCache extends CacheLike {
  readonly keys: string[];
  readonly entries: Map<string, Response>;
}

/** Builds an inspectable cache. */
export function fakeCache(): FakeCache {
  const entries = new Map<string, Response>();
  const keys: string[] = [];
  return {
    keys,
    entries,
    async match(request: Request): Promise<Response | undefined> {
      const hit = entries.get(request.url);
      return hit === undefined ? undefined : hit.clone();
    },
    async put(request: Request, response: Response): Promise<void> {
      keys.push(request.url);
      entries.set(request.url, response);
    },
  };
}

/** A published, Dutch-only bakery. */
export function manifest(overrides: Partial<RoutingManifest> = {}): RoutingManifest {
  return {
    v: ROUTING_MANIFEST_VERSION,
    siteId: 'ste_01J0000000000000000000000A',
    shardId: 0,
    orgId: 'org_01J0000000000000000000000B',
    liveVersion: 'ver_01J0000000000000000000000C',
    canonicalHost: 'bakkerij-jansen.mijnsaas.com',
    locales: ['nl'],
    defaultLocale: 'nl',
    indexState: 'indexable',
    goneAt: null,
    publishedAt: 1_757_000_000_000,
    ...overrides,
  };
}

/** Assembles an `Env` from the doubles a case needs. */
export function fakeEnv(options: {
  readonly manifests?: readonly RoutingManifest[];
  /** Extra host -> manifest entries, for the case where a host is not its own canonical host. */
  readonly routing?: Readonly<Record<string, RoutingManifest>>;
  readonly blobs?: Readonly<Record<string, FakeObject>>;
  readonly media?: Readonly<Record<string, FakeObject>>;
  readonly analytics?: FakeAnalytics;
  readonly api?: FakeFetcher;
}): Env {
  const routing: Record<string, string> = {};
  for (const entry of options.manifests ?? []) {
    routing[entry.canonicalHost] = encodeRoutingManifest(entry);
  }
  for (const [host, entry] of Object.entries(options.routing ?? {})) {
    routing[host] = encodeRoutingManifest(entry);
  }
  return {
    BLOBS: fakeR2(options.blobs ?? {}),
    MEDIA: fakeR2(options.media ?? {}),
    ROUTING: fakeKv(routing),
    AE: (options.analytics ?? fakeAnalytics()).dataset,
    API: (options.api ?? fakeFetcher()).binding,
    ENVIRONMENT: 'staging',
    SITES_ROOT_DOMAIN: 'mijnsaas.com',
    INDEXNOW_KEY: 'indexnowkey0123456789',
  };
}
