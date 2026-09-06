import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { AppEnv } from '../env';
import { appCors, jsonContentTypeGuard, originGuard } from '../middleware/origin';
import { TEST_APP_ORIGIN, testEnv } from './doubles';

/**
 * Layer 2 of the funnel, tested at the boundary that matters: what a browser can and cannot get
 * through with a cookie attached.
 *
 * The case worth reading twice is the missing `Origin`. Treating absence as "probably fine" is how
 * a form on an attacker's page reaches a cookie-authenticated endpoint, so it is asserted here as a
 * rejection rather than left as a comment in the middleware.
 */
function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', appCors);
  app.use('*', originGuard);
  app.use('*', jsonContentTypeGuard);
  app.post('/thing', (c) => c.json({ ok: true }));
  app.get('/thing', (c) => c.json({ ok: true }));
  return app;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

describe('origin middleware', () => {
  it('rejects a state-changing request with NO Origin header', async () => {
    const response = await buildApp().request(
      '/thing',
      { method: 'POST', headers: JSON_HEADERS, body: '{}' },
      testEnv(),
    );

    expect(response.status).toBe(403);
    const body: unknown = await response.json();
    expect((body as { error: string }).error).toBe('origin_rejected');
  });

  it('rejects an Origin that merely ends with the application origin', async () => {
    const response = await buildApp().request(
      '/thing',
      {
        method: 'POST',
        headers: {
          ...JSON_HEADERS,
          Origin: `https://evil${TEST_APP_ORIGIN.slice('https://'.length)}`,
        },
        body: '{}',
      },
      testEnv(),
    );

    expect(response.status).toBe(403);
  });

  it('accepts the exact application origin', async () => {
    const response = await buildApp().request(
      '/thing',
      { method: 'POST', headers: { ...JSON_HEADERS, Origin: TEST_APP_ORIGIN }, body: '{}' },
      testEnv(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(TEST_APP_ORIGIN);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('refuses a state-changing request that is not JSON', async () => {
    const response = await buildApp().request(
      '/thing',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', Origin: TEST_APP_ORIGIN },
        body: 'a=1',
      },
      testEnv(),
    );

    // A form post is a CORS *simple request*: it crosses origins with cookies and without a
    // preflight. Requiring JSON is what forces the preflight the Origin check then answers.
    expect(response.status).toBe(415);
  });

  it('lets a safe method through without an Origin, and still varies on it', async () => {
    const response = await buildApp().request('/thing', { method: 'GET' }, testEnv());

    expect(response.status).toBe(200);
    expect(response.headers.get('vary')).toContain('Origin');
    // Nothing to read cross-origin, so nothing is echoed.
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers a preflight from the application origin and refuses one from anywhere else', async () => {
    const allowed = await buildApp().request(
      '/thing',
      { method: 'OPTIONS', headers: { Origin: TEST_APP_ORIGIN } },
      testEnv(),
    );
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-methods')).toContain('POST');

    const refused = await buildApp().request(
      '/thing',
      { method: 'OPTIONS', headers: { Origin: 'https://attacker.test' } },
      testEnv(),
    );
    expect(refused.status).toBe(403);
  });
});
