/** @jsxImportSource react */
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useLoaderData,
  useRouteError,
} from 'react-router';
import type { LinksFunction, LoaderFunctionArgs } from 'react-router';
import type { ReactNode } from 'react';
import uiStyles from '@aibuilder/ui/styles.css?url';

import appStyles from './styles/app.css?url';
import { copyFor, uiLocaleFor } from './lib/copy';
import type { UiLocale } from './lib/copy';
import { loadViewer } from './lib/guard.server';

/**
 * The document shell.
 *
 * IT LOADS THE VIEWER, AND THAT IS THE ONLY THING IT LOADS. The root loader runs on every
 * navigation, so anything expensive here is expensive everywhere. What it needs is the language to
 * put on `<html lang>` — which is a rendering decision, not an authorisation one — so it uses the
 * non-throwing `loadViewer`: an unauthenticated visitor on `/inloggen` must not be redirected by
 * the shell that is rendering the login page.
 *
 * `<html lang>` IS NOT COSMETIC. A screen reader chooses its pronunciation rules from it, and a
 * Dutch page announced by an English voice is close to unusable. It is set from the signed-in
 * user's stored locale, falling back to `Accept-Language`.
 *
 * THE SKIP LINK IS FIRST IN THE DOM and visible on focus (WCAG 2.2 SC 2.4.1). It targets
 * `#main-content`, which every page provides, because a skip link that lands nowhere is worse than
 * none — it consumes the first Tab and does nothing with it.
 */

export const links: LinksFunction = () => [
  { rel: 'stylesheet', href: uiStyles },
  { rel: 'stylesheet', href: appStyles },
];

export async function loader({ request, context }: LoaderFunctionArgs) {
  const viewer = await loadViewer(context.cloudflare.env, request, Date.now());
  const locale = uiLocaleFor({
    userLocale: viewer?.user.locale,
    acceptLanguage: request.headers.get('accept-language'),
  });
  return {
    locale,
    // The header renders a name; it never renders an id. `null` when signed out.
    signedInAs: viewer === null ? null : (viewer.user.full_name ?? viewer.user.email),
  };
}

/** The HTML document. Shared by the app and by the error boundary, so both are complete pages. */
function Document({ locale, children }: { locale: UiLocale; children: ReactNode }) {
  const copy = copyFor(locale);
  return (
    <html lang={locale}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* The dashboard is behind a session and must never be indexed, whatever a stray link says. */}
        <meta name="robots" content="noindex, nofollow" />
        <Meta />
        <Links />
      </head>
      <body>
        <a className="aib-skip-link" href="#main-content">
          {copy.common.skipToContent}
        </a>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const { locale } = useLoaderData<typeof loader>();
  return (
    <Document locale={locale}>
      <Outlet />
    </Document>
  );
}

/**
 * The error boundary.
 *
 * It renders a COMPLETE document, including `<html lang>` and the stylesheets, because a boundary
 * that renders a fragment produces an unstyled page in an unknown language at the exact moment the
 * user is already confused.
 *
 * It never renders the error's own message for a 500. A thrown error's message on this surface
 * could be a D1 statement or a binding name; the thrown `Response`s this app raises deliberately
 * carry no body worth reading, and the boundary says the same thing for all of them.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  // The loader may not have run, so the locale is not available here. Dutch is the product default
  // and is the honest fallback rather than guessing from a header the boundary cannot see.
  const copy = copyFor('nl');
  const isNotFound = isRouteErrorResponse(error) && error.status === 404;

  return (
    <Document locale="nl">
      <main id="main-content" className="app-shell__main app-error">
        <h1>{isNotFound ? copy.errors.notFound : copy.errors.generic}</h1>
        <p>{isNotFound ? copy.errors.notFoundDetail : ''}</p>
        <p>
          <a href="/dashboard">{copy.nav.dashboard}</a>
        </p>
      </main>
    </Document>
  );
}
