import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { assetR2Key } from '@aibuilder/core';

import type { Env } from '../env';
import app, { normaliseAssetPath } from '../index';

const HOST = 'cdn.mijnsaas.com';
const SHA = 'd'.repeat(64);

/** A read-only `R2Bucket` over a plain map. One cast, as in `apps/api`'s doubles. */
function fakeR2(objects: Readonly<Record<string, Uint8Array>>): R2Bucket {
  const bucket = {
    get(key: string): Promise<unknown> {
      const bytes = objects[key];
      if (bytes === undefined) return Promise.resolve(null);
      return Promise.resolve({
        key,
        body: new Blob([bytes]).stream(),
        httpEtag: `"${key.length.toString(16)}"`,
        // Deliberately WRONG, to prove the served type comes from the key and not from here.
        httpMetadata: { contentType: 'text/html' },
      });
    },
  };
  return bucket as unknown as R2Bucket;
}

function env(objects: Readonly<Record<string, Uint8Array>>): Env {
  return {
    MEDIA: fakeR2(objects),
    ENVIRONMENT: 'staging',
    SITES_ROOT_DOMAIN: 'mijnsaas.com',
  };
}

async function call(path: string, bindings: Env, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(`https://${HOST}${path}`, init), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const IMAGE_KEY = assetR2Key({ kind: 'image', sha256: SHA, width: 1200, format: 'avif' });
const OBJECTS = { [IMAGE_KEY]: new Uint8Array([1, 2, 3, 4]) };

describe('forced Content-Type', () => {
  it('serves the type derived from the key, NOT the one stored on the object', async () => {
    // The stored type is `text/html` in this double. If it ever reached the response, an uploaded
    // file would be a document on a host that serves user bytes.
    const response = await call(`/i/${SHA}/1200.avif`, env(OBJECTS));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/avif');
  });

  it('sends nosniff, so the browser cannot override the declared type either', async () => {
    const response = await call(`/i/${SHA}/1200.avif`, env(OBJECTS));
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('sends a sandboxed, nothing-allowed CSP', async () => {
    const response = await call(`/i/${SHA}/1200.avif`, env(OBJECTS));
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  });

  it('is cookieless', async () => {
    const response = await call(`/i/${SHA}/1200.avif`, env(OBJECTS), {
      headers: { cookie: 'aib_session=whatever' },
    });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('is cacheable forever, because the key is the content', async () => {
    const response = await call(`/i/${SHA}/1200.avif`, env(OBJECTS));
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('is embeddable cross-origin, which is the whole reason this host exists', async () => {
    const response = await call(`/i/${SHA}/1200.avif`, env(OBJECTS));
    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('path handling', () => {
  it('accepts the bare CDN spelling and the renderer prefix as the same asset', async () => {
    expect(normaliseAssetPath(`/i/${SHA}/1200.avif`)).toBe(`/_a/i/${SHA}/1200.avif`);
    expect(normaliseAssetPath(`/_a/i/${SHA}/1200.avif`)).toBe(`/_a/i/${SHA}/1200.avif`);

    const bare = await call(`/i/${SHA}/1200.avif`, env(OBJECTS));
    const prefixed = await call(`/_a/i/${SHA}/1200.avif`, env(OBJECTS));
    expect(bare.status).toBe(200);
    expect(prefixed.status).toBe(200);
  });

  it('404s anything outside the five closed asset shapes, before touching the bucket', async () => {
    const bindings = env(OBJECTS);
    for (const path of [
      '/',
      `/i/${SHA}/1201.avif`,
      `/i/${SHA}/1200.svg`,
      `/p/${SHA}.svg`,
      `/v/${SHA}.mov`,
      '/../etc/passwd',
      '/i/short/1200.avif',
      '/f/evil.html',
      '/sitedoc.json',
      `/sites/ste_x/ver_y/nl/index.html`,
    ]) {
      const response = await call(path, bindings);
      expect(response.status, path).toBe(404);
    }
  });

  it('404s a well-formed path for an object that does not exist', async () => {
    const response = await call(`/i/${'e'.repeat(64)}/1200.avif`, env(OBJECTS));
    expect(response.status).toBe(404);
  });

  it('answers a conditional request with 304', async () => {
    const first = await call(`/i/${SHA}/1200.avif`, env(OBJECTS));
    const etag = first.headers.get('etag');
    expect(etag).not.toBeNull();
    const second = await call(`/i/${SHA}/1200.avif`, env(OBJECTS), {
      headers: { 'if-none-match': etag ?? '' },
    });
    expect(second.status).toBe(304);
  });
});

describe('methods', () => {
  it('answers HEAD like GET', async () => {
    const response = await call(`/i/${SHA}/1200.avif`, env(OBJECTS), { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/avif');
  });

  it('refuses every write method', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await call(`/i/${SHA}/1200.avif`, env(OBJECTS), { method });
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, HEAD');
    }
  });
});

describe('transport security', () => {
  it('sends the full HSTS policy on our own zone', async () => {
    const response = await call(`/i/${SHA}/1200.avif`, env(OBJECTS));
    expect(response.headers.get('strict-transport-security')).toBe(
      'max-age=63072000; includeSubDomains',
    );
  });
});
