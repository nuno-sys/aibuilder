/** @jsxImportSource react */
import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Ref } from 'react';
import { postThemeToFrame } from '@aibuilder/ui';
import type { ThemeDoc } from '@aibuilder/site-schema';

/**
 * The preview iframe: a cross-origin window onto the customer's own draft.
 *
 * TWO WAYS TO UPDATE IT, AND THEY EXIST FOR DIFFERENT REASONS.
 *
 *   THEME → `postMessage`, applied by the eleven-line bridge inside the document. One style
 *   recalculation, no reload, nothing refetched. This is the "0 ms round-trip" the architecture asks
 *   for, and it is only possible because every component in `site-kit` reads colour exclusively
 *   through CSS custom properties.
 *
 *   COPY AND STRUCTURE → a reload of the frame, debounced. There is no honest way to patch rendered
 *   HTML from outside the document: the change may move a section, alter a heading's length and
 *   therefore its wrap, or add a JSON-LD field. Re-rendering on the server is the only thing that
 *   produces the page that will actually publish, and a preview that shows something else is worse
 *   than one that takes 300 ms to catch up.
 *
 * THE FIRST LOAD GOES THROUGH THE HANDSHAKE and every later one does not. `initialSrc` is the
 * `/_authorise` URL carrying a single-use grant; it spends the grant, sets the `__Host-aib_preview`
 * cookie and 303s to the render URL. After that the cookie is in the jar, so a refresh is just the
 * render URL with a changed revision parameter — no secret in it, and nothing to spend.
 *
 * `contentWindow.location.reload()` IS NOT AVAILABLE and that is by design: the frame is a different
 * origin, which is the entire security property. Setting `src` is how a parent navigates a
 * cross-origin frame it owns.
 */

/** What the editor can ask the frame to do. */
export interface PreviewHandle {
  /** Repaints the theme in place. Returns false when the frame has not loaded yet. */
  applyTheme(tokens: ThemeDoc['tokens']): boolean;
  /** Reloads the rendered document, at most once per `REFRESH_DEBOUNCE_MS`. */
  refresh(revision: number): void;
}

/** How long after the last stored patch the frame reloads. */
const REFRESH_DEBOUNCE_MS = 700;

export interface PreviewFrameProps {
  readonly ref?: Ref<PreviewHandle>;
  /** The `/_authorise` URL, with its one-time grant. Used for the first load only. */
  readonly initialSrc: string;
  /** `https://preview.<domain>/s/<siteId>` — the render URL, without a query string. */
  readonly renderBase: string;
  readonly previewOrigin: string;
  readonly pageId: string;
  readonly locale: string;
  readonly title: string;
}

/** Renders the preview and exposes the two ways to update it. */
export function PreviewFrame({
  ref,
  initialSrc,
  renderBase,
  previewOrigin,
  pageId,
  locale,
  title,
}: PreviewFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [src, setSrc] = useState(initialSrc);
  // The page and locale the frame is currently showing. Changing either is a navigation, not a
  // refresh, so it is tracked separately from the revision.
  const shown = useRef({ pageId, locale });

  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (shown.current.pageId === pageId && shown.current.locale === locale) {
      return;
    }
    shown.current = { pageId, locale };
    const url = new URL(renderBase);
    url.searchParams.set('p', pageId);
    url.searchParams.set('l', locale);
    setSrc(url.toString());
  }, [pageId, locale, renderBase]);

  useImperativeHandle<PreviewHandle, PreviewHandle>(
    ref,
    () => ({
      applyTheme: (tokens) => postThemeToFrame(frameRef.current, previewOrigin, tokens),
      refresh: (revision) => {
        if (timer.current !== null) {
          clearTimeout(timer.current);
        }
        timer.current = setTimeout(() => {
          const url = new URL(renderBase);
          url.searchParams.set('p', shown.current.pageId);
          url.searchParams.set('l', shown.current.locale);
          // The revision is a cache-buster AND a statement of what is being shown. The preview
          // response is `no-store`, so this is belt and braces — but a browser that decided to
          // reuse the document would show the customer their previous edit as though it were the
          // current one, which is the one lie this whole screen exists not to tell.
          url.searchParams.set('r', String(revision));
          setSrc(url.toString());
        }, REFRESH_DEBOUNCE_MS);
      },
    }),
    [previewOrigin, renderBase],
  );

  return (
    <iframe
      ref={frameRef}
      className="app-preview__frame"
      src={src}
      // The frame is a named region for a screen-reader user, who otherwise gets "frame" and no
      // idea what is inside it.
      title={title}
      // `allow-scripts` because the rendered page carries `site-kit`'s three inline scripts and the
      // theme bridge; `allow-same-origin` because without it the document is given an opaque origin
      // and cannot read the `__Host-aib_preview` cookie it was just handed — which is not a
      // loosening, since the frame's own origin is already isolated from this one. Everything else
      // stays off: a draft page has no business opening a popup, submitting a form to a third party,
      // or navigating the top-level window.
      sandbox="allow-scripts allow-same-origin"
      referrerPolicy="no-referrer"
      loading="eager"
    />
  );
}
