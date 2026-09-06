/**
 * Act 7 — the generation. Status rail on the left, live preview on the right.
 *
 * PHASE → ACT IS MANY-TO-ONE, AND ACTS ONLY EVER ADVANCE. The workflow emits twelve phases; the
 * user sees nine acts. `api_call` and `thinking` are one act, `parsing` and `pages_written` are
 * another. A phase belonging to a LOWER act than the one already reached updates the detail line and
 * nothing else — it never moves the rail backwards. This matters because a Workflow replays: a
 * retried step legitimately re-emits an earlier phase, and a progress bar that jumps back is read as
 * a failure even when the run is healthy.
 *
 * ACT 0 IS `awaiting_payment`, AND IT IS THE ONE ACT WHERE THE RAIL DOES NOT MOVE. Under the
 * trial-first funnel (DECISIONS §D2) a job exists, holds a reserved slug and a promoted media set,
 * and does not run until the `checkout.session.completed` webhook releases it. The customer can
 * therefore be looking at this screen before a single token has been generated — and the honest
 * rendering of "nothing is happening yet" is a stopped bar with a sentence that says so, not an
 * asymptotic creep that implies work (PHASE2-BILLING-AUTH §2.3). The interpolation below is
 * switched off for exactly this act; every other act keeps it.
 *
 * THE BAR NEVER LIES AND NEVER STALLS. Between events it approaches the next act's floor
 * asymptotically —
 *
 *     displayed = floor + (nextFloor − floor) × (1 − e^(−elapsed / τ)),   τ = 6 s
 *
 * — so it is always moving, always slowing, and can never reach the next milestone before the event
 * that earns it. A real event snaps it forward over 400 ms. Under reduced motion the interpolation
 * is switched off entirely and the bar steps on events alone: the `width` transition stays, because
 * a progress bar that does not move is a broken progress bar.
 *
 * SILENCE IS HANDLED HONESTLY, AND THE TWO SILENCES ARE DIFFERENT. During the build, 15 seconds
 * without an event says so in plain language and 45 seconds offers the email-and-release path. While
 * waiting for a payment webhook the clocks are 20 s and 90 s (PHASE2-BILLING-AUTH §2.3) and they are
 * measured from entering the act rather than from the last event, because in this act there are no
 * events to measure from — and the "taking longer than usual" copy would be wrong anyway: nothing is
 * building, we are waiting for Stripe.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Locale } from '@aibuilder/core';

import type { PaymentState } from '../lib/api';
import { SITES_ROOT_DOMAIN } from '../lib/config';
import { copyFor } from '../lib/copy';
import { formatClockTime, formatPercent, interpolate, spokenHost, tenantHost } from '../lib/format';
import { cssVars, useMotionTiming } from '../lib/motion';

import type { GenerationEvent, SseConnection } from './hooks/useSSE';
import { ACTS, ACT_DONE, ACT_FLOOR, ACT_QUEUED, PHASE_TO_ACT } from './acts';
import type { ActIndex } from './acts';
import SkeletonMorph from './SkeletonMorph';
import RevealCard from './RevealCard';
import fields from './fields.module.css';
import styles from './Generation.module.css';

/** Time constant of the between-events approach, in milliseconds. */
const TAU_MS = 6000;

/** How often the interpolated value is recomputed. Four times a second is smooth and cheap. */
const TICK_MS = 250;

/** Silence before the honest line appears. */
const SLOW_AFTER_MS = 15_000;

/** Silence before the email-and-release offer appears. */
const RELEASE_AFTER_MS = 45_000;

/** Waiting on the payment webhook before the second, apologetic line appears (§2.3). */
const PAYMENT_SLOW_AFTER_MS = 20_000;

/**
 * Waiting on the payment webhook before the email-and-release offer appears (§2.3).
 *
 * Ninety seconds is the point at which a webhook is genuinely late rather than merely in flight.
 * There is nothing to retry — the job is durable, the entitlement will land, and the site will be
 * built with the tab closed — so the offer here is the one that already exists: we mail the link.
 */
const PAYMENT_RELEASE_AFTER_MS = 90_000;

/** How often the payment wait clock ticks. It only ever crosses two thresholds. */
const PAYMENT_TICK_MS = 1000;

export interface GenerationTheatreProps {
  readonly locale: Locale;
  readonly businessName: string;
  readonly industryLabel: string | null;
  readonly slug: string;
  readonly siteUrl: string;
  readonly email: string;
  /** The newest event from the stream, or `null` before the first one arrives. */
  readonly event: GenerationEvent | null;
  /** Every `{slot, text}` seen so far, accumulated by the modal. */
  readonly slots: ReadonlyMap<string, string>;
  readonly connection: SseConnection;
  /** Milliseconds since the last event of any kind. */
  readonly silentFor: number;
  /** Where the job stands with the trial. `not_required` renders exactly the Phase 1 theatre. */
  readonly paymentState: PaymentState;
  /**
   * True when the server has told us the Checkout Session is complete — i.e. the customer arrived
   * on `?payment=confirming`, which `GET /v1/billing/return` only issues after asking Stripe.
   *
   * It is the difference between "we are confirming your trial" and "your site is waiting for you to
   * start it", and therefore between showing no action and showing a button back to Stripe. Guessing
   * wrong in either direction is a real failure: offering to pay someone who just paid, or leaving
   * someone who never paid staring at a confirmation that will never arrive.
   */
  readonly paymentConfirmed: boolean;
  /** Epoch milliseconds at which the Checkout Session expires, or `null` when unknown. */
  readonly checkoutDeadlineAt: number | null;
  /** Mints a fresh Checkout Session and navigates to it. */
  readonly onResumeCheckout: () => void;
  /** True while that call is in flight; the button is disabled and `aria-busy`. */
  readonly resuming: boolean;
  /** Localised failure of the last resume attempt, or `null`. */
  readonly resumeError: string | null;
  /** Throttled to one message per four seconds by `LiveRegions`. */
  readonly onAnnounce: (message: string) => void;
  /** Announced assertively; the build is finished and the user may be looking elsewhere. */
  readonly onAnnounceDone: (message: string) => void;
  /** Closes the modal with the "we will email you" promise. */
  readonly onRelease: () => void;
}

/**
 * Renders the status rail, the preview and — at `done` — the reveal.
 *
 * Guarantees the act index is monotonic, that the displayed percentage never exceeds the next act's
 * floor before its event has arrived, that the rail is motionless while payment is outstanding, and
 * that the completion announcement fires exactly once.
 */
export default function GenerationTheatre({
  locale,
  businessName,
  industryLabel,
  slug,
  siteUrl,
  email,
  event,
  slots,
  connection,
  silentFor,
  paymentState,
  paymentConfirmed,
  checkoutDeadlineAt,
  onResumeCheckout,
  resuming,
  resumeError,
  onAnnounce,
  onAnnounceDone,
  onRelease,
}: GenerationTheatreProps) {
  const copy = copyFor(locale);
  const timing = useMotionTiming();

  const [act, setAct] = useState<ActIndex>(0);
  const [floor, setFloor] = useState(0);
  const [displayed, setDisplayed] = useState(0);
  const [failed, setFailed] = useState(false);
  const [released, setReleased] = useState(false);
  const [waitingFor, setWaitingFor] = useState(0);
  const lastEventAt = useRef(Date.now());
  const announcedDone = useRef(false);
  const announcedPayment = useRef(false);
  // Mirrors of `act` and `floor` for the absorb effect, which both reads and writes them: keeping
  // them in state alone would mean either a stale read or an effect that re-runs on its own writes.
  const actRef = useRef<ActIndex>(0);
  const floorRef = useRef(0);

  /**
   * Both are gated on `act === 0`, i.e. on no build event having arrived.
   *
   * A `progress` frame is proof the Workflow is running, and the Workflow only runs on a released
   * job — so the first event settles the payment question no matter what the last `payment` frame
   * said. Without the gate a released job would render the confirmation card beside "We beginnen…"
   * and keep the rail frozen at 0 % for the whole build.
   */
  const awaitingPayment = act === 0 && paymentState === 'awaiting_payment';
  const checkoutExpired = act === 0 && paymentState === 'abandoned';
  /**
   * The act actually on screen.
   *
   * `act` is the high-water mark of the events received, which is 0 until the first one arrives —
   * and 0 now means "waiting for a card", a claim that is only true for a job that is genuinely
   * awaiting payment. Anything else starts at `queued`, exactly as Phase 1 did.
   */
  const shownAct: ActIndex = act > 0 ? act : awaitingPayment || checkoutExpired ? 0 : ACT_QUEUED;

  /**
   * Whether the checklist carries the payment row at all.
   *
   * Sticky once seen: a job released mid-session must keep the row (now ticked) rather than have the
   * whole list shift up by one under the reader, which reads as a step being skipped.
   */
  const [showsPaymentAct, setShowsPaymentAct] = useState(false);
  useEffect(() => {
    if (awaitingPayment || checkoutExpired) {
      setShowsPaymentAct(true);
    }
  }, [awaitingPayment, checkoutExpired]);

  const headlines = useMemo(
    () => ({
      awaitingPayment: copy.generation.acts.awaitingPayment,
      queued: copy.generation.acts.queued,
      prompt: interpolate(copy.generation.acts.prompt, { name: businessName }),
      design: interpolate(copy.generation.acts.design, {
        industry: industryLabel ?? (locale === 'nl' ? 'jouw vak' : 'your trade'),
      }),
      writing: copy.generation.acts.writing,
      layout: copy.generation.acts.layout,
      media: copy.generation.acts.media,
      build: copy.generation.acts.build,
      // A modal resumed from `?job=` may not know the slug yet; naming the root domain is honest
      // where naming `.mijnsaas.com` with an empty label would not be.
      deploy: interpolate(copy.generation.acts.deploy, {
        host: slug.length > 0 ? tenantHost(slug) : SITES_ROOT_DOMAIN,
      }),
      done: copy.generation.acts.done,
    }),
    [copy, businessName, industryLabel, locale, slug],
  );

  // Absorb one event: advance the act monotonically, raise the floor, announce.
  useEffect(() => {
    if (event === null) {
      return;
    }
    lastEventAt.current = Date.now();

    if (event.phase === 'error') {
      setFailed(true);
      return;
    }

    const mapped = PHASE_TO_ACT[event.phase];
    // Monotonic by construction: a replayed step legitimately re-emits an earlier phase, and the
    // rail must not move backwards for it.
    const resolvedAct =
      mapped === null ? actRef.current : (Math.max(actRef.current, mapped) as ActIndex);
    actRef.current = resolvedAct;
    setAct(resolvedAct);

    // The server's own number wins whenever it is ahead of the act's floor: it knows about progress
    // inside a long step that the act table cannot express.
    const nextFloor = Math.max(floorRef.current, ACT_FLOOR[resolvedAct] ?? 0, event.progress);
    floorRef.current = nextFloor;
    setFloor(nextFloor);
    setDisplayed((previous) => Math.max(previous, nextFloor));

    if (event.phase === 'done') {
      if (!announcedDone.current) {
        announcedDone.current = true;
        onAnnounceDone(
          interpolate(copy.generation.doneAnnouncement, {
            spokenHost: spokenHost(tenantHost(slug), locale),
          }),
        );
      }
      return;
    }

    onAnnounce(
      interpolate(copy.generation.announcement, {
        headline: headlines[ACTS[resolvedAct] ?? 'queued'],
        percent: formatPercent(nextFloor, locale),
      }),
    );
  }, [event, copy, headlines, locale, slug, onAnnounce, onAnnounceDone]);

  // The asymptotic approach between events. Never runs in the payment act — see the module header.
  useEffect(() => {
    if (timing.reduced || shownAct >= ACT_DONE || failed || awaitingPayment || checkoutExpired) {
      return undefined;
    }
    const nextFloor = ACT_FLOOR[Math.min(ACT_DONE, shownAct + 1)] ?? 100;
    const timer = setInterval(() => {
      const elapsed = Date.now() - lastEventAt.current;
      const target = floor + (nextFloor - floor) * (1 - Math.exp(-elapsed / TAU_MS));
      setDisplayed((previous) => Math.max(previous, Math.min(nextFloor, target)));
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [shownAct, floor, failed, awaitingPayment, checkoutExpired, timing.reduced]);

  // The payment wait clock. Measured from entering the act, not from the last event: there are no
  // events in this act, and `silentFor` would be counting the wrong thing. It runs only for a
  // CONFIRMED payment, because the two thresholds it feeds are both about a late webhook — a
  // customer who has not paid is not waiting for one, and has a button instead.
  useEffect(() => {
    if (!awaitingPayment || !paymentConfirmed) {
      setWaitingFor(0);
      return undefined;
    }
    const enteredAt = Date.now();
    const timer = setInterval(() => {
      setWaitingFor(Date.now() - enteredAt);
    }, PAYMENT_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [awaitingPayment, paymentConfirmed]);

  // One announcement on entering the payment act. A screen reader user who has just been bounced
  // through Stripe's page and back needs to be told where they landed and that they need do nothing.
  useEffect(() => {
    if (!awaitingPayment || announcedPayment.current) {
      return;
    }
    announcedPayment.current = true;
    onAnnounce(
      paymentConfirmed
        ? copy.generation.payment.confirmingAnnounce
        : `${copy.generation.payment.pendingTitle} ${copy.generation.payment.pendingBody}`,
    );
  }, [awaitingPayment, paymentConfirmed, copy, onAnnounce]);

  const isDone = shownAct >= ACT_DONE && !failed;
  const paymentPending = awaitingPayment || checkoutExpired;
  // The build's own silence copy is suppressed while payment is outstanding: "this is taking longer
  // than usual" would be a statement about a build that has not begun.
  const showSlow = !isDone && !failed && !paymentPending && silentFor >= SLOW_AFTER_MS;
  const showRelease = !isDone && !failed && !paymentPending && silentFor >= RELEASE_AFTER_MS;
  const showPaymentSlow =
    awaitingPayment && paymentConfirmed && waitingFor >= PAYMENT_SLOW_AFTER_MS;
  const showPaymentRelease =
    awaitingPayment && paymentConfirmed && waitingFor >= PAYMENT_RELEASE_AFTER_MS;

  /** The checklist rows, with their true act indices — the payment row is conditionally absent. */
  const visibleActs = ACTS.slice(showsPaymentAct ? 0 : ACT_QUEUED, ACT_DONE).map(
    (name, offset) => ({ name, index: (showsPaymentAct ? 0 : ACT_QUEUED) + offset }),
  );

  return (
    // `data-generation` lets the dialog widen for this act only (see OnboardingModal.module.css).
    <div className={styles.theatre} data-generation="true">
      <div className={styles.rail}>
        <h3 className={styles.railTitle}>{copy.generation.title}</h3>

        <div
          className={styles.bar}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(displayed)}
          aria-label={copy.generation.progressLabel}
        >
          <span
            className={styles.barFill}
            style={cssVars({
              '--progress': `${String(Math.min(100, displayed))}%`,
              '--bar-duration': `${String(timing.railFill)}ms`,
            })}
          />
        </div>
        <p className={styles.percent}>{formatPercent(displayed, locale)}%</p>

        <ol className={styles.acts}>
          {visibleActs.map(({ name, index }) => {
            const state = index < shownAct ? 'done' : index === shownAct ? 'active' : 'todo';
            return (
              <li
                key={name}
                className={`${styles.actRow} ${
                  state === 'done' ? styles.actDone : state === 'active' ? styles.actActive : ''
                }`}
              >
                <span className={styles.actTick} aria-hidden="true">
                  <svg
                    viewBox="0 0 16 16"
                    focusable="false"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 8.5 6.5 12 13 4.5" />
                  </svg>
                </span>
                <span className={styles.actText}>{headlines[name]}</span>
              </li>
            );
          })}
        </ol>

        {/* The payment act's own card. It is neutral, not a warning: nothing has gone wrong, and
            colouring a normal state in amber trains people to ignore amber. */}
        {awaitingPayment ? (
          <div className={styles.payment}>
            <p className={styles.paymentTitle}>
              <span className={styles.paymentPulse} aria-hidden="true" />
              {paymentConfirmed
                ? copy.generation.payment.confirmingTitle
                : copy.generation.payment.pendingTitle}
            </p>
            <p className={styles.paymentBody}>
              {paymentConfirmed
                ? copy.generation.payment.confirmingBody
                : copy.generation.payment.pendingBody}
            </p>
            {showPaymentSlow ? (
              <p className={styles.paymentBody}>{copy.generation.payment.confirmingSlow}</p>
            ) : null}
            {!paymentConfirmed ? (
              <>
                <button
                  type="button"
                  className={`${fields.button} ${fields.buttonPrimary}`}
                  disabled={resuming}
                  aria-busy={resuming}
                  onClick={onResumeCheckout}
                >
                  {copy.generation.payment.pendingAction}
                </button>
                {checkoutDeadlineAt !== null && checkoutDeadlineAt > Date.now() ? (
                  <p className={styles.paymentNote}>
                    {interpolate(copy.checkout.expiresAt, {
                      time: formatClockTime(checkoutDeadlineAt, locale),
                    })}
                  </p>
                ) : null}
              </>
            ) : null}
            {resumeError !== null ? <p className={styles.failed}>{resumeError}</p> : null}
          </div>
        ) : null}

        {/* The Checkout window closed. The job is untouched — `payment_state` moved, `status` did
            not (PHASE2-BILLING-AUTH §2.1) — so the only thing missing is a fresh session. */}
        {checkoutExpired ? (
          <div className={styles.payment}>
            <p className={styles.paymentTitle}>{copy.generation.payment.expiredTitle}</p>
            <p className={styles.paymentBody}>{copy.generation.payment.expiredBody}</p>
            <button
              type="button"
              className={`${fields.button} ${fields.buttonPrimary}`}
              disabled={resuming}
              aria-busy={resuming}
              onClick={onResumeCheckout}
            >
              {copy.generation.payment.expiredAction}
            </button>
            {resumeError !== null ? <p className={styles.failed}>{resumeError}</p> : null}
          </div>
        ) : null}

        {event !== null && event.message !== null && !isDone ? (
          <p className={styles.detail}>{event.message}</p>
        ) : null}

        {connection === 'polling' && !isDone ? (
          <p className={styles.detail}>{copy.modal.offline}</p>
        ) : null}

        {showSlow && !showRelease ? <p className={styles.slow}>{copy.generation.slow}</p> : null}

        {(showRelease || showPaymentRelease) && !released ? (
          <div className={styles.release}>
            <p className={styles.slow}>{copy.generation.release}</p>
            <button
              type="button"
              className={`${fields.button} ${fields.buttonSecondary}`}
              onClick={() => {
                setReleased(true);
                onRelease();
              }}
            >
              {copy.generation.releaseAction}
            </button>
          </div>
        ) : null}

        {released ? (
          <p className={styles.slow}>{interpolate(copy.generation.releaseDone, { email })}</p>
        ) : null}

        {failed ? (
          <div className={styles.release}>
            <p className={styles.failed}>{copy.generation.failed}</p>
          </div>
        ) : null}
      </div>

      <div className={styles.stage}>
        <div className={`${styles.stageInner} ${isDone ? styles.stageRevealed : ''}`}>
          <SkeletonMorph slots={slots} act={shownAct} businessName={businessName} />
        </div>

        {isDone ? <RevealCard locale={locale} slug={slug} siteUrl={siteUrl} email={email} /> : null}
      </div>
    </div>
  );
}
