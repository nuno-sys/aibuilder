/** @jsxImportSource react */
import { useId } from 'react';
import type { ReactNode } from 'react';

import { FieldMessage, fieldMessageId } from '../a11y/FieldMessage';

/**
 * The label / hint / message wrapper, and the one place `aria-describedby` is composed.
 *
 * THE BUG THIS COMPONENT EXISTS TO PREVENT is writing `aria-describedby={errorId}` on a field that
 * also has a hint. That replaces the hint rather than adding to it, so the moment a user makes a
 * mistake the help text explaining how to avoid it stops being announced. `describedBy()` joins
 * both, in reading order, and the render props hand the caller the exact attribute set to spread.
 *
 * THE LABEL IS ALWAYS A REAL `<label for>`. Not `aria-label`, which is invisible to voice control
 * users who say "click Bedrijfsnaam", and not a placeholder, which disappears the moment there is
 * a value to check against it.
 *
 * `aria-invalid` is set from the presence of an error and never from "the field is untouched", so
 * a form does not announce itself as broken before anyone has typed in it.
 */

/** The attributes a control must spread onto itself to be wired into this field. */
export interface FieldControlProps {
  readonly id: string;
  readonly 'aria-describedby': string | undefined;
  readonly 'aria-invalid': true | undefined;
}

export interface FieldProps {
  readonly label: string;
  /** Persistent help text. Announced with the field, and never replaced by an error. */
  readonly hint?: string | undefined;
  /** The validation failure, if any. Rendered inline and referenced from `aria-describedby`. */
  readonly error?: string | undefined;
  /** A positive confirmation ("Deze naam is beschikbaar"). Ignored while `error` is set. */
  readonly success?: string | undefined;
  /** Marks the control required, visibly and in the accessibility tree. */
  readonly required?: boolean | undefined;
  /** Overrides the generated id, for the cases where a caller has to address the control. */
  readonly id?: string | undefined;
  readonly children: (props: FieldControlProps) => ReactNode;
}

/** Joins the described-by ids in reading order, or `undefined` when there are none. */
function describedBy(ids: readonly (string | null)[]): string | undefined {
  const present = ids.filter((id): id is string => id !== null);
  return present.length === 0 ? undefined : present.join(' ');
}

/** Renders a labelled control with its hint and message correctly associated. */
export function Field({ label, hint, error, success, required, id, children }: FieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const hintId = hint === undefined ? null : `${fieldId}-hint`;
  const errorId = error === undefined ? null : fieldMessageId(fieldId, 'error');
  const successId =
    error === undefined && success !== undefined ? fieldMessageId(fieldId, 'success') : null;

  return (
    <div className={error === undefined ? 'aib-field' : 'aib-field aib-field--invalid'}>
      <label className="aib-field__label" htmlFor={fieldId}>
        {label}
        {required === true ? (
          <span className="aib-field__required" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {hint === undefined ? null : (
        <p id={hintId ?? undefined} className="aib-field__hint">
          {hint}
        </p>
      )}
      {children({
        id: fieldId,
        'aria-describedby': describedBy([hintId, errorId, successId]),
        'aria-invalid': error === undefined ? undefined : true,
      })}
      {error !== undefined ? (
        <FieldMessage fieldId={fieldId} tone="error">
          {error}
        </FieldMessage>
      ) : success !== undefined ? (
        <FieldMessage fieldId={fieldId} tone="success">
          {success}
        </FieldMessage>
      ) : null}
    </div>
  );
}
