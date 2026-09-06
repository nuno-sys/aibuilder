/**
 * The photo dropzone.
 *
 * `accept="image/jpeg,image/png,image/webp"` IS LOAD-BEARING, not a filter. When the accept list
 * excludes HEIC, iOS Safari **transcodes the photo to JPEG as it hands it over**. That single
 * attribute is why roughly a third of European iPhone uploads arrive in a format Chrome and Firefox
 * can decode instead of one they cannot — and it is why there is no `heic2any` fallback in this
 * bundle. Adding `image/heic` to the list would turn the conversion off and break exactly the users
 * most likely to convert.
 *
 * THE DRAG LISTENER IS ON THE DOCUMENT, WITH A COUNTER. `dragenter`/`dragleave` fire for every
 * child element the pointer crosses, so a zone that toggles on the raw events flickers violently
 * the moment the pointer passes over its own heading. Counting enter/leave pairs and reacting only
 * to the transitions through zero is the fix, and it also lets the WHOLE WINDOW be a drop target —
 * which is what people actually do with a modal that fills the screen.
 *
 * `capture="environment"` IS ON A SEPARATE INPUT because it is a different intention: "take a photo
 * now" opens the camera directly, while "choose files" opens the picker. One input cannot be both,
 * and the camera button is hidden on desktop where it would open a webcam nobody wants to be seen on.
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { Locale } from '@aibuilder/core';

import { copyFor } from '../lib/copy';

import { ACCEPT_ATTRIBUTE } from './hooks/useMediaUpload';
import fields from './fields.module.css';
import styles from './Media.module.css';

export interface MediaDropzoneProps {
  readonly locale: Locale;
  /** True on coarse pointers, where the camera button is offered. */
  readonly onFiles: (files: readonly File[]) => void;
  /** Disabled once twelve photos are present. */
  readonly disabled: boolean;
}

/**
 * Renders the dropzone and its two file inputs.
 *
 * Guarantees that a drop anywhere in the window is accepted, that the highlight never flickers, and
 * that the browser's own "open this file" navigation is always suppressed — a dropped photo that
 * replaces the page is a lost draft.
 */
export default function MediaDropzone({ locale, onFiles, disabled }: MediaDropzoneProps) {
  const copy = copyFor(locale);
  const [dragging, setDragging] = useState(false);
  const [hasCamera, setHasCamera] = useState(false);
  const depth = useRef(0);
  const chooseId = useId();
  const captureId = useId();

  useEffect(() => {
    setHasCamera(window.matchMedia('(pointer: coarse)').matches);
  }, []);

  useEffect(() => {
    if (disabled) {
      return undefined;
    }

    const onDragEnter = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes('Files') !== true) {
        return;
      }
      depth.current += 1;
      setDragging(true);
    };
    const onDragOver = (event: DragEvent): void => {
      // Without this the browser navigates to the dropped file and the whole draft is gone.
      event.preventDefault();
      if (event.dataTransfer !== null) {
        event.dataTransfer.dropEffect = 'copy';
      }
    };
    const onDragLeave = (): void => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) {
        setDragging(false);
      }
    };
    const onDrop = (event: DragEvent): void => {
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) {
        onFiles(files);
      }
    };

    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
    };
  }, [disabled, onFiles]);

  return (
    <div className={`${styles.dropzone} ${dragging ? styles.dropzoneActive : ''}`}>
      <p className={styles.dropzoneText}>
        {dragging ? copy.media.dropzoneActive : copy.media.dropzone}
      </p>

      <div className={styles.dropzoneActions}>
        {/* The inputs are visually hidden rather than `display: none`: a hidden-but-present input
            keeps its label association and stays reachable by the keyboard through the label. */}
        <label className={`${fields.button} ${fields.buttonSecondary}`} htmlFor={chooseId}>
          {copy.media.choose}
        </label>
        <input
          id={chooseId}
          className="sr-only"
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          multiple
          disabled={disabled}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            if (files.length > 0) {
              onFiles(files);
            }
            // Cleared so choosing the same file twice fires `change` the second time as well.
            event.target.value = '';
          }}
        />

        {hasCamera ? (
          <>
            <label className={`${fields.button} ${fields.buttonSecondary}`} htmlFor={captureId}>
              {copy.media.capture}
            </label>
            <input
              id={captureId}
              className="sr-only"
              type="file"
              accept={ACCEPT_ATTRIBUTE}
              capture="environment"
              disabled={disabled}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                if (files.length > 0) {
                  onFiles(files);
                }
                event.target.value = '';
              }}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
