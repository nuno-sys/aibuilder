import { cp, runBatch } from '@aibuilder/db';
import type { SessionId } from '@aibuilder/db';
import { Hono } from 'hono';
import { monotonicFactory } from 'ulid';

import type { AppEnv } from '../env';
import { fromBase64Url, toBase64Url } from '../lib/encoding';
import { clientIp, hashIp } from '../lib/subjects';
import { clearDraftCookieHeader } from '../middleware/draft-cookie';
import { CLAIMED_DRAFT_RETENTION_MS } from './submit';

/**
 * `GET /claim?t=…` — the e-mailed link that turns a provisional organisation into a real one.
 *
 * THE WHOLE FLOW HANGS OFF ONE ROW COUNT. D1 has no interactive transactions, so
 * `UPDATE … WHERE consumed_at IS NULL` plus `meta.changes === 1` IS the transaction. Run twice, the
 * work below would create two memberships and two sessions; the predicate is what makes it run
 * once, and `cp.drafts.consumeClaimToken()` returns `null` — a 410, never a 500 — to the loser.
 *
 * SESSION FIXATION. The anonymous cookie is deleted and a FRESH session is minted rather than the
 * anonymous one being promoted (architecture §3b step 8). An attacker who plants a known
 * `__Host-aib_draft` value in someone's browser must not end up holding a cookie that is now
 * authenticated as them.
 *
 * INDEXABILITY. Claiming moves `index_state` from `noindex` to `eligible`, never straight to
 * `indexable`: §7.26 requires card-on-file AND a passing quality gate for that, and until then the
 * renderer keeps serving `X-Robots-Tag: noindex` — which is what stops a real third party's
 * verified name, address and hours being published to an indexable URL before anyone proved they
 * own the e-mail address (architecture §3b step 7).
 */

/** A claim token is 128 bits, base64url. The bound is generous so a re-mint cannot break the link. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** The session cookie minted on a successful claim. */
const SESSION_COOKIE_NAME = '__Host-aib_session';

/** Thirty days, matching the anonymous window it replaces. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** `user_agent` columns cap at 512 characters. */
const USER_AGENT_MAX = 512;

/**
 * Session ids are minted here rather than through `@aibuilder/core`'s `mintId`.
 *
 * `ID_PREFIXES` has no `session` entry: sessions belong to the authentication surface, which is
 * Phase 2's `apps/app`. Phase 1 mints exactly one, on this route, so the prefix is spelled out
 * where it is used instead of widening a shared map from an app that owns none of it. The body is
 * a monotonic ULID, which is what `CHECK (id GLOB 'ses_[0-7]*' …)` in `migrations/cp/0001` requires.
 */
const nextUlid = monotonicFactory();

/** Mints a `ses_…` id satisfying the sessions table's id CHECK. */
function mintSessionId(): SessionId {
  return `ses_${nextUlid()}`;
}

/** Escapes text for interpolation into the minimal HTML pages below. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders a minimal page.
 *
 * Phase 1 has no dashboard, so the only HTML this API serves is this page. It carries no scripts,
 * no styles and no third-party origin, and its CSP says so — which makes it immune to every class
 * of injection by construction rather than by escaping alone. The escaping is still applied.
 */
function page(status: 200 | 400 | 410 | 500, titleNl: string, bodyNl: string): Response {
  const html =
    '<!doctype html><html lang="nl"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow">' +
    `<title>${escapeHtml(titleNl)}</title></head><body>` +
    `<h1>${escapeHtml(titleNl)}</h1><p>${escapeHtml(bodyNl)}</p>` +
    '</body></html>';
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'",
    },
  });
}

/** Decodes a claim token into bytes, after a length and alphabet check. */
function decodeToken(value: string): Uint8Array | null {
  return TOKEN_PATTERN.test(value) ? fromBase64Url(value) : null;
}

/** The 410 page. Used for spent, expired and unknown tokens alike — they are one answer. */
function expiredPage(): Response {
  return page(
    410,
    'Deze link werkt niet meer',
    'De link is al gebruikt of verlopen. Vraag een nieuwe link aan via de e-mail die je van ons kreeg.',
  );
}

export const claimRoutes = new Hono<AppEnv>();

claimRoutes.get('/', async (c) => {
  const token = c.req.query('t') ?? '';
  const tokenBytes = decodeToken(token);
  if (tokenBytes === null) {
    return page(
      400,
      'Ongeldige link',
      'Deze link is niet compleet. Kopieer hem opnieuw uit je e-mail.',
    );
  }

  const now = Date.now();
  const ip = clientIp(c.req.raw);
  const ipHash = ip === null ? null : await hashIp(c.env, ip);
  const digest = await crypto.subtle.digest('SHA-256', tokenBytes);
  const tokenHash = new Uint8Array(digest);

  const claim = await cp.drafts.consumeClaimToken(c.env.CP, { tokenHash, now, ipHash });
  if (claim === null) {
    return expiredPage();
  }

  const [user, site] = await Promise.all([
    cp.users.getUserByEmail(c.env.CP, claim.email_normalized),
    cp.sites.getLiveSite(c.env.CP, claim.site_id),
  ]);
  if (user === null || site === null) {
    // The token was consumed but the rows it points at are gone. The token is spent either way, so
    // this is reported honestly rather than retried: re-issuing would need a human to look at why.
    return page(
      500,
      'Er ging iets mis',
      'We konden je website niet koppelen. Neem contact met ons op, dan lossen we het op.',
    );
  }

  // Order is the invariant, not a preference: `trg_orgs_deprovision_needs_member` aborts an
  // organisation that would become reachable-and-billable with nobody able to sign in to it, so the
  // membership must be inserted before the flag is cleared. Both are in one atomic batch with the
  // draft transition and the indexability promotion.
  const statements = [
    cp.users.insertMembershipStatement(c.env.CP, {
      orgId: claim.org_id,
      userId: user.id,
      role: 'owner',
      invitedBy: null,
      acceptedAt: now,
      now,
    }),
    cp.orgs.deprovisionOrganisationStatement(c.env.CP, {
      orgId: claim.org_id,
      billingEmail: user.email,
      now,
    }),
    c.env.CP.prepare(cp.sites.SQL_SET_INDEX_STATE).bind(claim.site_id, 'eligible', now),
    ...(claim.draft_id === null
      ? []
      : [
          cp.drafts.markDraftClaimedStatement(c.env.CP, {
            draftId: claim.draft_id,
            now,
            // A claimed draft is the fact source publish projects from, so it outlives the 30-day
            // purge that unclaimed drafts are subject to.
            purgeAfter: now + CLAIMED_DRAFT_RETENTION_MS,
          }),
        ]),
  ];
  await runBatch(c.env.CP, statements);

  const sessionTokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const sessionDigest = await crypto.subtle.digest('SHA-256', sessionTokenBytes);
  const sessionCookie = toBase64Url(sessionTokenBytes);

  await cp.users.insertSession(c.env.CP, {
    tokenHash: new Uint8Array(sessionDigest),
    id: mintSessionId(),
    userId: user.id,
    activeOrgId: claim.org_id,
    ipHash,
    userAgent: (c.req.header('User-Agent') ?? '').slice(0, USER_AGENT_MAX) || null,
    now,
    expiresAt: now + SESSION_TTL_MS,
  });

  const headers = new Headers();
  headers.append(
    'set-cookie',
    `${SESSION_COOKIE_NAME}=${sessionCookie}; Max-Age=${String(Math.floor(SESSION_TTL_MS / 1000))}; ` +
      'Path=/; Secure; HttpOnly; SameSite=Lax',
  );
  // Session fixation: the anonymous cookie is destroyed in the same response that creates the
  // authenticated one.
  headers.append('set-cookie', clearDraftCookieHeader());
  headers.set('location', `https://${site.canonical_host}`);
  headers.set('cache-control', 'private, no-store');

  return new Response(null, { status: 303, headers });
});
