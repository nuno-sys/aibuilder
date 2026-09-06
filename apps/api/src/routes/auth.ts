import {
  authenticationCeremony,
  boundUserAgent,
  clearSessionCookieHeader,
  clearWebauthnCookieHeader,
  consumeMagicLink,
  issueMagicLink,
  loadSession,
  markMagicLinkLogin,
  preferredOrgId,
  registrationCeremony,
  revokeAllSessions,
  revokeSession,
  rotateSession,
  rpIdProblem,
  safeNextPath,
  sessionCookieHeader,
  webauthnCookieHeader,
} from '@aibuilder/auth';
import type { MagicLinkSender } from '@aibuilder/auth';
import { cp } from '@aibuilder/db';
import type { MembershipRow, UserRow } from '@aibuilder/db';
import { Hono } from 'hono';
import { z } from 'zod';

import type { Env, RateLimitBinding } from '../env';
import {
  errorResponse,
  jsonResponse,
  malformedBodyResponse,
  validationErrorFromIssues,
} from '../lib/responses';
import { clientIp, hashIp, normalizeEmail, sha256Hex, toHex } from '../lib/subjects';
import { clearDraftCookieHeader } from '../middleware/draft-cookie';
import { currentSession, noSessionResponse, requireSession } from '../middleware/session';
import type { SessionEnv } from '../middleware/session';
import { TURNSTILE_ACTION_MAGIC_LINK, verifyTurnstile } from '../middleware/turnstile';

/**
 * `/v1/auth` — the login surface (`PHASE2-BILLING-AUTH.md` §6).
 *
 * TWO RULES SHAPE EVERY HANDLER BELOW.
 *
 * **No account-existence oracle.** `POST /v1/auth/magic-link` answers `202` for every address it is
 * given, known or not, in the same shape and — because the send is moved off the response path with
 * `waitUntil` — in the same time. A `404` for an unknown address hands an attacker a free
 * enumeration endpoint against a table whose keys are e-mail addresses, and every other control in
 * this system assumes those addresses are not enumerable.
 *
 * **No `GET` consumes anything.** Mail clients, link expanders and security appliances prefetch
 * URLs. The e-mailed link points at `app.<domain>/inloggen/verifieren?t=…`, which is a page; the
 * only endpoint that consumes a token is the JSON `POST` below, behind `originGuard` and
 * `jsonContentTypeGuard`. A prefetch therefore cannot burn a link — a stronger guarantee than §6.2's
 * interstitial page, which still depends on a scanner not following a form. The 15-minute TTL is
 * kept as well: two mitigations, both cheap.
 *
 * SESSION FIXATION, EVERY TIME. Verifying a magic link mints a NEW session row and revokes whatever
 * the browser was carrying (`rotateSession`). An attacker who plants a `__Host-aib_session` value in
 * a victim's browser holds a token that is dead the moment the victim proves a factor.
 *
 * WHAT IS NOT HERE YET, AND WHY. The two passkey `verify` endpoints answer `503`. WebAuthn
 * verification needs `@simplewebauthn/server` (not installed), `webauthn_credentials` and the three
 * `sessions` columns from `migrations/cp/0008_trials_passkeys.sql` (not written), and the statements
 * in `packages/db/src/cp/auth.ts` (not written) — none of which this change owns. The half that does
 * not depend on any of them ships and is tested: the RP ID one-way door, options generation and the
 * ceremony's challenge lifecycle. That ordering is deliberate, because the RP ID door has to be shut
 * BEFORE the first credential exists, not after (`@aibuilder/auth`'s `webauthn/rpid.ts`).
 */

/**
 * The Turnstile action the login widget sets.
 *
 * Declared here rather than in `src/middleware/turnstile.ts` because that file is owned by another
 * change in this phase; it belongs beside `TURNSTILE_ACTION_DRAFT` and `TURNSTILE_ACTION_SUBMIT`.
 * Binding the action matters for the same reason it does at submit: a token farmed against the
 * onboarding widget must not open the login endpoint.
 */

/** The rate-limit window `RL_AUTH` is configured with, for an honest `Retry-After`. */
const AUTH_WINDOW_SECONDS = 60;

/** What the auth surface needs injected. */
export interface AuthRouteDeps {
  /**
   * The transport that puts a magic link in a mailbox.
   *
   * Absent by default, and that is the current production state, not an oversight. Phase 1 states
   * the rule in `src/routes/submit.ts`: a credential whose only safe home is a mailbox is minted by
   * the component that can deliver it, and nothing may deliver one before the control-plane domain
   * has SPF/DKIM/DMARC `p=reject` (architecture §10 risk 7). With no sender, the endpoint still
   * answers `202` and mints nothing — indistinguishable, from outside, from an address with no
   * account, which is exactly the property the endpoint is required to have anyway.
   */
  readonly magicLinkSender?: MagicLinkSender | undefined;
}

/** `POST /v1/auth/magic-link`. */
const MagicLinkRequestSchema = z.object({
  email: z.string().email().max(254),
  turnstileToken: z.string().min(1).max(4096),
  /** Where to land afterwards. Passed through `safeNextPath` before it is ever stored. */
  next: z.string().max(128).optional(),
});

/** `POST /v1/auth/magic-link/verify`. The token is base64url of 32 bytes: 43 characters. */
const MagicLinkVerifySchema = z.object({
  t: z.string().min(16).max(128),
});

/** What `GET /v1/auth/me` answers with. */
interface MeBody {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly fullName: string | null;
    readonly locale: string;
    readonly emailVerified: boolean;
  };
  readonly activeOrgId: string | null;
  readonly memberships: readonly { readonly orgId: string; readonly role: string }[];
}

/** 429 with the window the binding is actually configured for. */
function rateLimitedResponse(): Response {
  return errorResponse(
    429,
    'rate_limited',
    'Je gaat iets te snel. Probeer het over een minuut opnieuw.',
    'That was a bit quick. Please try again in a minute.',
    { retryAfterSeconds: AUTH_WINDOW_SECONDS },
    { 'retry-after': String(AUTH_WINDOW_SECONDS) },
  );
}

/** 410 for a link that is spent, expired, unknown or issued for something else. One answer for four. */
function linkExpiredResponse(): Response {
  return errorResponse(
    410,
    'link_expired',
    'Deze link werkt niet meer. Vraag een nieuwe inloglink aan.',
    'This link no longer works. Request a new sign-in link.',
  );
}

/**
 * 503 for a passkey ceremony that cannot be completed yet, or that is misconfigured.
 *
 * `reason` distinguishes the two for an operator without telling a caller anything useful: a
 * misconfigured RP ID is a deployment fault that must be loud, and a missing verifier is a known
 * gap. Both are 503 rather than 500 because neither is caused by the request.
 */
function passkeyUnavailableResponse(reason: string): Response {
  return errorResponse(
    503,
    'passkey_unavailable',
    'Inloggen met een passkey kan nog niet. Gebruik voorlopig een inloglink.',
    'Passkey sign-in is not available yet. Use a sign-in link for now.',
    { reason },
  );
}

/** Consumes one unit against `RL_AUTH`. A binding that throws is a pass — see `middleware/ratelimit.ts`. */
async function consumeAuthLimit(binding: RateLimitBinding, key: string): Promise<boolean> {
  try {
    const outcome = await binding.limit({ key });
    return outcome.success;
  } catch {
    return true;
  }
}

/** The rate-limit key for the caller's IP, or one shared bucket when the request bypassed the edge. */
async function ipKey(env: Env, request: Request): Promise<string> {
  const ip = clientIp(request);
  return ip === null ? 'RL_AUTH:no-ip' : `RL_AUTH:ip:${toHex(await hashIp(env, ip))}`;
}

/**
 * Reads a JSON body, or answers 400.
 *
 * Returns a `Response` on failure so a handler can `return` it directly; the alternative is a
 * `try`/`catch` in every route around a parse that fails for exactly one reason.
 */
async function readJson(request: Request): Promise<{ body: unknown } | { response: Response }> {
  try {
    return { body: await request.json() };
  } catch {
    return { response: malformedBodyResponse() };
  }
}

/** Builds the `MeBody` for a user and their memberships. */
function meBody(
  user: UserRow,
  activeOrgId: string | null,
  memberships: readonly Pick<MembershipRow, 'org_id' | 'role'>[],
): MeBody {
  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      locale: user.locale,
      emailVerified: user.email_verified_at !== null,
    },
    activeOrgId,
    memberships: memberships.map((membership) => ({
      orgId: membership.org_id,
      role: membership.role,
    })),
  };
}

/**
 * Builds the auth router.
 *
 * A factory rather than a module-level constant so a mail transport can be injected without this
 * module reaching for a binding that does not exist yet. `authRoutes` below is the wiring
 * `src/index.ts` mounts.
 */
export function createAuthRoutes(deps: AuthRouteDeps = {}): Hono<SessionEnv> {
  const routes = new Hono<SessionEnv>();

  routes.post('/magic-link', async (c) => {
    const parsedBody = await readJson(c.req.raw);
    if ('response' in parsedBody) {
      return parsedBody.response;
    }
    const parsed = MagicLinkRequestSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return validationErrorFromIssues(parsed.error.issues);
    }

    const emailNormalized = normalizeEmail(parsed.data.email);

    // Two keys against the same binding. The IP cap stops one script hammering the endpoint; the
    // per-address cap is what stops a distributed script mail-bombing ONE person, which no IP cap
    // can see. Both are checked before anything is written or sent.
    //
    // TODO(phase-2-db): §6.2 wants the per-address cap read off `idx_auth_tokens_email`
    // (5 sends / 15 min / address) rather than off a rate-limit binding, because the binding is
    // per-Cloudflare-location and approximate. That needs a counting statement in
    // `packages/db/src/cp/users.ts`, which this change does not own; it is in the handover notes.
    const addressKey = `RL_AUTH:email:${await sha256Hex(`magic-link${emailNormalized}`)}`;
    if (
      !(await consumeAuthLimit(c.env.RL_AUTH, await ipKey(c.env, c.req.raw))) ||
      !(await consumeAuthLimit(c.env.RL_AUTH, addressKey))
    ) {
      return rateLimitedResponse();
    }

    const turnstile = await verifyTurnstile(c.env, {
      token: parsed.data.turnstileToken,
      action: TURNSTILE_ACTION_MAGIC_LINK,
      cdata: null,
      remoteIp: clientIp(c.req.raw),
    });
    if (!turnstile.ok) {
      return errorResponse(
        403,
        'challenge_failed',
        'De verificatie is niet gelukt. Ververs de pagina en probeer het opnieuw.',
        'Verification failed. Refresh the page and try again.',
      );
    }

    const user = await cp.users.getUserByEmail(c.env.CP, emailNormalized);
    const sender = deps.magicLinkSender;

    if (user !== null && user.status === 'active' && sender !== undefined) {
      const ip = clientIp(c.req.raw);
      // Off the response path on purpose, hashing included. Minting and mailing take a different
      // amount of time than doing nothing, and doing any of it inline would turn the "always 202"
      // promise into a timing oracle answering the same question a 404 would have.
      c.executionCtx.waitUntil(
        (async (): Promise<void> => {
          try {
            await issueMagicLink(c.env, {
              email: user.email,
              userId: user.id,
              dashboardOrigin: c.env.DASHBOARD_ORIGIN,
              next: safeNextPath(parsed.data.next),
              ipHash: ip === null ? null : await hashIp(c.env, ip),
              now: Date.now(),
              sender,
            });
          } catch (error) {
            // Never the token, never the address: architecture §8 makes log redaction mandatory.
            console.error('magic_link_send_failed', {
              name: error instanceof Error ? error.name : 'unknown',
            });
          }
        })(),
      );
    }

    return jsonResponse({ ok: true }, 202);
  });

  routes.post('/magic-link/verify', async (c) => {
    const parsedBody = await readJson(c.req.raw);
    if ('response' in parsedBody) {
      return parsedBody.response;
    }
    const parsed = MagicLinkVerifySchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return validationErrorFromIssues(parsed.error.issues);
    }
    if (!(await consumeAuthLimit(c.env.RL_AUTH, await ipKey(c.env, c.req.raw)))) {
      return rateLimitedResponse();
    }

    const now = Date.now();
    const consumed = await consumeMagicLink(c.env, { token: parsed.data.t, now });
    if (consumed === null) {
      return linkExpiredResponse();
    }

    // `consumeMagicLink` guarantees a non-null `user_id`; the row is re-read because the token may
    // be up to fifteen minutes old and the account may have been suspended or deleted since.
    const userId = consumed.token.user_id;
    const user = userId === null ? null : await cp.users.getUser(c.env.CP, userId);
    if (user === null || user.status !== 'active' || user.deleted_at !== null) {
      return linkExpiredResponse();
    }

    // The consumed magic link is the ONLY thing in this system that may set `email_verified_at`
    // (§2.4: Stripe Checkout collects an address and mails a receipt to it, which is not proof of
    // control of the mailbox).
    await markMagicLinkLogin(c.env, { userId: user.id, now });

    const memberships = await cp.users.listMembershipsForUser(c.env.CP, user.id);
    const previous = await loadSession(c.env, c.req.header('Cookie'), now);
    const ip = clientIp(c.req.raw);
    const minted = await rotateSession(c.env, {
      previous,
      userId: user.id,
      activeOrgId: preferredOrgId(memberships),
      ipHash: ip === null ? null : await hashIp(c.env, ip),
      userAgent: boundUserAgent(c.req.header('User-Agent')),
      now,
    });

    return jsonResponse({ ok: true, next: consumed.next }, 200, {
      'set-cookie': sessionCookieHeader(minted.cookieValue),
    });
  });

  routes.get('/me', requireSession, async (c) => {
    const session = currentSession(c);
    const user = await cp.users.getUser(c.env.CP, session.user_id);
    if (user === null || user.status !== 'active' || user.deleted_at !== null) {
      // The session row outlived its user. Treated as "not signed in" rather than as a 500: the
      // cascade delete on `users` will take the session with it, and until it does the correct
      // answer to "who am I" is "nobody".
      return noSessionResponse();
    }
    const memberships = await cp.users.listMembershipsForUser(c.env.CP, user.id);
    return jsonResponse(meBody(user, session.active_org_id, memberships), 200);
  });

  routes.post('/logout', requireSession, async (c) => {
    const session = currentSession(c);
    await revokeSession(c.env, session, Date.now());

    // Both cookies. The anonymous draft cookie is a capability over an in-flight onboarding draft;
    // leaving it behind on a shared machine after an explicit sign-out would be the same mistake
    // the session cookie is being cleared to avoid.
    const response = jsonResponse({ ok: true }, 200);
    response.headers.append('set-cookie', clearSessionCookieHeader());
    response.headers.append('set-cookie', clearDraftCookieHeader());
    return response;
  });

  routes.post('/logout-all', requireSession, async (c) => {
    const session = currentSession(c);
    const revoked = await revokeAllSessions(c.env, session.user_id, Date.now());

    const response = jsonResponse({ ok: true, revoked }, 200);
    response.headers.append('set-cookie', clearSessionCookieHeader());
    response.headers.append('set-cookie', clearDraftCookieHeader());
    return response;
  });

  routes.post('/passkey/register/options', requireSession, async (c) => {
    const problem = rpIdProblem({
      rpId: c.env.WEBAUTHN_RP_ID,
      dashboardOrigin: c.env.DASHBOARD_ORIGIN,
    });
    if (problem !== null) {
      return passkeyUnavailableResponse(problem);
    }

    const session = currentSession(c);
    const user = await cp.users.getUser(c.env.CP, session.user_id);
    if (user === null || user.status !== 'active') {
      return noSessionResponse();
    }

    const ceremony = registrationCeremony({
      rpId: c.env.WEBAUTHN_RP_ID,
      dashboardOrigin: c.env.DASHBOARD_ORIGIN,
      rpName: 'aibuilder',
      userId: user.id,
      userName: user.email,
      userDisplayName: user.full_name ?? user.email,
      // Empty until `webauthn_credentials` exists (migrations/cp/0008). The consequence today is
      // that a platform would happily enrol the same authenticator twice — which it cannot, because
      // the verify half answers 503 and nothing is ever stored.
      existingCredentials: [],
    });

    return jsonResponse(ceremony.options, 200, {
      'set-cookie': webauthnCookieHeader(ceremony.challenge),
    });
  });

  routes.post('/passkey/authenticate/options', async (c) => {
    if (!(await consumeAuthLimit(c.env.RL_AUTH, await ipKey(c.env, c.req.raw)))) {
      return rateLimitedResponse();
    }
    const problem = rpIdProblem({
      rpId: c.env.WEBAUTHN_RP_ID,
      dashboardOrigin: c.env.DASHBOARD_ORIGIN,
    });
    if (problem !== null) {
      return passkeyUnavailableResponse(problem);
    }

    const ceremony = authenticationCeremony({
      rpId: c.env.WEBAUTHN_RP_ID,
      dashboardOrigin: c.env.DASHBOARD_ORIGIN,
    });

    return jsonResponse(ceremony.options, 200, {
      'set-cookie': webauthnCookieHeader(ceremony.challenge),
    });
  });

  /**
   * The two verification endpoints.
   *
   * They exist as routes rather than as 404s so that the gap is machine-readable: a dashboard that
   * offers the passkey card gets `503 passkey_unavailable` with a reason, not a mystery. The
   * ceremony cookie is cleared on the way out, because a challenge that cannot be verified is a
   * challenge that must not be reusable.
   *
   * TODO(phase-2-passkeys): implement against `WebAuthnVerifier` (see
   * `packages/auth/src/webauthn/verifier.ts`) once `@simplewebauthn/server@14.0.1` is installed,
   * `migrations/cp/0008_trials_passkeys.sql` has created `webauthn_credentials` and added
   * `sessions.pending_challenge` / `pending_challenge_expires_at` / `auth_method`, and
   * `packages/db/src/cp/auth.ts` exports the statements over them. At that point the registration
   * challenge moves from the `__Host-aib_webauthn` cookie into the session row per §6.3, the
   * session is rotated on a successful registration (§6.4), and `checkSignCounter` gates the
   * authentication path.
   */
  const passkeyVerifyUnavailable = (): Response => {
    const response = passkeyUnavailableResponse('verifier_not_wired');
    response.headers.append('set-cookie', clearWebauthnCookieHeader());
    return response;
  };

  routes.post('/passkey/register/verify', () => passkeyVerifyUnavailable());
  routes.post('/passkey/authenticate/verify', () => passkeyVerifyUnavailable());

  return routes;
}

/** The router `src/index.ts` mounts at `/v1/auth`. */
export const authRoutes = createAuthRoutes();
