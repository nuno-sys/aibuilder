/**
 * The onboarding modal — the product's single conversion surface.
 *
 * NOTE ON DEPENDENCIES: this island needs `@aibuilder/core` and `libphonenumber-js` declared in
 * `apps/marketing/package.json`. The exact lines are in `src/islands/DEPENDENCIES.md`.
 *
 * THE DIALOG IS NATIVE, AND EVERYTHING THAT FOLLOWS FROM THAT IS FREE AND CORRECT.
 * `HTMLDialogElement.showModal()` gives the top layer (so no z-index can ever cover it), `inert` on
 * the rest of the document, a real focus trap implemented by the browser, a `::backdrop`
 * pseudo-element, and Escape handling through the `cancel` event. A hand-rolled trap is not just
 * more code — it is worse code, because it cannot make the content behind it inert to a screen
 * reader's virtual cursor, which is the half everybody forgets.
 *
 * `aria-modal="true"` IS DELIBERATELY ABSENT. It is implicit on a dialog opened with `showModal()`,
 * and adding it by hand makes some assistive technology announce the dialog twice.
 *
 * ESCAPE IS INTERCEPTED, NEVER IGNORED. On a dirty draft past step 1 it opens a nested dialog whose
 * PRIMARY action is "keep going" and whose message is *"your draft is saved"* — never a destructive
 * default, never a "discard?" question about work the user has not lost. During generation it does
 * not close at all: the job keeps running in a Durable Object whether the tab is open or not, so the
 * honest response is to say so.
 *
 * THE HISTORY MODEL IS REAL HISTORY. Every step advance is a `pushState`, so back and forward move
 * between steps, iOS Safari's swipe-back works, and a link to `/start/?step=4` is shareable. Deep
 * links are CLAMPED to `furthestStep + 1`: nobody can be linked past validation.
 *
 * THE SUBMIT IS DEFENDED FOUR TIMES OVER, and the first of the four lives here: the button is
 * disabled and `aria-busy` synchronously inside the click handler, before any `await`, and a
 * module-scoped in-flight promise makes a second call return the first one. The other three layers
 * (the server's stored idempotency key, the per-draft Durable Object, and the per-org job limit) are
 * the API's, because a UI guard alone is a suggestion.
 *
 * THE SUBMIT NO LONGER STARTS A GENERATION. Under the trial-first funnel (DECISIONS §D2)
 * `POST /v1/onboarding/submit` reserves the slug, writes the job in `awaiting_payment` and returns a
 * Stripe Checkout URL; the `checkout.session.completed` webhook is what dispatches the Workflow. So
 * the submit lands on `phase: 'checkout'` — one screen, `CheckoutHandoff`, that says what was built,
 * what it costs and how to stop, and whose primary button performs the top-level navigation. The
 * redirect is never automatic and never framed: an unannounced jump from a button reading "Bouw mijn
 * website" to a card form is a bait-and-switch, and `x-frame-options: DENY` plus Stripe's own
 * frame-ancestors policy make the iframe structurally impossible anyway.
 *
 * FOUR URL STATES ARE READ ON MOUNT, and each one is a different truth about the same job:
 *
 *   `?job=…`                     resume — payment state is learned from the stream
 *   `?job=…&payment=confirming`  the customer paid; the webhook may not have landed yet (§2.3)
 *   `?job=…&checkout=cancelled`  they pressed Back at Stripe. Nothing charged, nothing lost
 *   `?job=…&checkout=expired`    the 30-minute Checkout window closed
 *
 * The three markers are ONE-SHOT: they are stripped with `replaceState` the moment they are read, so
 * a reload never re-asserts a payment state the server has since moved past.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_LOCALE, isLocale, slugify } from '@aibuilder/core';
import type { Locale } from '@aibuilder/core';

import { plan } from '../content/pricing';
import { ApiError, getBootstrap, getJobStatus, resumeCheckout, submitOnboarding } from '../lib/api';
import type { BootstrapResponse, PaymentState, SubmitResponse } from '../lib/api';
import {
  CTA_ATTRIBUTE,
  LOCAL_JOB_KEY,
  START_PATH,
  TURNSTILE_ACTION_DRAFT,
  TURNSTILE_ACTION_SUBMIT,
} from '../lib/config';
import { copyFor } from '../lib/copy';
import { formatEuro, interpolate, tenantHost } from '../lib/format';
import { cssVars, useMotionTiming } from '../lib/motion';
import { readJson, safeStorage, writeJson } from '../lib/storage';
import { createTurnstileWidget } from '../lib/turnstile';
import type { TurnstileWidget } from '../lib/turnstile';
import { STEP_COUNT, STEP_IDS } from '../lib/types';
import type { Draft, FieldError, PersistedMedia, StepIndex } from '../lib/types';
import {
  validateBusinessName,
  validateEmail,
  validateIndustry,
  validateIntake,
  validatePhone,
  validationMessage,
} from '../lib/validation';

import CheckoutHandoff from './CheckoutHandoff';
import type { CheckoutReason } from './CheckoutHandoff';
import ErrorSummary from './ErrorSummary';
import GenerationTheatre from './GenerationTheatre';
import LiveRegions from './LiveRegions';
import ProgressRail from './ProgressRail';
import Step1Name from './Step1Name';
import Step2Industry from './Step2Industry';
import Step3Address from './Step3Address';
import Step4Hours from './Step4Hours';
import Step5Contact from './Step5Contact';
import Step6Story from './Step6Story';
import StepShell from './StepShell';
import type { LiveRegionsHandle } from './LiveRegions';
import type { StepDirection } from './StepShell';
import { useDraft, draftHasContent } from './hooks/useDraft';
import { useKeyboardInset } from './hooks/useKeyboardInset';
import { useMediaUpload } from './hooks/useMediaUpload';
import { useSSE } from './hooks/useSSE';
import type { GenerationEvent, PaymentFrame } from './hooks/useSSE';
import fields from './fields.module.css';
import styles from './OnboardingModal.module.css';

/** Delay between the step transition starting and its announcement, so nothing is clipped. */
const STEP_ANNOUNCE_DELAY_MS = 150;

/**
 * Where the wizard is.
 *
 * `resume` is the one-tap "welcome back" card (UX §7.3); `checkout` is the hand-off to Stripe, which
 * sits between the last step and the theatre and is reachable both forwards (a fresh submit) and
 * backwards (a return from a cancelled or expired Checkout).
 */
type Phase = 'closed' | 'resume' | 'steps' | 'checkout' | 'generating';

/**
 * The accepted job.
 *
 * Everything here survives the Stripe round trip in `localStorage`, because that round trip is a
 * document unload and the returning page would otherwise know only the job id from the URL.
 */
interface JobHandle {
  readonly jobId: string;
  readonly eventsPath: string;
  readonly slug: string;
  readonly siteUrl: string;
  readonly paymentState: PaymentState;
  /** The live Checkout Session, or `null` when there is none to reuse. */
  readonly checkoutUrl: string | null;
  /** Epoch milliseconds; `null` when unknown. */
  readonly checkoutExpiresAt: number | null;
}

/**
 * How much of a Checkout Session's life must remain before it is worth reusing.
 *
 * A session that is still `open` is exactly the state a customer who pressed Back left it in, so
 * reusing it is both correct and free — it does not burn one of the five sessions the server allows
 * a job for its whole life. Below this margin the link would very likely expire between the click
 * and the page load, and a fresh session is minted instead.
 */
const CHECKOUT_REUSE_MARGIN_MS = 60_000;

/** The job handle as it is written to storage, with the clock that bounds its usefulness. */
interface StoredJob extends JobHandle {
  /** Epoch milliseconds of the write. */
  readonly storedAt: number;
}

/**
 * How long a stored job is worth resuming.
 *
 * Thirty days is the provisional-organisation purge (PHASE2-BILLING-AUTH §2.6): past it the org, the
 * site, the slug and the shard rows are gone, so offering to resume would be offering to resume
 * nothing. Below it every one of those rows is still there and the resume is real.
 */
const STORED_JOB_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Reads the stored job handle.
 *
 * Every field is re-narrowed rather than trusted: this is `localStorage`, which the user, an
 * extension, or a previous build of this island can have written, and a `paymentState` of the wrong
 * shape would put the modal on a screen the server disagrees with.
 */
function readStoredJob(): StoredJob | null {
  const stored = readJson<Partial<StoredJob>>(LOCAL_JOB_KEY);
  if (
    stored === null ||
    typeof stored.jobId !== 'string' ||
    stored.jobId.length === 0 ||
    typeof stored.eventsPath !== 'string'
  ) {
    return null;
  }
  const storedAt = typeof stored.storedAt === 'number' ? stored.storedAt : 0;
  if (Date.now() - storedAt > STORED_JOB_TTL_MS) {
    return null;
  }
  return {
    jobId: stored.jobId,
    eventsPath: stored.eventsPath,
    slug: typeof stored.slug === 'string' ? stored.slug : '',
    siteUrl: typeof stored.siteUrl === 'string' ? stored.siteUrl : '',
    paymentState:
      stored.paymentState === 'awaiting_payment' ||
      stored.paymentState === 'paid' ||
      stored.paymentState === 'abandoned'
        ? stored.paymentState
        : 'not_required',
    checkoutUrl: typeof stored.checkoutUrl === 'string' ? stored.checkoutUrl : null,
    checkoutExpiresAt:
      typeof stored.checkoutExpiresAt === 'number' ? stored.checkoutExpiresAt : null,
    storedAt,
  };
}

/** Reads the UI locale from `<html lang>`, falling back to the product default. */
function documentLocale(): Locale {
  if (typeof document === 'undefined') {
    return DEFAULT_LOCALE;
  }
  const lang = document.documentElement.lang.slice(0, 2).toLowerCase();
  return isLocale(lang) ? lang : DEFAULT_LOCALE;
}

/** Reads `cf.country` if the shell injected it, so bootstrap can be asked for the right chips. */
function documentCountry(): string | undefined {
  if (typeof document === 'undefined') {
    return undefined;
  }
  const value = document.documentElement.dataset['cfCountry'];
  return value !== undefined && /^[A-Z]{2}$/.test(value) ? value : undefined;
}

/**
 * The onboarding modal island.
 *
 * Takes no props: its inputs are the URL, the `data-onboarding-cta` elements on the page and its own
 * `PUBLIC_*` build variables. That is what lets `components/OnboardingMount.astro` drop it into the
 * layout with `client:idle` and nothing else.
 */
export default function OnboardingModal() {
  const locale = useMemo(documentLocale, []);
  const copy = copyFor(locale);
  const timing = useMotionTiming();
  const keyboardInset = useKeyboardInset();

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const confirmRef = useRef<HTMLDialogElement | null>(null);
  const turnstileHostRef = useRef<HTMLDivElement | null>(null);
  const liveRef = useRef<LiveRegionsHandle | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const widgetRef = useRef<TurnstileWidget | null>(null);
  /**
   * The URL to put back in the address bar when the modal closes.
   *
   * Opening from a CTA pushes `/start/?step=1`; closing must not leave the visitor reading the home
   * page under the wizard's URL. Restored with `replaceState` rather than `history.back()`, which
   * would fight the popstate handler that also closes the modal.
   */
  const returnUrlRef = useRef<string>('/');
  const submitInFlight = useRef<Promise<SubmitResponse> | null>(null);

  const [phase, setPhase] = useState<Phase>('closed');
  const [direction, setDirection] = useState<StepDirection>('forward');
  /** Which copy the nested confirmation carries: a saved draft, or a job waiting on its trial. */
  const [confirmVariant, setConfirmVariant] = useState<'draft' | 'checkout'>('draft');
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [submitAttempt, setSubmitAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [job, setJob] = useState<JobHandle | null>(null);
  const [event, setEvent] = useState<GenerationEvent | null>(null);
  const [slots, setSlots] = useState<ReadonlyMap<string, string>>(new Map());
  const [focusReady, setFocusReady] = useState(false);
  const [escapeDuringBuild, setEscapeDuringBuild] = useState(false);

  /* ── Checkout ──────────────────────────────────────────────────────────────────────────────
     `checkoutReason` is why the hand-off screen is on screen; it selects the first paragraph and
     the primary button's label. `checkoutFailures` is what makes the retry SINGLE: the first press
     of a `ready` screen is the attempt, the next one is the retry, and there is no third. */
  const [checkoutReason, setCheckoutReason] = useState<CheckoutReason>('ready');
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checkoutExhausted, setCheckoutExhausted] = useState(false);
  const checkoutPresses = useRef(0);
  /** True only when the server has confirmed the Checkout Session with Stripe (`payment=confirming`). */
  const [paymentConfirmed, setPaymentConfirmed] = useState(false);
  /** The `409 trial_already_used` sign-in link, which is a route out and not a field error. */
  const [submitLink, setSubmitLink] = useState<{ label: string; href: string } | null>(null);
  const checkoutHeadingRef = useRef<HTMLHeadingElement | null>(null);

  const draftApi = useDraft(locale);
  const {
    draft,
    // Every one of these is a `useCallback` whose dependencies are themselves stable, so they are
    // safe to use as effect and callback dependencies. `draftApi` itself is a fresh object every render
    // and must never be one.
    hydrate,
    flush,
    setValues,
    setUi,
    setMedia,
    setStep,
    ensureServerDraft,
    freeze,
    reset,
    resolveConflict,
  } = draftApi;

  /** Mirror of the current draft for callbacks that must not re-bind on every keystroke. */
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const announce = useCallback((message: string): void => {
    liveRef.current?.polite(message);
  }, []);

  const announceAssertive = useCallback((message: string): void => {
    liveRef.current?.assertive(message);
  }, []);

  const announceGeneration = useCallback((message: string): void => {
    liveRef.current?.generation(message);
  }, []);

  /* ── Turnstile ────────────────────────────────────────────────────────────────────────────── */

  const getToken = useCallback(
    async (action: string, cData?: string): Promise<string> => {
      const siteKey = bootstrap?.turnstileSiteKey;
      const host = turnstileHostRef.current;
      if (siteKey === undefined || siteKey.length === 0 || host === null) {
        throw new Error('turnstile-not-ready');
      }
      widgetRef.current ??= await createTurnstileWidget({ container: host, siteKey });
      return widgetRef.current.getToken({ action, cData });
    },
    [bootstrap],
  );

  const ensureDraft = useCallback(
    async (): Promise<string> => ensureServerDraft(() => getToken(TURNSTILE_ACTION_DRAFT)),
    [ensureServerDraft, getToken],
  );

  /* ── Media ───────────────────────────────────────────────────────────────────────────────── */

  const onMediaChange = useCallback(
    (items: PersistedMedia[]): void => {
      setMedia(() => items);
    },
    [setMedia],
  );

  const media = useMediaUpload({
    ensureDraft,
    onChange: onMediaChange,
    onAnnounce: announce,
    locale,
  });

  /* ── Field errors ────────────────────────────────────────────────────────────────────────── */

  const setFieldError = useCallback((field: string, message: string | null): void => {
    setErrors((previous) => {
      const next = new Map(previous);
      if (message === null) {
        next.delete(field);
      } else {
        next.set(field, message);
      }
      return next;
    });
  }, []);

  /** Validates the current step, returning the errors in the order the fields appear. */
  const validateStep = useCallback(
    (step: StepIndex, current: Draft): FieldError[] => {
      const found: FieldError[] = [];
      const push = (field: string, message: string): void => {
        found.push({ field, message });
      };

      if (step === 1) {
        const failure = validateBusinessName(current.values.businessName ?? '');
        if (failure !== null) {
          push('businessName', validationMessage(failure.code, locale, failure.params));
        }
      }
      if (step === 2) {
        const failure = validateIndustry(current.values.industryKey, '');
        if (failure !== null) {
          push('industryKey', validationMessage(failure.code, locale, failure.params));
        }
      }
      if (step === 3) {
        if (current.ui.locationMode === 'service_area') {
          if ((current.values.serviceArea?.city ?? '').trim().length === 0) {
            push('serviceArea.city', validationMessage('serviceArea.cityEmpty', locale));
          }
        } else {
          if ((current.values.address.line1 ?? '').trim().length === 0) {
            push('address.line1', validationMessage('address.empty', locale));
          }
          if ((current.values.address.city ?? '').trim().length === 0) {
            push('address.city', validationMessage('address.cityEmpty', locale));
          }
        }
      }
      // Step 4 has no required field: hours are explicitly skippable (UX §2.4).
      if (step === 5) {
        const failure = validatePhone({
          e164: current.values.phoneE164,
          valid: null,
          countryLabel: current.ui.phoneCountry,
          example: '',
        });
        if (failure !== null) {
          push('phoneE164', validationMessage(failure.code, locale, failure.params));
        }
      }
      if (step === 6) {
        const failure = validateEmail(current.values.contactEmail ?? '');
        if (failure !== null) {
          push('contactEmail', validationMessage(failure.code, locale, failure.params));
        }
      }
      return found;
    },
    [locale],
  );

  /* ── Opening and closing ─────────────────────────────────────────────────────────────────── */

  const openDialog = useCallback(
    (nextPhase: Phase): void => {
      const dialog = dialogRef.current;
      if (dialog === null || dialog.open) {
        setPhase(nextPhase);
        return;
      }
      triggerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPhase(nextPhase);
      dialog.showModal();
      // Focus is taken only after the entrance has finished: a screen reader must not be handed a
      // moving target, and iOS must not be asked to scroll to one (UX §5.2).
      window.setTimeout(() => {
        setFocusReady(true);
      }, timing.modalEnter);
    },
    [timing.modalEnter],
  );

  const closeDialog = useCallback((): void => {
    const dialog = dialogRef.current;
    setFocusReady(false);
    void flush();
    if (dialog === null) {
      setPhase('closed');
      return;
    }
    dialog.setAttribute('data-closing', 'true');
    window.setTimeout(() => {
      dialog.removeAttribute('data-closing');
      dialog.close();
      setPhase('closed');
      const currentUrl = `${window.location.pathname}${window.location.search}`;
      if (currentUrl !== returnUrlRef.current) {
        window.history.replaceState({}, '', returnUrlRef.current);
      }
      // Two frames, then focus back on the trigger: restoring it in the same tick as `close()`
      // races the browser's own focus restoration and loses.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const trigger = triggerRef.current;
          if (trigger !== null && trigger.isConnected) {
            trigger.focus();
          } else {
            document.querySelector<HTMLElement>(`[${CTA_ATTRIBUTE}]`)?.focus();
          }
        });
      });
    }, timing.modalExit);
  }, [flush, timing.modalExit]);

  /**
   * Opens the modal from a CTA or a deep link.
   *
   * A `?step=` in the URL is CLAMPED to `furthestStep + 1` and then written back with
   * `replaceState`: `/start/?step=5` sent to someone with an empty draft lands them on step 1 with
   * an address bar that says so. Nobody can be linked past validation, and the URL never claims a
   * step the wizard is not on.
   */
  const start = useCallback(async (): Promise<void> => {
    // A submitted job that never got its card comes back here, not to step 1. Without this the
    // visitor who abandoned Checkout and later pressed a CTA would be shown their own answers in a
    // form that is FROZEN — every autosave refused, the offline banner raised over a connection that
    // is fine, and no route to the payment they actually still want.
    const pending = readStoredJob();
    if (
      pending !== null &&
      (pending.paymentState === 'awaiting_payment' || pending.paymentState === 'abandoned')
    ) {
      await hydrate();
      setStep(STEP_COUNT);
      freeze();
      setJob(pending);
      checkoutPresses.current = 0;
      // Which of the three framings is true here cannot be guessed from the fact that a job is
      // pending — it can only be read off the session. A live link means they simply have not
      // finished ("last step"); a dead one means it timed out; anything else means they left
      // Checkout without completing it.
      const linkIsLive =
        pending.checkoutUrl !== null &&
        pending.paymentState !== 'abandoned' &&
        pending.checkoutExpiresAt !== null &&
        pending.checkoutExpiresAt - Date.now() > CHECKOUT_REUSE_MARGIN_MS;
      setCheckoutReason(
        pending.paymentState === 'abandoned' ? 'expired' : linkIsLive ? 'ready' : 'cancelled',
      );
      setCheckoutError(null);
      setCheckoutExhausted(false);
      window.history.replaceState(
        { aibJob: pending.jobId },
        '',
        `${START_PATH}?job=${encodeURIComponent(pending.jobId)}`,
      );
      openDialog('checkout');
      return;
    }

    // `hydrate()` returns the resulting draft rather than leaving the caller to read state that
    // React has not re-rendered yet.
    const current = await hydrate();

    const requested = Number(new URLSearchParams(window.location.search).get('step') ?? '');
    const ceiling = Math.min(STEP_COUNT, current.furthestStep + 1);
    const target = (
      Number.isFinite(requested) && requested >= 1
        ? Math.min(Math.max(1, Math.round(requested)), ceiling)
        : current.step
    ) as StepIndex;

    if (target !== current.step) {
      setStep(target);
    }
    window.history.replaceState({ aibStep: target }, '', `${START_PATH}?step=${String(target)}`);

    openDialog(draftHasContent(current) && current.step > 1 ? 'resume' : 'steps');
  }, [freeze, hydrate, openDialog, setStep]);

  /** The latest `start`, so the entry-point listeners can be registered exactly once. */
  const startRef = useRef(start);
  startRef.current = start;

  /* ── Bootstrap ───────────────────────────────────────────────────────────────────────────── */

  useEffect(() => {
    if (phase === 'closed' || bootstrap !== null) {
      return undefined;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        setBootstrap(await getBootstrap({ locale, country: documentCountry() }, controller.signal));
      } catch {
        // The modal still works without it: the combobox is empty, the popular chips are absent and
        // Turnstile cannot run — which is caught where a token is actually needed.
      }
    })();
    return () => {
      controller.abort();
    };
  }, [phase, bootstrap, locale]);

  /* ── Entry points: CTA clicks, `/start/`, `?job=` ────────────────────────────────────────── */

  useEffect(() => {
    const onClick = (clickEvent: MouseEvent): void => {
      const target = clickEvent.target;
      if (!(target instanceof Element)) {
        return;
      }
      const cta = target.closest<HTMLElement>(`[${CTA_ATTRIBUTE}]`);
      if (cta === null) {
        return;
      }
      // A modified click is the user asking for a new tab; `/start/` is a real page, so let it.
      if (
        clickEvent.defaultPrevented ||
        clickEvent.metaKey ||
        clickEvent.ctrlKey ||
        clickEvent.shiftKey ||
        clickEvent.button !== 0
      ) {
        return;
      }
      clickEvent.preventDefault();
      triggerRef.current = cta;
      returnUrlRef.current = `${window.location.pathname}${window.location.search}`;
      window.history.pushState({ aibStep: 1 }, '', `${START_PATH}?step=1`);
      void startRef.current();
    };

    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('click', onClick);
    };
    // Registered once for the life of the island: the handler reads the latest `start` through a
    // ref, so re-binding it on every render would be churn with no behavioural difference.
  }, []);

  const enteredRef = useRef(false);
  useEffect(() => {
    if (enteredRef.current) {
      return;
    }
    enteredRef.current = true;
    if (window.location.pathname !== START_PATH && window.location.pathname !== '/start') {
      return;
    }
    // Entering directly on `/start/` means the page itself is the destination: closing the modal
    // leaves the visitor there, not on the home page.
    returnUrlRef.current = START_PATH;
    const params = new URLSearchParams(window.location.search);
    const jobId = params.get('job');
    if (jobId !== null && jobId.length > 0) {
      const checkoutMarker = params.get('checkout');
      const paymentMarker = params.get('payment');
      const restored = readStoredJob();
      const stored = restored !== null && restored.jobId === jobId ? restored : null;
      const cancelled = checkoutMarker === 'cancelled';
      const expired = checkoutMarker === 'expired';
      const confirming = paymentMarker === 'confirming';

      setJob(
        stored ?? {
          jobId,
          eventsPath: `/v1/jobs/${encodeURIComponent(jobId)}/events`,
          // The slug and URL are re-learned from the stream's `done` event; until then the reveal is
          // not shown, so an empty string here is never rendered.
          slug: '',
          siteUrl: '',
          // A marker in the URL is knowledge, and using it costs a wrong first frame otherwise: an
          // unmarked `?job=` is assumed to be running (the overwhelmingly common case) and corrected
          // within a second by the `payment` frame, while a marked one is known to be waiting and is
          // rendered as waiting from the first paint.
          paymentState: cancelled || expired || confirming ? 'awaiting_payment' : 'not_required',
          checkoutUrl: null,
          checkoutExpiresAt: null,
        },
      );

      // The markers are one-shot. Stripping them now means a reload cannot re-assert "you cancelled"
      // over a payment that has since completed, and cannot re-show a confirmation for a job that
      // has been building for ten minutes.
      window.history.replaceState(
        { aibJob: jobId },
        '',
        `${START_PATH}?job=${encodeURIComponent(jobId)}`,
      );

      if (cancelled || expired) {
        // Nothing was charged and nothing is lost: the draft row, the promoted media and the
        // reserved slug all survive an abandoned Checkout (PHASE2-BILLING-AUTH §2.6). Bringing the
        // draft back is what lets the hand-off screen name the business, the trade and the photos
        // rather than showing a job id. It is then FROZEN: the draft row is `submitted`, every
        // further autosave would be refused, and two refusals would raise the offline banner over a
        // screen that is perfectly online.
        void (async () => {
          await hydrate();
          setStep(STEP_COUNT);
          freeze();
        })();
        setCheckoutReason(expired ? 'expired' : 'cancelled');
        openDialog('checkout');
        return;
      }

      // `payment=confirming` is only ever issued by `GET /v1/billing/return` after it has asked
      // Stripe whether the session is complete, so it — and nothing else — is evidence of payment.
      setPaymentConfirmed(confirming);
      openDialog('generating');
      return;
    }
    void startRef.current();
    // Runs once, on mount: the URL at load time is the entry point, and it does not change again
    // except through `pushState`, which this component performs itself.
  }, [openDialog, hydrate, setStep, freeze]);

  /* ── History ─────────────────────────────────────────────────────────────────────────────── */

  const goToStep = useCallback(
    (next: StepIndex, how: 'push' | 'replace' | 'none'): void => {
      setDirection(next > draftRef.current.step ? 'forward' : 'back');
      setStep(next);
      setErrors(new Map());
      if (how !== 'none') {
        const url = `${START_PATH}?step=${String(next)}`;
        if (how === 'push') {
          window.history.pushState({ aibStep: next }, '', url);
        } else {
          window.history.replaceState({ aibStep: next }, '', url);
        }
      }
      window.setTimeout(() => {
        announce(
          interpolate(copy.a11y.stepChanged, {
            step: next,
            total: STEP_COUNT,
            name: copy.rail.steps[next - 1] ?? '',
          }),
        );
      }, STEP_ANNOUNCE_DELAY_MS);
    },
    [announce, copy, setStep],
  );

  useEffect(() => {
    const onPopState = (popEvent: PopStateEvent): void => {
      if (phase === 'generating') {
        return;
      }
      if (phase === 'checkout') {
        // Back from the hand-off means "leave", not "edit": the draft is submitted and frozen, so
        // returning to step 5 would put a step URL under a form nobody can change. Closing loses
        // nothing — the job is durable and `/start/?job=…` comes straight back here.
        closeDialog();
        return;
      }
      const state = popEvent.state;
      const step =
        typeof state === 'object' && state !== null && 'aibStep' in state
          ? Number((state as { aibStep: unknown }).aibStep)
          : Number.NaN;
      if (!Number.isFinite(step)) {
        closeDialog();
        return;
      }
      const clamped = Math.min(
        Math.max(1, step),
        Math.min(STEP_COUNT, draftRef.current.furthestStep + 1),
      ) as StepIndex;
      goToStep(clamped, 'none');
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
    };
  }, [phase, closeDialog, goToStep]);

  /* ── Escape ──────────────────────────────────────────────────────────────────────────────── */

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return undefined;
    }
    const onCancel = (cancelEvent: Event): void => {
      cancelEvent.preventDefault();

      // An open combobox owns Escape: the first press collapses its list, and only a second one
      // should reach the dialog.
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active.getAttribute('role') === 'combobox' &&
        active.getAttribute('aria-expanded') === 'true'
      ) {
        return;
      }

      if (phase === 'generating') {
        // The job survives the tab closing, so Escape does not close — it explains.
        setEscapeDuringBuild(true);
        return;
      }
      if (phase === 'checkout') {
        // A reflex key press must not dismiss the conversion screen, and the generic "your draft is
        // saved" would be false here: there is no draft any more, there is a reserved address and a
        // job waiting on a trial. Same dialog, accurate words.
        setConfirmVariant('checkout');
        confirmRef.current?.showModal();
        return;
      }
      const current = draftRef.current;
      if (current.step > 1 && draftHasContent(current)) {
        setConfirmVariant('draft');
        confirmRef.current?.showModal();
        return;
      }
      closeDialog();
    };
    dialog.addEventListener('cancel', onCancel);
    return () => {
      dialog.removeEventListener('cancel', onCancel);
    };
  }, [phase, closeDialog]);

  /* ── Generation stream ───────────────────────────────────────────────────────────────────── */

  const onStreamEvent = useCallback((incoming: GenerationEvent): void => {
    setEvent(incoming);
    // A build event is proof the webhook released the job — the Workflow runs on nothing else. It
    // is therefore also the authoritative answer to the payment question, and recording it is what
    // stops a later CTA press from resuming a Checkout for a site that is already being built.
    setJob((previous) =>
      previous === null ||
      previous.paymentState === 'paid' ||
      previous.paymentState === 'not_required'
        ? previous
        : { ...previous, paymentState: 'paid', checkoutUrl: null },
    );
    const slot = incoming.data?.['slot'];
    const text = incoming.data?.['text'];
    if (typeof slot === 'string' && typeof text === 'string') {
      setSlots((previous) => {
        const next = new Map(previous);
        next.set(slot, text);
        return next;
      });
    }
    const siteUrl = incoming.data?.['siteUrl'];
    if (typeof siteUrl === 'string') {
      setJob((previous) => (previous === null ? previous : { ...previous, siteUrl }));
    }
  }, []);

  /**
   * The `payment` frame, from either transport.
   *
   * The theatre needs no polling loop and holds no timer for the release: the webhook's dispatch is
   * followed within a second by the Workflow's own `claimed → queued` event, which arrives as an
   * ordinary progress frame (PHASE2-BILLING-AUTH §2.2).
   *
   * It never moves a job BACK out of `paid`. A reconnect can replay a payment frame that was true
   * when the connection opened, and applying it over a build in progress would put the confirmation
   * card back on screen over a site that is already being written.
   */
  const onPaymentFrame = useCallback((frame: PaymentFrame): void => {
    setJob((previous) =>
      previous === null || previous.paymentState === 'paid'
        ? previous
        : {
            ...previous,
            paymentState: frame.paymentState,
            checkoutExpiresAt: frame.deadlineAt ?? previous.checkoutExpiresAt,
          },
    );
  }, []);

  const stream = useSSE({
    // Opened only for the theatre. A stream held open behind the hand-off screen would sit on a
    // heartbeat for the whole thirty minutes a customer spends deciding, for no event it could use.
    jobId: phase === 'generating' ? (job?.jobId ?? null) : null,
    eventsPath: phase === 'generating' ? (job?.eventsPath ?? null) : null,
    onEvent: onStreamEvent,
    onPayment: onPaymentFrame,
  });

  /**
   * One status read per job.
   *
   * A modal opened from `/start/?job=…` knows the job id and nothing else, and one read fills in the
   * slug, the live URL and where the job stands with its trial — so the deploy act and the reveal
   * name the real domain, and the hand-off screen after a cancelled Checkout can show the address
   * that is already reserved. It runs even when a stored handle already carries a slug, because that
   * handle was written before a round trip through Stripe and its `paymentState` may be exactly one
   * webhook out of date.
   */
  const statusReadFor = useRef<string | null>(null);
  useEffect(() => {
    if (job === null || statusReadFor.current === job.jobId) {
      return undefined;
    }
    statusReadFor.current = job.jobId;
    const controller = new AbortController();
    void (async () => {
      try {
        const status = await getJobStatus(job.jobId, controller.signal);
        setJob((previous) => {
          if (previous === null) {
            return previous;
          }
          const host = status.siteUrl === undefined ? null : new URL(status.siteUrl).hostname;
          return {
            ...previous,
            siteUrl: status.siteUrl ?? previous.siteUrl,
            slug: host === null ? previous.slug : (host.split('.')[0] ?? ''),
            paymentState: status.paymentState ?? previous.paymentState,
            checkoutExpiresAt: status.checkoutExpiresAt ?? previous.checkoutExpiresAt,
          };
        });
      } catch {
        // The stream is the primary source; a failed status read costs the domain in one headline.
      }
    })();
    return () => {
      controller.abort();
    };
  }, [job]);

  // The hand-off screen is for a job that still needs a card. If the status read or a `payment`
  // frame says the trial is already running — the customer paid in another tab, or the webhook
  // landed while they were reading — the screen would be asking for something already given.
  useEffect(() => {
    if (phase !== 'checkout' || job === null) {
      return;
    }
    if (job.paymentState === 'paid' || job.paymentState === 'not_required') {
      setPhase('generating');
    }
  }, [phase, job]);

  /** Mirrors the job handle into storage so the Stripe round trip comes back to something. */
  useEffect(() => {
    if (job !== null) {
      writeJson(LOCAL_JOB_KEY, { ...job, storedAt: Date.now() } satisfies StoredJob);
    }
  }, [job]);

  /* ── Submit ──────────────────────────────────────────────────────────────────────────────── */

  /** Builds the payload `IntakeSchema` validates, from the draft. */
  const buildIntake = useCallback(
    (current: Draft, turnstileToken: string): Record<string, unknown> => {
      const serviceMode = current.ui.locationMode === 'service_area';
      const slug =
        current.values.slug ?? slugify(current.values.businessName ?? '', current.locale);
      return {
        businessName: (current.values.businessName ?? '').trim(),
        slug,
        industryKey: current.values.industryKey ?? '',
        defaultLocale: current.values.defaultLocale ?? current.locale,
        extraLocales: current.values.extraLocales,
        serviceArea:
          serviceMode && current.values.serviceArea !== null
            ? {
                city: current.values.serviceArea.city,
                // The draft column stores a number; `IntakeSchema` wants the enum's string form.
                radiusKm: String(current.values.serviceArea.radiusKm),
              }
            : null,
        address: serviceMode
          ? null
          : {
              line1: current.values.address.line1 ?? '',
              line2: current.values.address.line2,
              postalCode: current.values.address.postalCode ?? '',
              city: current.values.address.city ?? '',
              country: current.values.address.country ?? current.ui.phoneCountry,
              latitude: current.values.address.latitude,
              longitude: current.values.address.longitude,
              geoSource: current.values.address.geoSource,
            },
        openingHours: current.values.openingHours,
        phoneE164: current.values.phoneE164 ?? '',
        whatsappE164: current.ui.whatsappSame
          ? (current.values.phoneE164 ?? null)
          : current.values.whatsappE164,
        gbpUrl: current.values.gbpUrl,
        shortDescription: current.values.shortDescription,
        contactEmail: (current.values.contactEmail ?? '').trim().toLowerCase(),
        marketingOptIn: current.values.marketingOptIn,
        mediaIds: current.values.mediaIds,
        turnstileToken,
      };
    },
    [],
  );

  const submit = useCallback(async (): Promise<void> => {
    // Layer 1 of the four: synchronous, before any await.
    if (submitting || submitInFlight.current !== null) {
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setSubmitLink(null);
    setSubmitAttempt((previous) => previous + 1);

    const current = draftRef.current;
    const stepErrors = validateStep(6, current);
    if (stepErrors.length > 0) {
      setErrors(new Map(stepErrors.map((entry) => [entry.field, entry.message])));
      announceAssertive(
        interpolate(copy.a11y.errorPrefix, { message: stepErrors[0]?.message ?? '' }),
      );
      setSubmitting(false);
      return;
    }

    try {
      await flush();
      const draftId = await ensureDraft();
      const token = await getToken(TURNSTILE_ACTION_SUBMIT, draftId);
      const payload = buildIntake(current, token);

      // The client validates with the SERVER's schema, imported. A drift between the two would
      // surface as a 422 at the most expensive moment in the funnel.
      const parsed = validateIntake(payload);
      if (!parsed.ok) {
        const mapped = fieldErrorsToMessages(parsed.fields, locale);
        setErrors(new Map(mapped.map((entry) => [entry.field, entry.message])));
        setSubmitError(mapped.length === 0 ? copy.modal.genericError : null);
        setSubmitting(false);
        return;
      }

      const inFlight = submitOnboarding(payload);
      submitInFlight.current = inFlight;
      const accepted = await inFlight;

      freeze();
      const paymentState: PaymentState = accepted.paymentState ?? 'not_required';
      setJob({
        jobId: accepted.jobId,
        eventsPath: accepted.eventsUrl,
        slug: accepted.slug,
        siteUrl: accepted.siteUrl,
        paymentState,
        checkoutUrl: accepted.checkoutUrl ?? null,
        checkoutExpiresAt: accepted.checkoutExpiresAt ?? null,
      });
      // The generation gets its own history entry, replacing step 6 so that "back" from the reveal
      // does not re-open the form the user has already submitted.
      window.history.replaceState(
        { aibJob: accepted.jobId },
        '',
        `${START_PATH}?job=${encodeURIComponent(accepted.jobId)}`,
      );
      // Two possible next screens, and the API's own answer decides which. An API that has not yet
      // been rolled forward answers without the payment fields; that job runs immediately and the
      // Phase 1 theatre is exactly right for it.
      if (paymentState === 'awaiting_payment') {
        checkoutPresses.current = 0;
        setCheckoutReason(accepted.checkoutUrl === undefined ? 'unavailable' : 'ready');
        setCheckoutError(null);
        setCheckoutExhausted(false);
        setPhase('checkout');
      } else {
        setPhase('generating');
      }
    } catch (error: unknown) {
      // Held in a local rather than read back from state: `setSubmitError` has not been applied by
      // the time the announcement is built, and announcing the *previous* error would be worse than
      // announcing nothing.
      let message: string | null;
      if (error instanceof ApiError && error.code === 'trial_already_used') {
        // Neither a validation failure nor a payment failure: the request was fine and the identity
        // is not eligible. The only useful response is the way in, so the message carries a link.
        message = error.localised(locale);
        const signInUrl = error.extra['signInUrl'];
        setSubmitLink(
          typeof signInUrl === 'string'
            ? { label: copy.modal.trialUsed.signIn, href: signInUrl }
            : null,
        );
      } else if (error instanceof ApiError && error.code === 'checkout_unavailable') {
        // The job row exists and is durable; only the Stripe call failed. Nothing the customer
        // entered is lost, and the hand-off screen can mint a session for it (§1 step 6).
        const jobId = error.extra['jobId'];
        if (typeof jobId === 'string' && jobId.length > 0) {
          freeze();
          setJob({
            jobId,
            eventsPath: `/v1/jobs/${encodeURIComponent(jobId)}/events`,
            slug: '',
            siteUrl: '',
            paymentState: 'awaiting_payment',
            checkoutUrl: null,
            checkoutExpiresAt: null,
          });
          window.history.replaceState(
            { aibJob: jobId },
            '',
            `${START_PATH}?job=${encodeURIComponent(jobId)}`,
          );
          checkoutPresses.current = 0;
          setCheckoutReason('unavailable');
          setCheckoutError(null);
          setCheckoutExhausted(false);
          setPhase('checkout');
          // `finally` still runs on this return and clears the in-flight guard.
          return;
        }
        message = error.localised(locale);
      } else if (error instanceof ApiError && error.fields !== null) {
        const mapped = fieldErrorsToMessages(error.fields, locale);
        setErrors(new Map(mapped.map((entry) => [entry.field, entry.message])));
        message = mapped.length === 0 ? error.localised(locale) : null;
      } else if (error instanceof ApiError) {
        message = error.localised(locale);
      } else {
        message = copy.modal.genericError;
      }
      setSubmitError(message);
      announceAssertive(
        interpolate(copy.a11y.errorPrefix, { message: message ?? copy.modal.genericError }),
      );
    } finally {
      submitInFlight.current = null;
      setSubmitting(false);
    }
  }, [
    announceAssertive,
    buildIntake,
    copy,
    ensureDraft,
    flush,
    freeze,
    getToken,
    locale,
    submitting,
    validateStep,
  ]);

  /* ── The hand-off to Stripe ──────────────────────────────────────────────────────────────── */

  /**
   * Sends the browser to Checkout.
   *
   * `window.location.assign` and nothing else: a TOP-LEVEL navigation. Checkout must never be
   * framed, and it never opens in a new tab either — a popup blocker eats it, and a customer who
   * pays in a tab that the original page cannot observe comes back to a screen that has no idea
   * what happened.
   *
   * A still-live session is REUSED rather than re-minted. That is what a customer who pressed Back
   * left behind, Stripe still considers it `open`, and re-minting would spend one of the five
   * sessions a job is allowed for its whole life (PHASE2-BILLING-AUTH §5.4) to arrive at the same
   * page.
   */
  const continueToCheckout = useCallback(async (): Promise<void> => {
    const handle = job;
    if (handle === null || checkoutBusy) {
      return;
    }
    // The first press of a `ready` screen is the attempt; anything after it is the retry, and there
    // is exactly one of those. A third identical button against a service that has refused twice is
    // not a remedy.
    const isRetry = checkoutReason !== 'ready' || checkoutPresses.current > 0;
    checkoutPresses.current += 1;
    setCheckoutBusy(true);
    setCheckoutError(null);
    try {
      const reusable =
        handle.checkoutUrl !== null &&
        handle.paymentState !== 'abandoned' &&
        checkoutReason !== 'expired' &&
        (handle.checkoutExpiresAt === null ||
          handle.checkoutExpiresAt - Date.now() > CHECKOUT_REUSE_MARGIN_MS);
      let target = handle.checkoutUrl;
      if (!reusable) {
        const minted = await resumeCheckout(handle.jobId);
        target = minted.checkoutUrl;
        setJob((previous) =>
          previous === null
            ? previous
            : {
                ...previous,
                paymentState: minted.paymentState,
                checkoutUrl: minted.checkoutUrl,
                checkoutExpiresAt: minted.checkoutExpiresAt,
              },
        );
      }
      if (target === null) {
        throw new Error('no-checkout-url');
      }
      // The draft is already frozen and both copies are flushed, so the unload loses nothing.
      window.location.assign(target);
    } catch (error: unknown) {
      const message = error instanceof ApiError ? error.localised(locale) : copy.modal.genericError;
      setCheckoutError(message);
      if (isRetry) {
        setCheckoutExhausted(true);
      }
      announceAssertive(interpolate(copy.a11y.errorPrefix, { message }));
      setCheckoutBusy(false);
    }
    // No `finally`: on the success path the document is navigating away, and clearing `busy` there
    // would flash the idle button for the frame before the unload.
  }, [announceAssertive, checkoutBusy, checkoutReason, copy, job, locale]);

  /** The same navigation, as a void-returning handler for the two buttons that fire it. */
  const onCheckoutPressed = useCallback((): void => {
    void continueToCheckout();
  }, [continueToCheckout]);

  /* ── Advancing ───────────────────────────────────────────────────────────────────────────── */

  const advance = useCallback((): void => {
    const current = draftRef.current;
    const found = validateStep(current.step, current);
    if (found.length > 0) {
      setErrors(new Map(found.map((entry) => [entry.field, entry.message])));
      setSubmitAttempt((previous) => previous + 1);
      // One error is announced from here; two or more are announced by the error summary, which
      // takes focus and carries `role="alert"`. Doing both would say the first problem twice.
      if (found.length === 1) {
        announceAssertive(interpolate(copy.a11y.errorPrefix, { message: found[0]?.message ?? '' }));
      }
      return;
    }
    if (current.step === STEP_COUNT) {
      void submit();
      return;
    }
    const next = (current.step + 1) as StepIndex;
    goToStep(next, 'push');
    void flush();
  }, [announceAssertive, copy, flush, goToStep, submit, validateStep]);

  const goBack = useCallback((): void => {
    if (draftRef.current.step === 1) {
      closeDialog();
      return;
    }
    window.history.back();
  }, [closeDialog]);

  /* ── The checkout screen's focus and announcement ────────────────────────────────────────── */

  useEffect(() => {
    if (phase !== 'checkout') {
      return undefined;
    }
    announce(
      interpolate(copy.checkout.announce, { days: plan.trialDays, today: formatEuro(0, locale) }),
    );
    // Focus lands after the entrance, for the same reason it does everywhere else in this island: a
    // screen reader must not be handed a moving target (UX §5.2). The heading carries `tabIndex=-1`,
    // so it is a focus target and never a tab stop.
    const timer = window.setTimeout(() => {
      checkoutHeadingRef.current?.focus();
    }, timing.stepIn);
    return () => {
      window.clearTimeout(timer);
    };
  }, [phase, announce, copy, locale, timing.stepIn]);

  /* ── Render ──────────────────────────────────────────────────────────────────────────────── */

  const stepIndex = draft.step;
  const stepId = STEP_IDS[stepIndex - 1] ?? 'name';
  const industryLabel =
    bootstrap?.industries.find((entry) => entry.key === draft.values.industryKey)?.label ?? null;
  const confirmCopy = confirmVariant === 'checkout' ? copy.modal.savedCheckout : copy.modal.saved;
  /** `€ 0,00`, from the plan whose build guard asserts the rate multiplies out to the annual total. */
  const todayAmount = formatEuro(0, locale);
  /** The reserved host, or `null` while it is genuinely unknown — never a guess. */
  const reservedHost =
    job !== null && job.siteUrl.length > 0
      ? new URL(job.siteUrl).hostname
      : job !== null && job.slug.length > 0
        ? tenantHost(job.slug)
        : null;
  const errorList = useMemo<FieldError[]>(
    () => Array.from(errors, ([field, message]) => ({ field, message })),
    [errors],
  );

  const headings: Readonly<Record<string, { label: string; helper: string }>> = {
    name: { label: copy.step1.label, helper: copy.step1.helper },
    industry: { label: copy.step2.label, helper: copy.step2.helper },
    address: { label: copy.step3.label, helper: copy.step3.helper },
    hours: { label: copy.step4.label, helper: copy.step4.helper },
    contact: { label: copy.step5.label, helper: copy.step5.helper },
    story: { label: copy.step6.label, helper: copy.step6.helper },
  };
  const heading = headings[stepId] ?? headings['name'];

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="onboarding-title"
      aria-describedby="onboarding-step-description"
      style={cssVars({
        '--enter': `${String(timing.modalEnter)}ms`,
        '--exit': `${String(timing.modalExit)}ms`,
        '--keyboard-inset': `${String(keyboardInset)}px`,
      })}
    >
      {/* `role="document"` keeps JAWS and NVDA in browse mode for the helper prose inside a dialog
          that is mostly form controls (UX §6.1). */}
      <div className={styles.panel} role="document">
        <LiveRegions ref={liveRef} />

        <h1 id="onboarding-title" className="sr-only">
          {phase === 'generating'
            ? copy.modal.titleGenerating
            : phase === 'checkout'
              ? interpolate(copy.checkout.title, { name: draft.values.businessName ?? '' })
              : interpolate(copy.modal.title, { step: stepIndex, total: STEP_COUNT })}
        </h1>
        <p id="onboarding-step-description" className="sr-only">
          {/* On the hand-off screen the step description would announce "step 6 of 6" over a screen
              that is no longer a step, so the dialog describes itself with what it is instead. */}
          {phase === 'checkout'
            ? copy.checkout.intro
            : stepIndex === STEP_COUNT
              ? interpolate(copy.modal.stepDescriptionLast, {
                  step: stepIndex,
                  total: STEP_COUNT,
                  name: copy.rail.steps[stepIndex - 1] ?? '',
                })
              : interpolate(copy.modal.stepDescription, {
                  step: stepIndex,
                  total: STEP_COUNT,
                  name: copy.rail.steps[stepIndex - 1] ?? '',
                  remaining: STEP_COUNT - stepIndex,
                })}
        </p>

        <header className={styles.header}>
          {phase !== 'generating' && phase !== 'checkout' ? (
            <ProgressRail
              step={stepIndex}
              furthestStep={draft.furthestStep}
              locale={locale}
              onNavigate={(target) => {
                goToStep(target, 'push');
              }}
            />
          ) : null}

          <button
            type="button"
            className={styles.close}
            aria-label={copy.modal.close}
            onClick={() => {
              if (phase === 'generating') {
                // The job keeps running in its Durable Object and the Worker mails the link, so
                // closing here loses nothing. Escape, by contrast, says so first — see the `cancel`
                // handler: a reflex key press should not dismiss the thing being waited for.
                closeDialog();
                return;
              }
              if (phase === 'checkout') {
                setConfirmVariant('checkout');
                confirmRef.current?.showModal();
                return;
              }
              if (draft.step > 1 && draftHasContent(draft)) {
                setConfirmVariant('draft');
                confirmRef.current?.showModal();
                return;
              }
              closeDialog();
            }}
          >
            <svg
              viewBox="0 0 16 16"
              aria-hidden="true"
              focusable="false"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        {draftApi.offline ? (
          <p className={styles.banner} role="status">
            {copy.modal.offline}
          </p>
        ) : null}

        {draftApi.conflict !== null ? (
          <div className={styles.banner} role="status">
            <span>{copy.modal.conflict.body}</span>
            <span className={fields.row}>
              <button
                type="button"
                className={`${fields.button} ${fields.buttonSecondary}`}
                onClick={() => {
                  resolveConflict('server');
                }}
              >
                {copy.modal.conflict.useServer}
              </button>
              <button
                type="button"
                className={`${fields.button} ${fields.buttonGhost}`}
                onClick={() => {
                  resolveConflict('local');
                }}
              >
                {copy.modal.conflict.useLocal}
              </button>
            </span>
          </div>
        ) : null}

        <div className={styles.body}>
          {phase === 'resume' ? (
            <div className={styles.resume}>
              <h2 className={styles.resumeTitle}>{copy.modal.resume.title}</h2>
              <p className={styles.resumeBody}>
                {interpolate(copy.modal.resume.body, {
                  step: draft.step,
                  total: STEP_COUNT,
                })}
              </p>
              <p className={styles.resumeSummary}>
                {[draft.values.businessName, industryLabel, draft.values.address.city]
                  .filter((value): value is string => typeof value === 'string' && value.length > 0)
                  .join(' · ')}
              </p>
              <div className={fields.row}>
                <button
                  type="button"
                  className={`${fields.button} ${fields.buttonPrimary}`}
                  onClick={() => {
                    setPhase('steps');
                  }}
                >
                  {copy.modal.resume.resume}
                </button>
                <button
                  type="button"
                  className={`${fields.button} ${fields.buttonGhost}`}
                  onClick={() => {
                    if (window.confirm(copy.modal.resume.restartConfirm)) {
                      // The stored job goes with the draft. Leaving it behind would make the next
                      // CTA press reopen a hand-off screen for the site they just discarded.
                      safeStorage().remove(LOCAL_JOB_KEY);
                      reset();
                      setPhase('steps');
                      goToStep(1, 'replace');
                    }
                  }}
                >
                  {copy.modal.resume.restart}
                </button>
              </div>
            </div>
          ) : null}

          {phase === 'checkout' ? (
            <CheckoutHandoff
              locale={locale}
              businessName={draft.values.businessName ?? ''}
              industryLabel={industryLabel}
              host={reservedHost}
              photoCount={draft.values.mediaIds.length}
              reason={checkoutReason}
              deadlineAt={job?.checkoutExpiresAt ?? null}
              busy={checkoutBusy}
              error={checkoutError}
              exhausted={checkoutExhausted}
              onContinue={onCheckoutPressed}
              onClose={closeDialog}
              headingRef={checkoutHeadingRef}
            />
          ) : null}

          {phase === 'generating' && job !== null ? (
            <GenerationTheatre
              locale={locale}
              businessName={draft.values.businessName ?? ''}
              industryLabel={industryLabel}
              slug={job.slug}
              siteUrl={job.siteUrl}
              email={draft.values.contactEmail ?? ''}
              event={event}
              slots={slots}
              connection={stream.connection}
              silentFor={stream.silentFor}
              paymentState={job.paymentState}
              paymentConfirmed={paymentConfirmed}
              checkoutDeadlineAt={job.checkoutExpiresAt}
              onResumeCheckout={onCheckoutPressed}
              resuming={checkoutBusy}
              resumeError={checkoutError}
              onAnnounce={announceGeneration}
              onAnnounceDone={announceAssertive}
              onRelease={closeDialog}
            />
          ) : null}

          {phase === 'steps' ? (
            <>
              <ErrorSummary errors={errorList} locale={locale} attempt={submitAttempt} />

              <StepShell
                stepId={stepId}
                direction={direction}
                headingId="onboarding-step-heading"
                helperId="onboarding-step-helper"
                heading={heading?.label ?? ''}
                helper={heading?.helper ?? ''}
                autoFocus={stepIndex === 1 ? 'none' : 'heading'}
                onEntered={() => {
                  setFocusReady(true);
                }}
              >
                {stepIndex === 1 ? (
                  <Step1Name
                    draft={draft}
                    locale={locale}
                    error={errors.get('businessName') ?? null}
                    setValues={setValues}
                    onValidate={setFieldError}
                    onAnnounce={announce}
                    onAdvance={advance}
                    focusReady={focusReady}
                  />
                ) : null}

                {stepIndex === 2 ? (
                  <Step2Industry
                    draft={draft}
                    locale={locale}
                    industries={bootstrap?.industries ?? []}
                    groups={bootstrap?.groups ?? []}
                    country={bootstrap?.country ?? null}
                    error={errors.get('industryKey') ?? null}
                    setValues={setValues}
                    onValidate={setFieldError}
                    onAdvance={advance}
                  />
                ) : null}

                {stepIndex === 3 ? (
                  <Step3Address
                    draft={draft}
                    locale={locale}
                    errors={errors}
                    setValues={setValues}
                    setUi={setUi}
                    onValidate={setFieldError}
                  />
                ) : null}

                {stepIndex === 4 ? (
                  <Step4Hours
                    draft={draft}
                    locale={locale}
                    setValues={setValues}
                    setUi={setUi}
                    onAnnounce={announce}
                  />
                ) : null}

                {stepIndex === 5 ? (
                  <Step5Contact
                    draft={draft}
                    locale={locale}
                    errors={errors}
                    setValues={setValues}
                    setUi={setUi}
                    onValidate={setFieldError}
                    onAdvance={advance}
                  />
                ) : null}

                {stepIndex === 6 ? (
                  <Step6Story
                    draft={draft}
                    locale={locale}
                    errors={errors}
                    media={media.items}
                    industryLabel={industryLabel}
                    setValues={setValues}
                    onValidate={setFieldError}
                    onAnnounce={announce}
                    onAddFiles={media.add}
                    onRemoveMedia={media.remove}
                    onRetryMedia={media.retry}
                    onMoveMedia={media.move}
                  />
                ) : null}
              </StepShell>
            </>
          ) : null}
        </div>

        {phase === 'steps' ? (
          <footer className={styles.footer}>
            {submitError !== null ? (
              <p className={styles.submitError}>
                {submitError}
                {submitLink !== null ? (
                  <>
                    {' '}
                    <a className={styles.submitLink} href={submitLink.href}>
                      {submitLink.label}
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
            {/* The disclosure sits INSIDE the sticky footer rather than in the step's body, so it is
                on screen at the moment of the irreversible action. In the body it scrolls away above
                the button on every phone, which is where a disclosure is worth nothing. */}
            {stepIndex === STEP_COUNT ? (
              <p className={styles.footerNotice}>
                {interpolate(copy.step6.checkoutNotice, { today: todayAmount })}
              </p>
            ) : null}
            <div className={styles.footerRow}>
              <button
                type="button"
                className={`${fields.button} ${fields.buttonSecondary}`}
                onClick={goBack}
              >
                {copy.actions.back}
              </button>
              <button
                type="button"
                className={`${fields.button} ${fields.buttonPrimary} ${styles.primary}`}
                disabled={submitting}
                aria-busy={submitting}
                onClick={advance}
              >
                {stepIndex === STEP_COUNT
                  ? submitting
                    ? copy.actions.submitting
                    : copy.actions.submit
                  : copy.actions.continue}
              </button>
            </div>
          </footer>
        ) : null}

        {escapeDuringBuild ? (
          <p className={styles.banner} role="status">
            {copy.generation.escapeHint}
          </p>
        ) : null}

        {/* Turnstile renders its iframe here. It is inside the panel rather than at the document
            root so that a managed challenge, on the rare occasion it decides to show itself,
            appears within the dialog the user is looking at. */}
        <div ref={turnstileHostRef} className={styles.turnstile} />
      </div>

      {/* The nested confirmation. Its PRIMARY action is "keep going" — the draft is already saved,
          so there is nothing to warn about and nothing destructive to default to (UX §6.3). After
          submit it carries the checkout wording, because by then the facts are different. */}
      <dialog
        ref={confirmRef}
        className={styles.confirm}
        aria-labelledby="onboarding-confirm-title"
      >
        <h2 id="onboarding-confirm-title" className={styles.confirmTitle}>
          {confirmCopy.title}
        </h2>
        <p className={styles.confirmBody}>{confirmCopy.body}</p>
        <div className={fields.row}>
          <button
            type="button"
            className={`${fields.button} ${fields.buttonPrimary}`}
            onClick={() => {
              confirmRef.current?.close();
            }}
          >
            {confirmCopy.keepGoing}
          </button>
          <button
            type="button"
            className={`${fields.button} ${fields.buttonSecondary}`}
            onClick={() => {
              confirmRef.current?.close();
              closeDialog();
            }}
          >
            {confirmCopy.close}
          </button>
        </div>
      </dialog>
    </dialog>
  );
}

/**
 * Maps a server (or local) field-code map onto human messages.
 *
 * The API answers 422 with issue CODES rather than messages, deliberately — a code cannot echo what
 * the user typed back into a response body. The modal owns the copy, so this is where the two meet.
 * A field with no known message is dropped rather than shown as a code: `too_small` is not a
 * sentence, and the generic submit error is a better thing to read than a fragment of Zod.
 */
function fieldErrorsToMessages(
  map: Readonly<Record<string, readonly string[]>>,
  locale: Locale,
): FieldError[] {
  const messages: FieldError[] = [];
  for (const field of Object.keys(map)) {
    switch (field) {
      case 'businessName':
        messages.push({ field, message: validationMessage('businessName.empty', locale) });
        break;
      case 'slug':
        messages.push({
          field: 'businessName',
          message: validationMessage('slug.invalid', locale),
        });
        break;
      case 'industryKey':
        messages.push({ field, message: validationMessage('industry.empty', locale) });
        break;
      case 'phoneE164':
        messages.push({ field, message: validationMessage('phone.empty', locale) });
        break;
      case 'contactEmail':
        messages.push({ field, message: validationMessage('email.invalid', locale) });
        break;
      case 'address.line1':
      case 'address':
      case '_':
        messages.push({
          field: 'address.line1',
          message: validationMessage('address.empty', locale),
        });
        break;
      case 'address.city':
        messages.push({ field, message: validationMessage('address.cityEmpty', locale) });
        break;
      default:
        break;
    }
  }
  return messages;
}
