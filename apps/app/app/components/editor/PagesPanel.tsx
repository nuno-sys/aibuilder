/** @jsxImportSource react */
import type { SiteDoc } from '@aibuilder/site-schema';
import { Button } from '@aibuilder/ui';

import type { DraftPatch } from '../../do/patch';
import type { Copy } from '../../lib/copy';

/**
 * The structure panel: which pages are in the navigation, which are hidden from search, and the
 * order of the sections on the page being previewed.
 *
 * SECTION ORDER IS BUTTONS, NOT DRAG-AND-DROP. A drag handle is unusable with a keyboard unless it
 * ships a full keyboard alternative anyway (WCAG 2.2 SC 2.5.7 makes the alternative mandatory, not
 * optional), it is unusable one-thumbed on the phone this panel is a bottom sheet on, and it needs a
 * live region narrating every drop or a screen-reader user has no idea what happened. Two buttons
 * that say "move up" and "move down" are the accessible implementation, they are half the code, and
 * on a list of at most a dozen sections they are not meaningfully slower to use.
 *
 * EACH BUTTON NAMES ITS SECTION for the accessibility tree. Twelve buttons all reading "Omhoog" are
 * useless in a screen reader's control list, so the visible label is the arrow and the accessible
 * name carries the section type.
 *
 * `noindex` IS OFFERED PER PAGE AND `showInNav` IS NOT OFFERED FOR THE HOME PAGE, because a site
 * whose home page is out of the navigation has no way back to itself. That is enforced by leaving
 * the control out rather than by disabling it: a disabled control invites a customer to wonder what
 * they did wrong.
 */

export interface PagesPanelProps {
  readonly copy: Copy;
  readonly doc: SiteDoc;
  /** The page whose sections are listed — the one the preview is showing. */
  readonly pageId: string;
  readonly onPatch: (patch: DraftPatch) => void;
}

/** Renders the page flags and the section order. */
export function PagesPanel({ copy, doc, pageId, onPatch }: PagesPanelProps) {
  const page = doc.pages.find((candidate) => candidate.pageId === pageId);

  return (
    <section aria-labelledby="pages-heading">
      <h3 id="pages-heading" className="app-panel__heading">
        {copy.editor.tabPages}
      </h3>

      <ul className="app-panel__list">
        {doc.pages.map((candidate) => (
          <li key={candidate.pageId} className="app-panel__row">
            <span className="app-panel__rowLabel">{candidate.role}</span>
            {candidate.role === 'home' ? null : (
              <label className="app-panel__toggle">
                <input
                  type="checkbox"
                  checked={candidate.showInNav}
                  onChange={(event) => {
                    onPatch({
                      op: 'set_page_flag',
                      pageId: candidate.pageId,
                      field: 'showInNav',
                      value: event.currentTarget.checked,
                    });
                  }}
                />
                {copy.editor.inNav}
              </label>
            )}
            <label className="app-panel__toggle">
              <input
                type="checkbox"
                checked={candidate.noindex}
                onChange={(event) => {
                  onPatch({
                    op: 'set_page_flag',
                    pageId: candidate.pageId,
                    field: 'noindex',
                    value: event.currentTarget.checked,
                  });
                }}
              />
              {copy.editor.hideFromSearch}
            </label>
          </li>
        ))}
      </ul>

      {page === undefined ? null : (
        <>
          <h3 className="app-panel__heading">{copy.editor.sectionsHeading}</h3>
          <ol className="app-panel__list">
            {page.sections.map((section, index) => (
              <li key={section.id} className="app-panel__row">
                <span className="app-panel__rowLabel">{section.type}</span>
                <Button
                  aria-label={`${copy.editor.moveUp}: ${section.type}`}
                  disabled={index === 0}
                  onClick={() => {
                    onPatch({
                      op: 'move_section',
                      pageId: page.pageId,
                      sectionId: section.id,
                      toIndex: index - 1,
                    });
                  }}
                >
                  <span aria-hidden="true">↑</span>
                </Button>
                <Button
                  aria-label={`${copy.editor.moveDown}: ${section.type}`}
                  disabled={index === page.sections.length - 1}
                  onClick={() => {
                    onPatch({
                      op: 'move_section',
                      pageId: page.pageId,
                      sectionId: section.id,
                      toIndex: index + 1,
                    });
                  }}
                >
                  <span aria-hidden="true">↓</span>
                </Button>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
