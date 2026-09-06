/**
 * One photo in the media grid, in whichever of its six states it is in.
 *
 * THE FIRST TILE IS BADGED `Hero`, and that badge is the strongest teaching signal in the whole
 * step: it says what the order means without a sentence of explanation, which is why reordering
 * needs no instructions beyond the arrows themselves.
 *
 * THE UPLOAD RING IS A REAL `role="progressbar"`. A CSS-only ring communicates nothing to a screen
 * reader; with `aria-valuenow` the same pixels are a value that can be read on demand. The percentage
 * is also rendered as text inside the ring, because a ring alone is not a number for anyone.
 *
 * WHAT THE STATES MEAN, and why `verifying` is not `done`: `commit` hands the file to a queue that
 * sniffs its magic bytes, re-encodes it and only then promotes the row. A tile that claims "done"
 * before that has finished is claiming something the server has not agreed to.
 */

import type { Locale } from '@aibuilder/core';

import { copyFor } from '../lib/copy';
import { interpolate, truncateFileName } from '../lib/format';
import type { MediaItem } from '../lib/types';
import { validationMessage } from '../lib/validation';
import type { ValidationCode } from '../lib/validation';

import styles from './Media.module.css';

/** Radius of the progress ring in its own 36×36 viewBox. */
const RING_RADIUS = 15;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** Maps a tile's error code onto the copy table's key. */
function messageKey(code: NonNullable<MediaItem['errorCode']>): ValidationCode {
  return `media.${code}` as ValidationCode;
}

export interface MediaTileProps {
  readonly item: MediaItem;
  readonly index: number;
  readonly total: number;
  readonly locale: Locale;
  /** True while this tile is picked up by the keyboard reorder. */
  readonly picked: boolean;
  readonly onRemove: (clientId: string) => void;
  readonly onRetry: (clientId: string) => void;
  readonly onMove: (clientId: string, toIndex: number) => void;
}

/**
 * Renders one tile.
 *
 * Guarantees the tile is fully operable with a keyboard — move left, move right and remove are all
 * real buttons at 44 px — and that every visual state has a text equivalent.
 */
export default function MediaTile({
  item,
  index,
  total,
  locale,
  picked,
  onRemove,
  onRetry,
  onMove,
}: MediaTileProps) {
  const copy = copyFor(locale);
  const name = truncateFileName(item.name);

  const stateText =
    item.status === 'uploading'
      ? interpolate(copy.media.states.uploading, { percent: item.progress })
      : item.status === 'error'
        ? copy.media.states.error
        : copy.media.states[item.status];

  return (
    // A `<div>` rather than an `<li>`: the list item is the wrapper in `MediaReorder`, which also
    // owns the drag handle, and a `<ul>` may only contain `<li>` children.
    <div
      className={`${styles.tile} ${picked ? styles.tilePicked : ''} ${
        item.status === 'error' ? styles.tileError : ''
      }`}
      data-media-tile={item.clientId}
    >
      <div className={styles.thumb}>
        {item.previewUrl === null ? (
          <div className={styles.placeholder} aria-hidden="true" />
        ) : (
          // `alt=""`: the photo is decoration *of the tile*; the tile's own controls carry the
          // accessible names, and a filename read as alt text is noise.
          <img
            className={styles.image}
            src={item.previewUrl}
            alt=""
            loading="lazy"
            decoding="async"
          />
        )}

        {index === 0 && item.status !== 'error' ? (
          <span className={styles.heroBadge}>{copy.media.hero}</span>
        ) : null}

        {item.status === 'uploading' ? (
          <div
            className={styles.ring}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={item.progress}
            aria-label={interpolate(copy.media.states.uploading, { percent: item.progress })}
          >
            <svg viewBox="0 0 36 36" aria-hidden="true" focusable="false">
              <circle className={styles.ringTrack} cx="18" cy="18" r={RING_RADIUS} />
              <circle
                className={styles.ringFill}
                cx="18"
                cy="18"
                r={RING_RADIUS}
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={RING_CIRCUMFERENCE * (1 - item.progress / 100)}
              />
            </svg>
            <span className={styles.ringLabel}>{item.progress}%</span>
          </div>
        ) : null}

        {item.status === 'compressing' ||
        item.status === 'queued' ||
        item.status === 'verifying' ? (
          <div className={styles.shimmer} aria-hidden="true" />
        ) : null}
      </div>

      <p className={styles.tileMeta}>
        <span className={styles.tileName}>{name}</span>
        <span className={styles.tileState}>{stateText}</span>
      </p>

      {item.status === 'error' && item.errorCode !== null ? (
        <div className={styles.tileErrorBody}>
          <p className={styles.tileErrorText}>
            {validationMessage(messageKey(item.errorCode), locale, item.errorParams)}
          </p>
          <button
            type="button"
            className={styles.tileAction}
            onClick={() => {
              onRetry(item.clientId);
            }}
          >
            {copy.media.retry}
          </button>
        </div>
      ) : null}

      <div className={styles.tileControls}>
        {/* SC 2.5.7: these two buttons are the primary reorder mechanism. Pointer dragging is an
            enhancement layered on top of them, never a replacement for them. */}
        <button
          type="button"
          className={styles.moveButton}
          disabled={index === 0}
          aria-label={`${copy.media.moveLeft}: ${name}`}
          onClick={() => {
            onMove(item.clientId, index - 1);
          }}
        >
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10 3 5 8l5 5" />
          </svg>
        </button>
        <button
          type="button"
          className={styles.moveButton}
          disabled={index === total - 1}
          aria-label={`${copy.media.moveRight}: ${name}`}
          onClick={() => {
            onMove(item.clientId, index + 1);
          }}
        >
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 3 5 5-5 5" />
          </svg>
        </button>
        <button
          type="button"
          className={styles.removeButton}
          aria-label={`${copy.media.remove}: ${name}`}
          onClick={() => {
            onRemove(item.clientId);
          }}
        >
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
    </div>
  );
}
