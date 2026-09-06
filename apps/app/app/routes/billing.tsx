/** @jsxImportSource react */
import { Form, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { cp } from '@aibuilder/db';
import type { OrganisationId } from '@aibuilder/db';
import { Button } from '@aibuilder/ui';

import { Shell } from '../components/Shell';
import { createPortalSession } from '../lib/api.server';
import { copyFor, uiLocaleFor } from '../lib/copy';
import { requireViewer, resolveActiveOrg } from '../lib/guard.server';

/**
 * `/facturatie` — the subscription's state and the invoices behind it.
 *
 * THE PATH IS PART OF A CONTRACT. `apps/api/src/lib/entitlement.ts` answers a 402 with
 * `portalUrl: ${DASHBOARD_ORIGIN}/facturatie`, so this route's path is referenced by a Worker that
 * knows nothing else about this app. Renaming it breaks every paywall link, silently.
 *
 * THIS PAGE IS NOT BEHIND THE PAYWALL, and that is the point. A customer whose trial lapsed must be
 * able to reach the screen with the payment button on it; locking them out of it is how you lose
 * someone who was trying to give you money. `requireViewer` — a session and nothing more.
 *
 * WE DO NOT BUILD A BILLING UI. Stripe's customer portal is PCI-compliant, localised, handles SCA,
 * proration, tax IDs and cancellation flows, and is maintained by somebody else. What this page owns
 * is the summary a customer wants at a glance — am I on trial, when does it end, what have I been
 * charged — read from OUR mirror, because a page that has to call Stripe to render is a page that
 * fails when Stripe is slow.
 *
 * THE PORTAL LINK IS MINTED ON THE CLICK. A portal session is short-lived and single-use; rendering
 * one into a page that might sit in a tab for an hour produces a dead link exactly when it is
 * needed. So the button is a form post, and the action redirects to the URL the API just minted.
 */

/** Two years of monthly invoices. More than that is an export, not a page. */
const INVOICE_LIMIT = 24;

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.cloudflare.env;
  const now = Date.now();
  const viewer = await requireViewer(env, request, now);
  const orgId = await resolveActiveOrg(env, viewer);

  const locale = uiLocaleFor({ userLocale: viewer.user.locale });
  const signedInAs = viewer.user.full_name ?? viewer.user.email;

  if (orgId === null) {
    // A user with no membership: the provisional organisation from onboarding is unreachable until
    // the Stripe webhook creates the membership, and that is the tenancy isolation invariant doing
    // its job rather than an error.
    return {
      locale,
      signedInAs,
      orgId: null,
      organisation: null,
      subscription: null,
      invoices: [],
    };
  }

  const [organisation, subscriptions, invoices] = await Promise.all([
    cp.orgs.getOrganisation(env.CP, orgId),
    cp.subscriptions.listLiveSubscriptionsForOrg(env.CP, orgId),
    cp.billing.listInvoicesForOrg(env.CP, { orgId, limit: INVOICE_LIMIT }),
  ]);
  const subscription = subscriptions[0] ?? null;

  return {
    locale,
    signedInAs,
    orgId,
    organisation:
      organisation === null
        ? null
        : {
            name: organisation.name,
            plan: organisation.plan,
            entitlement: organisation.entitlement,
            entitlementUntil: organisation.entitlement_until,
          },
    subscription:
      subscription === null
        ? null
        : {
            status: subscription.status,
            currentPeriodEnd: subscription.current_period_end,
            cancelAtPeriodEnd: subscription.cancel_at_period_end === 1,
          },
    invoices: invoices.map((invoice) => ({
      id: invoice.stripe_invoice_id,
      number: invoice.number,
      status: invoice.status,
      totalCents: invoice.total_cents,
      currency: invoice.currency,
      issuedAt: invoice.issued_at,
      hostedUrl: invoice.hosted_invoice_url,
    })),
  };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.cloudflare.env;
  const now = Date.now();
  const viewer = await requireViewer(env, request, now);
  const orgId = await resolveActiveOrg(env, viewer);
  if (orgId === null) {
    return { failed: true } as const;
  }

  // The API enforces `owner` on this route; asking again here is not duplication, it is what lets
  // the page hide a button an editor may not press instead of showing them a 403.
  const result = await createPortalSession(env, request, orgId as OrganisationId);
  const url = result.body?.url;
  if (result.status !== 200 || url === undefined || !url.startsWith('https://')) {
    return { failed: true } as const;
  }
  // An external redirect, deliberately: the portal is Stripe's origin, and `redirect()` here emits a
  // 302 the browser follows out of the application.
  throw redirect(url);
}

/** Money, in the invoice's own currency. Never a hardcoded symbol. */
function formatMoney(cents: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

export default function Billing() {
  const { locale, signedInAs, organisation, subscription, invoices } =
    useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const navigation = useNavigation();
  const copy = copyFor(locale);
  const busy = navigation.state === 'submitting';

  const formatDate = (value: number | null): string =>
    value === null
      ? '—'
      : new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(value));

  return (
    <Shell copy={copy} signedInAs={signedInAs}>
      <main id="main-content" className="app-shell__main">
        <h1>{copy.billing.title}</h1>

        {organisation === null ? (
          <p>{copy.errors.notFoundDetail}</p>
        ) : (
          <>
            <dl className="app-facts">
              <dt>{copy.billing.planLabel}</dt>
              <dd>{organisation.plan}</dd>
              <dt>{copy.billing.statusLabel}</dt>
              <dd>{organisation.entitlement}</dd>
              <dt>
                {subscription?.cancelAtPeriodEnd === true
                  ? copy.billing.endsOn
                  : copy.billing.renewsOn}
              </dt>
              <dd>{formatDate(subscription?.currentPeriodEnd ?? organisation.entitlementUntil)}</dd>
            </dl>

            <Form method="post">
              <Button type="submit" variant="primary" busy={busy}>
                {copy.billing.manage}
              </Button>
              <p className="app-hint">{copy.billing.manageHint}</p>
            </Form>
            {data?.failed === true ? <p role="alert">{copy.billing.portalFailed}</p> : null}
          </>
        )}

        <section aria-labelledby="invoices-heading">
          <h2 id="invoices-heading">{copy.billing.invoices}</h2>
          {invoices.length === 0 ? (
            <p>{copy.billing.noInvoices}</p>
          ) : (
            // A real table with real headers: an invoice list is tabular data, and a grid of divs
            // is unnavigable with a screen reader's table commands.
            <table className="app-table">
              <thead>
                <tr>
                  <th scope="col">{copy.billing.invoiceDate}</th>
                  <th scope="col">{copy.billing.invoiceAmount}</th>
                  <th scope="col">{copy.billing.invoiceStatus}</th>
                  <th scope="col">
                    <span className="aib-sr-only">{copy.billing.invoiceDownload}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td>{formatDate(invoice.issuedAt)}</td>
                    <td>{formatMoney(invoice.totalCents, invoice.currency, locale)}</td>
                    <td>{invoice.status}</td>
                    <td>
                      {invoice.hostedUrl === null ? null : (
                        <a href={invoice.hostedUrl} rel="noreferrer">
                          {copy.billing.invoiceDownload}
                          {/* The link text is identical on every row, so each one names its own
                              invoice for a screen reader's link list (SC 2.4.4). */}
                          <span className="aib-sr-only"> {invoice.number ?? invoice.id}</span>
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </Shell>
  );
}
