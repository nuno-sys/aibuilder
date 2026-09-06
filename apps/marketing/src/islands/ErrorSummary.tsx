/**
 * The error summary — the WCAG 2.2 pattern for a form that failed on submit.
 *
 * THREE THINGS THAT MAKE IT WORK, all of them easy to get subtly wrong:
 *
 *  1. **`role="alert"` plus `tabindex="-1"`, and focus is moved to the container.** The role
 *     announces the summary the moment it appears; the focus move is what lets a screen-reader user
 *     *navigate* it afterwards. Doing only one of the two produces either an announcement the user
 *     cannot reach or a silent jump they did not ask for.
 *
 *  2. **The anchor text is the exact error message, not "see below" or the field label.** A screen
 *     reader's link list is a common navigation mode; a list of six links all reading "Fout" is
 *     useless. Reading the message from the link is the whole point of the pattern.
 *
 *  3. **The click focuses the field instead of navigating to it.** A real `#hash` jump would push a
 *     history entry into a wizard whose history stack *is* its step model — the back button would
 *     then undo an error-summary click rather than a step.
 *
 * It appears only when a submit produced two or more errors. One error is shown inline on its field
 * and nowhere else: a summary listing a single item is ceremony, and it pushes the field the user
 * has to fix further down the screen.
 */

import { useEffect, useRef } from 'react';
import type { Locale } from '@aibuilder/core';

import { copyFor } from '../lib/copy';
import { interpolate } from '../lib/format';
import type { FieldError } from '../lib/types';

import styles from './ErrorSummary.module.css';

/** Minimum errors before the summary is shown at all. */
const MIN_ERRORS = 2;

export interface ErrorSummaryProps {
  /** In the order the fields appear on the step, which is the order they should be fixed in. */
  readonly errors: readonly FieldError[];
  readonly locale: Locale;
  /**
   * Increments on every submit attempt.
   *
   * Focus follows this rather than the error list: re-submitting with the same two errors must
   * re-announce and re-focus, and an identical array would not trigger an effect keyed on content.
   */
  readonly attempt: number;
}

/**
 * Renders the summary, focusing itself on each new submit attempt with two or more errors.
 *
 * Guarantees focus is never stolen from a field the user is currently fixing: the effect runs only
 * when `attempt` changes, which happens exactly once per press of the primary button.
 */
export default function ErrorSummary({ errors, locale, attempt }: ErrorSummaryProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const copy = copyFor(locale);

  // The current errors are read through a ref so the focus effect can depend on `attempt` alone.
  // Depending on `errors` as well would move focus into the summary while the user is mid-fix.
  const errorsRef = useRef(errors);
  errorsRef.current = errors;

  useEffect(() => {
    if (attempt > 0 && errorsRef.current.length >= MIN_ERRORS) {
      containerRef.current?.focus();
    }
  }, [attempt]);

  if (errors.length < MIN_ERRORS) {
    return null;
  }

  const heading =
    errors.length === 1
      ? copy.errorSummary.headingOne
      : interpolate(copy.errorSummary.headingMany, { count: errors.length });

  return (
    <div
      ref={containerRef}
      className={styles.summary}
      role="alert"
      tabIndex={-1}
      aria-labelledby="onboarding-error-summary-heading"
    >
      <h3 id="onboarding-error-summary-heading" className={styles.heading}>
        {heading}
      </h3>
      <ul className={styles.list}>
        {errors.map((error) => (
          <li key={error.field}>
            <a
              className={styles.link}
              href={`#${error.field}`}
              onClick={(event) => {
                event.preventDefault();
                const target = document.getElementById(error.field);
                if (target === null) {
                  return;
                }
                target.focus({ preventScroll: true });
                target.scrollIntoView({ block: 'center', behavior: 'smooth' });
              }}
            >
              {error.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
