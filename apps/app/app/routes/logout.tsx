/** @jsxImportSource react */
import { redirect } from 'react-router';
import type { ActionFunctionArgs } from 'react-router';
import { clearSessionCookieHeader, revokeAllSessions, revokeSession } from '@aibuilder/auth';

import { currentSession } from '../lib/session.server';

/**
 * `/uitloggen` — sign out.
 *
 * POST ONLY. A `GET /uitloggen` is a link an attacker can put in an `<img src>` on any page, and
 * being logged out of a tool you were using is a denial of service that also loses the tab's state.
 * The `loader` therefore redirects rather than logging anybody out, and the button that reaches this
 * route is a real form.
 *
 * BOTH COOKIES ARE CLEARED. The anonymous `__Host-aib_draft` cookie is a draft capability from the
 * onboarding flow, and a shared machine where someone signs out must not leave the next person
 * holding it. Clearing it is one header and it costs nothing.
 *
 * REVOKE FIRST, THEN CLEAR. If the revoke fails the cookie stays, so the user is still signed in
 * with a session that is still live — a consistent state. The reverse order produces a cleared
 * cookie and a live session row, which is the state that outlives a stolen token.
 */

/** `GET` never signs anybody out. */
export function loader(): never {
  throw redirect('/dashboard');
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.cloudflare.env;
  const now = Date.now();
  const session = await currentSession(env, request, now);

  if (session !== null) {
    const form = await request.formData();
    if (form.get('scope') === 'all') {
      // `logout-all` after a suspected compromise. Returns a count, which is deliberately not shown
      // to the user: "we signed out 3 devices" is a number they cannot verify and would worry about.
      await revokeAllSessions(env, session.user_id, now);
    } else {
      await revokeSession(env, session, now);
    }
  }

  const headers = new Headers();
  headers.append('set-cookie', clearSessionCookieHeader());
  // The anonymous draft cookie's attributes must match the ones `apps/api` set it with, or the
  // browser deletes nothing.
  headers.append(
    'set-cookie',
    '__Host-aib_draft=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax',
  );
  throw redirect('/inloggen', { headers });
}

/** Unreachable: both handlers throw a redirect. Present because a route needs a component. */
export default function Logout() {
  return null;
}
