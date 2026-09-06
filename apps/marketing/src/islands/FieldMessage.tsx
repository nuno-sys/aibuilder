/**
 * The inline message under a field: an error, or a positive confirmation.
 *
 * It exists as its own component because the *shape* of the message is an accessibility contract
 * repeated on every field, and repeating a contract by hand six times is how one of the six ends up
 * without the icon:
 *
 *   - the element's `id` is `{field}-err`, which the input references from `aria-describedby`
 *     alongside its hint — the hint is never replaced, so help text is not lost when a field errors
 *   - an error carries an icon as well as colour (SC 1.4.1), and the input's border thickens
 *   - the message is NOT itself a live region: the field's own `aria-describedby` announces it when
 *     focus lands, and the assertive region announces it at submit. Making it live as well means
 *     the same sentence three times.
 */

import styles from './fields.module.css';

export interface FieldMessageProps {
  /** The field's id; the element becomes `{id}-err` or `{id}-ok`. */
  readonly fieldId: string;
  readonly tone: 'error' | 'success';
  readonly children: string;
}

/** Renders one inline field message with the right id, colour and icon. */
export default function FieldMessage({ fieldId, tone, children }: FieldMessageProps) {
  if (tone === 'success') {
    return (
      <p id={`${fieldId}-ok`} className={styles.success}>
        <svg
          className={styles.errorIcon}
          viewBox="0 0 16 16"
          aria-hidden="true"
          focusable="false"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 8.5 6.5 12 13 4.5" />
        </svg>
        {children}
      </p>
    );
  }

  return (
    <p id={`${fieldId}-err`} className={styles.error}>
      <svg
        className={styles.errorIcon}
        viewBox="0 0 16 16"
        aria-hidden="true"
        focusable="false"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <circle cx="8" cy="8" r="6.5" />
        <path d="M8 4.75v4M8 11.25h.01" />
      </svg>
      {children}
    </p>
  );
}
