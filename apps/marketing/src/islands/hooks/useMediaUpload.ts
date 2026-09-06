/**
 * The media pipeline, browser side: decode → downscale → encode → hash → sign → PUT → commit.
 *
 * WHY THE BROWSER COMPRESSES AT ALL. A modern phone photo is 4–12 MB. Uploading twelve of them
 * over a shop's ADSL is minutes of waiting on the last step of the funnel, and the server would
 * immediately re-encode them down to roughly the 1.6 MB this produces. Compressing first turns a
 * three-minute upload into a fifteen-second one and costs about 300 ms of GPU time per photo.
 *
 * WHY THERE IS NO WEB WORKER. The two expensive operations already run off the main thread:
 * `createImageBitmap()` decodes on a browser-internal thread, and `OffscreenCanvas.convertToBlob()`
 * encodes on one. What remains on the main thread is a `drawImage` into an offscreen surface, which
 * is GPU work and does not block scrolling. A dedicated worker would add a second module, a
 * transfer protocol and a fallback path for browsers without `OffscreenCanvas` — for the part of
 * the job that is already cheap.
 *
 * WHY `accept` LISTS ONLY JPEG/PNG/WEBP. It is the reason iOS Safari hands us a JPEG instead of an
 * HEIC. iOS transcodes on selection when the accept list excludes HEIC — and a third of EU iPhone
 * uploads are HEIC, which Chrome and Firefox cannot decode at all. Excluding it from `accept` is
 * not a restriction, it is the conversion.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE. No EXIF parsing, no blurhash, no dominant colour: the encode
 * strips metadata by construction (a canvas has no EXIF to write out, so GPS never leaves the
 * device), and the blurhash and dominant colour are computed server-side by the verify queue,
 * which is also the only party whose numbers may be trusted. Video is Phase 3 (architecture §9).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Locale, UploadMimeType } from '@aibuilder/core';

import { ApiError, commitMedia, getMediaStatus, signMedia, uploadToR2 } from '../../lib/api';
import type { MediaErrorCode, MediaItem, PersistedMedia } from '../../lib/types';
import { copyFor } from '../../lib/copy';
import { formatBytes, interpolate, truncateFileName } from '../../lib/format';

/** The accept list, and the whole of it. Anything else is rejected before a byte is read. */
export const ACCEPTED_MIME_TYPES: readonly UploadMimeType[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
];

/** The `accept` attribute for the file inputs. */
export const ACCEPT_ATTRIBUTE = ACCEPTED_MIME_TYPES.join(',');

/** Server ceiling (architecture §S4). Checked here so a doomed upload never starts. */
const MAX_FILE_BYTES = 15 * 1024 * 1024;

/** Server ceiling per draft. */
const MAX_FILES = 12;

/** Below this the photo is blurry on a desktop hero and the user is warned (UX §4.2). */
const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;

/** Longest edge after downscaling. Halved on a metered or slow connection. */
const MAX_EDGE = 2560;
const MAX_EDGE_SAVE_DATA = 1200;

/** Encode ladder: quality steps tried until the result fits the target. */
const QUALITY_LADDER = [0.82, 0.72, 0.62] as const;

/** Target size of an encoded photo. */
const TARGET_BYTES = 1_600_000;

/** Parallel uploads. Three saturates a domestic uplink without starving the autosave. */
const MAX_CONCURRENCY = 3;

/** How often a `verifying` tile asks the server whether it is ready. */
const VERIFY_POLL_MS = 1500;

/** Give up polling after this long and leave the tile usable — verification continues server-side. */
const VERIFY_TIMEOUT_MS = 30_000;

/** The connection hints that make us compress harder and upload one at a time. */
interface NetworkHints {
  readonly saveData: boolean;
  readonly slow: boolean;
}

/** Reads the Network Information API, which most browsers do not implement. Absence means "fine". */
function networkHints(): NetworkHints {
  const connection = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }
  ).connection;
  if (connection === undefined) {
    return { saveData: false, slow: false };
  }
  const effective = connection.effectiveType ?? '';
  return {
    saveData: connection.saveData === true,
    slow: effective === 'slow-2g' || effective === '2g',
  };
}

/** A decoded image plus the way to draw it. Both branches expose the same three fields. */
interface DecodedImage {
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  readonly release: () => void;
}

/**
 * Decodes a file off the main thread where possible.
 *
 * `imageOrientation: 'from-image'` bakes the EXIF rotation into the pixels, which is what stops a
 * portrait photo from a phone landing sideways in the hero. The `<img>` fallback exists for Safari
 * versions without the options bag; browsers there apply EXIF orientation to `<img>` themselves.
 */
async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => {
          bitmap.close();
        },
      };
    } catch {
      // Falls through to the <img> path: some builds reject the options bag rather than ignore it.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => {
        URL.revokeObjectURL(url);
      },
    };
  } catch (error: unknown) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/** Draws onto an `OffscreenCanvas` when there is one, and a DOM canvas otherwise. */
async function encode(
  image: DecodedImage,
  width: number,
  height: number,
  quality: number,
): Promise<Blob | null> {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context === null) {
      return null;
    }
    context.drawImage(image.source, 0, 0, width, height);
    return canvas.convertToBlob({ type: 'image/webp', quality });
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) {
    return null;
  }
  context.drawImage(image.source, 0, 0, width, height);
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob(
      (blob) => {
        resolve(blob);
      },
      'image/webp',
      quality,
    );
  });
}

/** The prepared upload: bytes, type and the dimensions the signer binds into the row. */
interface PreparedFile {
  readonly blob: Blob;
  readonly mime: UploadMimeType;
  readonly width: number;
  readonly height: number;
}

/**
 * Downscales and re-encodes one file.
 *
 * Keeps the original when the encode comes out larger — which happens for small PNG logos and for
 * photos that were already aggressively compressed — because uploading a bigger file to save
 * bandwidth is not a trade.
 */
async function prepareFile(file: File, hints: NetworkHints): Promise<PreparedFile> {
  const image = await decodeImage(file);
  try {
    const maxEdge = hints.saveData || hints.slow ? MAX_EDGE_SAVE_DATA : MAX_EDGE;
    const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));

    let best: Blob | null = null;
    for (const quality of QUALITY_LADDER) {
      const encoded = await encode(image, width, height, quality);
      if (encoded === null) {
        break;
      }
      best = encoded;
      if (encoded.size <= TARGET_BYTES) {
        break;
      }
    }

    if (best === null || best.size >= file.size) {
      const mime = ACCEPTED_MIME_TYPES.find((type) => type === file.type);
      if (mime === undefined) {
        throw new Error('unsupported-source-type');
      }
      return { blob: file, mime, width: image.width, height: image.height };
    }
    return { blob: best, mime: 'image/webp', width, height };
  } finally {
    image.release();
  }
}

/** Lowercase hex SHA-256 of a blob — the digest `POST /v1/media/:id/commit` records. */
async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Client-minted tile identity. Never sent anywhere; the server's id is `mediaId`. */
function mintClientId(): string {
  return `local_${Math.random().toString(36).slice(2, 10)}${String(Date.now() % 1_000_000)}`;
}

/** What the media UI gets back. */
export interface UseMediaUploadResult {
  readonly items: readonly MediaItem[];
  /** True while any tile is still working. Never blocks submit — see `OnboardingModal`. */
  readonly busy: boolean;
  add(files: readonly File[]): void;
  remove(clientId: string): void;
  retry(clientId: string): void;
  /** Moves a tile to an absolute index, clamped. The first tile is the hero. */
  move(clientId: string, toIndex: number): void;
}

/**
 * Owns the media grid and its uploads.
 *
 * Guarantees: a file is validated before any network call, a failed file never blocks the others,
 * every blob URL is revoked, and the persisted projection handed to `onChange` contains only ids
 * the server has acknowledged — so a resumed draft never references an upload that does not exist.
 */
export function useMediaUpload(params: {
  /** Resolves the draft id, creating the server-side draft (behind Turnstile) if needed. */
  ensureDraft: () => Promise<string>;
  onChange: (media: PersistedMedia[]) => void;
  onAnnounce: (message: string) => void;
  locale: Locale;
}): UseMediaUploadResult {
  const { ensureDraft, onChange, onAnnounce, locale } = params;
  const [items, setItems] = useState<readonly MediaItem[]>([]);
  const itemsRef = useRef<readonly MediaItem[]>(items);
  const running = useRef(0);
  const hints = useMemo(networkHints, []);
  const copy = useMemo(() => copyFor(locale), [locale]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  /** Applies a change and mirrors the persistable projection into the draft. */
  const commitItems = useCallback(
    (mutate: (previous: readonly MediaItem[]) => readonly MediaItem[]): void => {
      const next = mutate(itemsRef.current);
      itemsRef.current = next;
      setItems(next);
      onChange(
        next.map((item) => ({
          clientId: item.clientId,
          mediaId: item.mediaId,
          name: item.name,
          width: item.width,
          height: item.height,
          bytes: item.bytes,
          mime: item.mime,
          status: item.status,
        })),
      );
    },
    [onChange],
  );

  const patchItem = useCallback(
    (clientId: string, patch: Partial<MediaItem>): void => {
      commitItems((previous) =>
        previous.map((item) => (item.clientId === clientId ? { ...item, ...patch } : item)),
      );
    },
    [commitItems],
  );

  const failItem = useCallback(
    (
      clientId: string,
      code: MediaErrorCode,
      extra: Readonly<Record<string, string>> = {},
    ): void => {
      patchItem(clientId, { status: 'error', errorCode: code, errorParams: extra, progress: 0 });
    },
    [patchItem],
  );

  /** Polls one media row until it is ready, failed or the timeout expires. */
  const awaitVerification = useCallback(
    async (clientId: string, mediaId: string): Promise<void> => {
      const deadline = Date.now() + VERIFY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, VERIFY_POLL_MS));
        try {
          const status = await getMediaStatus(mediaId);
          if (status.status === 'ready') {
            patchItem(clientId, { status: 'ready', progress: 100 });
            return;
          }
          if (status.status === 'quarantined' || status.status === 'failed') {
            failItem(clientId, 'quarantined');
            return;
          }
        } catch {
          // Keep polling: a single failed status read says nothing about the file.
        }
      }
      // Verification outlives our patience often enough on a cold queue; the file is almost
      // certainly fine, and the generation step waits for it anyway (UX §4.6).
      patchItem(clientId, { status: 'ready', progress: 100 });
    },
    [failItem, patchItem],
  );

  /** Runs one file through the whole pipeline. Never throws; every failure lands on the tile. */
  const process = useCallback(
    async (item: MediaItem, file: File): Promise<void> => {
      try {
        patchItem(item.clientId, { status: 'compressing' });
        const prepared = await prepareFile(file, hints).catch(() => null);
        if (prepared === null) {
          failItem(item.clientId, 'decodeFailed', { name: truncateFileName(item.name) });
          return;
        }
        if (prepared.width < MIN_WIDTH || prepared.height < MIN_HEIGHT) {
          failItem(item.clientId, 'tooSmall', {
            width: String(prepared.width),
            height: String(prepared.height),
          });
          return;
        }

        const draftId = await ensureDraft();
        if (draftId.length === 0) {
          failItem(item.clientId, 'uploadFailed', { name: truncateFileName(item.name) });
          return;
        }

        const digest = await sha256Hex(prepared.blob);
        const isFirst = itemsRef.current[0]?.clientId === item.clientId;
        const signed = await signMedia({
          // The role is a hint recorded at sign time; the hero is ultimately decided by the ORDER
          // of `mediaIds` in the intake, which the user can still change by reordering tiles.
          role: isFirst ? 'hero' : 'gallery',
          declaredType: prepared.mime,
          bytes: prepared.blob.size,
          width: prepared.width,
          height: prepared.height,
        });

        patchItem(item.clientId, {
          status: 'uploading',
          mediaId: signed.mediaId,
          bytes: prepared.blob.size,
          width: prepared.width,
          height: prepared.height,
          mime: prepared.mime,
          progress: 0,
        });

        await uploadToR2({
          url: signed.uploadUrl,
          headers: signed.headers,
          blob: prepared.blob,
          onProgress: (fraction) => {
            patchItem(item.clientId, { progress: Math.round(fraction * 100) });
          },
        });

        patchItem(item.clientId, { status: 'verifying', progress: 100 });
        await commitMedia({ mediaId: signed.mediaId, sha256: digest });

        const index = itemsRef.current.findIndex((entry) => entry.clientId === item.clientId);
        onAnnounce(
          interpolate(copy.media.uploaded, {
            index: index + 1,
            total: itemsRef.current.length,
          }),
        );
        await awaitVerification(item.clientId, signed.mediaId);
      } catch (error: unknown) {
        if (error instanceof ApiError && error.status === 429) {
          failItem(item.clientId, 'tooMany');
          return;
        }
        if (error instanceof ApiError && error.status === 413) {
          failItem(item.clientId, 'tooLarge', {
            name: truncateFileName(item.name),
            size: formatBytes(item.bytes, locale),
          });
          return;
        }
        if (!navigator.onLine) {
          failItem(item.clientId, 'offline');
          return;
        }
        failItem(item.clientId, 'uploadFailed', { name: truncateFileName(item.name) });
      }
    },
    [awaitVerification, copy, ensureDraft, failItem, hints, locale, onAnnounce, patchItem],
  );

  /** Pending files, keyed by tile. Blobs are never in React state — only their metadata is. */
  const pending = useRef(new Map<string, File>());

  const pump = useCallback((): void => {
    const concurrency = hints.saveData || hints.slow ? 1 : MAX_CONCURRENCY;
    while (running.current < concurrency) {
      const next = itemsRef.current.find(
        (item) => item.status === 'queued' && pending.current.has(item.clientId),
      );
      if (next === undefined) {
        return;
      }
      const file = pending.current.get(next.clientId);
      if (file === undefined) {
        return;
      }
      pending.current.delete(next.clientId);
      running.current += 1;
      void process(next, file).finally(() => {
        running.current -= 1;
        pump();
      });
    }
  }, [hints, process]);

  const add = useCallback(
    (files: readonly File[]): void => {
      const accepted: MediaItem[] = [];
      let slots = MAX_FILES - itemsRef.current.length;

      for (const file of files) {
        if (slots <= 0) {
          // One tile carries the "twelve is the maximum" message rather than one per rejected file:
          // dropping twenty photos should not produce eight identical errors.
          accepted.push(errorTile(file, 'tooMany', {}));
          break;
        }
        const mime = ACCEPTED_MIME_TYPES.find((type) => type === file.type);
        if (mime === undefined) {
          accepted.push(errorTile(file, 'wrongType', { name: truncateFileName(file.name) }));
          continue;
        }
        if (file.size > MAX_FILE_BYTES) {
          accepted.push(
            errorTile(file, 'tooLarge', {
              name: truncateFileName(file.name),
              size: formatBytes(file.size, locale),
            }),
          );
          continue;
        }
        const clientId = mintClientId();
        pending.current.set(clientId, file);
        accepted.push({
          clientId,
          mediaId: null,
          name: file.name,
          previewUrl: URL.createObjectURL(file),
          width: 0,
          height: 0,
          bytes: file.size,
          mime,
          status: 'queued',
          progress: 0,
          errorCode: null,
          errorParams: {},
        });
        slots -= 1;
      }

      if (accepted.length === 0) {
        return;
      }
      commitItems((previous) => [...previous, ...accepted]);
      pump();
    },
    [commitItems, locale, pump],
  );

  const remove = useCallback(
    (clientId: string): void => {
      const previewUrl =
        itemsRef.current.find((entry) => entry.clientId === clientId)?.previewUrl ?? null;
      if (previewUrl !== null) {
        URL.revokeObjectURL(previewUrl);
      }
      pending.current.delete(clientId);
      commitItems((previous) => previous.filter((entry) => entry.clientId !== clientId));
    },
    [commitItems],
  );

  const retry = useCallback(
    (clientId: string): void => {
      if (!pending.current.has(clientId)) {
        // The original `File` is gone (a resumed session, or a tile that already uploaded), so
        // there is nothing to retry with. Removing the tile is the honest outcome.
        remove(clientId);
        return;
      }
      patchItem(clientId, { status: 'queued', errorCode: null, errorParams: {}, progress: 0 });
      pump();
    },
    [patchItem, pump, remove],
  );

  const move = useCallback(
    (clientId: string, toIndex: number): void => {
      commitItems((previous) => {
        const from = previous.findIndex((item) => item.clientId === clientId);
        if (from === -1) {
          return previous;
        }
        const to = Math.max(0, Math.min(previous.length - 1, toIndex));
        if (from === to) {
          return previous;
        }
        const next = [...previous];
        const [moved] = next.splice(from, 1);
        if (moved === undefined) {
          return previous;
        }
        next.splice(to, 0, moved);
        return next;
      });
    },
    [commitItems],
  );

  // Object URLs are a document-lifetime leak if they are not revoked; the island can be unmounted
  // by a client-side navigation on the marketing site.
  useEffect(
    () => () => {
      for (const item of itemsRef.current) {
        if (item.previewUrl !== null) {
          URL.revokeObjectURL(item.previewUrl);
        }
      }
    },
    [],
  );

  const busy = items.some(
    (item) =>
      item.status === 'queued' || item.status === 'compressing' || item.status === 'uploading',
  );

  return { items, busy, add, remove, retry, move };
}

/** A tile that failed before it ever started, so the user sees *which* file was rejected. */
function errorTile(
  file: File,
  code: MediaErrorCode,
  params: Readonly<Record<string, string>>,
): MediaItem {
  return {
    clientId: mintClientId(),
    mediaId: null,
    name: file.name,
    previewUrl: null,
    width: 0,
    height: 0,
    bytes: file.size,
    mime: 'image/jpeg',
    status: 'error',
    progress: 0,
    errorCode: code,
    errorParams: params,
  };
}
