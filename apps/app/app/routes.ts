import { index, route } from '@react-router/dev/routes';
import type { RouteConfig } from '@react-router/dev/routes';

/**
 * The dashboard's routes.
 *
 * PATHS ARE DUTCH where another part of the system already fixed them, and that is not decoration:
 * `@aibuilder/auth`'s `MAGIC_LINK_VERIFY_PATH` is `/inloggen/verifieren` and
 * `apps/api/src/lib/entitlement.ts` sends a 402'd customer to `${DASHBOARD_ORIGIN}/facturatie`.
 * Those two strings are a contract with code owned elsewhere; renaming a route here silently breaks
 * a login link or a paywall link, and nothing would fail until a customer hit it.
 *
 * TYPES ARE EXPLICIT, NOT GENERATED. React Router ships a `typegen` step that emits `./+types/<route>`
 * modules, and this app deliberately does not use it: it would put a code generator between `tsc`
 * and every route in the repo's `typecheck` task, in CI and in the turbo cache, to save importing
 * `LoaderFunctionArgs`. Loaders here take `LoaderFunctionArgs`/`ActionFunctionArgs` and components
 * read `useLoaderData<typeof loader>()`, which the same compiler checks with nothing to run first.
 *
 * EVERY LOADER GUARDS ITSELF, including the four nested under `sites/:siteId`. React Router runs a
 * parent and its children's loaders in PARALLEL, so a child cannot wait on a parent's authorisation
 * even if it wanted to — and that is the better arrangement anyway: there is no route in this app
 * that is protected only because something above it happened to check. `routes/site.tsx` is a
 * layout for the chrome and the section navigation; it is not a gate, and no route relies on it
 * being one.
 */
export default [
  index('routes/home.tsx'),

  route('inloggen', 'routes/login.tsx'),
  route('inloggen/verifieren', 'routes/verify.tsx'),
  route('uitloggen', 'routes/logout.tsx'),

  route('dashboard', 'routes/dashboard.tsx'),
  route('facturatie', 'routes/billing.tsx'),
  route('instellingen', 'routes/settings.tsx'),

  route('sites/:siteId', 'routes/site.tsx', [
    index('routes/site.overview.tsx'),
    route('editor', 'routes/site.editor.tsx'),
    route('media', 'routes/site.media.tsx'),
    route('domein', 'routes/site.domain.tsx'),
  ]),

  // A RESOURCE route: no component, JSON only. Two things put it OUTSIDE the `sites/:siteId`
  // layout rather than inside it. It is the editor's write endpoint and must not drag a layout
  // loader into every keystroke; and it is a route of its own rather than the editor route's
  // action because `useFetcher` cancels in-flight submissions, and a cancelled patch is a
  // keystroke the customer watches disappear.
  route('sites/:siteId/draft', 'routes/site.draft.tsx'),
] satisfies RouteConfig;
