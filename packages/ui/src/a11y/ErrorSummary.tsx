/** @jsxImportSource react */
import { useEffect, useId, useRef } from 'react';

/**
 * The error summary — the WCAG 2.2 pattern for a form that failed on submit.
 *
 * The onboarding modal's component (`apps/marketing/src/islands/ErrorSummary.tsx`), with the copy
 * lifted out into props so the dashboard can supply its own without this package growing a
 * dependency on the locale registry.
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
 *  3. **The click focuses the field instead of navigating to it.** A real `#hash` jump pushes a
 *     history entry, and in a dashboard whose history stack is its navigation that makes the back
 *     button undo an error-summary click rather than a page.
 *
 * It appears only when a submit produced two or more errors. One error is shown inline on its field
 * and nowhere else: a summary listing a single item is ceremony, and it pushes the field the user
 * has to fix further down the screen.
 */

/** Minimum errors before the summary is shown at all. */
const MIN_ERRORS = 2;

/** One field-level failure, in the order the fields appear on the form. */
export interface SummarisedError {
  /** The `id` of the control to focus. Must match the rendered input's `id` exactly. */
  readonly fieldId: string;
  /** The message, as it will be read aloud from the link list. */
  readonly message: string;
}

export interface ErrorSummaryProps {
  /** In the order the fields appear, which is the order they should be fixed in. */
  readonly errors: readonly SummarisedError[];
  /** e.g. "Er zijn 3 problemen" — already interpolated by the caller, which owns the locale. */
  readonly heading: string;
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
export function ErrorSummary({ errors, heading, attempt }: ErrorSummaryProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const headingId = useId();

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

  return (
    <div
      ref={containerRef}
      className="aib-error-summary"
      role="alert"
      tabIndex={-1}
      aria-labelledby={headingId}
    >
      <h2 id={headingId} className="aib-error-summary__heading">
        {heading}
      </h2>
      <ul className="aib-error-summary__list">
        {errors.map((error) => (
          <li key={error.fieldId}>
            <a
              href={`#${error.fieldId}`}
              onClick={(event) => {
                event.preventDefault();
                const target = document.getElementById(error.fieldId);
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
