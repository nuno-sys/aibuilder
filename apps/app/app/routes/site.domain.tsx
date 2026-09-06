/** @jsxImportSource react */
import { useLoaderData } from 'react-router';
import type { LoaderFunctionArgs } from 'react-router';
import { cp } from '@aibuilder/db';

import { copyFor, uiLocaleFor } from '../lib/copy';
import { requireSiteAccess } from '../lib/guard.server';

/**
 * `/sites/:siteId/domein` — the honest Phase 3 placeholder.
 *
 * THIS PAGE SAYS "NOT YET" AND MEANS IT. Custom hostnames are Cloudflare for SaaS, and architecture
 * §9 puts that in Phase 3 with three prerequisites that do not exist yet: our own ownership proof
 * via a `_aibuilder-challenge` TXT record before the Custom Hostnames API is ever called, a daily
 * dangling-DNS reconciler, and the per-registrar DNS instructions the target market needs because
 * `www` is the canonical host and apex→www is a redirect they configure themselves.
 *
 * So there is no form here, and there is deliberately no "coming soon — join the waitlist" button
 * either. A disabled input that looks like it should work is worse than a sentence explaining why
 * it does not: the customer types their domain into it, nothing happens, and they file a support
 * ticket. The copy names the thing they actually want and says when it arrives.
 *
 * IT STILL READS THE DATABASE. `custom_domains` rows can exist — an operator can attach one, and a
 * migrated site arrives with one — so the page lists what is really there rather than assuming the
 * feature's absence means the table is empty. A dashboard that contradicts the database is how a
 * support conversation starts.
 */

/** No tenant has more than a handful; a bound, not a page size. */
const DOMAIN_LIMIT = 20;

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.cloudflare.env;
  const now = Date.now();
  const { viewer, site } = await requireSiteAccess(env, request, params['siteId'] ?? '', {
    minRole: 'viewer',
    now,
  });

  const domains = await cp.dashboard.listDomainsForSite(env.CP, {
    siteId: site.siteId,
    limit: DOMAIN_LIMIT,
  });

  return {
    locale: uiLocaleFor({ userLocale: viewer.user.locale }),
    canonicalHost: site.canonicalHost,
    domains: domains.map((domain) => ({
      hostname: domain.hostname,
      status: domain.status,
      sslStatus: domain.ssl_status,
      isPrimary: domain.is_primary === 1,
    })),
  };
}

export default function SiteDomain() {
  const { locale, canonicalHost, domains } = useLoaderData<typeof loader>();
  const copy = copyFor(locale);

  return (
    <main id="main-content" className="app-shell__main">
      <h1>{copy.domain.title}</h1>

      <dl className="app-facts">
        <dt>{copy.domain.currentLabel}</dt>
        <dd>
          <a href={`https://${canonicalHost}`} rel="noreferrer">
            {canonicalHost}
          </a>
        </dd>
      </dl>

      <section aria-labelledby="domain-phase" className="app-notice">
        <h2 id="domain-phase">{copy.domain.phaseTitle}</h2>
        <p>{copy.domain.phaseDetail}</p>
      </section>

      <section aria-labelledby="domain-attached">
        <h2 id="domain-attached">{copy.domain.attachedTitle}</h2>
        {domains.length === 0 ? (
          <p>{copy.domain.attachedEmpty}</p>
        ) : (
          <ul className="app-activity">
            {domains.map((domain) => (
              <li key={domain.hostname}>
                {domain.hostname} — {domain.status} · {domain.sslStatus}
                {domain.isPrimary ? ' · primary' : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
