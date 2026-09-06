/**
 * Build-time configuration for the onboarding island.
 *
 * The island is a browser bundle, so everything here is a `PUBLIC_*` Vite variable substituted at
 * build time. It deliberately does not import `src/content/site.ts`: that module also carries the
 * legal-entity block and a build-time `console.warn`, none of which belongs in the client chunk
 * whose size is on the marketing page's idle budget (architecture §S6). The two files read the same
 * variables and must agree; they are asserted equal by nothing but review, which is why the names
 * are written out literally in both.
 *
 * Literal property access on `import.meta.env` is mandatory — Vite only substitutes the literal
 * form, and `import.meta.env[name]` would be `undefined` in the built bundle.
 */

/** Narrows a `PUBLIC_*` variable, which arrives as `unknown`, or falls back. */
function envOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

/**
 * Origin of the public API (architecture §S4).
 *
 * Cross-origin from the marketing host but same-*site* (both under the control-plane registrable
 * domain), which is what lets the `__Host-aib_draft` cookie ride along under `SameSite=Lax`.
 * Every call therefore sets `credentials: 'include'`, and the API answers
 * `Access-Control-Allow-Credentials: true` for exactly this origin.
 */
export const API_ORIGIN: string = envOr(
  import.meta.env.PUBLIC_API_ORIGIN,
  'https://api.aibuilder.app',
);

/** The tenant registrable domain. The reveal shows `<slug>.${SITES_ROOT_DOMAIN}`. */
export const SITES_ROOT_DOMAIN: string = envOr(
  import.meta.env.PUBLIC_SITES_ROOT_DOMAIN,
  'mijnsaas.com',
);

/**
 * Turnstile's script URL.
 *
 * Loaded lazily, on the first keystroke of step 1 — never on page load. It is the only third-party
 * script the marketing surface has, `challenges.cloudflare.com` is the sole non-self entry in the
 * `script-src`/`frame-src` of `public/_headers`, and pulling it in before the visitor has shown any
 * intent would put a third-party request on the LCP path for everyone who never opens the modal.
 *
 * `render=explicit` because the widget is created by `turnstile.render()` against a container this
 * island owns; the implicit renderer scans the document for `.cf-turnstile`, which would race the
 * island's own mount.
 */
export const TURNSTILE_SCRIPT_URL =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** `action` values the API's Turnstile verifier requires; a draft token cannot be replayed at submit. */
export const TURNSTILE_ACTION_DRAFT = 'draft-create';
export const TURNSTILE_ACTION_SUBMIT = 'onboarding-submit';

/** `localStorage` key for the resumable draft. The `v1` suffix is the schema version, not a date. */
export const LOCAL_DRAFT_KEY = 'aib.onboarding.v1';

/**
 * `localStorage` key for the accepted job, so a return from Stripe knows what it is returning to.
 *
 * The Checkout round trip is a full document unload: the island's state is gone and the only things
 * that come back are the URL's `?job=` and whatever was written to storage. Without this the
 * returning customer is shown a job id and nothing else — no reserved address, no photo count, no
 * live Checkout URL to reuse — and the recovery screen has to ask the API for facts it already had.
 * Nothing secret lives here: the job id is already in the address bar, and the Checkout URL is a
 * capability the same browser was just about to open.
 */
export const LOCAL_JOB_KEY = 'aib.onboarding.job.v1';

/**
 * Local draft schema version.
 *
 * Bumping it invalidates every stored draft, which is the correct behaviour for an incompatible
 * change: restoring a v1 draft into a v2 reader is how a wizard lands on a step whose fields no
 * longer exist.
 */
export const DRAFT_SCHEMA_VERSION = 1;

/** The real page that backs the modal, so the flow survives a hard navigation (UX §7.4). */
export const START_PATH = '/start/';

/** Attribute marking any CTA that opens the modal. Set by `components/CtaButton.astro`. */
export const CTA_ATTRIBUTE = 'data-onboarding-cta';
