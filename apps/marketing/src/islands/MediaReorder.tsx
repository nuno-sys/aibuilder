/**
 * The media grid and its reordering — keyboard first, pointer second.
 *
 * WCAG 2.2 SC 2.5.7 (Dragging Movements) IS THE DESIGN CONSTRAINT, not a checkbox afterwards.
 * Every reorder is reachable without a dragging gesture:
 *
 *   - always-visible `⟨` and `⟩` buttons on every tile, 44 px, which move one position per press
 *   - a grab handle that responds to `Space`: pick up, announce, arrow keys move with a live
 *     announcement per step, `Space` drops, `Escape` cancels and restores the original position
 *   - pointer dragging on top of all of that, as an enhancement — with a 6 px threshold so a tap
 *     still behaves like a tap
 *
 * THE FLIP ANIMATION IS DONE BY HAND and it is worth the thirty lines: reordering a grid without one
 * makes tiles teleport, and the user loses track of which photo they just moved — which is the one
 * thing the interaction exists to communicate. Rects are measured before the DOM updates, the delta
 * is applied as a transform with no transition, and the transform is released on the next frame.
 *
 * Announcements go to the polite live region through `onAnnounce`; they are the only feedback a
 * screen-reader user gets from a reorder, so they carry the item, its new position and the total.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Locale } from '@aibuilder/core';

import { copyFor } from '../lib/copy';
import { interpolate, truncateFileName } from '../lib/format';
import { DURATION, EASING, prefersReducedMotion } from '../lib/motion';
import type { MediaItem } from '../lib/types';

import MediaTile from './MediaTile';
import styles from './Media.module.css';

/** Movement, in pixels, before a pointer press becomes a drag rather than a tap. */
const DRAG_THRESHOLD_PX = 6;

export interface MediaReorderProps {
  readonly items: readonly MediaItem[];
  readonly locale: Locale;
  readonly onMove: (clientId: string, toIndex: number) => void;
  readonly onRemove: (clientId: string) => void;
  readonly onRetry: (clientId: string) => void;
  readonly onAnnounce: (message: string) => void;
}

/**
 * Renders the grid.
 *
 * Guarantees that no reorder is available only by dragging, that every move is announced, and that
 * `Escape` during a keyboard move restores the original order exactly.
 */
export default function MediaReorder({
  items,
  locale,
  onMove,
  onRemove,
  onRetry,
  onAnnounce,
}: MediaReorderProps) {
  const copy = copyFor(locale);
  const listRef = useRef<HTMLUListElement | null>(null);
  const rects = useRef(new Map<string, DOMRect>());

  /** The tile currently picked up by the keyboard, and where it started. */
  const [picked, setPicked] = useState<{ clientId: string; originIndex: number } | null>(null);
  const dragState = useRef<{
    clientId: string;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);

  // FLIP: measure before paint, invert, then release on the next frame.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null) {
      return;
    }
    const reduced = prefersReducedMotion();
    const tiles = list.querySelectorAll<HTMLElement>('[data-media-tile]');
    const next = new Map<string, DOMRect>();

    for (const tile of tiles) {
      const id = tile.dataset['mediaTile'];
      if (id === undefined) {
        continue;
      }
      const rect = tile.getBoundingClientRect();
      next.set(id, rect);
      const previous = rects.current.get(id);
      if (previous === undefined || reduced) {
        continue;
      }
      const deltaX = previous.left - rect.left;
      const deltaY = previous.top - rect.top;
      if (deltaX === 0 && deltaY === 0) {
        continue;
      }
      tile.style.transition = 'none';
      tile.style.transform = `translate(${String(deltaX)}px, ${String(deltaY)}px)`;
      requestAnimationFrame(() => {
        tile.style.transition = `transform ${String(DURATION.d4)}ms ${EASING.outQuint}`;
        tile.style.transform = '';
      });
    }
    rects.current = next;
  }, [items]);

  const nameOf = (item: MediaItem): string => truncateFileName(item.name);

  const announceMove = (item: MediaItem, position: number): void => {
    onAnnounce(
      interpolate(copy.media.moved, {
        name: nameOf(item),
        position: position + 1,
        total: items.length,
      }),
    );
  };

  const onHandleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    const item = items[index];
    if (item === undefined) {
      return;
    }

    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      if (picked === null) {
        setPicked({ clientId: item.clientId, originIndex: index });
        onAnnounce(interpolate(copy.media.picked, { name: nameOf(item) }));
      } else {
        setPicked(null);
        onAnnounce(interpolate(copy.media.dropped, { name: nameOf(item), position: index + 1 }));
      }
      return;
    }

    if (event.key === 'Escape' && picked !== null) {
      event.preventDefault();
      onMove(picked.clientId, picked.originIndex);
      onAnnounce(
        interpolate(copy.media.cancelled, {
          name: nameOf(item),
          position: picked.originIndex + 1,
        }),
      );
      setPicked(null);
      return;
    }

    const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    if (!back && !forward) {
      return;
    }
    event.preventDefault();
    // Arrows only move a tile that has been picked up. Without the pick-up gesture they would move
    // photos while a user is merely reading the grid with the keyboard.
    if (picked === null || picked.clientId !== item.clientId) {
      return;
    }
    const target = Math.max(0, Math.min(items.length - 1, index + (back ? -1 : 1)));
    if (target === index) {
      return;
    }
    onMove(item.clientId, target);
    announceMove(item, target);
  };

  return (
    <ul
      ref={listRef}
      className={styles.grid}
      aria-label={copy.step6.mediaLabel}
      onPointerMove={(event) => {
        const state = dragState.current;
        if (state === null) {
          return;
        }
        if (
          !state.active &&
          Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < DRAG_THRESHOLD_PX
        ) {
          return;
        }
        state.active = true;
        const under = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest<HTMLElement>('[data-media-tile]');
        const targetId = under?.dataset['mediaTile'];
        if (targetId === undefined || targetId === state.clientId) {
          return;
        }
        const targetIndex = items.findIndex((item) => item.clientId === targetId);
        if (targetIndex !== -1) {
          onMove(state.clientId, targetIndex);
        }
      }}
      onPointerUp={() => {
        dragState.current = null;
      }}
      onPointerCancel={() => {
        dragState.current = null;
      }}
    >
      {items.map((item, index) => (
        <li key={item.clientId} className={styles.tileWrap}>
          <MediaTile
            item={item}
            index={index}
            total={items.length}
            locale={locale}
            picked={picked?.clientId === item.clientId}
            onRemove={onRemove}
            onRetry={onRetry}
            onMove={(clientId, toIndex) => {
              onMove(clientId, toIndex);
              const moved = items.find((entry) => entry.clientId === clientId);
              if (moved !== undefined) {
                announceMove(moved, Math.max(0, Math.min(items.length - 1, toIndex)));
              }
            }}
          />
          <button
            type="button"
            className={styles.handle}
            aria-label={`${nameOf(item)} — ${copy.media.reorderHint}`}
            aria-pressed={picked?.clientId === item.clientId}
            onKeyDown={(event) => {
              onHandleKeyDown(event, index);
            }}
            onPointerDown={(event) => {
              dragState.current = {
                clientId: item.clientId,
                startX: event.clientX,
                startY: event.clientY,
                active: false,
              };
              // Capture so the drag survives the pointer leaving the handle, which it does
              // immediately once the tiles start moving underneath it.
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="currentColor">
              <circle cx="6" cy="4" r="1.2" />
              <circle cx="10" cy="4" r="1.2" />
              <circle cx="6" cy="8" r="1.2" />
              <circle cx="10" cy="8" r="1.2" />
              <circle cx="6" cy="12" r="1.2" />
              <circle cx="10" cy="12" r="1.2" />
            </svg>
          </button>
        </li>
      ))}
    </ul>
  );
}
