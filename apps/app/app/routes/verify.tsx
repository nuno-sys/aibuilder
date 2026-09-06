/** @jsxImportSource react */
import { Form, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import {
  consumeMagicLink,
  markMagicLinkLogin,
  preferredOrgId,
  rotateSession,
  safeNextPath,
  sessionCookieHeader,
} from '@aibuilder/auth';
import { cp } from '@aibuilder/db';
import { Button } from '@aibuilder/ui';

import { copyFor, uiLocaleFor } from '../lib/copy';
import { currentSession, requestIpHash, requestUserAgent } from '../lib/session.server';

/**
 * `/inloggen/verifieren` — the magic-link interstitial, and the POST that actually signs you in.
 *
 * THE GET DOES NOT CONSUME THE TOKEN, and that is the entire reason this page exists rather than a
 * link straight into an endpoint. E-mail links are prefetched: by scanners at the mail gateway, by
 * the mail client's own link preview, by a corporate proxy warming its cache. Every one of those
 * issues a `GET`, and a `GET` that consumed the token would burn the customer's only sign-in link
 * before they clicked it. So the `GET` renders a page with one button ("Inloggen") and the `POST`
 * from that button is what calls `consumeMagicLink` (§6.2).
 *
 * The token still travels in the URL, which is why it lives fifteen minutes and is single-use: the
 * `UPDATE … WHERE consumed_at IS NULL` inside `consumeAuthToken` asserts its own change count, so a
 * link opened twice is a 410 and never a second session.
 *
 * WHY THIS WORKER MINTS THE SESSION AND NOT THE API. `__Host-aib_session` is host-only. A cookie set
 * by `api.<domain>` is never sent to `app.<domain>`, so a session minted there could not be read by
 * a single loader in this dashboard. `@aibuilder/auth` exists precisely so that all three Workers
 * can mint the same row; the cookie is set by whichever host the browser is on, and this is that
 * host. Only `sha256(token)` reaches D1 either way.
 *
 * THE SESSION IS ROTATED, NOT MUTATED. `rotateSession` inserts a new row and then revokes the old
 * one, in that order (a failure between the two leaves the user signed in rather than signed out).
 * An attacker who planted a `__Host-aib_session` value in the victim's browser holds a token that is
 * revoked the moment the victim proves their factor — which is what session fixation requires.
 */

/** The token as `@aibuilder/auth` mints it: 32 bytes, base64url, unpadded. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get('t') ?? '';
  return {
    locale: uiLocaleFor({ acceptLanguage: request.headers.get('accept-language') }),
    // Reflected into a hidden input, so it is shape-checked here rather than only at consume time.
    // A malformed token renders the expired page: there is nothing to gain from telling the holder
    // of a bad token which kind of bad it was.
    token: TOKEN_PATTERN.test(token) ? token : '',
  };
}

interface ActionData {
  readonly expired: true;
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.cloudflare.env;
  const now = Date.now();
  const form = await request.formData();
  const token = String(form.get('token') ?? '');
  if (!TOKEN_PATTERN.test(token)) {
    return { expired: true } satisfies ActionData;
  }

  const consumed = await consumeMagicLink(env, { token, now });
  if (consumed === null || consumed.token.user_id === null) {
    // Unknown, malformed, expired, already consumed, or issued for another purpose — one answer for
    // five causes. A link opened twice is a user event, not an incident, so this is a rendered page
    // and not a 500.
    return { expired: true } satisfies ActionData;
  }

  const userId = consumed.token.user_id;
  // The ONLY thing in this system that may set `email_verified_at`: a consumed magic link proves
  // control of a mailbox, and Stripe Checkout — which merely collects an address — does not.
  await markMagicLinkLogin(env, { userId, now });

  const memberships = await cp.users.listMembershipsForUser(env.CP, userId);
  const previous = await currentSession(env, request, now);
  const minted = await rotateSession(env, {
    previous,
    userId,
    activeOrgId: preferredOrgId(memberships),
    ipHash: await requestIpHash(env, request),
    userAgent: requestUserAgent(request),
    now,
  });

  const headers = new Headers();
  headers.append('set-cookie', sessionCookieHeader(minted.cookieValue));
  // `safeNextPath` again on the way out: the value was validated when the token was minted, but it
  // has been through a database round trip since, and an allowlisted-path check is cheap.
  throw redirect(safeNextPath(consumed.next), { headers });
}

export default function Verify() {
  const { locale, token } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const navigation = useNavigation();
  const copy = copyFor(locale);
  const busy = navigation.state === 'submitting';

  if (token === '' || data?.expired === true) {
    return (
      <main id="main-content" className="app-narrow">
        <h1>{copy.login.verifyExpired}</h1>
        <p>{copy.login.verifyExpiredDetail}</p>
        <p>
          <a href="/inloggen">{copy.login.title}</a>
        </p>
      </main>
    );
  }

  return (
    <main id="main-content" className="app-narrow">
      <h1>{copy.login.verifyTitle}</h1>
      <p>{copy.login.verifyIntro}</p>
      <Form method="post">
        <input type="hidden" name="token" value={token} />
        <Button type="submit" variant="primary" busy={busy} block>
          {busy ? copy.common.loading : copy.login.verifyContinue}
        </Button>
      </Form>
    </main>
  );
}
