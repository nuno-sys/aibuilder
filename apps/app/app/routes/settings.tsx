/** @jsxImportSource react */
import { Form, useLoaderData } from 'react-router';
import type { LoaderFunctionArgs } from 'react-router';
import { cp } from '@aibuilder/db';

import { Shell } from '../components/Shell';
import { copyFor, uiLocaleFor } from '../lib/copy';
import { requireViewer } from '../lib/guard.server';

/**
 * `/instellingen` — the account, as it actually is.
 *
 * IT SHOWS `email_verified_at` HONESTLY. After `DECISIONS` §D2 a customer can hold a paid
 * subscription and a live site with an UNVERIFIED address, because Stripe Checkout collects an
 * e-mail and mails a receipt to it — which is not proof of control of a mailbox. Only a consumed
 * magic link sets `email_verified_at` (`PHASE2-BILLING-AUTH.md` §6.2), so the first sign-in through
 * `/inloggen` is what flips this. Showing "not confirmed yet" until then is the truth, and it is
 * also the nudge that gets the address confirmed.
 *
 * WHAT IS NOT HERE YET, and why saying so beats a disabled control: changing the e-mail address
 * (it rotates the session and re-verifies, and the flow belongs with the passkey work), inviting a
 * colleague (`memberships` supports it and `auth_tokens` has the `org_invite` purpose, but there is
 * no invitation mail), and deleting the account (an erasure request touches two databases and R2,
 * and it is an operator runbook before it is a button).
 *
 * "SIGN OUT EVERYWHERE" IS HERE because it is the one security control a customer can exercise
 * alone, and `revokeUserSessions` already exists and already returns a count.
 */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.cloudflare.env;
  const now = Date.now();
  const viewer = await requireViewer(env, request, now);
  const memberships = await cp.users.listMembershipsForUser(env.CP, viewer.userId);

  const organisations = await Promise.all(
    memberships.map(async (membership) => {
      const organisation = await cp.orgs.getOrganisation(env.CP, membership.org_id);
      return {
        orgId: membership.org_id,
        name: organisation?.name ?? membership.org_id,
        role: membership.role,
      };
    }),
  );

  return {
    locale: uiLocaleFor({ userLocale: viewer.user.locale }),
    signedInAs: viewer.user.full_name ?? viewer.user.email,
    email: viewer.user.email,
    emailVerified: viewer.user.email_verified_at !== null,
    organisations,
  };
}

export default function Settings() {
  const { locale, signedInAs, email, emailVerified, organisations } =
    useLoaderData<typeof loader>();
  const copy = copyFor(locale);

  return (
    <Shell copy={copy} signedInAs={signedInAs}>
      <main id="main-content" className="app-shell__main">
        <h1>{copy.settings.title}</h1>

        <dl className="app-facts">
          <dt>{copy.settings.emailLabel}</dt>
          <dd>
            {email}{' '}
            <span className={emailVerified ? 'app-badge' : 'app-badge app-badge--warn'}>
              {emailVerified ? copy.settings.verifiedYes : copy.settings.verifiedNo}
            </span>
          </dd>
        </dl>

        <section aria-labelledby="orgs-heading">
          <h2 id="orgs-heading">{copy.settings.organisationLabel}</h2>
          <ul className="app-activity">
            {organisations.map((organisation) => (
              <li key={organisation.orgId}>
                {organisation.name} — {copy.settings.roleLabel}: {organisation.role}
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="sessions-heading">
          <h2 id="sessions-heading">{copy.common.signOut}</h2>
          <Form method="post" action="/uitloggen">
            <input type="hidden" name="scope" value="all" />
            <button type="submit" className="aib-button aib-button--danger">
              {copy.settings.signOutEverywhere}
            </button>
          </Form>
        </section>
      </main>
    </Shell>
  );
}
