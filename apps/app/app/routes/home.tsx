/** @jsxImportSource react */
import { redirect } from 'react-router';
import type { LoaderFunctionArgs } from 'react-router';

import { loadViewer } from '../lib/guard.server';

/**
 * `/` — a decision, not a page.
 *
 * The dashboard has no public front page: the marketing site is a different origin and owns that
 * job. So the root either sends a signed-in customer to their sites or an anonymous visitor to the
 * login form, and renders nothing either way. `run_worker_first` in `wrangler.jsonc` is what makes
 * this possible — the static asset handler would otherwise answer `/` before the Worker saw it.
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const viewer = await loadViewer(context.cloudflare.env, request, Date.now());
  throw redirect(viewer === null ? '/inloggen' : '/dashboard');
}

/** Unreachable: the loader always throws a redirect. Present because a route needs a component. */
export default function Home() {
  return null;
}
