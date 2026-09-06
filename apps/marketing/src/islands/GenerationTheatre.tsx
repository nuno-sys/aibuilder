/**
 * Act 7 — the generation. Status rail on the left, live preview on the right.
 *
 * PHASE → ACT IS MANY-TO-ONE, AND ACTS ONLY EVER ADVANCE. The workflow emits twelve phases; the
 * user sees eight acts. `api_call` and `thinking` are one act, `parsing` and `pages_written` are
 * another. A phase belonging to a LOWER act than the one already reached updates the detail line and
 * nothing else — it never moves the rail backwards. This matters because a Workflow replays: a
 * retried step legitimately re-emits an earlier phase, and a progress bar that jumps back is read as
 * a failure even when the run is healthy.
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
 * SILENCE IS HANDLED HONESTLY. At 15 seconds without an event the rail says so in plain language. At
 * 45 seconds it offers the email-and-release path — the job runs in a Durable Object and survives
 * the tab being closed, so "close this and we will email you" is a real offer and not a dismissal.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Locale } from '@aibuilder/core';

import { SITES_ROOT_DOMAIN } from '../lib/config';
import { copyFor } from '../lib/copy';
import { formatPercent, interpolate, spokenHost, tenantHost } from '../lib/format';
import { cssVars, useMotionTiming } from '../lib/motion';

import type { GenerationEvent, GenerationPhase, SseConnection } from './hooks/useSSE';
import SkeletonMorph from './SkeletonMorph';
import RevealCard from './RevealCard';
import fields from './fields.module.css';
import styles from './Generation.module.css';

/** The eight acts the user sees, in order. */
const ACTS = [
  'queued',
  'prompt',
  'design',
  'writing',
  'layout',
  'media',
  'build',
  'deploy',
  'done',
] as const;

/** One act index, 0–8. */
type ActIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Phase → act. Many-to-one by design; `error` keeps whatever act was reached. */
const PHASE_TO_ACT: Readonly<Record<GenerationPhase, ActIndex | null>> = {
  queued: 0,
  prompt_built: 1,
  api_call: 2,
  thinking: 2,
  streaming: 3,
  parsing: 4,
  pages_written: 4,
  media_fetch: 5,
  build: 6,
  deploy: 7,
  done: 8,
  error: null,
};

/** Progress floor of each act, and therefore the ceiling of the one before it (UX §5.5). */
const ACT_FLOOR: readonly number[] = [0, 3, 10, 24, 58, 70, 84, 93, 100];

/** Time constant of the between-events approach, in milliseconds. */
const TAU_MS = 6000;

/** How often the interpolated value is recomputed. Four times a second is smooth and cheap. */
const TICK_MS = 250;

/** Silence before the honest line appears. */
const SLOW_AFTER_MS = 15_000;

/** Silence before the email-and-release offer appears. */
const RELEASE_AFTER_MS = 45_000;

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
 * floor before its event has arrived, and that the completion announcement fires exactly once.
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
  const lastEventAt = useRef(Date.now());
  const announcedDone = useRef(false);
  // Mirrors of `act` and `floor` for the absorb effect, which both reads and writes them: keeping
  // them in state alone would mean either a stale read or an effect that re-runs on its own writes.
  const actRef = useRef<ActIndex>(0);
  const floorRef = useRef(0);

  const headlines = useMemo(
    () => ({
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

  // The asymptotic approach between events.
  useEffect(() => {
    if (timing.reduced || act >= 8 || failed) {
      return undefined;
    }
    const nextFloor = ACT_FLOOR[Math.min(8, act + 1)] ?? 100;
    const timer = setInterval(() => {
      const elapsed = Date.now() - lastEventAt.current;
      const target = floor + (nextFloor - floor) * (1 - Math.exp(-elapsed / TAU_MS));
      setDisplayed((previous) => Math.max(previous, Math.min(nextFloor, target)));
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [act, floor, failed, timing.reduced]);

  const isDone = act >= 8 && !failed;
  const showSlow = !isDone && !failed && silentFor >= SLOW_AFTER_MS;
  const showRelease = !isDone && !failed && silentFor >= RELEASE_AFTER_MS;

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
          {ACTS.slice(0, 8).map((name, index) => {
            const state = index < act ? 'done' : index === act ? 'active' : 'todo';
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

        {event !== null && event.message !== null && !isDone ? (
          <p className={styles.detail}>{event.message}</p>
        ) : null}

        {connection === 'polling' && !isDone ? (
          <p className={styles.detail}>{copy.modal.offline}</p>
        ) : null}

        {showSlow && !showRelease ? <p className={styles.slow}>{copy.generation.slow}</p> : null}

        {showRelease && !released ? (
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
          <SkeletonMorph slots={slots} act={act} businessName={businessName} />
        </div>

        {isDone ? <RevealCard locale={locale} slug={slug} siteUrl={siteUrl} email={email} /> : null}
      </div>
    </div>
  );
}
