/**
 * "Skip — we'll pick beautiful imagery for you."
 *
 * WHY THIS CARD IS AS LARGE AS THE DROPZONE'S OWN CALL TO ACTION. Uploads are the single biggest
 * abandonment point on mobile in this flow. A small grey "skip" link reads as a penalty, so people
 * either fight with a photo they do not have or close the tab. A full-width card with its own
 * preview reframes skipping as *choosing* — and it is an honest offer: the generator really does
 * select imagery that suits the trade.
 *
 * THE PREVIEWS ARE DRAWN, NOT FETCHED, and that is a deliberate Phase 1 decision with two reasons.
 * The marketing surface's CSP allows images from `'self'`, `data:` and `blob:` only, so a stock
 * provider's thumbnails could not load at all; and Phase 1 has no stock provider integration to be
 * honest about. Three tinted SVG compositions say "imagery in your colours" without pretending to
 * be photographs the user will actually receive.
 */

import type { Locale } from '@aibuilder/core';

import { copyFor } from '../lib/copy';
import { interpolate } from '../lib/format';

import fields from './fields.module.css';
import styles from './Media.module.css';

/** The three preview swatches, as [ground, shape] token pairs. */
const PREVIEWS: readonly { readonly ground: string; readonly shape: string }[] = [
  { ground: 'var(--brand-50)', shape: 'var(--brand-200)' },
  { ground: 'var(--n-100)', shape: 'var(--n-300)' },
  { ground: 'var(--brand-25)', shape: 'var(--brand-100)' },
];

export interface SkipMediaCardProps {
  readonly locale: Locale;
  /** The industry label, lower-cased into the sentence. Falls back to a neutral noun. */
  readonly industryLabel: string | null;
  /** True once the user has chosen to skip; the card then offers the way back. */
  readonly skipped: boolean;
  readonly onSkip: () => void;
  readonly onUndo: () => void;
}

/**
 * Renders the skip card.
 *
 * Guarantees the skip action is a real button of at least 44 px and is never visually subordinate
 * to the upload buttons.
 */
export default function SkipMediaCard({
  locale,
  industryLabel,
  skipped,
  onSkip,
  onUndo,
}: SkipMediaCardProps) {
  const copy = copyFor(locale);
  const industry = industryLabel ?? (locale === 'nl' ? 'jouw vak' : 'your trade');

  return (
    <div className={`${styles.skip} ${skipped ? styles.skipChosen : ''}`}>
      <div className={styles.skipPreviews} aria-hidden="true">
        {PREVIEWS.map((preview, index) => (
          <svg
            key={preview.ground}
            viewBox="0 0 64 48"
            className={styles.skipPreview}
            focusable="false"
          >
            <rect width="64" height="48" fill={preview.ground} rx="4" />
            {index === 0 ? (
              <>
                <circle cx="20" cy="18" r="7" fill={preview.shape} />
                <path d="M4 44l16-14 12 9 10-8 18 13z" fill={preview.shape} />
              </>
            ) : index === 1 ? (
              <>
                <rect x="8" y="26" width="14" height="18" fill={preview.shape} rx="2" />
                <rect x="26" y="16" width="14" height="28" fill={preview.shape} rx="2" />
                <rect x="44" y="22" width="14" height="22" fill={preview.shape} rx="2" />
              </>
            ) : (
              <>
                <rect x="8" y="10" width="48" height="6" fill={preview.shape} rx="3" />
                <rect x="8" y="22" width="34" height="6" fill={preview.shape} rx="3" />
                <rect x="8" y="34" width="42" height="6" fill={preview.shape} rx="3" />
              </>
            )}
          </svg>
        ))}
      </div>

      <div className={styles.skipBody}>
        <p className={styles.skipTitle}>{copy.media.skip.title}</p>
        <p className={styles.skipText}>{interpolate(copy.media.skip.body, { industry })}</p>
      </div>

      <button
        type="button"
        className={`${fields.button} ${skipped ? fields.buttonGhost : fields.buttonSecondary} ${styles.skipAction}`}
        onClick={skipped ? onUndo : onSkip}
      >
        {skipped ? copy.media.skip.undo : copy.media.skip.action}
      </button>
    </div>
  );
}
