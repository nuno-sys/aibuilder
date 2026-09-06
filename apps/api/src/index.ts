import { Hono } from 'hono';

import type { AppEnv } from './env';
import { internalErrorResponse, notFoundResponse } from './lib/responses';
import { appCors, jsonContentTypeGuard, originGuard } from './middleware/origin';
import { securityHeaders } from './middleware/security-headers';
import { authRoutes } from './routes/auth';
import { billingRoutes } from './routes/billing';
import { bootstrapRoutes } from './routes/bootstrap';
import { claimRoutes } from './routes/claim';
import { draftRoutes } from './routes/drafts';
import { geoRoutes } from './routes/geo';
import { jobRoutes } from './routes/jobs';
import { mediaRoutes } from './routes/media';
import { siteRoutes } from './routes/sites';
import { slugRoutes } from './routes/slug';
import { submitRoutes } from './routes/submit';

/**
 * `aibuilder-api` — the Worker behind the onboarding modal.
 *
 * MIDDLEWARE ORDER IS THE SECURITY MODEL, so it is written once, here, outermost first:
 *
 *   1. `securityHeaders`  — outermost, so that the two responses a per-route helper always misses
 *                           (`onError` and `notFound`) carry them too.
 *   2. `appCors`          — answers preflights and appends `Vary: Origin` to everything, including
 *                           the one cacheable route, before any handler can decide otherwise.
 *   3. `originGuard`      — layer 2 of the funnel. A state-changing method reaches nothing without
 *                           an exact `Origin`, and a missing one is a rejection.
 *   4. `jsonContentTypeGuard` — closes the form-post shape that crosses origins without a preflight.
 *
 * Per-route middleware (rate limiting, the draft cookie) is mounted by the route modules
 * themselves, because which limit applies is a property of the route and not of the app.
 *
 * NOT MOUNTED HERE: `POST /v1/leads/:siteId`. `apps/renderer` shipped in Phase 2 and calls this
 * Worker through its `API` service binding, but the lead endpoint itself is Phase 3 — it needs the
 * per-tenant origin allowlist and the spam scoring that go with a live contact form. `RL_LEADS` is
 * already declared in `wrangler.jsonc` so the namespace is reserved.
 */
const app = new Hono<AppEnv>();

app.use('*', securityHeaders);
app.use('*', appCors);
app.use('*', originGuard);
app.use('*', jsonContentTypeGuard);

app.route('/v1/bootstrap', bootstrapRoutes);
app.route('/v1/drafts', draftRoutes);
app.route('/v1/slug-check', slugRoutes);
app.route('/v1/geo', geoRoutes);
app.route('/v1/media', mediaRoutes);
app.route('/v1/onboarding', submitRoutes);
app.route('/v1/jobs', jobRoutes);
app.route('/v1/auth', authRoutes);
app.route('/v1/billing', billingRoutes);
app.route('/v1/sites', siteRoutes);
app.route('/claim', claimRoutes);

app.notFound(() => notFoundResponse('route_not_found'));

/**
 * The last line of defence.
 *
 * Logs the shape of the failure and nothing else. Architecture §8 makes log redaction mandatory:
 * prompts, intake bodies and lead bodies must never reach Workers Logs or Logpush, so the request
 * body is not touched here — not even on the path where knowing it would be most useful.
 */
app.onError((error, c) => {
  console.error('api_error', {
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    name: error.name,
    message: error.message,
  });
  return internalErrorResponse();
});

export default app;
