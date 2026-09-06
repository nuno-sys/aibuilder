import { cp } from '@aibuilder/db';
import type { SiteId } from '@aibuilder/db';

import { siteDraftStub } from '../app/do/stub';
import type { Env } from '../app/env';
import {
  PREVIEW_COOKIE_NAME,
  PREVIEW_SESSION_TTL_MS,
  clearPreviewCookieHeader,
  mintPreviewCookie,
  previewCookieHeader,
  readCookie,
  verifyPreviewCookie,
} from '../app/lib/preview-cookie.server';
import {
  PreviewPageNotFoundError,
  previewHeaders,
  renderPreview,
} from '../app/lib/preview-render.server';

/**
 * `preview.<control-plane-domain>` — the draft renderer, and the only origin that serves
 * unpublished tenant markup.
 *
 * WHY IT IS A SEPARATE ORIGIN AND NOT A ROUTE ON THE DASHBOARD. What this handler returns is model
 * output and customer copy rendered into HTML — the most attacker-influenced content this product
 * produces. On the dashboard's origin it would share a DOM, a `localStorage` and a cookie jar with
 * the session that can regenerate a site and open a billing portal. On its own origin it shares
 * nothing: the browser's same-origin policy is doing the isolation, which is the only mechanism in
 * this system that does not depend on us not having made a mistake.
 *
 * THE CONSEQUENCE, WHICH IS A FEATURE. Because it is cross-origin, the editor cannot reach into
 * the preview's DOM to change a colour. It posts a message instead, which the eleven-line bridge in
 * `preview-bridge.ts` turns into `setProperty` calls. Still no network round trip; still one style
 * recalculation.
 *
 * THREE ROUTES, AND NOTHING ELSE ANSWERS:
 *
 *   GET /_authorise?g=<siteId>.<token>   spend a one-time grant, set the cookie, 303 away
 *   GET /s/<siteId>?p=<pageId>&l=<locale>  render, if the cookie says this site
 *   *                                     404, with the same hardened headers
 *
 * Every response — including the 404 and the error pages — carries `X-Robots-Tag: noindex`,
 * `Referrer-Policy: no-referrer` and a `frame-ancestors` policy naming the dashboard. A hardened
 * happy path and a bare error page is how a draft URL ends up in an index.
 */

/** `<siteId>.<base64url token>`, the shape `SiteDraftDO.mintPreviewGrant` hands out. */
const GRANT_PATTERN = /^(ste_[0-9A-HJKMNP-TV-Z]{26})\.([A-Za-z0-9_-]{43})$/u;

/** The rendered path prefix. The site id is in the path so a cookie for another site is visible. */
const RENDER_PREFIX = '/s/';

/** A site id, validated before it reaches a bound parameter or a Durable Object name. */
const SITE_ID_PATTERN = /^ste_[0-9A-HJKMNP-TV-Z]{26}$/u;

/**
 * A minimal, self-contained page for the cases the preview cannot render.
 *
 * NO TENANT CONTENT, no interpolation of anything from a request, and its own inline style. It
 * appears inside the editor's iframe, so it says what happened in the customer's language and tells
 * them what to do, rather than showing a browser error page inside their own product.
 */
function noticePage(title: string, body: string): string {
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${title}</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100vh;
font:16px/1.5 system-ui,sans-serif;background:#f4f5f8;color:#16181d}
main{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.125rem;margin:0 0 .5rem}
p{margin:0;color:#545b6b}</style></head>
<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

/** Wraps a notice in the hardened header set. */
function notice(env: Env, status: number, title: string, body: string): Response {
  const headers = previewHeaders(env.DASHBOARD_ORIGIN);
  return new Response(noticePage(title, body), { status, headers });
}

/**
 * Handles a request on the preview host.
 *
 * Returns a response for every path — React Router never sees this hostname, because a routing
 * mistake that let it would put the dashboard's HTML on the origin that renders tenant markup.
 */
export async function handlePreview(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return notice(env, 405, 'Niet toegestaan', 'Deze pagina accepteert alleen GET-verzoeken.');
  }
  if (url.pathname === '/_authorise') {
    return authorise(env, url);
  }
  if (url.pathname.startsWith(RENDER_PREFIX)) {
    return render(request, env, url);
  }
  return notice(env, 404, 'Niet gevonden', 'Deze voorbeeldpagina bestaat niet.');
}

/**
 * Spends a one-time grant and turns it into a cookie.
 *
 * THE ONLY RESPONSE IN THIS SYSTEM WHOSE URL CARRIES A PREVIEW SECRET, and it renders nothing: it
 * is a 303. There is therefore no document from which a `Referer` could carry the token onward when
 * the customer clicks their own `wa.me` link — which is the exact leak architecture §9 rejects a
 * query-string token for. The grant is single-use (`SiteDraftDO.redeemPreviewGrant` asserts the
 * write count) and lives sixty seconds, so a URL recovered from a proxy log is inert.
 *
 * `Referrer-Policy: no-referrer` is on this response too, because a 303's own URL is what a browser
 * would otherwise report as the referrer of the page it lands on.
 */
async function authorise(env: Env, url: URL): Promise<Response> {
  const grant = url.searchParams.get('g') ?? '';
  const match = GRANT_PATTERN.exec(grant);
  if (match === null) {
    return notice(
      env,
      400,
      'Voorbeeld verlopen',
      'Herlaad de editor om het voorbeeld opnieuw te openen.',
    );
  }
  const siteId = match[1];
  const token = match[2];
  if (siteId === undefined || token === undefined) {
    return notice(env, 400, 'Voorbeeld verlopen', 'Herlaad de editor om verder te gaan.');
  }

  const stub = siteDraftStub(env, siteId);
  const now = Date.now();
  const userId = await stub.redeemPreviewGrant(token, now);
  if (userId === null) {
    // Unknown, expired and already-spent are one answer. A grant is spent by the very redirect that
    // uses it, so "already spent" is what a refresh of this URL looks like — and telling the three
    // apart would be an oracle for nothing anybody needs.
    return notice(
      env,
      403,
      'Voorbeeld verlopen',
      'Deze voorbeeldlink is al gebruikt of verlopen. Herlaad de editor.',
    );
  }

  // The claims name the site this cookie may read and the user it was minted for. Both come from
  // the grant, which was only handed out to a session that had already passed `requireSiteAccess` —
  // so no identity in this flow is ever taken from the URL.
  const value = await mintPreviewCookie(env, {
    siteId,
    userId,
    expiresAt: now + PREVIEW_SESSION_TTL_MS,
  });

  const target = new URL(`${RENDER_PREFIX}${siteId}`, env.PREVIEW_ORIGIN);
  for (const key of ['p', 'l'] as const) {
    const passthrough = url.searchParams.get(key);
    if (passthrough !== null) {
      target.searchParams.set(key, passthrough);
    }
  }

  const headers = new Headers({
    location: target.toString(),
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
    'cache-control': 'no-store',
  });
  headers.append(
    'set-cookie',
    previewCookieHeader(value, Math.floor(PREVIEW_SESSION_TTL_MS / 1000)),
  );
  // 303 and not 302: the browser must issue a GET for the target regardless of how it got here, and
  // the distinction matters if this is ever reached from a form post.
  return new Response(null, { status: 303, headers });
}

/**
 * Renders one page of one draft.
 *
 * Authorisation is the cookie and only the cookie. The site id in the path is compared against the
 * one the cookie asserts, which is what makes the failure mode of a customer previewing two sites
 * in two tabs a visible, self-healing message rather than the wrong site silently rendering — a
 * `__Host-` cookie is `Path=/`, so there can only be one preview session per browser and the second
 * tab overwrites the first.
 */
async function render(request: Request, env: Env, url: URL): Promise<Response> {
  const requestedSiteId = url.pathname.slice(RENDER_PREFIX.length).split('/')[0] ?? '';
  if (!SITE_ID_PATTERN.test(requestedSiteId)) {
    return notice(env, 404, 'Niet gevonden', 'Deze voorbeeldpagina bestaat niet.');
  }

  const cookie = readCookie(request.headers.get('cookie'), PREVIEW_COOKIE_NAME);
  if (cookie === null) {
    return notice(
      env,
      401,
      'Voorbeeld niet actief',
      'Open het voorbeeld opnieuw vanuit de editor.',
    );
  }
  const claims = await verifyPreviewCookie(env, cookie, Date.now());
  if (claims === null) {
    const response = notice(
      env,
      401,
      'Voorbeeld verlopen',
      'Je voorbeeldsessie is verlopen. Herlaad de editor.',
    );
    // Clear it: an expired cookie that stays in the jar makes every subsequent load fail the same
    // way, and the customer has no way to see or delete it.
    response.headers.append('set-cookie', clearPreviewCookieHeader());
    return response;
  }
  if (claims.siteId !== requestedSiteId) {
    return notice(
      env,
      409,
      'Ander voorbeeld actief',
      'Je hebt het voorbeeld van een andere site geopend. Herlaad deze editor om verder te gaan.',
    );
  }

  // One primary-key read: it supplies the canonical host the rendered page's canonical URL and
  // JSON-LD must claim, and it proves the site has not been deleted since the cookie was minted.
  const site = await cp.sites.getLiveSite(env.CP, claims.siteId as SiteId);
  if (site === null) {
    return notice(env, 404, 'Site niet gevonden', 'Deze site bestaat niet meer.');
  }

  const state = await siteDraftStub(env, claims.siteId).readState(null);
  if (state === null) {
    return notice(
      env,
      404,
      'Nog geen concept',
      'Open de editor om een concept van deze site te maken.',
    );
  }

  try {
    const rendered = await renderPreview({
      doc: state.doc,
      pageId: url.searchParams.get('p'),
      locale: url.searchParams.get('l'),
      siteOrigin: `https://${site.canonical_host}`,
      cdnOrigin: env.MEDIA_CDN_ORIGIN,
      dashboardOrigin: env.DASHBOARD_ORIGIN,
      updatedAt: state.updatedAt,
    });
    return new Response(rendered.html, {
      status: 200,
      headers: previewHeaders(env.DASHBOARD_ORIGIN),
    });
  } catch (error) {
    if (error instanceof PreviewPageNotFoundError) {
      return notice(
        env,
        404,
        'Pagina niet in dit concept',
        'Deze pagina bestaat niet in de gekozen taal.',
      );
    }
    throw error;
  }
}
