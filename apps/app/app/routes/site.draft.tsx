/** @jsxImportSource react */
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';

import { siteDraftStub } from '../do/stub';
import type { MutationResult } from '../do/SiteDraftDO';
import { checkEntitlement, notFound, requireSiteAccess } from '../lib/guard.server';

/**
 * `POST /sites/:siteId/draft` — the editor's write endpoint. A resource route: no component, no
 * HTML, JSON in and JSON out.
 *
 * WHY IT IS NOT THE EDITOR ROUTE'S OWN ACTION. React Router's `useFetcher` cancels an in-flight
 * submission when a new one starts, and this is the one endpoint in the product where that is
 * unacceptable: two keystrokes 200 ms apart would cancel the first patch, and the customer would
 * watch a word they typed disappear. The editor therefore drives a strict FIFO queue over plain
 * `fetch` (`useDraftEditor`), which needs an endpoint that answers JSON rather than a document —
 * and that is exactly what a resource route is.
 *
 * THE ORIGIN CHECK IS THE CSRF CONTROL, and it has to be here because a resource route has none of
 * its own. Two properties do the work, in this order:
 *   1. `Origin` must equal `DASHBOARD_ORIGIN` exactly — `===`, never a suffix or a regex, the same
 *      rule `apps/api/src/middleware/origin.ts` states. A MISSING `Origin` is refused too: browsers
 *      send it on every cross-origin request and on every same-origin one that is not a simple
 *      navigation, so "absent" is a request that did not come from a browser we recognise.
 *   2. `Content-Type` must be `application/json`. An HTML form cannot produce that content type
 *      without a CORS preflight, which a cross-site attacker cannot satisfy.
 *
 * THE ENTITLEMENT GATE IS INLINE, NOT A THROWN 402. A save refused mid-edit must leave the
 * customer's work on the screen with an explanation, not navigate them away from it. So this
 * answers `200 { ok: false, reason: 'not_entitled' }` and the editor renders a banner over an
 * otherwise intact editor.
 */

/** What the editor sends. Discriminated on `intent` so the switch below is exhaustive. */
interface DraftRequestBody {
  readonly intent?: unknown;
  readonly patch?: unknown;
  readonly expectedRev?: unknown;
}

/** A refusal this route produces before the Durable Object is ever reached. */
type RouteRefusal = 'bad_request' | 'not_entitled' | 'org_suspended' | 'entitlement_lapsed';

/** The response shape. A superset of `MutationResult`, so the client branches on `ok` once. */
export type DraftResponse =
  MutationResult | { readonly ok: false; readonly reason: RouteRefusal; readonly rev: number };

/** JSON, with `no-store`: a draft mutation is never a cacheable answer. */
function json(body: DraftResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** A `GET` on this path is not a thing. Answering 404 rather than 405 says nothing about what is. */
export function loader(_args: LoaderFunctionArgs): never {
  throw notFound();
}

export async function action({ request, params, context }: ActionFunctionArgs): Promise<Response> {
  const env = context.cloudflare.env;
  const now = Date.now();

  if (request.method !== 'POST') {
    throw notFound();
  }
  // Exact string equality against the configured origin. A missing header is a refusal, not a pass.
  if (request.headers.get('origin') !== env.DASHBOARD_ORIGIN) {
    return json({ ok: false, reason: 'bad_request', rev: 0 }, 403);
  }
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) {
    return json({ ok: false, reason: 'bad_request', rev: 0 }, 415);
  }

  // `editor` and not `viewer`: this is the write path. `requireSiteAccess` throws a bare 404 for a
  // site the caller cannot reach, which is the same answer it gives for one that does not exist.
  const { site } = await requireSiteAccess(env, request, params['siteId'] ?? '', {
    minRole: 'editor',
    now,
  });

  const refusal = checkEntitlement(site, now);
  if (refusal !== null) {
    return json({ ok: false, reason: refusal, rev: 0 });
  }

  let body: DraftRequestBody;
  try {
    body = (await request.json()) as DraftRequestBody;
  } catch {
    return json({ ok: false, reason: 'bad_request', rev: 0 }, 400);
  }

  const stub = siteDraftStub(env, site.siteId);
  const expectedRev = typeof body.expectedRev === 'number' ? body.expectedRev : null;

  switch (body.intent) {
    case 'patch': {
      // The patch itself is validated inside the Durable Object, against the document it is about
      // to be applied to — the only place both halves of the question are available.
      const result = await stub.applyEdit({ patch: body.patch, expectedRev, now });
      return json(result);
    }
    case 'undo':
      return json(await stub.undo(now));
    case 'redo':
      return json(await stub.redo(now));
    default:
      return json({ ok: false, reason: 'bad_request', rev: 0 }, 400);
  }
}
