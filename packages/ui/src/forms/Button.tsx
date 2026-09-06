/** @jsxImportSource react */
import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * The one button.
 *
 * WHY `busy` IS NOT `disabled`. A disabled button is removed from the tab order, so the moment a
 * form submits, the keyboard user's focus point vanishes and focus falls back to `<body>` — they
 * lose their place in the form they were filling in. `aria-disabled` plus a guard in the handler
 * keeps the element focusable and announceable while refusing the second activation, which is what
 * `aria-busy` is telling assistive technology has already happened.
 *
 * The `disabled` prop is still accepted and still means the native thing, for the case where a
 * control is genuinely unavailable rather than merely in flight.
 *
 * TARGET SIZE. The CSS gives every variant a 44×44 CSS-pixel minimum, above WCAG 2.2 SC 2.5.8's
 * 24×24 floor, because the editor is used on a phone with one thumb while looking at a preview.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'children'
> {
  readonly variant?: ButtonVariant | undefined;
  /** In flight. Keeps focus, refuses activation, sets `aria-busy`. */
  readonly busy?: boolean | undefined;
  /** Renders full width. The editor's sheet uses this; the toolbar does not. */
  readonly block?: boolean | undefined;
  readonly children: ReactNode;
}

/** Renders a button that stays focusable while it is working. */
export function Button({
  variant = 'secondary',
  busy = false,
  block = false,
  type = 'button',
  onClick,
  disabled,
  ...rest
}: ButtonProps) {
  const classes = ['aib-button', `aib-button--${variant}`];
  if (block) classes.push('aib-button--block');

  return (
    <button
      {...rest}
      type={type}
      className={classes.join(' ')}
      disabled={disabled}
      aria-disabled={busy ? true : undefined}
      aria-busy={busy ? true : undefined}
      onClick={(event) => {
        if (busy) {
          // The click is refused here rather than by `disabled`, so the element keeps focus and the
          // user keeps their place. `preventDefault` also stops a `type="submit"` from submitting.
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    />
  );
}
