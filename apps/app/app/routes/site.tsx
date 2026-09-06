/** @jsxImportSource react */
import { NavLink, Outlet, useLoaderData } from 'react-router';
import type { LoaderFunctionArgs } from 'react-router';

import { Shell } from '../components/Shell';
import { copyFor, uiLocaleFor } from '../lib/copy';
import { requireSiteAccess } from '../lib/guard.server';

/**
 * `/sites/:siteId` — the layout for one site's four pages.
 *
 * IT IS CHROME, NOT A GATE. React Router runs a parent's loader in PARALLEL with its children's, so
 * a child could not wait on this one's authorisation even if it wanted to. Every child loader calls
 * `requireSiteAccess` itself, and that is the arrangement worth having: there is no route in this
 * app that is protected only because something above it happened to check first.
 *
 * The cost is one extra membership seek per navigation. `cp.dashboard.getSiteForUser` is two index
 * seeks on rows this Worker's colo is already caching; correctness that is structural beats a saved
 * round trip that has to be argued for in review.
 */

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.cloudflare.env;
  const now = Date.now();
  const { viewer, site } = await requireSiteAccess(env, request, params['siteId'] ?? '', {
    minRole: 'viewer',
    now,
  });

  return {
    locale: uiLocaleFor({ userLocale: viewer.user.locale }),
    signedInAs: viewer.user.full_name ?? viewer.user.email,
    siteId: site.siteId,
    slug: site.slug,
    orgName: site.orgName,
  };
}

/** One section link. `end` on the overview so it is not "current" on every child route. */
function SectionLink({ to, label, end }: { to: string; label: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end ?? false}
      className={({ isActive }) => (isActive ? 'app-subnav__link is-current' : 'app-subnav__link')}
    >
      {label}
    </NavLink>
  );
}

export default function SiteLayout() {
  const { locale, signedInAs, siteId, slug, orgName } = useLoaderData<typeof loader>();
  const copy = copyFor(locale);
  const base = `/sites/${siteId}`;

  return (
    <Shell copy={copy} signedInAs={signedInAs}>
      <div className="app-site">
        <div className="app-site__heading">
          <p className="app-site__org">{orgName}</p>
          <p className="app-site__slug">{slug}</p>
        </div>
        {/* A second navigation landmark needs its own accessible name, or a screen reader announces
            two unlabelled "navigation" regions and the user has to guess which is which. */}
        <nav className="app-subnav" aria-label={slug}>
          <SectionLink to={base} label={copy.nav.overview} end />
          <SectionLink to={`${base}/editor`} label={copy.nav.editor} />
          <SectionLink to={`${base}/media`} label={copy.nav.media} />
          <SectionLink to={`${base}/domein`} label={copy.nav.domain} />
        </nav>
        <Outlet />
      </div>
    </Shell>
  );
}
