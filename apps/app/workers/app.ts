import { createRequestHandler } from 'react-router';

import type { Env } from '../app/env';
import { handlePreview } from './preview';

/**
 * The Worker entry point: two hostnames, one script.
 *
 * THE HOST BRANCH IS THE FIRST THING THAT HAPPENS, before React Router is even constructed. The
 * preview origin serves attacker-influenced tenant markup and must never be able to reach a
 * dashboard loader — not because a loader would leak (they all guard), but because the cheapest way
 * to guarantee that is for the router to never see the hostname at all.
 *
 * WHY THE DURABLE OBJECT IS EXPORTED FROM HERE. `wrangler.jsonc` binds `SITE_DRAFT` to a class in
 * this same script, so the class has to be an export of the entry module. It is re-exported rather
 * than defined here so the object's own file stays readable on its own.
 */
export { SiteDraftDO } from '../app/do/SiteDraftDO';

/**
 * The React Router request handler.
 *
 * Built lazily from the virtual server build so the dev server can replace it on hot reload; in a
 * deployed Worker the dynamic import resolves at module scope on the first request and is cached by
 * the module system from then on.
 */
const requestHandler = createRequestHandler(
  () => import('virtual:react-router/server-build'),
  import.meta.env.MODE,
);

/**
 * The header set every dashboard response carries.
 *
 * `frame-ancestors 'none'` and `X-Frame-Options: DENY` say the same thing to two generations of
 * browser, and both matter here: the dashboard frames the preview, never the other way round, and a
 * clickjacked "Regenerate" button spends real money. The `Permissions-Policy` turns off the three
 * capabilities this surface has no use for, so a compromised dependency cannot quietly acquire
 * them.
 *
 * There is no `script-src` in this policy, deliberately. React Router's client bundle is emitted by
 * Vite with content hashes this Worker never sees, and the hydration payload is an inline script
 * whose bytes change per request; a policy that had to enumerate them would either be wrong or
 * would carry `'unsafe-inline'`, which is worse than the honest narrower policy here.
 */
function applyDashboardHeaders(headers: Headers): void {
  headers.set('x-frame-options', 'DENY');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set(
    'content-security-policy',
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  // Two years with subdomains: the control plane is a domain we own end to end, and every host on
  // it is HTTPS-only. The tenant zone gets a weaker policy for the custom-hostname reason
  // documented in `apps/renderer` — this one has no such constraint.
  headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains');
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // The preview host is matched on its exact hostname, parsed from the configured origin — never
    // on a suffix or a regex. `preview.aibuilder.app.evil.test` must not match, and a suffix check
    // is exactly how it would.
    if (url.hostname === new URL(env.PREVIEW_ORIGIN).hostname) {
      return handlePreview(request, env, url);
    }

    const response = await requestHandler(request, { cloudflare: { env, ctx } });
    // The handler's response is immutable for `Response`s built from a stream, so headers are
    // applied to a copy. Cloning the headers rather than the body keeps the stream flowing.
    const headers = new Headers(response.headers);
    applyDashboardHeaders(headers);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
} satisfies ExportedHandler<Env>;
