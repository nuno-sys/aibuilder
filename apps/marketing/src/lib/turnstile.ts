/**
 * Cloudflare Turnstile, loaded on intent and executed twice per session.
 *
 * WHY IT IS HERE AT ALL. `POST /v1/drafts` and `POST /v1/onboarding/submit` are the two endpoints
 * that cost money downstream, and both are reachable without an account. Turnstile in **managed**
 * mode is the bot defence WCAG 2.2 SC 3.3.8 allows: no puzzle, no cognitive function test, nothing
 * to solve. The overwhelming majority of visitors never see anything at all.
 *
 * WHY IT IS LAZY. It is the only third-party script on the marketing surface. Loading it on page
 * load would put a `challenges.cloudflare.com` request on the critical path of every visitor,
 * including the ones who never open the modal. It is fetched on the first keystroke of step 1 —
 * after intent, before it is needed.
 *
 * TOKENS ARE SINGLE-USE, which is why `execute()` always resets the widget first: a token that has
 * already been redeemed comes back `timeout-or-duplicate`, and the API answers 403 — which reads to
 * the customer as "we think you are a robot" on a request that was fine.
 */

import { TURNSTILE_SCRIPT_URL } from './config';

/** Options `turnstile.render()` accepts, narrowed to the ones this island sets. */
interface TurnstileRenderOptions {
  readonly sitekey: string;
  /** Bound into the token and checked server-side; a draft token cannot be replayed at submit. */
  readonly action: string;
  /** Customer data. The submit call binds the draft id here so a token cannot be moved between drafts. */
  readonly cData?: string;
  /** `'execute'` defers the challenge until `turnstile.execute()` is called. */
  readonly appearance: 'always' | 'execute' | 'interaction-only';
  readonly callback: (token: string) => void;
  readonly 'error-callback': (code: string) => void;
  readonly 'timeout-callback': () => void;
  readonly 'expired-callback': () => void;
}

/** The global the script installs. Declared structurally so no `any` enters the module. */
interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string | undefined;
  execute(container: HTMLElement | string, options?: Partial<TurnstileRenderOptions>): void;
  reset(widgetId?: string): void;
  remove(widgetId: string): void;
}

/** A Turnstile challenge that did not produce a token. */
export class TurnstileError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super(`Turnstile failed: ${code}`);
    this.name = 'TurnstileError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Narrows `window.turnstile` without widening anything to `any`. */
function readApi(): TurnstileApi | null {
  const candidate = (globalThis as { turnstile?: unknown }).turnstile;
  if (typeof candidate !== 'object' || candidate === null) {
    return null;
  }
  const api = candidate as Partial<TurnstileApi>;
  return typeof api.render === 'function' && typeof api.execute === 'function'
    ? (candidate as TurnstileApi)
    : null;
}

let loading: Promise<TurnstileApi> | null = null;

/**
 * Loads the Turnstile script once and resolves with its API.
 *
 * Idempotent: concurrent callers share one `<script>` and one promise. Safe to call on every
 * keystroke, which is exactly how it is used — the first keystroke wins and the rest are no-ops.
 */
export function loadTurnstile(): Promise<TurnstileApi> {
  const existing = readApi();
  if (existing !== null) {
    return Promise.resolve(existing);
  }
  if (loading !== null) {
    return loading;
  }
  loading = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => {
      const api = readApi();
      if (api === null) {
        reject(new TurnstileError('script-loaded-without-api'));
        return;
      }
      resolve(api);
    });
    script.addEventListener('error', () => {
      // A blocked or failed script must not leave the promise pending forever; the caller shows
      // the honest "we could not verify you" copy and offers a retry.
      loading = null;
      reject(new TurnstileError('script-load-failed'));
    });
    document.head.appendChild(script);
  });
  return loading;
}

/** A live widget bound to one container. */
export interface TurnstileWidget {
  /** Runs the challenge and resolves with a fresh, unredeemed token. */
  getToken(params: { action: string; cData?: string | undefined }): Promise<string>;
  /** Removes the widget and its iframe. */
  destroy(): void;
}

/** How long we wait for a token before giving up and letting the user retry. */
const TOKEN_TIMEOUT_MS = 20_000;

/**
 * Creates the invisible widget the modal executes twice.
 *
 * The container must be in the document (Turnstile renders an iframe into it) but may be visually
 * hidden; a managed challenge that decides to show itself is inserted at the container's position,
 * which is why the modal keeps it inside the panel rather than off-screen at the page root.
 */
export async function createTurnstileWidget(params: {
  container: HTMLElement;
  siteKey: string;
}): Promise<TurnstileWidget> {
  const api = await loadTurnstile();

  let widgetId: string | null = null;
  let pending: {
    resolve: (token: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  const settle = (outcome: { token: string } | { error: Error }): void => {
    const current = pending;
    pending = null;
    if (current === null) {
      return;
    }
    clearTimeout(current.timer);
    if ('token' in outcome) {
      current.resolve(outcome.token);
    } else {
      current.reject(outcome.error);
    }
  };

  const id = api.render(params.container, {
    sitekey: params.siteKey,
    // Rendered with the draft action; `execute()` overrides both per call.
    action: 'draft-create',
    appearance: 'execute',
    callback: (token: string) => {
      settle({ token });
    },
    'error-callback': (code: string) => {
      settle({ error: new TurnstileError(code) });
    },
    'timeout-callback': () => {
      settle({ error: new TurnstileError('challenge-timeout') });
    },
    'expired-callback': () => {
      settle({ error: new TurnstileError('token-expired') });
    },
  });
  widgetId = id ?? null;

  return {
    getToken: ({ action, cData }) =>
      new Promise<string>((resolve, reject) => {
        if (pending !== null) {
          reject(new TurnstileError('challenge-already-running'));
          return;
        }
        const timer = setTimeout(() => {
          settle({ error: new TurnstileError('challenge-timeout') });
        }, TOKEN_TIMEOUT_MS);
        pending = { resolve, reject, timer };
        try {
          // Reset first: the previous token has been redeemed, and Turnstile will otherwise hand
          // back the same consumed string.
          if (widgetId !== null) {
            api.reset(widgetId);
          }
          api.execute(params.container, {
            action,
            ...(cData === undefined ? {} : { cData }),
          });
        } catch (error: unknown) {
          settle({
            error: error instanceof Error ? error : new TurnstileError('execute-threw'),
          });
        }
      }),
    destroy: () => {
      settle({ error: new TurnstileError('widget-destroyed') });
      if (widgetId !== null) {
        try {
          api.remove(widgetId);
        } catch {
          // A widget the script has already torn down is not an error worth surfacing.
        }
      }
    },
  };
}
