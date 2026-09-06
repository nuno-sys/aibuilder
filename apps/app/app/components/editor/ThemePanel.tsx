/** @jsxImportSource react */
import { useCallback, useId } from 'react';
import {
  COLOR_MODES,
  DENSITY_IDS,
  DNA_IDS,
  HUE_SHIFTS,
  MOTION_IDS,
  PALETTE_VARIANTS,
  RADIUS_IDS,
  TYPE_SCALE_IDS,
} from '@aibuilder/site-schema';
import type { ThemeDoc } from '@aibuilder/site-schema';
import { resolveTheme } from '@aibuilder/site-kit';

import type { ThemeKnobsPatch } from '../../do/patch';
import type { Copy } from '../../lib/copy';

/**
 * The colour panel: eight closed enums, and a repaint with no network in it.
 *
 * THE ZERO-ROUND-TRIP CLAIM, AND HOW IT IS ACTUALLY MET. `resolveTheme` is a pure function in
 * `@aibuilder/site-kit` — OKLCH maths, a monotone lightness solver and a contrast verification — and
 * it is imported HERE, into the browser bundle, on purpose. So a knob change resolves the 47 custom
 * properties locally and posts them into the preview frame, and the page restyles in one style
 * recalculation. No server call, no re-render of the preview, no rebuild of its CSS.
 *
 * The same function then runs again on the server when the patch lands, and the stored tokens are
 * the server's. That is not redundancy: the client's copy is an optimisation and the server's is the
 * truth, so a client that was tampered with, or that is running yesterday's bundle, cannot persist a
 * theme the resolver would not have produced.
 *
 * `resolveTheme` CONSTRUCTS, THEN VERIFIES, THEN THROWS. A knob combination whose contrast cannot be
 * proven raises rather than returning a bad palette, so the `try` here is the difference between "we
 * refuse that combination" and a white-on-white hero. The refusal is shown; nothing is posted and
 * nothing is queued.
 *
 * WHY EIGHT `<select>`s AND NOT A COLOUR PICKER. The design surface is deliberately closed
 * (`site-kit` §1): the model chooses eight enums and the resolver proves the result. A free colour
 * picker would produce palettes nothing can prove, on sites this product is responsible for the
 * accessibility of. A native `<select>` is also the one control that works identically with a
 * keyboard, a screen reader and a thumb, which is what this panel is used with.
 */

/** One labelled `<select>` over a closed enum. */
function Knob<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly T[];
  readonly onChange: (next: T) => void;
}) {
  const id = useId();
  return (
    <div className="aib-field">
      <label className="aib-field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="aib-input"
        value={value}
        onChange={(event) => {
          // The value can only be one of `options`: a `<select>` cannot produce anything else, and
          // the server re-validates against the same enum through `ThemeKnobsSchema`.
          onChange(event.currentTarget.value as T);
        }}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}

export interface ThemePanelProps {
  readonly copy: Copy;
  readonly knobs: ThemeKnobsPatch;
  /** Applies the change: resolve locally, paint, then queue. Returns false when it was refused. */
  readonly onChange: (next: ThemeKnobsPatch, tokens: ThemeDoc['tokens']) => void;
  /** Called when `resolveTheme` refused the combination, so the panel can say so. */
  readonly onRefused: () => void;
}

/** Renders the eight knobs. */
export function ThemePanel({ copy, knobs, onChange, onRefused }: ThemePanelProps) {
  const change = useCallback(
    (next: ThemeKnobsPatch): void => {
      try {
        onChange(next, resolveTheme(next));
      } catch {
        onRefused();
      }
    },
    [onChange, onRefused],
  );

  return (
    <section aria-labelledby="theme-heading">
      <h3 id="theme-heading" className="app-panel__heading">
        {copy.editor.colourScheme}
      </h3>

      <Knob
        label={copy.editor.colourScheme}
        value={knobs.dnaId}
        options={DNA_IDS}
        onChange={(dnaId) => {
          change({ ...knobs, dnaId });
        }}
      />
      <Knob
        label={copy.editor.palette}
        value={knobs.paletteVariant}
        options={PALETTE_VARIANTS}
        onChange={(paletteVariant) => {
          change({ ...knobs, paletteVariant });
        }}
      />
      <Knob
        label={copy.editor.accentHue}
        value={knobs.accentHueShift}
        options={HUE_SHIFTS}
        onChange={(accentHueShift) => {
          change({ ...knobs, accentHueShift });
        }}
      />
      <Knob
        label={copy.editor.mode}
        value={knobs.colorMode}
        options={COLOR_MODES}
        onChange={(colorMode) => {
          change({ ...knobs, colorMode });
        }}
      />
      <Knob
        label={copy.editor.typeScale}
        value={knobs.typeScaleId}
        options={TYPE_SCALE_IDS}
        onChange={(typeScaleId) => {
          change({ ...knobs, typeScaleId });
        }}
      />
      <Knob
        label={copy.editor.radius}
        value={knobs.radiusId}
        options={RADIUS_IDS}
        onChange={(radiusId) => {
          change({ ...knobs, radiusId });
        }}
      />
      <Knob
        label={copy.editor.density}
        value={knobs.densityId}
        options={DENSITY_IDS}
        onChange={(densityId) => {
          change({ ...knobs, densityId });
        }}
      />
      <Knob
        label={copy.editor.motion}
        value={knobs.motionId}
        options={MOTION_IDS}
        onChange={(motionId) => {
          change({ ...knobs, motionId });
        }}
      />
    </section>
  );
}
