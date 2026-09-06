/** @jsxImportSource react */
import { Link, useLoaderData } from 'react-router';
import type { LoaderFunctionArgs } from 'react-router';
import { cp } from '@aibuilder/db';

import { Shell } from '../components/Shell';
import { copyFor, uiLocaleFor } from '../lib/copy';
import { requireViewer } from '../lib/guard.server';

/**
 * `/dashboard` — every site the signed-in customer can reach.
 *
 * ONE STATEMENT, AND IT IS DRIVEN FROM `memberships`. `cp.dashboard.listSitesForUser` starts at the
 * covering index on `(user_id, org_id, role)` and joins outward, so a user sees exactly the sites of
 * the organisations they belong to — the isolation is the join, not a filter applied afterwards to
 * a list of everything. There is no code path here that reads a site and then decides.
 *
 * IT SHOWS THE TRIAL DEADLINE, because `DECISIONS` §D2 put the card before the first generation:
 * every customer with a site is inside a seven-day trial or past it, and a dashboard that does not
 * say when the trial ends is a dashboard that gets a support e-mail on day eight.
 */

/** More sites than any customer of this product has. A bound, not a page size. */
const SITE_LIMIT = 50;

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.cloudflare.env;
  const now = Date.now();
  const viewer = await requireViewer(env, request, now);

  const sites = await cp.dashboard.listSitesForUser(env.CP, {
    userId: viewer.userId,
    limit: SITE_LIMIT,
  });

  return {
    locale: uiLocaleFor({ userLocale: viewer.user.locale }),
    signedInAs: viewer.user.full_name ?? viewer.user.email,
    marketingOrigin: env.APP_ORIGIN,
    sites: sites.map((site) => ({
      id: site.id,
      slug: site.slug,
      orgName: site.org_name,
      status: site.status,
      canonicalHost: site.canonical_host,
      published: site.published_version_id !== null,
      entitlement: site.entitlement,
      entitlementUntil: site.entitlement_until,
    })),
  };
}

/** Formats a deadline for display. `null` renders nothing rather than "Invalid Date". */
function formatDate(value: number | null, locale: string): string | null {
  if (value === null) {
    return null;
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(value));
}

export default function Dashboard() {
  const { locale, signedInAs, sites, marketingOrigin } = useLoaderData<typeof loader>();
  const copy = copyFor(locale);

  return (
    <Shell copy={copy} signedInAs={signedInAs}>
      <main id="main-content" className="app-shell__main">
        <h1>{copy.dashboard.title}</h1>

        {sites.length === 0 ? (
          <div className="app-empty">
            <p>{copy.dashboard.empty}</p>
            {/* Onboarding lives on the marketing origin, so this is a plain anchor and not a
                `<Link>`: it leaves the application. */}
            <a className="aib-button aib-button--primary" href={`${marketingOrigin}/start/`}>
              {copy.dashboard.emptyAction}
            </a>
          </div>
        ) : (
          <ul className="app-site-list">
            {sites.map((site) => {
              const trialEnd =
                site.entitlement === 'trialing' ? formatDate(site.entitlementUntil, locale) : null;
              return (
                <li key={site.id} className="app-site-card">
                  <h2 className="app-site-card__title">
                    <Link to={`/sites/${site.id}`}>{site.slug}</Link>
                  </h2>
                  <p className="app-site-card__meta">{site.orgName}</p>
                  <p className="app-site-card__meta">
                    {site.published ? (
                      <a href={`https://${site.canonicalHost}`} rel="noreferrer">
                        {site.canonicalHost}
                      </a>
                    ) : (
                      copy.dashboard.notPublished
                    )}
                  </p>
                  {trialEnd === null ? null : (
                    <p className="app-site-card__meta">
                      {copy.dashboard.trialEndsOn} {trialEnd}
                    </p>
                  )}
                  <p>
                    <Link
                      className="aib-button aib-button--secondary"
                      to={`/sites/${site.id}/editor`}
                    >
                      {copy.dashboard.openEditor}
                    </Link>
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </Shell>
  );
}
