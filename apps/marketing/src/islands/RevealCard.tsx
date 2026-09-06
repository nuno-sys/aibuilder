/**
 * The reveal — peak P2, and the last thing the user remembers about the whole flow.
 *
 * The peak-end rule says an experience is recalled by its most intense moment and its end. This is
 * both. Everything here exists to make the end *success* rather than *a form*: the preview un-blurs
 * and scales up, the card rises with a spring, the real domain gets a sheen sweep, and fourteen
 * confetti particles fire once and remove themselves.
 *
 * ALL OF IT IS SUPPRESSED UNDER `prefers-reduced-motion`, replaced by the same card in its final
 * state. Not reduced — removed. Confetti is the canonical example of motion that causes real
 * discomfort, and there is nothing about the information here that needs movement to be understood.
 *
 * THE DOMAIN IS THE HERO OF THIS CARD. It is the thing the customer did not believe would exist
 * fifteen minutes ago, it is rendered in the monospace face so it reads as an address rather than a
 * sentence, and it is a real link.
 */

import { useEffect, useState } from 'react';
import type { Locale } from '@aibuilder/core';

import { copyFor } from '../lib/copy';
import { interpolate, tenantHost } from '../lib/format';
import { cssVars, useMotionTiming } from '../lib/motion';

import fields from './fields.module.css';
import styles from './Generation.module.css';

/** Particle count. Fourteen is enough to read as celebration and few enough to composite cheaply. */
const CONFETTI_COUNT = 14;

/** Deterministic pseudo-random spread, so the burst looks scattered without a random seed per render. */
const CONFETTI = Array.from({ length: CONFETTI_COUNT }, (_unused, index) => ({
  index,
  x: (index * 37) % 100,
  delay: (index % 5) * 40,
  rotate: ((index * 53) % 120) - 60,
}));

export interface RevealCardProps {
  readonly locale: Locale;
  readonly slug: string;
  /** Absolute URL of the published site, as the submit response returned it. */
  readonly siteUrl: string;
  readonly email: string;
  /** Opens the Phase 2 editor. Absent in Phase 1, where the secondary button explains why. */
  readonly onEdit?: (() => void) | undefined;
}

/**
 * Renders the success card.
 *
 * Guarantees the confetti nodes are removed from the DOM once their animation has finished, so a
 * card that stays on screen does not keep fourteen animated elements alive.
 */
export default function RevealCard({ locale, slug, siteUrl, email, onEdit }: RevealCardProps) {
  const copy = copyFor(locale);
  const timing = useMotionTiming();
  const [confettiVisible, setConfettiVisible] = useState(!timing.reduced);
  const host = tenantHost(slug);

  useEffect(() => {
    if (!confettiVisible) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setConfettiVisible(false);
    }, 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [confettiVisible]);

  return (
    <div className={styles.reveal} style={cssVars({ '--reveal': `${String(timing.reveal)}ms` })}>
      {confettiVisible ? (
        <div className={styles.confetti} aria-hidden="true">
          {CONFETTI.map((particle) => (
            <span
              key={particle.index}
              className={styles.particle}
              style={cssVars({
                '--x': `${String(particle.x)}%`,
                '--delay': `${String(particle.delay)}ms`,
                '--rotate': `${String(particle.rotate)}deg`,
              })}
            />
          ))}
        </div>
      ) : null}

      <h3 className={styles.revealTitle}>{copy.generation.reveal.title}</h3>

      <a className={styles.revealDomain} href={siteUrl} target="_blank" rel="noopener">
        <span className={styles.revealDomainText}>{host}</span>
      </a>

      <p className={styles.revealBody}>
        {interpolate(copy.generation.reveal.body, { host, email })}
      </p>

      <div className={fields.row}>
        <a
          className={`${fields.button} ${fields.buttonPrimary}`}
          href={siteUrl}
          target="_blank"
          rel="noopener"
        >
          {copy.generation.reveal.view}
        </a>
        {onEdit === undefined ? (
          <p className={styles.revealNote}>{copy.generation.reveal.editSoon}</p>
        ) : (
          <button
            type="button"
            className={`${fields.button} ${fields.buttonSecondary}`}
            onClick={onEdit}
          >
            {copy.generation.reveal.edit}
          </button>
        )}
      </div>
    </div>
  );
}
