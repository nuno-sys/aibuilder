/** @jsxImportSource react */
import { Form, NavLink } from 'react-router';
import type { ReactNode } from 'react';

import type { Copy } from '../lib/copy';

/**
 * The dashboard's chrome: one landmark set, rendered the same way on every page.
 *
 * THE LANDMARKS ARE THE NAVIGATION MODEL for a screen-reader user, so they are not decoration and
 * they are not duplicated: exactly one `<header>`, one `<nav>` with an accessible name, and one
 * `<main id="main-content">` per page — which is what the root's skip link targets. A page that
 * rendered a second `<main>` would make the skip link ambiguous and the document outline wrong.
 *
 * `aria-current="page"` COMES FROM `NavLink` and is the thing that tells a screen reader which item
 * of a visually-highlighted list is the current one. Colour alone would fail SC 1.4.1.
 *
 * SIGN OUT IS A FORM, not a link. A `GET` sign-out is CSRF-able from any page on the internet
 * (`<img src="https://app…/uitloggen">`), and being signed out of the tool you are using is a real
 * denial of service.
 */

export interface ShellProps {
  readonly copy: Copy;
  /** The signed-in user's display name. `null` renders no identity block. */
  readonly signedInAs: string | null;
  readonly children: ReactNode;
}

/** One top-level navigation item. */
function Item({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => (isActive ? 'app-nav__link is-current' : 'app-nav__link')}
      end
    >
      {label}
    </NavLink>
  );
}

/** Renders the application chrome around a page. */
export function Shell({ copy, signedInAs, children }: ShellProps) {
  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <a className="app-shell__brand" href="/dashboard">
          aibuilder
        </a>
        <nav className="app-nav" aria-label={copy.nav.label}>
          <Item to="/dashboard" label={copy.nav.dashboard} />
          <Item to="/facturatie" label={copy.nav.billing} />
          <Item to="/instellingen" label={copy.nav.settings} />
        </nav>
        {signedInAs === null ? null : (
          <div className="app-shell__identity">
            <span className="app-shell__who">{signedInAs}</span>
            <Form method="post" action="/uitloggen">
              <button type="submit" className="aib-button aib-button--ghost">
                {copy.common.signOut}
              </button>
            </Form>
          </div>
        )}
      </header>
      {children}
    </div>
  );
}
