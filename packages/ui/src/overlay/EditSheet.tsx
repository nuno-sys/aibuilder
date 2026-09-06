/** @jsxImportSource react */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * The editor's panel: a static column on the left on desktop, a bottom sheet on a phone.
 *
 * WHY THIS IS NOT A `<dialog>`, and why that is the accessible choice rather than the lazy one.
 * A modal dialog makes the rest of the document `inert` — which is exactly what the onboarding
 * modal wants and exactly what this must not do. The entire point of the editor is that you change
 * a colour and watch the preview change; a sheet that makes the preview inert to a screen reader's
 * virtual cursor, and unscrollable to everyone else, has broken the feature it exists to serve.
 * `dialog.show()` (non-modal) does not help either: it is not in the top layer, so it is back to
 * ordinary positioning with none of the browser behaviour that made `showModal()` worth using.
 *
 * So this is a **disclosure**, which is what it actually is: a labelled region, a button that
 * expands and collapses it, and `aria-expanded` on the button. Nothing is trapped, nothing is
 * inert, Escape collapses rather than closes, and the preview stays reachable at every size.
 *
 * ONE DOM SERVES BOTH LAYOUTS. The breakpoint lives in CSS and nothing here reads it during render,
 * so there is no hydration mismatch, no flash of the wrong layout, and no resize listener. The
 * `expanded` state is meaningful only under the mobile media query; desktop CSS ignores it.
 * `matchMedia` is consulted at *event* time — never at render time — and only to decide whether
 * moving focus would be a helpful thing to do or an unexplained jump.
 *
 * FOCUS, ON A PHONE. Expanding moves focus to the sheet's content so the next Tab lands inside it;
 * collapsing returns focus to the handle, because the alternative is focus on `<body>` and a user
 * who has lost their place. Neither happens on desktop, where the panel never moved.
 */

/** Below this width the panel is a sheet. Must match `--aib-editor-breakpoint` in `styles.css`. */
const SHEET_MEDIA_QUERY = '(max-width: 899px)';

export interface EditSheetProps {
  /** The region's accessible name, e.g. "Bewerken". Rendered visibly as the sheet's title. */
  readonly title: string;
  /** Announced on the handle when collapsed, e.g. "Bewerkpaneel openen". */
  readonly expandLabel: string;
  /** Announced on the handle when expanded, e.g. "Bewerkpaneel sluiten". */
  readonly collapseLabel: string;
  /** Starts expanded. Desktop ignores it; a phone opens on the preview by default. */
  readonly defaultExpanded?: boolean | undefined;
  readonly children: ReactNode;
}

/** True when the viewport is currently narrow enough for the sheet layout. */
function isSheetLayout(): boolean {
  // `matchMedia` is absent in a server render and in some test environments. Answering `false`
  // there is right: the server renders the desktop DOM, and the desktop path moves no focus.
  return typeof window !== 'undefined' && window.matchMedia(SHEET_MEDIA_QUERY).matches;
}

/** Renders the edit panel / bottom sheet. */
export function EditSheet({
  title,
  expandLabel,
  collapseLabel,
  defaultExpanded = false,
  children,
}: EditSheetProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();
  const titleId = useId();

  const toggle = useCallback(() => {
    setExpanded((previous) => !previous);
  }, []);

  useEffect(() => {
    if (!isSheetLayout()) {
      return;
    }
    if (expanded) {
      contentRef.current?.focus();
    } else {
      handleRef.current?.focus();
    }
  }, [expanded]);

  useEffect(() => {
    if (!expanded) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      // Escape collapses only in the sheet layout. On desktop the panel is not an overlay, so
      // Escape belongs to whatever control the user is actually in.
      if (event.key === 'Escape' && isSheetLayout()) {
        setExpanded(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [expanded]);

  return (
    <section
      className="aib-sheet"
      data-expanded={expanded ? 'true' : 'false'}
      aria-labelledby={titleId}
    >
      <div className="aib-sheet__bar">
        <h2 id={titleId} className="aib-sheet__title">
          {title}
        </h2>
        {/* The grab bar IS the button. A decorative bar next to a separate close control is two
            targets where the user's thumb expects one, and only one of them is announced. */}
        <button
          ref={handleRef}
          type="button"
          className="aib-sheet__handle"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={toggle}
        >
          <span className="aib-sr-only">{expanded ? collapseLabel : expandLabel}</span>
          <span className="aib-sheet__grip" aria-hidden="true" />
        </button>
      </div>
      {/* `tabIndex={-1}` so focus can be moved here programmatically without adding a tab stop.
          The region is never `hidden`: in the collapsed sheet state CSS leaves a peek visible, and
          hiding it would make the panel unreachable to a screen reader that is not in browse
          mode. */}
      <div id={panelId} ref={contentRef} className="aib-sheet__content" tabIndex={-1}>
        {children}
      </div>
    </section>
  );
}
