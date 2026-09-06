/**
 * The JSON response shapes every route in this Worker answers with.
 *
 * Two rules hold everywhere. **Bodies are built here, not inline**, so that a status code and its
 * body shape are decided in one place and the modal can rely on `error` being a stable machine
 * string. And **every human-readable message ships twice** — `message` in Dutch, the primary UI
 * language of the product, and `messageEn` alongside it for logs, support tooling and the English
 * modal. The `error` field is never translated: it is what the client switches on.
 *
 * Cache-Control is explicit on every response these helpers build. Nothing in this API is
 * cacheable by default: `GET /v1/bootstrap` opts in to `public, max-age=3600` on purpose, and
 * everything else is `private, no-store` because it is either cookie-authenticated or a mutation.
 */

/** The status codes this API is allowed to answer with. Anything else is a bug, not a branch. */
export type ApiStatus =
  | 200
  | 201
  | 202
  | 204
  | 303
  | 304
  | 400
  | 401
  | 402
  | 403
  | 404
  | 409
  | 410
  | 413
  | 415
  | 422
  | 429
  | 451
  | 500
  | 502
  | 503;

/** The body every non-2xx JSON response carries. Routes may add fields, never remove these. */
export interface ApiErrorBody {
  /** Stable machine string. Never localised, never derived from user input. */
  readonly error: string;
  /** Dutch, user-facing. */
  readonly message: string;
  /** English, for logs and the English modal. */
  readonly messageEn: string;
}

/** A field-keyed validation error map: `{ "address.postalCode": ["too_small"] }`. */
export interface FieldErrors {
  readonly [field: string]: readonly string[];
}

/** The key form-level (cross-field) errors are reported under, e.g. the address-or-area refine. */
export const FORM_ERROR_KEY = '_';

/** The 422 body. `fields` is always present, even when only the form-level key is populated. */
export interface ValidationErrorBody extends ApiErrorBody {
  readonly error: 'validation_failed';
  readonly fields: FieldErrors;
}

/** The subset of a Zod issue this module needs, declared structurally to avoid a zod type import. */
export interface ValidationIssue {
  readonly path: readonly PropertyKey[];
  readonly code: string;
  readonly message: string;
}

/** Headers applied to every response that must never be stored by a cache or a proxy. */
const NO_STORE: Readonly<Record<string, string>> = {
  'cache-control': 'private, no-store',
};

/**
 * Builds a JSON response.
 *
 * Guarantees `content-type: application/json; charset=utf-8` and, unless the caller overrides it,
 * `cache-control: private, no-store`.
 */
export function jsonResponse(
  body: unknown,
  status: ApiStatus,
  headers: Readonly<Record<string, string>> = {},
): Response {
  const merged = new Headers({ ...NO_STORE, ...headers });
  merged.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers: merged });
}

/**
 * Builds an error response.
 *
 * `extra` is merged into the body, which is how §S4's per-status extras (`mode` on 402,
 * `server` on 409, `reason` on 451) travel without a bespoke helper each.
 */
export function errorResponse(
  status: ApiStatus,
  error: string,
  message: string,
  messageEn: string,
  extra: Readonly<Record<string, unknown>> = {},
  headers: Readonly<Record<string, string>> = {},
): Response {
  const body: ApiErrorBody & Record<string, unknown> = { error, message, messageEn, ...extra };
  return jsonResponse(body, status, headers);
}

/**
 * Turns validation issues into the field-keyed map `POST /v1/onboarding/submit` answers 422 with.
 *
 * Keys are dotted paths (`address.postalCode`, `openingHours.spec.0.opens`); a cross-field issue
 * has an empty path and lands under `FORM_ERROR_KEY`. Values are issue CODES, never messages that
 * could echo the submitted value back into a response body — the modal already owns the Dutch copy
 * for each field, and a code cannot leak what the user typed.
 */
export function fieldErrorsFromIssues(issues: readonly ValidationIssue[]): FieldErrors {
  const out: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.length === 0 ? FORM_ERROR_KEY : issue.path.map(String).join('.');
    const codes = out[key] ?? [];
    // A refine reports its rule name as the message and `custom` as the code; the rule name is the
    // useful half ("address_or_service_area_required"), so it wins where it exists.
    const code = issue.code === 'custom' && issue.message.length > 0 ? issue.message : issue.code;
    if (!codes.includes(code)) {
      codes.push(code);
    }
    out[key] = codes;
  }
  return out;
}

/** Dutch copy for the generic 422. Field-level copy belongs to the modal, not to the API. */
const VALIDATION_MESSAGE_NL =
  'Sommige gegevens kloppen nog niet. Controleer de gemarkeerde velden.';
const VALIDATION_MESSAGE_EN = 'Some details are not valid yet. Check the highlighted fields.';

/** Builds the 422 response from a field map. */
export function validationErrorResponse(fields: FieldErrors): Response {
  const body: ValidationErrorBody = {
    error: 'validation_failed',
    message: VALIDATION_MESSAGE_NL,
    messageEn: VALIDATION_MESSAGE_EN,
    fields,
  };
  return jsonResponse(body, 422);
}

/** Builds the 422 response straight from a failed parse. */
export function validationErrorFromIssues(issues: readonly ValidationIssue[]): Response {
  return validationErrorResponse(fieldErrorsFromIssues(issues));
}

/** 400 for a body that is not JSON at all — a client bug, not a validation failure. */
export function malformedBodyResponse(): Response {
  return errorResponse(
    400,
    'malformed_body',
    'De aanvraag kon niet worden gelezen.',
    'The request body could not be read.',
  );
}

/** 401 for a missing, forged or expired `__Host-aib_draft` cookie. */
export function unauthorizedResponse(): Response {
  return errorResponse(
    401,
    'no_draft_session',
    'Je sessie is verlopen. Begin opnieuw om verder te gaan.',
    'Your session has expired. Start again to continue.',
  );
}

/** 404 with a neutral body. Never says which of "missing" or "not yours" applies. */
export function notFoundResponse(error = 'not_found'): Response {
  return errorResponse(404, error, 'Niet gevonden.', 'Not found.');
}

/** 500. The cause is logged, never returned: an internal message is an information leak. */
export function internalErrorResponse(): Response {
  return errorResponse(
    500,
    'internal_error',
    'Er ging iets mis aan onze kant. Probeer het zo nog eens.',
    'Something went wrong on our side. Please try again shortly.',
  );
}
