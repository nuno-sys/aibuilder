/** @jsxImportSource react */
import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

/**
 * The two text controls, styled once.
 *
 * Neither owns a label, a hint or a message: `Field` does, and it hands the wiring in through its
 * render prop. Keeping the association in one place is the whole reason `Field` takes a function
 * instead of rendering an input itself.
 *
 * `spellCheck` defaults to on for the editor's copy fields — this is a product whose users are
 * writing marketing prose in their second language on a phone — and the caller turns it off for
 * slugs and identifiers, where a red squiggle under every value is noise.
 */

export type TextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'className'>;

/** A single-line text input. */
export function TextInput(props: TextInputProps) {
  return <input {...props} className="aib-input" />;
}

export type TextAreaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'>;

/**
 * A multi-line text input.
 *
 * `rows` defaults to 3 rather than the browser's 2: a copy slot's ceiling is 400–800 characters
 * (`SLOT_MAX_LENGTH`), and a two-line box makes every one of them feel like an overflow.
 */
export function TextArea({ rows = 3, ...rest }: TextAreaProps) {
  return <textarea {...rest} rows={rows} className="aib-input aib-input--multiline" />;
}
