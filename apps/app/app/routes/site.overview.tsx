/** @jsxImportSource react */
import { Form, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { shard } from '@aibuilder/db';
import { Button } from '@aibuilder/ui';

import { regenerateSite } from '../lib/api.server';
import { copyFor, uiLocaleFor } from '../lib/copy';
import { requireSiteAccess } from '../lib/guard.server';

/**
 * `/sites/:siteId` — what this site is doing right now, and the one button that spends money.
 *
 * REGENERATE CALLS THE SERVER GATE AND RENDERS WHAT IT SAYS. This route does not decide whether the
 * customer may regenerate; `POST /v1/sites/:id/regenerate` does, and its refusal is a real state
 * change — a `generation_jobs` row with `status='blocked_paywall'` and `finished_at` set. Rendering
 * anything other than the answer it gave (guessing from `entitlement`, hiding the button, retrying)
 * would put a second, divergent copy of the paywall in the client.
 *
 * Four answers, four screens, and they are genuinely different situations:
 *   202 → started; the current site stays online while the new one builds.
 *   402 → the subscription is not active; the copy points at the billing page.
 *   409 → the quota is spent. After `DECISIONS` §D2 this is the limiter customers actually meet —
 *         two regenerations per 30 days — and calling it a payment problem would be a lie.
 *   *   → something went wrong; say so and offer a retry rather than inventing a reason.
 *
 * THE BUTTON IS A FORM POST to this route's own action, so it is CSRF-protected by the framework's
 * same-origin form handling AND by the API's Origin guard on the far side.
 */

/** Enough activity to show what happened; not a log viewer. */
const JOB_LIMIT = 5;

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.cloudflare.env;
  const now = Date.now();
  const { viewer, site } = await requireSiteAccess(env, request, params['siteId'] ?? '', {
    minRole: 'viewer',
    now,
  });

  const jobs = await shard.editor.listJobsForSite(site.db, {
    siteId: site.siteId,
    limit: JOB_LIMIT,
  });

  return {
    locale: uiLocaleFor({ userLocale: viewer.user.locale }),
    canRegenerate: site.role === 'owner' || site.role === 'admin' || site.role === 'editor',
    site: {
      status: site.status,
      canonicalHost: site.canonicalHost,
      indexState: site.indexState,
      published: site.publishedVersionId !== null,
    },
    jobs: jobs.map((job) => ({
      id: job.id,
      kind: job.kind,
      status: job.status,
      createdAt: job.created_at,
      finishedAt: job.finished_at,
    })),
  };
}

/** What the action tells the page. One of four, never a raw status code. */
type RegenerateOutcome = 'started' | 'blocked' | 'quota' | 'failed';

export async function action({ request, params, context }: ActionFunctionArgs) {
  const env = context.cloudflare.env;
  const now = Date.now();
  // Re-guarded, with a higher bar than the loader: a `viewer` may read this page and may not spend
  // the organisation's money on it.
  const { site } = await requireSiteAccess(env, request, params['siteId'] ?? '', {
    minRole: 'editor',
    now,
  });

  const result = await regenerateSite(env, request, site.siteId);
  const outcome: RegenerateOutcome =
    result.status === 202 || result.status === 200
      ? 'started'
      : result.status === 402
        ? 'blocked'
        : result.status === 409
          ? 'quota'
          : 'failed';

  return { outcome, portalUrl: result.body?.portalUrl ?? null };
}

export default function SiteOverview() {
  const { locale, site, jobs, canRegenerate } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const navigation = useNavigation();
  const copy = copyFor(locale);
  const busy = navigation.state === 'submitting';

  const indexText =
    site.indexState === 'indexable'
      ? copy.site.indexIndexable
      : site.indexState === 'eligible'
        ? copy.site.indexEligible
        : copy.site.indexNoindex;

  return (
    <main id="main-content" className="app-shell__main">
      <h1>{copy.site.overviewTitle}</h1>

      <dl className="app-facts">
        <dt>{copy.site.addressLabel}</dt>
        <dd>
          {site.published ? (
            <a href={`https://${site.canonicalHost}`} rel="noreferrer">
              {site.canonicalHost}
            </a>
          ) : (
            copy.dashboard.notPublished
          )}
        </dd>
        <dt>{copy.site.indexLabel}</dt>
        <dd>{indexText}</dd>
      </dl>

      <section aria-labelledby="regenerate-heading">
        <h2 id="regenerate-heading">{copy.site.regenerate}</h2>
        <p>{copy.site.regenerateHint}</p>
        {canRegenerate ? (
          <Form method="post">
            <Button type="submit" variant="primary" busy={busy}>
              {busy ? copy.common.loading : copy.site.regenerate}
            </Button>
          </Form>
        ) : null}

        {/* `role="status"` for the success and `role="alert"` for the refusals: one is information
            the user asked for, the other interrupts because it changes what they should do next. */}
        {data?.outcome === 'started' ? <p role="status">{copy.site.regenerateStarted}</p> : null}
        {data?.outcome === 'quota' ? <p role="alert">{copy.site.regenerateQuota}</p> : null}
        {data?.outcome === 'failed' ? <p role="alert">{copy.site.regenerateFailed}</p> : null}
        {data?.outcome === 'blocked' ? (
          <p role="alert">
            {copy.site.regenerateBlocked}{' '}
            <a href={data.portalUrl ?? '/facturatie'}>{copy.editor.paywallAction}</a>
          </p>
        ) : null}
      </section>

      <section aria-labelledby="activity-heading">
        <h2 id="activity-heading">{copy.site.lastActivity}</h2>
        {jobs.length === 0 ? (
          <p>{copy.site.noActivity}</p>
        ) : (
          <ul className="app-activity">
            {jobs.map((job) => (
              <li key={job.id}>
                <time dateTime={new Date(job.createdAt).toISOString()}>
                  {new Intl.DateTimeFormat(locale, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }).format(new Date(job.createdAt))}
                </time>{' '}
                — {job.kind} · {job.status}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
