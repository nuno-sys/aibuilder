/**
 * THE `rpID` ONE-WAY DOOR (architecture §10, door 7; `PHASE2-BILLING-AUTH.md` §6.5).
 *
 * A WebAuthn credential is scoped to the RP ID it was created under and **cannot be migrated**.
 * Changing that string invalidates every passkey ever registered, with no recovery path that does
 * not involve every user re-enrolling from a second factor they may not have. There is no
 * deprecation window and no dual-accept trick: the browser simply will not offer a credential whose
 * RP ID does not match.
 *
 * SO THE VALUE IS FIXED NOW, AND IT IS A SUBDOMAIN: `app.<control-plane-domain>`, never the apex.
 * Two failure modes make the apex wrong, and only one of them is obvious:
 *
 *  1. **A domain on the Public Suffix List cannot be an RP ID.** Browsers reject it outright. This
 *     product's roadmap already contains a PSL submission (architecture §9, one-way door 5, for
 *     `mijnsaas.com`). Submitting the *control-plane* domain later — for any reason at all,
 *     including a subdomain-isolation hardening decision nobody has thought of yet — would
 *     instantly invalidate every apex-scoped passkey in existence.
 *  2. **An apex RP ID is valid for every subdomain of the apex**, including future ones whose
 *     security we do not control. A passkey scoped to the apex can be used by anything we ever host
 *     under it.
 *
 * This module is the enforcement. It is called on **every** ceremony rather than once at boot,
 * because the realistic mistake is not a typo — it is someone changing a `var` in
 * `wrangler.jsonc` and deploying. A broadened RP ID must fail loudly at the first ceremony, before
 * a single credential is minted under it, which is exactly when the mistake is still free.
 */

/** Raised when the configured RP ID would open the one-way door. Never carries a secret. */
export class RpIdInvariantError extends Error {
  /** Machine-readable reason, for logs and for the route's error body. */
  public readonly reason: string;

  public constructor(reason: string) {
    super(`WEBAUTHN_RP_ID violates the one-way-door invariant: ${reason}`);
    this.name = 'RpIdInvariantError';
    this.reason = reason;
  }
}

/**
 * The first label the RP ID must carry.
 *
 * `app.<control-plane-domain>` is the dashboard's host, and the RP ID must equal it: a credential
 * is offered on the origin whose host matches, so an RP ID that is not the dashboard's host is a
 * credential nobody can ever use.
 */
export const WEBAUTHN_RP_ID_FIRST_LABEL = 'app';

/**
 * Minimum labels in the RP ID.
 *
 * Three is what separates `app.example.com` from `example.com`. It is a floor and not an equality
 * because the control-plane domain may itself be a two-label public suffix (`example.co.uk`), in
 * which case the correct RP ID has four.
 */
export const MIN_RP_ID_LABELS = 3;

/** What an RP ID is checked against. Both values come from `vars`, never from source (§D1). */
export interface RpIdConfig {
  /** `WEBAUTHN_RP_ID`. */
  readonly rpId: string;
  /** `DASHBOARD_ORIGIN`, e.g. `https://app.<control-plane-domain>`. */
  readonly dashboardOrigin: string;
}

/** A single hostname label: LDH, no leading or trailing hyphen. */
const LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** The hostname of an origin, or `null` when it is not a URL — which is a deployment fault. */
function hostnameOf(origin: string): string | null {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

/**
 * Returns the reason the configuration is unsafe, or `null` when it is safe.
 *
 * Split from `assertRpId` so the same rules can be asserted as data in a test, and so a route can
 * report the reason without catching an exception.
 */
export function rpIdProblem(config: RpIdConfig): string | null {
  const { rpId, dashboardOrigin } = config;

  if (typeof rpId !== 'string' || rpId.length < 3 || rpId.length > 253) {
    return 'not_configured';
  }
  if (rpId !== rpId.toLowerCase()) {
    // `webauthn_credentials.rp_id` carries `CHECK (rp_id = lower(rp_id))`; a mixed-case value would
    // be rejected by D1 *after* the browser had already created the credential.
    return 'not_lowercase';
  }

  const labels = rpId.split('.');
  if (labels.some((label) => !LABEL_PATTERN.test(label))) {
    return 'not_a_hostname';
  }
  if (labels.length < MIN_RP_ID_LABELS) {
    // The apex. This is THE mistake this module exists to stop.
    return 'apex_or_registrable_domain';
  }
  if (labels[0] !== WEBAUTHN_RP_ID_FIRST_LABEL) {
    return 'not_the_dashboard_subdomain';
  }

  const host = hostnameOf(dashboardOrigin);
  if (host === null) {
    return 'dashboard_origin_not_a_url';
  }
  if (host !== rpId) {
    // The realistic failure: somebody moves the dashboard to a different host and the ceremony's
    // `expectedOrigin` silently stops matching `expectedRPID`. Caught here, before any credential
    // is minted against the new host.
    return 'dashboard_origin_host_mismatch';
  }
  if (!dashboardOrigin.startsWith('https://')) {
    // WebAuthn requires a secure context. An `http://` dashboard would fail in the browser, but it
    // would fail *after* the server had committed to the ceremony.
    return 'dashboard_origin_not_https';
  }

  return null;
}

/**
 * Asserts the RP ID invariant.
 *
 * @throws RpIdInvariantError when the configuration would create credentials that a future PSL
 * entry could invalidate, or credentials the dashboard's own origin cannot use.
 */
export function assertRpId(config: RpIdConfig): void {
  const problem = rpIdProblem(config);
  if (problem !== null) {
    throw new RpIdInvariantError(problem);
  }
}
